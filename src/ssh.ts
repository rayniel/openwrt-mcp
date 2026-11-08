import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Client } from "ssh2";
import type {
  CommandResult,
  HostTrust,
  OutputArchive,
  OutputCapture,
  RouterConfig,
  SshExecutor,
} from "./types.js";
import { createMemoryCapture } from "./output-store.js";
import { normalizeFingerprint } from "./host-trust.js";

// Minimal surface of ssh2.Client that we depend on (keeps tests honest).
export interface SshClientLike {
  on(event: string, cb: (...args: any[]) => void): unknown;
  connect(opts: Record<string, unknown>): void;
  exec(command: string, cb: (err: Error | undefined, stream: any) => void): void;
  end(): void;
}

export interface SshDeps {
  connect?: () => SshClientLike;
  outputArchive?: OutputArchive;
  hostTrust?: HostTrust;
}

interface SshFailure extends Error {
  status: CommandResult["status"];
}

interface PooledClient {
  client: SshClientLike;
  key: string;
  fingerprint: string;
  ready: boolean;
  closed: boolean;
  hostKeyMismatch: boolean;
  connecting: Promise<PooledClient>;
  disconnectHandlers: Set<(message: string) => void>;
}

interface AttemptResult {
  status: CommandResult["status"];
  code: number | null;
  signal: string | null;
  dispatchState: CommandResult["dispatchState"];
  error?: string;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace(/^~/, homedir()) : p;
}

function connectOptions(router: RouterConfig): Record<string, unknown> {
  const base = {
    host: router.host,
    port: router.port,
    username: router.username,
    readyTimeout: 20000,
    hostHash: "sha256",
  };
  if (router.auth.type === "password") return { ...base, password: router.auth.password };
  return {
    ...base,
    privateKey: readFileSync(expandHome(router.auth.privateKeyPath)),
    passphrase: router.auth.passphrase,
  };
}

function errorStatus(err: Error, hostKeyMismatch: boolean): CommandResult["status"] {
  if (hostKeyMismatch || /host key|host.*verif/i.test(err.message)) return "host_key_mismatch";
  if (
    (err as Error & { level?: string }).level === "client-authentication" ||
    /authentication failed|all configured authentication methods failed/i.test(err.message)
  ) {
    return "authentication_error";
  }
  return "connection_error";
}

function connectionKey(router: RouterConfig): string {
  const auth = createHash("sha256").update(JSON.stringify(router.auth)).digest("hex");
  return JSON.stringify([router.name, router.host, router.port, router.username, auth]);
}

function failureResult(
  status: CommandResult["status"],
  message: string,
  dispatchState: CommandResult["dispatchState"] = "not_dispatched",
): AttemptResult {
  return { status, code: null, signal: null, dispatchState, error: message };
}

export function createSshExecutor(deps: SshDeps = {}): SshExecutor {
  const makeClient = deps.connect ?? (() => new Client() as unknown as SshClientLike);
  const clients = new Map<string, PooledClient>();

  const closePoolEntry = (entry: PooledClient, message: string) => {
    if (entry.closed) return;
    entry.closed = true;
    if (clients.get(entry.key) === entry) clients.delete(entry.key);
    for (const handler of entry.disconnectHandlers) handler(message);
    entry.disconnectHandlers.clear();
  };

  const acquire = async (
    router: RouterConfig,
    fingerprint: string,
    timeoutMs: number,
  ): Promise<PooledClient> => {
    const key = connectionKey(router);
    const existing = clients.get(key);
    if (existing && !existing.closed && existing.fingerprint === fingerprint) {
      if (existing.ready) return existing;
      return withTimeout(existing.connecting, timeoutMs);
    }
    if (existing && !existing.closed) {
      existing.client.end();
      closePoolEntry(existing, "SSH trust record changed; connection was closed");
    }

    const client = makeClient();
    let resolveConnection!: (value: PooledClient) => void;
    let rejectConnection!: (reason: SshFailure) => void;
    const connecting = new Promise<PooledClient>((resolve, reject) => {
      resolveConnection = resolve;
      rejectConnection = reject;
    });
    const entry: PooledClient = {
      client,
      key,
      fingerprint,
      ready: false,
      closed: false,
      hostKeyMismatch: false,
      connecting,
      disconnectHandlers: new Set(),
    };
    clients.set(key, entry);

    client.on("ready", () => {
      if (entry.closed) return;
      entry.ready = true;
      resolveConnection(entry);
    });
    client.on("error", (err: Error) => {
      if (entry.closed) return;
      if (!entry.ready) {
        const status = errorStatus(err, entry.hostKeyMismatch);
        const message = entry.hostKeyMismatch
          ? `SSH host key mismatch; review it with \`openwrt-mcp trust ${router.name}\``
          : err.message;
        const failure: SshFailure = Object.assign(new Error(message), { status });
        closePoolEntry(entry, message);
        rejectConnection(failure);
      } else {
        closePoolEntry(entry, err.message);
      }
    });
    client.on("close", () => {
      if (entry.closed) return;
      const message = entry.hostKeyMismatch
        ? `SSH host key mismatch; review it with \`openwrt-mcp trust ${router.name}\``
        : "SSH connection closed";
      if (!entry.ready) {
        const status: CommandResult["status"] = entry.hostKeyMismatch
          ? "host_key_mismatch"
          : "connection_error";
        const failure: SshFailure = Object.assign(new Error(message), { status });
        closePoolEntry(entry, message);
        rejectConnection(failure);
      } else {
        closePoolEntry(entry, message);
      }
    });

    try {
      const options = connectOptions(router);
      options.hostVerifier = (keyValue: string | Buffer, callback?: (verified: boolean) => void) => {
        let matches = false;
        try {
          matches = normalizeFingerprint(keyValue) === fingerprint;
        } catch {
          matches = false;
        }
        entry.hostKeyMismatch = !matches;
        if (callback) {
          callback(matches);
          return;
        }
        return matches;
      };
      client.connect(options);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const failure = Object.assign(error, { status: "connection_error" as const });
      closePoolEntry(entry, error.message);
      rejectConnection(failure);
    }
    return withTimeout(connecting, timeoutMs);
  };

  const runAttempt = (
    entry: PooledClient,
    command: string,
    timeoutMs: number,
    stdin: string | undefined,
    capture: OutputCapture,
  ): Promise<AttemptResult> =>
    new Promise((resolve) => {
      let settled = false;
      let stream: any;
      let dispatchState: CommandResult["dispatchState"] = "not_dispatched";
      let signal: string | null = null;
      const discardChannel = (channel: any) => {
        const reportError = (err: unknown) => {
          console.error(
            "SSH channel cleanup failed after execution ended:",
            err instanceof Error ? err.message : String(err),
          );
        };
        try {
          channel.on("error", reportError);
          channel.on("data", () => {});
          channel.stderr.on("error", reportError);
          channel.stderr.on("data", () => {});
          if (typeof channel.resume === "function") channel.resume();
          if (typeof channel.stderr.resume === "function") channel.stderr.resume();
          if (typeof channel.close === "function") channel.close();
        } catch (err) {
          reportError(err);
        }
      };
      const finish = (result: AttemptResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        entry.disconnectHandlers.delete(onDisconnect);
        resolve(result);
        if (result.status !== "completed" && stream) discardChannel(stream);
      };
      const onDisconnect = (message: string) => {
        finish(failureResult("interrupted", message, dispatchState));
      };
      const timer = setTimeout(() => {
        finish(failureResult("timeout", `operation timed out after ${timeoutMs}ms`, dispatchState));
      }, timeoutMs);

      if (entry.closed || !entry.ready) {
        finish(failureResult("connection_error", "SSH connection is no longer available"));
        return;
      }
      entry.disconnectHandlers.add(onDisconnect);
      try {
        dispatchState = "possibly_dispatched";
        entry.client.exec(command, (err, channel) => {
          if (settled) {
            if (channel) discardChannel(channel);
            return;
          }
          if (err) {
            dispatchState = "not_dispatched";
            finish(failureResult("channel_error", err.message));
            return;
          }
          stream = channel;
          dispatchState = "dispatched";
          channel.on("data", (chunk: Buffer) => {
            if (!settled) capture.append("stdout", chunk, channel);
          });
          channel.stderr.on("data", (chunk: Buffer) => {
            if (!settled) capture.append("stderr", chunk, channel.stderr);
          });
          channel.on("exit", (_code: number | undefined, exitSignal: string | undefined) => {
            if (!settled && exitSignal) signal = exitSignal;
          });
          channel.on("close", (code: number | null | undefined, closeSignal?: string) => {
            if (settled) return;
            if (closeSignal) signal = closeSignal;
            finish({
              status: "completed",
              code: typeof code === "number" ? code : null,
              signal,
              dispatchState,
            });
          });
          if (stdin !== undefined) {
            try {
              channel.end(stdin);
            } catch (sendError) {
              finish(
                failureResult(
                  "interrupted",
                  sendError instanceof Error ? `failed to send stdin: ${sendError.message}` : String(sendError),
                  dispatchState,
                ),
              );
            }
          }
        });
      } catch (err) {
        dispatchState = "not_dispatched";
        finish(
          failureResult(
            "channel_error",
            err instanceof Error ? err.message : String(err),
            dispatchState,
          ),
        );
      }
    });

  return {
    async exec(router, command, opts = {}): Promise<CommandResult> {
      const timeoutMs = opts.timeoutMs ?? 30000;
      const startedAt = Date.now();
      let capture: OutputCapture;
      try {
        capture = deps.outputArchive
          ? await deps.outputArchive.createCapture()
          : createMemoryCapture("not_configured");
      } catch (err) {
        capture = createMemoryCapture(
          "failed",
          `output archive setup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      let attemptResult: AttemptResult;
      try {
        if (!deps.hostTrust) {
          attemptResult = failureResult(
            "host_untrusted",
            "local host trust is not configured; run `openwrt-mcp trust <router>` first",
          );
        } else {
          const trust = await deps.hostTrust.get(router);
          if (!trust.fingerprint) {
            attemptResult = failureResult(
              "host_untrusted",
              `${trust.reason ?? "host key has not been trusted"}; run \`openwrt-mcp trust ${JSON.stringify(router.name)}\``,
            );
          } else {
            let retries = 0;
            while (true) {
              const remaining = timeoutMs - (Date.now() - startedAt);
              if (remaining <= 0) {
                attemptResult = failureResult(
                  "timeout",
                  `operation timed out after ${timeoutMs}ms`,
                );
                break;
              }
              let entry: PooledClient;
              try {
                entry = await acquire(router, trust.fingerprint, remaining);
              } catch (err) {
                const failure = err as SshFailure;
                attemptResult = failureResult(
                  failure.status ?? "connection_error",
                  failure.message,
                );
                if (retries === 0 && attemptResult.status === "connection_error") {
                  retries += 1;
                  continue;
                }
                break;
              }
              const remainingForCommand = timeoutMs - (Date.now() - startedAt);
              if (remainingForCommand <= 0) {
                attemptResult = failureResult(
                  "timeout",
                  `operation timed out after ${timeoutMs}ms`,
                );
                break;
              }
              attemptResult = await runAttempt(
                entry,
                command,
                remainingForCommand,
                opts.stdin,
                capture,
              );
              if (
                retries === 0 &&
                attemptResult.dispatchState === "not_dispatched" &&
                (attemptResult.status === "channel_error" ||
                  attemptResult.status === "interrupted")
              ) {
                retries += 1;
                continue;
              }
              break;
            }
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        attemptResult = failureResult(errorStatus(error, false), error.message);
      }

      let output;
      try {
        output = await capture.finish();
      } catch (err) {
        return {
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          outputPartial: true,
          archiveStatus: "failed",
          archiveError: `output archive finalization failed: ${err instanceof Error ? err.message : String(err)}`,
          code: attemptResult.code,
          signal: attemptResult.signal,
          durationMs: Date.now() - startedAt,
          status: attemptResult.status,
          dispatchState: attemptResult.dispatchState,
          ...(attemptResult.error ? { error: attemptResult.error } : {}),
        };
      }
      return {
        ...output,
        code: attemptResult.code,
        signal: attemptResult.signal,
        durationMs: Date.now() - startedAt,
        status: attemptResult.status,
        dispatchState: attemptResult.dispatchState,
        outputPartial:
          (attemptResult.dispatchState !== "not_dispatched" && attemptResult.status !== "completed") ||
          output.archiveStatus === "truncated" ||
          output.archiveStatus === "failed" ||
          output.stdoutTruncated ||
          output.stderrTruncated,
        ...(attemptResult.error ? { error: attemptResult.error } : {}),
      };
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const error = Object.assign(new Error(`connection timed out after ${timeoutMs}ms`), {
            status: "timeout" as const,
          });
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
