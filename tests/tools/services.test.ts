import { describe, it, expect, vi } from "vitest";
import { serviceTools } from "../../src/tools/services.js";
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
const tool = (name: string) => serviceTools.find((t) => t.name === name)!;

describe("service tools", () => {
  it("service_list lists /etc/init.d entries", async () => {
    const c = ctx({ "ls /etc/init.d": "dnsmasq\nfirewall\nnetwork\n" });
    const res = await runTool(tool("service_list"), {}, c);
    expect(res.data).toEqual(["dnsmasq", "firewall", "network"]);
  });

  it("service_control restarts a named service (confirmed, escaped)", async () => {
    const c = ctx();
    await runTool(tool("service_control"), { service: "dnsmasq", action: "restart", confirm: true }, c);
    expect(c.ssh.exec).toHaveBeenCalledWith(router, "/etc/init.d/'dnsmasq' restart", expect.anything());
  });

  it("service_enabled enable runs `enable` (confirmed)", async () => {
    const c = ctx();
    await runTool(tool("service_enabled"), { service: "dnsmasq", enabled: true, confirm: true }, c);
    expect(c.ssh.exec).toHaveBeenCalledWith(router, "/etc/init.d/'dnsmasq' enable", expect.anything());
  });
});
