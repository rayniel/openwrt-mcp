import { describe, it, expect, vi } from "vitest";
import { uciTools } from "../../src/tools/uci.js";
import { runTool } from "../../src/safety.js";
import type { ToolContext, RouterConfig, CommandResult } from "../../src/types.js";

const router: RouterConfig = {
  name: "home", host: "h", port: 22, username: "root",
  auth: { type: "password", password: "x" }, readonly: false, default: true,
};
const ok = (s: string): CommandResult => ({
  stdout: s, stderr: "", code: 0, signal: null, durationMs: 1,
  status: "completed", dispatchState: "dispatched",
  stdoutBytes: Buffer.byteLength(s), stderrBytes: 0,
  stdoutTruncated: false, stderrTruncated: false, outputPartial: false,
  archiveStatus: "not_configured",
});
function ctx(map: Record<string, string> = {}): ToolContext {
  return { ssh: { exec: vi.fn(async (_r, cmd: string) => ok(map[cmd] ?? "")) }, resolveRouter: () => router };
}
const tool = (name: string) => uciTools.find((t) => t.name === name)!;

describe("uci tools", () => {
  it("uci_get builds an escaped command and returns the value", async () => {
    const c = ctx({ "uci -q get 'network.lan.proto'": "static\n" });
    const res = await runTool(tool("uci_get"), { key: "network.lan.proto" }, c);
    expect(res.data).toEqual({ key: "network.lan.proto", value: "static" });
  });

  it("uci_set is mutate; unconfirmed returns preview with uci changes diff", async () => {
    const c = ctx({ "uci changes": "network.lan.proto='dhcp'\n" });
    const res = await runTool(tool("uci_set"), { key: "network.lan.proto", value: "dhcp" }, c);
    expect(res.preview?.risk).toBe("mutate");
    expect(res.preview?.commands).toEqual(["uci set 'network.lan.proto'='dhcp'"]);
    expect(res.preview?.diff).toContain("network.lan.proto");
    expect(c.ssh.exec).toHaveBeenCalledTimes(1); // only `uci changes`
  });

  it("uci_set executes when confirmed", async () => {
    const c = ctx();
    const res = await runTool(tool("uci_set"), { key: "network.lan.proto", value: "dhcp", confirm: true }, c);
    expect(res.ok).toBe(true);
    expect(c.ssh.exec).toHaveBeenCalledWith(router, "uci set 'network.lan.proto'='dhcp'", expect.anything());
  });

  it("uci_commit on network is risky", async () => {
    const c = ctx({ "uci changes": "" });
    const res = await runTool(tool("uci_commit"), { config: "network" }, c);
    expect(res.preview?.risk).toBe("risky");
    expect(res.preview?.warning).toMatch(/network|firewall|lock/i);
  });

  it("uci_commit on dhcp is mutate (not risky)", async () => {
    const c = ctx({ "uci changes": "" });
    const res = await runTool(tool("uci_commit"), { config: "dhcp" }, c);
    expect(res.preview?.risk).toBe("mutate");
  });

  it("rejects shell-injection in keys via escaping", async () => {
    const c = ctx();
    await runTool(tool("uci_set"), { key: "network.lan.proto", value: "a'; reboot; '", confirm: true }, c);
    const call = (c.ssh.exec as any).mock.calls[0][1] as string;
    expect(call).toContain("'a'\\''; reboot; '\\'''"); // single quotes escaped, no break-out
  });
});
