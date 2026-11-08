import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { RouterConfig } from "./types.js";

export interface TrustedHost {
  host: string;
  port: number;
  fingerprint: string;
  updatedAt: string;
}

interface TrustDatabase {
  version: 1;
  routers: Record<string, TrustedHost>;
}

function emptyDatabase(): TrustDatabase {
  return { version: 1, routers: Object.create(null) as Record<string, TrustedHost> };
}

export function normalizeFingerprint(value: string | Buffer): string {
  const raw = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const base64 = raw.replace(/^SHA256:/, "").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]{20,50}$/.test(base64)) {
    throw new Error("SSH host key did not produce a valid SHA-256 fingerprint");
  }
  return `SHA256:${base64}`;
}

function isTrustedHost(value: unknown): value is TrustedHost {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.host === "string" &&
    Number.isInteger(entry.port) &&
    typeof entry.fingerprint === "string" &&
    entry.fingerprint.startsWith("SHA256:") &&
    typeof entry.updatedAt === "string"
  );
}

export class HostTrustStore {
  constructor(
    readonly filePath =
      process.env.OPENWRT_MCP_TRUST_FILE ??
      path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
        "openwrt-mcp",
        "trusted-hosts.json",
      ),
  ) {}

  async get(router: RouterConfig): Promise<{ fingerprint?: string; reason?: string }> {
    const entry = (await this.readDatabase()).routers[router.name];
    if (!entry) return { reason: "host key has not been trusted" };
    if (entry.host !== router.host || entry.port !== router.port) {
      return { reason: "router endpoint changed since its host key was trusted" };
    }
    return { fingerprint: entry.fingerprint };
  }

  async getEntry(name: string): Promise<TrustedHost | undefined> {
    return (await this.readDatabase()).routers[name];
  }

  async trust(router: RouterConfig, fingerprint: string): Promise<void> {
    if (!router.name.trim()) throw new Error("router name must not be empty");
    const normalized = normalizeFingerprint(fingerprint);
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new Error("trust directory must be a real directory, not a symlink");
    }
    await chmod(directory, 0o700);
    const canonicalDirectory = await realpath(directory);
    const target = path.join(canonicalDirectory, path.basename(this.filePath));
    const lockPath = `${target}.lock`;
    const createLock = () =>
      open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    let lock: FileHandle;
    try {
      lock = await createLock();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const lockInfo = await lstat(lockPath);
      if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) {
        throw new Error("trust lock is not a regular file");
      }
      if (Date.now() - lockInfo.mtimeMs <= 5 * 60 * 1000) {
        throw new Error("trust database is already being updated");
      }
      await rm(lockPath, { force: true });
      lock = await createLock();
    }
    try {
      await lock.writeFile(`${process.pid} ${Date.now()}\n`, "utf8");
      await lock.sync();
      const current = await this.readDatabaseAt(target);
      current.routers[router.name] = {
        host: router.host,
        port: router.port,
        fingerprint: normalized,
        updatedAt: new Date().toISOString(),
      };
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const file = await open(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        try {
          await file.writeFile(`${JSON.stringify(current, null, 2)}\n`, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, target);
        await chmod(target, 0o600);
      } catch (err) {
        await rm(temporary, { force: true });
        throw err;
      }
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }

  private async readDatabase(): Promise<TrustDatabase> {
    return this.readDatabaseAt(this.filePath);
  }

  private async readDatabaseAt(file: string): Promise<TrustDatabase> {
    let directoryInfo;
    try {
      directoryInfo = await lstat(path.dirname(file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyDatabase();
      throw err;
    }
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new Error("trust directory must be a real directory, not a symlink");
    }
    const target = path.join(await realpath(path.dirname(file)), path.basename(file));
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyDatabase();
      throw err;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new Error("trust database must be a regular file, not a symlink");
      }
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
        await handle.chmod(0o600);
      }
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as Record<string, unknown>).version !== 1 ||
        typeof (parsed as Record<string, unknown>).routers !== "object" ||
        (parsed as Record<string, unknown>).routers === null
      ) {
        throw new Error("trust database has an unsupported or invalid format");
      }
      const routers = (parsed as { routers: Record<string, unknown> }).routers;
      for (const [name, entry] of Object.entries(routers)) {
        if (!name || !isTrustedHost(entry)) throw new Error("trust database contains an invalid entry");
        normalizeFingerprint(entry.fingerprint);
      }
      return {
        version: 1,
        routers: Object.assign(Object.create(null), routers) as Record<string, TrustedHost>,
      };
    } finally {
      await handle.close();
    }
  }
}
