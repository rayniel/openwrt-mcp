import { describe, it, expect, vi } from "vitest";
import { firewallTools } from "../../src/tools/firewall.js";
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
const tool = (name: string) => firewallTools.find((t) => t.name === name)!;

describe("firewall tools", () => {
  it("fw_list returns uci show firewall", async () => {
    const c = ctx({ "uci show firewall": "firewall.@zone[0].name='lan'\n" });
    const res = await runTool(tool("fw_list"), {}, c);
    expect(res.data).toContain("zone[0]");
  });

  it("fw_add_rule is risky and warns about lock-out (unconfirmed)", async () => {
    const c = ctx({ "uci changes": "firewall.cfg99.name='allow-x'\n" });
    const res = await runTool(tool("fw_add_rule"),
      { name: "allow-x", src: "wan", dest_port: "22", target: "ACCEPT", proto: "tcp" }, c);
    expect(res.preview?.risk).toBe("risky");
    expect(res.preview?.warning).toMatch(/sever|lock|access/i);
    expect(c.ssh.exec).toHaveBeenCalledTimes(1);
  });

  it("fw_add_rule creates a rule section and reloads (confirmed)", async () => {
    const c = ctx();
    await runTool(tool("fw_add_rule"),
      { name: "allow-x", src: "wan", dest_port: "22", target: "ACCEPT", proto: "tcp", confirm: true }, c);
    const cmds = (c.ssh.exec as any).mock.calls.map((c2: any[]) => c2[1]).join("\n");
    expect(cmds).toContain("uci add firewall rule");
    expect(cmds).toContain("allow-x");
    expect(cmds).toContain("uci commit firewall");
    expect(cmds).toMatch(/firewall reload|fw3 reload|fw4 reload/);
    // Regression guard: $RULE must be shell-expandable (unquoted), not literal '$RULE' in sq().
    expect(cmds).toMatch(/uci set firewall\.\$RULE\.name='allow-x'/);
    expect(cmds).toMatch(/uci set firewall\.\$RULE\.proto='tcp'/);
    expect(cmds).toMatch(/uci set firewall\.\$RULE\.target='ACCEPT'/);
  });

  it("fw_remove_rule deletes by section name (confirmed)", async () => {
    const c = ctx();
    await runTool(tool("fw_remove_rule"), { section: "cfg99", confirm: true }, c);
    const cmds = (c.ssh.exec as any).mock.calls.map((c2: any[]) => c2[1]).join("\n");
    expect(cmds).toContain("uci delete 'firewall.cfg99'");
  });
});
