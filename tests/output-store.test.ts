import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemoryCapture, LocalOutputArchive } from "../src/output-store.js";

const tempDirs: string[] = [];

async function archive(
  maxArchiveBytes = 1024 * 1024,
  maxCaptureBytes = 1024 * 1024,
): Promise<LocalOutputArchive> {
  const root = await mkdtemp(path.join(tmpdir(), "openwrt-mcp-output-"));
  tempDirs.push(root);
  return new LocalOutputArchive(path.join(root, "outputs"), maxArchiveBytes, maxCaptureBytes);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("LocalOutputArchive", () => {
  it("archives large output and exposes a bounded excerpt and byte reads", async () => {
    const store = await archive();
    const capture = await store.createCapture();
    capture.append("stdout", Buffer.from("a".repeat(12000)));
    const result = await capture.finish();

    expect(result.outputId).toBeTruthy();
    expect(result.stdoutBytes).toBe(12000);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(8192);
    const read = await store.read({
      outputId: result.outputId!,
      stream: "stdout",
      mode: "bytes",
      offsetBytes: 0,
      maxBytes: 32,
    });
    expect(read.content).toBe("a".repeat(32));
    expect(read.truncated).toBe(true);
  });

  it("keeps memory excerpts bounded and makes quota truncation explicit", async () => {
    const store = await archive(1024, 128);
    const capture = await store.createCapture();
    capture.append("stdout", Buffer.alloc(1024 * 1024, 0x78));
    const result = await capture.finish();
    expect(result.stdoutBytes).toBe(1024 * 1024);
    expect(result.stdout.length).toBeLessThanOrEqual(8192);
    expect(result.archiveStatus).toBe("truncated");
    const read = await store.read({
      outputId: result.outputId!,
      stream: "stdout",
      mode: "bytes",
      maxBytes: 1024,
    });
    expect(read.content).toBe("x".repeat(128));
    expect(read.archiveStatus).toBe("truncated");
  });

  it("preserves UTF-8 characters when stream chunks and reads split code points", async () => {
    const store = await archive();
    const capture = await store.createCapture();
    const bytes = Buffer.from("你好🙂", "utf8");
    capture.append("stdout", bytes.subarray(0, 2));
    capture.append("stdout", bytes.subarray(2, 7));
    capture.append("stdout", bytes.subarray(7));
    const result = await capture.finish();

    let offsetBytes = 0;
    let text = "";
    while (offsetBytes < bytes.length) {
      const read = await store.read({
        outputId: result.outputId!,
        stream: "stdout",
        mode: "bytes",
        offsetBytes,
        maxBytes: 2,
      });
      expect(read.nextOffsetBytes).toBeGreaterThan(offsetBytes);
      text += read.content;
      offsetBytes = read.nextOffsetBytes;
    }
    expect(text).toBe("你好🙂");
  });

  it.each(["file", "memory"])(
    "separates non-adjacent UTF-8 excerpts without broken boundary characters in %s captures",
    async (mode) => {
      const omission = "\n[... output omitted ...]\n";
      const headLimit = 4096 - Buffer.byteLength(omission);
      const head = "a".repeat(headLimit - 1);
      const tail = "z".repeat(4095);
      const prefix = head + "🙂" + "b".repeat(4095 - Buffer.byteLength(head + "🙂")) + "🙂";
      const text = prefix + "OMITTED-INTERIOR".repeat(200) + "🙂" + tail;
      const bytes = Buffer.from(text);
      expect(bytes.length).toBeGreaterThan(8192);
      expect(bytes[4096] & 0xc0).toBe(0x80);
      expect(bytes[bytes.length - 4096] & 0xc0).toBe(0x80);

      const store = mode === "file" ? await archive() : undefined;
      const capture = store ? await store.createCapture() : createMemoryCapture("not_configured");
      for (const stream of ["stdout", "stderr"] as const) {
        capture.append(stream, bytes.subarray(0, 4096));
        capture.append(stream, bytes.subarray(4096, bytes.length - 4096));
        capture.append(stream, bytes.subarray(bytes.length - 4096));
      }
      const result = await capture.finish();
      expect(result.stdout).toBe(head + omission + tail);
      expect(result.stderr).toBe(head + omission + tail);
      expect(result.stdout).not.toContain("\uFFFD");
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8192);
      expect(result.stdoutBytes).toBe(bytes.length);
      expect(result.stderrBytes).toBe(bytes.length);
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrTruncated).toBe(true);

      if (store) {
        expect(result.outputId).toBeTruthy();
        for (const stream of ["stdout", "stderr"] as const) {
          let offsetBytes = 0;
          let archivedText = "";
          while (offsetBytes < bytes.length) {
            const read = await store.read({
              outputId: result.outputId!,
              stream,
              mode: "bytes",
              offsetBytes,
              maxBytes: 4096,
            });
            expect(read.nextOffsetBytes).toBeGreaterThan(offsetBytes);
            archivedText += read.content;
            offsetBytes = read.nextOffsetBytes;
          }
          expect(archivedText).toBe(text);
        }
      }
    },
  );

  it("supports bounded line reads and rejects invalid output IDs", async () => {
    const store = await archive();
    const capture = await store.createCapture();
    capture.append("stderr", Buffer.from("first\nsecond\nthird"));
    const result = await capture.finish();
    const read = await store.read({
      outputId: result.outputId!,
      stream: "stderr",
      mode: "lines",
      startLine: 2,
      maxLines: 1,
      maxBytes: 100,
    });
    expect(read.content).toBe("second\n");
    expect(read.linesRead).toBe(1);
    await expect(
      store.read({ outputId: "..\\outside", stream: "stdout", mode: "bytes", maxBytes: 10 }),
    ).rejects.toThrow(/invalid outputId/);
  });

  it("marks quota-limited archives as truncated while retaining readable partial data", async () => {
    const store = await archive(1024, 4);
    const capture = await store.createCapture();
    capture.append("stdout", Buffer.from("abcdef"));
    const result = await capture.finish();
    expect(result.archiveStatus).toBe("truncated");
    expect(result.archiveError).toMatch(/limit/);
    const read = await store.read({
      outputId: result.outputId!,
      stream: "stdout",
      mode: "bytes",
      maxBytes: 16,
    });
    expect(read.content).toBe("abcd");
    expect(read).toMatchObject({
      archiveStatus: "truncated",
      archivedBytes: 4,
      observedBytes: 6,
    });
  });

  it("expires old output files and reports IDs that are no longer available", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openwrt-mcp-expiry-"));
    tempDirs.push(root);
    const directory = path.join(root, "outputs");
    const store = new LocalOutputArchive(directory);
    const capture = await store.createCapture();
    capture.append("stdout", Buffer.from("old"));
    const result = await capture.finish();

    const expiredStore = new LocalOutputArchive(directory, 1024, 1024, -1);
    await expect(
      expiredStore.read({
        outputId: result.outputId!,
        stream: "stdout",
        mode: "bytes",
        maxBytes: 16,
      }),
    ).rejects.toThrow(/unknown or expired/);
  });
});
