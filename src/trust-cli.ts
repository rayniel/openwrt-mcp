import { Client } from "ssh2";
import { createInterface } from "node:readline/promises";
import { normalizeFingerprint, HostTrustStore, type TrustedHost } from "./host-trust.js";
import type { RouterConfig } from "./types.js";

interface HostProbeClient {
  on(event: string, callback: (...args: any[]) => void): unknown;
  connect(options: Record<string, unknown>): void;
  end(): void;
}

export interface TrustCliDeps {
  createClient?: () => HostProbeClient;
  confirm?: (question: string) => Promise<boolean>;
  print?: (message: string) => void;
}

export async function captureHostFingerprint(
  router: RouterConfig,
  createClient: () => HostProbeClient = () => new Client() as unknown as HostProbeClient,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const client = createClient();
    let fingerprint: string | undefined;
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      if (fingerprint) resolve(fingerprint);
      else reject(err ?? new Error("could not read SSH host fingerprint"));
    };
    const timer = setTimeout(() => finish(new Error("timed out while reading SSH host key")), 15000);
    client.on("error", (err: Error) => finish(err));
    client.on("close", () => finish());
    client.on("ready", () => finish(new Error("host-key probe unexpectedly authenticated")));
    client.connect({
      host: router.host,
      port: router.port,
      username: "openwrt-mcp-trust-probe",
      readyTimeout: 10000,
      hostHash: "sha256",
      hostVerifier: (key: string | Buffer, callback?: (verified: boolean) => void) => {
        try {
          fingerprint = normalizeFingerprint(key);
          if (callback) {
            callback(false);
            return;
          }
          return false;
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
          if (callback) callback(false);
          return false;
        }
      },
    });
  });
}

export async function registerFingerprint(
  router: RouterConfig,
  fingerprint: string,
  store: HostTrustStore,
  confirm: (previous: TrustedHost | undefined) => Promise<boolean>,
): Promise<"already_trusted" | "trusted"> {
  const normalized = normalizeFingerprint(fingerprint);
  const previous = await store.getEntry(router.name);
  if (
    previous?.host === router.host &&
    previous.port === router.port &&
    previous.fingerprint === normalized
  ) {
    return "already_trusted";
  }
  if (!(await confirm(previous))) throw new Error("host key trust was not changed");
  await store.trust(router, normalized);
  return "trusted";
}

export async function runTrustCommand(
  router: RouterConfig,
  store: HostTrustStore,
  deps: TrustCliDeps = {},
): Promise<void> {
  const print = deps.print ?? ((message: string) => process.stdout.write(`${message}\n`));
  const confirm =
    deps.confirm ??
    (async (question: string) => {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await readline.question(`${question} [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        readline.close();
      }
    });

  print(`Checking SSH host key for router '${router.name}' at ${router.host}:${router.port}...`);
  const fingerprint = await captureHostFingerprint(router, deps.createClient);
  print(`Observed fingerprint: ${fingerprint}`);
  const previous = await store.getEntry(router.name);
  if (
    previous?.host === router.host &&
    previous.port === router.port &&
    previous.fingerprint === fingerprint
  ) {
    print("This host key is already trusted; no change made.");
    return;
  }
  print(
    previous
      ? `Current trust: ${previous.host}:${previous.port} ${previous.fingerprint}`
      : "First-use trust (TOFU) does not prove this is the intended device.",
  );
  print("For best protection, compare the fingerprint with a trusted local/serial-console source.");
  const result = await registerFingerprint(router, fingerprint, store, () =>
    confirm("Trust this fingerprint for this router?"),
  );
  print(result === "trusted" ? "Host key trust saved locally." : "Host key was already trusted.");
}
