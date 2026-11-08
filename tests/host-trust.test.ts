import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HostTrustStore } from "../src/host-trust.js";
import { captureHostFingerprint, registerFingerprint } from "../src/trust-cli.js";
import type { RouterConfig } from "../src/types.js";
import { EventEmitter } from "node:events";

const router: RouterConfig = {
  name: "test-router",
  host: "127.0.0.1",
  port: 22022,
  username: "root",
  auth: { type: "password", password: "must-not-be-used-by-probe" },
  readonly: false,
  default: true,
};
const firstFingerprint = `SHA256:${"A".repeat(43)}`;
const changedFingerprint = `SHA256:${"B".repeat(43)}`;
const tempDirs: string[] = [];

async function store(): Promise<HostTrustStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "openwrt-mcp-trust-"));
  tempDirs.push(dir);
  return new HostTrustStore(path.join(dir, "config", "trusted-hosts.json"));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("HostTrustStore", () => {
  it("stores a first-use fingerprint locally and requires explicit approval for changes", async () => {
    const trust = await store();
    const confirmFirst = vi.fn(async () => true);
    await expect(registerFingerprint(router, firstFingerprint, trust, confirmFirst)).resolves.toBe("trusted");
    await expect(trust.get(router)).resolves.toEqual({ fingerprint: firstFingerprint });

    const confirmAgain = vi.fn(async () => true);
    await expect(registerFingerprint(router, firstFingerprint, trust, confirmAgain)).resolves.toBe(
      "already_trusted",
    );
    expect(confirmAgain).not.toHaveBeenCalled();

    const rejectChange = vi.fn(async () => false);
    await expect(registerFingerprint(router, changedFingerprint, trust, rejectChange)).rejects.toThrow(
      /not changed/,
    );
    await expect(trust.get(router)).resolves.toEqual({ fingerprint: firstFingerprint });

    await registerFingerprint(router, changedFingerprint, trust, async () => true);
    await expect(trust.get(router)).resolves.toEqual({ fingerprint: changedFingerprint });
  });

  it("requires re-trust when the configured endpoint changes", async () => {
    const trust = await store();
    await trust.trust(router, firstFingerprint);
    await expect(trust.get({ ...router, port: router.port + 1 })).resolves.toMatchObject({
      reason: expect.stringMatching(/endpoint changed/),
    });
  });

  it("captures a remote fingerprint without authenticating", async () => {
    let options: any;
    const createClient = () => {
      const client: any = new EventEmitter();
      client.end = vi.fn();
      client.connect = (opts: any) => {
        options = opts;
        queueMicrotask(() => {
          opts.hostVerifier(firstFingerprint, (verified: boolean) => {
            expect(verified).toBe(false);
            client.emit("error", new Error("host-key probe stopped before authentication"));
          });
        });
      };
      return client;
    };
    await expect(captureHostFingerprint(router, createClient)).resolves.toBe(firstFingerprint);
    expect(options).not.toHaveProperty("password");
    expect(options.hostHash).toBe("sha256");
  });
});
