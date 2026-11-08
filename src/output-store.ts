import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import type {
  OutputArchive,
  OutputCapture,
  OutputCaptureResult,
  OutputReadInput,
  OutputReadResult,
  OutputStreamName,
} from "./types.js";

export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
export const OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_READ_BYTES = 64 * 1024;
const EXCERPT_BYTES = 4096;
const EXCERPT_OMISSION = "\n[... output omitted ...]\n";
const OUTPUT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STREAMS: OutputStreamName[] = ["stdout", "stderr"];

interface StreamExcerpt {
  bytes: number;
  head: Buffer;
  tail: Buffer;
}

interface ArchiveMetadata {
  stdoutBytes: number;
  stderrBytes: number;
  stdoutArchivedBytes: number;
  stderrArchivedBytes: number;
  archiveStatus: "complete" | "truncated";
  archiveError?: string;
}

function excerpt(): StreamExcerpt {
  return { bytes: 0, head: Buffer.alloc(0), tail: Buffer.alloc(0) };
}

function addExcerpt(target: StreamExcerpt, chunk: Buffer): void {
  target.bytes += chunk.length;
  if (target.head.length < EXCERPT_BYTES) {
    target.head = Buffer.concat([
      target.head,
      chunk.subarray(0, EXCERPT_BYTES - target.head.length),
    ]);
  }
  target.tail = Buffer.concat([target.tail, chunk]).subarray(-EXCERPT_BYTES);
}

function excerptText(target: StreamExcerpt): { text: string; truncated: boolean } {
  const truncated = target.bytes > EXCERPT_BYTES * 2;
  if (truncated) {
    const head = target.head.subarray(0, EXCERPT_BYTES - Buffer.byteLength(EXCERPT_OMISSION));
    let tailStart = 0;
    while (tailStart < target.tail.length && (target.tail[tailStart] & 0xc0) === 0x80) {
      tailStart += 1;
    }
    const tail = target.tail.subarray(tailStart);
    return {
      text:
        head.subarray(0, completeUtf8Prefix(head)).toString("utf8") +
        EXCERPT_OMISSION +
        tail.subarray(0, completeUtf8Prefix(tail)).toString("utf8"),
      truncated,
    };
  }
  const overlap = Math.max(0, target.head.length + target.tail.length - target.bytes);
  const bytes = Buffer.concat([target.head, target.tail.subarray(overlap)]);
  const decoder = new StringDecoder("utf8");
  return {
    text: decoder.write(bytes) + decoder.end(),
    truncated,
  };
}

function byteBoundaryStart(data: Buffer, index: number): number {
  let start = index;
  while (start > 0 && (data[start] & 0xc0) === 0x80) start -= 1;
  return start;
}

function completeUtf8Prefix(data: Buffer): number {
  if (data.length === 0) return 0;
  let start = data.length - 1;
  while (start >= 0 && (data[start] & 0xc0) === 0x80) start -= 1;
  if (start < 0) return data.length;
  const lead = data[start];
  const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  return data.length - start < expected ? start : data.length;
}

class MemoryCapture implements OutputCapture {
  private readonly stdout = excerpt();
  private readonly stderr = excerpt();

  constructor(
    private readonly archiveStatus: "failed" | "not_configured",
    private readonly archiveError?: string,
  ) {}

  append(stream: OutputStreamName, chunk: Buffer): void {
    addExcerpt(stream === "stdout" ? this.stdout : this.stderr, chunk);
  }

  async finish(): Promise<OutputCaptureResult> {
    const stdout = excerptText(this.stdout);
    const stderr = excerptText(this.stderr);
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutBytes: this.stdout.bytes,
      stderrBytes: this.stderr.bytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      archiveStatus: this.archiveStatus,
      ...(this.archiveError ? { archiveError: this.archiveError } : {}),
    };
  }
}

class FileCapture implements OutputCapture {
  private readonly stdout = excerpt();
  private readonly stderr = excerpt();
  private readonly writers: Record<OutputStreamName, WriteStream>;
  private reservedBytes = 0;
  private captureBytes = 0;
  private readonly archivedBytes: Record<OutputStreamName, number> = {
    stdout: 0,
    stderr: 0,
  };
  private archiveStatus: "complete" | "truncated" | "failed" = "complete";
  private archiveError?: string;
  private finishedResult?: OutputCaptureResult;
  private readonly pausedSources = new Set<{ resume(): void }>();

  constructor(
    private readonly owner: LocalOutputArchive,
    readonly outputId: string,
    paths: Record<OutputStreamName, string>,
    private readonly maxArchiveBytes: number,
    private readonly maxCaptureBytes: number,
  ) {
    this.writers = {
      stdout: createWriteStream(paths.stdout, { flags: "wx", mode: 0o600 }),
      stderr: createWriteStream(paths.stderr, { flags: "wx", mode: 0o600 }),
    };
    for (const writer of Object.values(this.writers)) {
      writer.on("error", (err) => this.fail(err));
    }
  }

  async open(): Promise<void> {
    await Promise.all(
      Object.values(this.writers).map(
        (writer) =>
          new Promise<void>((resolve, reject) => {
            writer.once("open", () => resolve());
            writer.once("error", reject);
          }),
      ),
    );
  }

  append(
    stream: OutputStreamName,
    chunk: Buffer,
    source?: { pause(): void; resume(): void },
  ): void {
    if (this.finishedResult) return;
    const target = stream === "stdout" ? this.stdout : this.stderr;
    addExcerpt(target, chunk);
    if (this.archiveStatus === "failed") return;

    const available = Math.max(
      0,
      Math.min(this.maxCaptureBytes - this.captureBytes, this.maxArchiveBytes - this.owner.usedBytes),
    );
    const bytesToWrite = Math.min(chunk.length, available);
    if (bytesToWrite > 0) {
      const part = chunk.subarray(0, bytesToWrite);
      this.reservedBytes += bytesToWrite;
      this.captureBytes += bytesToWrite;
      this.archivedBytes[stream] += bytesToWrite;
      this.owner.reserve(bytesToWrite);
      const writer = this.writers[stream];
      if (!writer.write(part)) {
        source?.pause();
        if (source) this.pausedSources.add(source);
        writer.once("drain", () => {
          if (source) this.pausedSources.delete(source);
          if (this.archiveStatus !== "failed") source?.resume();
        });
      }
    }
    if (bytesToWrite < chunk.length) {
      this.archiveStatus = "truncated";
      this.archiveError = "archive size or storage quota limit reached";
    }
  }

  private fail(err: Error): void {
    if (this.archiveStatus === "failed") return;
    this.archiveStatus = "failed";
    this.archiveError = `output archive write failed: ${err.message}`;
    for (const source of this.pausedSources) source.resume();
    this.pausedSources.clear();
    for (const writer of Object.values(this.writers)) writer.destroy();
  }

  async finish(): Promise<OutputCaptureResult> {
    if (this.finishedResult) return this.finishedResult;
    for (const writer of Object.values(this.writers)) {
      if (!writer.destroyed) writer.end();
    }
    const settled = await Promise.allSettled(Object.values(this.writers).map((writer) => finished(writer)));
    const failed = settled.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") this.fail(failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason)));
    if (this.archiveStatus !== "failed") {
      try {
        await this.owner.writeMetadata(this.outputId, {
          stdoutBytes: this.stdout.bytes,
          stderrBytes: this.stderr.bytes,
          stdoutArchivedBytes: this.archivedBytes.stdout,
          stderrArchivedBytes: this.archivedBytes.stderr,
          archiveStatus: this.archiveStatus,
          ...(this.archiveError ? { archiveError: this.archiveError } : {}),
        });
      } catch (err) {
        this.fail(err instanceof Error ? err : new Error(String(err)));
      }
    }
    if (this.archiveStatus === "failed") {
      this.owner.reserve(-this.reservedBytes);
      await Promise.all([
        ...STREAMS.map((stream) => rm(this.owner.filePath(this.outputId, stream), { force: true })),
        rm(this.owner.metadataPath(this.outputId), { force: true }),
      ]);
    }

    const stdout = excerptText(this.stdout);
    const stderr = excerptText(this.stderr);
    this.finishedResult = {
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutBytes: this.stdout.bytes,
      stderrBytes: this.stderr.bytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      ...(this.archiveStatus === "failed" ? {} : { outputId: this.outputId }),
      archiveStatus: this.archiveStatus,
      ...(this.archiveError ? { archiveError: this.archiveError } : {}),
    };
    return this.finishedResult;
  }
}

export class LocalOutputArchive implements OutputArchive {
  private root?: string;
  private initialization?: Promise<void>;
  private cleaning?: Promise<void>;
  private used = 0;
  private lastCleanupAt = 0;

  constructor(
    private readonly directory =
      process.env.OPENWRT_MCP_OUTPUT_DIR ??
      path.join(homedir(), ".local", "state", "openwrt-mcp", "outputs"),
    private readonly maxArchiveBytes = MAX_ARCHIVE_BYTES,
    private readonly maxCaptureBytes = MAX_CAPTURE_BYTES,
    private readonly retentionMs = OUTPUT_RETENTION_MS,
  ) {}

  get usedBytes(): number {
    return this.used;
  }

  reserve(bytes: number): void {
    this.used = Math.max(0, this.used + bytes);
  }

  filePath(outputId: string, stream: OutputStreamName): string {
    if (!OUTPUT_ID_PATTERN.test(outputId)) throw new Error("invalid outputId");
    if (!this.root) throw new Error("output archive is not initialized");
    return path.join(this.root, `${outputId}.${stream}`);
  }

  metadataPath(outputId: string): string {
    if (!OUTPUT_ID_PATTERN.test(outputId)) throw new Error("invalid outputId");
    if (!this.root) throw new Error("output archive is not initialized");
    return path.join(this.root, `${outputId}.meta.json`);
  }

  async writeMetadata(outputId: string, metadata: ArchiveMetadata): Promise<void> {
    const file = await open(
      this.metadataPath(outputId),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await file.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
  }

  private async readMetadata(outputId: string): Promise<ArchiveMetadata> {
    const file = this.metadataPath(outputId);
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("outputId is unknown or expired");
      }
      throw err;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4096) throw new Error("invalid output archive metadata");
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Number.isSafeInteger((parsed as Record<string, unknown>).stdoutBytes) ||
        !Number.isSafeInteger((parsed as Record<string, unknown>).stderrBytes) ||
        !Number.isSafeInteger((parsed as Record<string, unknown>).stdoutArchivedBytes) ||
        !Number.isSafeInteger((parsed as Record<string, unknown>).stderrArchivedBytes) ||
        !["complete", "truncated"].includes(
          String((parsed as Record<string, unknown>).archiveStatus),
        ) ||
        ((parsed as Record<string, unknown>).archiveError !== undefined &&
          typeof (parsed as Record<string, unknown>).archiveError !== "string")
      ) {
        throw new Error("invalid output archive metadata");
      }
      const metadata = parsed as ArchiveMetadata;
      if (
        metadata.stdoutBytes < metadata.stdoutArchivedBytes ||
        metadata.stderrBytes < metadata.stderrArchivedBytes ||
        metadata.stdoutArchivedBytes < 0 ||
        metadata.stderrArchivedBytes < 0
      ) {
        throw new Error("invalid output archive byte counts");
      }
      return metadata;
    } finally {
      await handle.close();
    }
  }

  private async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = (async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const info = await lstat(this.directory);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new Error("output archive directory must be a real directory, not a symlink");
        }
        await chmod(this.directory, 0o700);
        this.root = await realpath(this.directory);
        const now = Date.now();
        let used = 0;
        for (const entry of await readdir(this.root, { withFileTypes: true })) {
          if (!/^[0-9a-f-]{36}\.(stdout|stderr|meta\.json)$/i.test(entry.name)) continue;
          const file = path.join(this.root, entry.name);
          const stat = await lstat(file);
          if (stat.isSymbolicLink() || !stat.isFile()) continue;
          if (now - stat.mtimeMs > this.retentionMs) {
            await rm(file, { force: true });
          } else if (/\.(stdout|stderr)$/i.test(entry.name)) {
            used += stat.size;
          }
        }
        this.used = used;
        this.lastCleanupAt = now;
      })();
    }
    await this.initialization;
  }

  async createCapture(): Promise<OutputCapture> {
    await this.initialize();
    await this.cleanupExpired();
    const outputId = randomUUID();
    const paths = {
      stdout: this.filePath(outputId, "stdout"),
      stderr: this.filePath(outputId, "stderr"),
    };
    const capture = new FileCapture(this, outputId, paths, this.maxArchiveBytes, this.maxCaptureBytes);
    try {
      await capture.open();
      return capture;
    } catch (err) {
      await capture.finish();
      await Promise.all([
        ...Object.values(paths).map((file) => rm(file, { force: true })),
        rm(this.metadataPath(outputId), { force: true }),
      ]);
      throw err;
    }
  }

  async read(input: OutputReadInput): Promise<OutputReadResult> {
    if (!OUTPUT_ID_PATTERN.test(input.outputId)) throw new Error("invalid outputId");
    if (!STREAMS.includes(input.stream)) throw new Error("invalid output stream");
    if (!Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > MAX_READ_BYTES) {
      throw new Error(`maxBytes must be between 1 and ${MAX_READ_BYTES}`);
    }
    if (
      input.mode === "bytes" &&
      (input.startLine !== undefined || input.maxLines !== undefined)
    ) {
      throw new Error("startLine and maxLines are only valid in lines mode");
    }
    if (input.mode === "lines" && input.offsetBytes !== undefined) {
      throw new Error("offsetBytes is only valid in bytes mode");
    }
    await this.initialize();
    const file = this.filePath(input.outputId, input.stream);
    let info;
    try {
      info = await lstat(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("outputId is unknown or expired");
      }
      throw err;
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("output archive entry is not a regular file");
    const canonicalFile = await realpath(file);
    if (!this.root || path.dirname(canonicalFile) !== this.root) throw new Error("output path escaped archive directory");
    const metadata = await this.readMetadata(input.outputId);
    const archivedBytes =
      input.stream === "stdout" ? metadata.stdoutArchivedBytes : metadata.stderrArchivedBytes;
    if (archivedBytes !== info.size) throw new Error("output archive data does not match its metadata");
    if (input.mode === "bytes") return this.readBytes(input, file, info.size, metadata);
    return this.readLines(input, file, info.size, metadata);
  }

  private async cleanupExpired(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCleanupAt < 60_000 || !this.root) return;
    if (!this.cleaning) {
      this.cleaning = (async () => {
        for (const entry of await readdir(this.root!, { withFileTypes: true })) {
          if (!/^[0-9a-f-]{36}\.(stdout|stderr|meta\.json)$/i.test(entry.name)) continue;
          const file = path.join(this.root!, entry.name);
          const stat = await lstat(file);
          if (stat.isSymbolicLink() || !stat.isFile() || now - stat.mtimeMs <= this.retentionMs) continue;
          await rm(file, { force: true });
          if (/\.(stdout|stderr)$/i.test(entry.name)) this.reserve(-stat.size);
        }
        this.lastCleanupAt = Date.now();
      })();
    }
    try {
      await this.cleaning;
    } finally {
      this.cleaning = undefined;
    }
  }

  private async readBytes(
    input: OutputReadInput,
    file: string,
    fileSize: number,
    metadata: ArchiveMetadata,
  ): Promise<OutputReadResult> {
    const requestedOffset = input.offsetBytes ?? 0;
    if (!Number.isInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > fileSize) {
      throw new Error("offsetBytes is outside the output");
    }
    const start = Math.max(0, requestedOffset - 3);
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const readLength = Math.min(fileSize - start, input.maxBytes + 6);
      const buffer = Buffer.alloc(readLength);
      const { bytesRead } = await handle.read(buffer, 0, readLength, start);
      const data = buffer.subarray(0, bytesRead);
      let actualStart = requestedOffset - start;
      if (actualStart < data.length && (data[actualStart] & 0xc0) === 0x80) {
        actualStart = byteBoundaryStart(data, actualStart);
      }
      let end = Math.min(data.length, actualStart + input.maxBytes);
      while (end < data.length && (data[end] & 0xc0) === 0x80) end += 1;
      const range = data.subarray(actualStart, end);
      const validLength = completeUtf8Prefix(range);
      const contentBytes = range.subarray(0, validLength);
      const decoder = new StringDecoder("utf8");
      const content = decoder.write(contentBytes) + decoder.end();
      const nextOffsetBytes = start + actualStart + contentBytes.length;
      return {
        outputId: input.outputId,
        stream: input.stream,
        mode: "bytes",
        archiveStatus: metadata.archiveStatus,
        ...(metadata.archiveError ? { archiveError: metadata.archiveError } : {}),
        archivedBytes:
          input.stream === "stdout" ? metadata.stdoutArchivedBytes : metadata.stderrArchivedBytes,
        observedBytes: input.stream === "stdout" ? metadata.stdoutBytes : metadata.stderrBytes,
        content,
        offsetBytes: start + actualStart,
        nextOffsetBytes,
        truncated: nextOffsetBytes < fileSize,
      };
    } finally {
      await handle.close();
    }
  }

  private async readLines(
    input: OutputReadInput,
    file: string,
    fileSize: number,
    metadata: ArchiveMetadata,
  ): Promise<OutputReadResult> {
    const startLine = input.startLine ?? 1;
    const maxLines = input.maxLines ?? 100;
    if (!Number.isInteger(startLine) || startLine < 1 || startLine > 1_000_000) {
      throw new Error("startLine must be between 1 and 1000000");
    }
    if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 1000) {
      throw new Error("maxLines must be between 1 and 1000");
    }
    let line = 1;
    let byteOffset = 0;
    let selectedStart = 0;
    let selectionStarted = false;
    let selectedBytes = 0;
    let linesRead = 0;
    let stopped = false;
    const parts: Buffer[] = [];

    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      for await (const chunkValue of handle.createReadStream({ highWaterMark: 4096, autoClose: false })) {
        const chunk = chunkValue as Buffer;
        let cursor = 0;
        while (cursor < chunk.length && !stopped) {
          const newline = chunk.indexOf(0x0a, cursor);
          const segmentEnd = newline < 0 ? chunk.length : newline + 1;
          if (line >= startLine) {
            if (!selectionStarted) {
              selectedStart = byteOffset + cursor;
              selectionStarted = true;
            }
            const segment = chunk.subarray(cursor, segmentEnd);
            let allowed = Math.min(segment.length, Math.max(0, input.maxBytes - selectedBytes));
            while (allowed < segment.length && (segment[allowed] & 0xc0) === 0x80) {
              allowed += 1;
            }
            if (allowed > 0) {
              parts.push(segment.subarray(0, allowed));
              selectedBytes += allowed;
            }
            if (allowed < segment.length) {
              stopped = true;
              break;
            }
            if (newline >= 0) {
              linesRead += 1;
              if (linesRead >= maxLines) stopped = true;
            }
          }
          if (newline >= 0) {
            line += 1;
          } else if (line < startLine) {
            cursor = segmentEnd;
            break;
          }
          cursor = segmentEnd;
        }
        byteOffset += chunk.length;
        if (stopped) break;
      }
    } finally {
      await handle.close();
    }
    if (!selectionStarted && startLine > line) {
      throw new Error("startLine is beyond the archived output");
    }
    if (
      !stopped &&
      selectionStarted &&
      linesRead < maxLines &&
      byteOffset > 0 &&
      line >= startLine
    ) {
      linesRead += 1;
    }

    const raw = Buffer.concat(parts);
    const validLength = completeUtf8Prefix(raw);
    const contentBytes = raw.subarray(0, validLength);
    const decoder = new StringDecoder("utf8");
    const content = decoder.write(contentBytes) + decoder.end();
    const nextOffsetBytes = selectedStart + contentBytes.length;
    return {
      outputId: input.outputId,
      stream: input.stream,
      mode: "lines",
      archiveStatus: metadata.archiveStatus,
      ...(metadata.archiveError ? { archiveError: metadata.archiveError } : {}),
      archivedBytes:
        input.stream === "stdout" ? metadata.stdoutArchivedBytes : metadata.stderrArchivedBytes,
      observedBytes: input.stream === "stdout" ? metadata.stdoutBytes : metadata.stderrBytes,
      content,
      offsetBytes: selectedStart,
      nextOffsetBytes,
      startLine,
      nextLine: startLine + linesRead,
      linesRead,
      truncated: nextOffsetBytes < fileSize,
    };
  }
}

export function createMemoryCapture(
  status: "failed" | "not_configured",
  error?: string,
): OutputCapture {
  return new MemoryCapture(status, error);
}
