import { describe, it, expect, vi } from "vitest";
import { logTools } from "../../src/tools/logs.js";
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
const tool = (name: string) => logTools.find((t) => t.name === name)!;

describe("log tools", () => {
  it("log_read tails N lines", async () => {
    const c = ctx({ "logread | tail -n 50": "line1\nline2\n" });
    const res = await runTool(tool("log_read"), { lines: 50 }, c);
    expect((res.data as any).lines).toEqual(["line1", "line2"]);
  });

  it("log_read applies a filter", async () => {
    const c = ctx({ "logread | grep -i 'dnsmasq' | tail -n 100": "dnsmasq: started\n" });
    const res = await runTool(tool("log_read"), { filter: "dnsmasq" }, c);
    expect((res.data as any).lines).toEqual(["dnsmasq: started"]);
  });

  it("dmesg returns kernel log lines", async () => {
    const c = ctx({ "dmesg | tail -n 100": "[ 0.0] boot\n" });
    const res = await runTool(tool("dmesg"), {}, c);
    expect((res.data as any).lines[0]).toContain("boot");
  });
});
