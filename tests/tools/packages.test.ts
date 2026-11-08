import { describe, it, expect, vi } from "vitest";
import { packageTools } from "../../src/tools/packages.js";
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
const tool = (name: string) => packageTools.find((t) => t.name === name)!;

describe("opkg tools", () => {
  it("opkg_list_installed parses name - version pairs", async () => {
    const c = ctx({ "opkg list-installed": "luci - 23.05\ndnsmasq - 2.90-7\n" });
    const res = await runTool(tool("opkg_list_installed"), {}, c);
    expect(res.data).toEqual([
      { name: "luci", version: "23.05" },
      { name: "dnsmasq", version: "2.90-7" },
    ]);
  });

  it("opkg_install is mutate; escapes the package name (confirmed)", async () => {
    const c = ctx();
    await runTool(tool("opkg_install"), { package: "tcpdump", confirm: true }, c);
    expect(c.ssh.exec).toHaveBeenCalledWith(router, "opkg install 'tcpdump'", expect.anything());
  });

  it("opkg_install unconfirmed returns a preview (no install runs)", async () => {
    const c = ctx();
    const res = await runTool(tool("opkg_install"), { package: "tcpdump" }, c);
    expect(res.preview?.commands).toEqual(["opkg install 'tcpdump'"]);
    expect(c.ssh.exec).not.toHaveBeenCalled();
  });
});
