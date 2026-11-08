import { describe, it, expect, vi } from "vitest";
import { systemTools } from "../../src/tools/system.js";
import { runTool } from "../../src/safety.js";
import type { ToolContext, RouterConfig, CommandResult } from "../../src/types.js";

const router: RouterConfig = {
  name: "home", host: "h", port: 22, username: "root",
  auth: { type: "password", password: "x" }, readonly: false, default: true,
};
const ok = (stdout: string): CommandResult => ({
  stdout, stderr: "", code: 0, signal: null, durationMs: 1,
  status: "completed", dispatchState: "dispatched",
  stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0,
  stdoutTruncated: false, stderrTruncated: false, outputPartial: false,
  archiveStatus: "not_configured",
});
function ctx(map: Record<string, string>): ToolContext {
  return {
    ssh: { exec: vi.fn(async (_r, cmd: string) => ok(map[cmd] ?? "")) },
    resolveRouter: () => router,
  };
}
const tool = (name: string) => systemTools.find((t) => t.name === name)!;

describe("system tools", () => {
  it("system_info parses board + release json", async () => {
    const board = JSON.stringify({ model: "GL-MT3000", board_name: "glinet,gl-mt3000" });
    const release = JSON.stringify({ release: { version: "23.05.3", target: "mediatek/filogic" } });
    const c = ctx({
      "ubus call system board": board,
      "cat /etc/os-release | grep -E '^(VERSION|OPENWRT)' || true": "",
    });
    // system_info uses `ubus call system board`
    const res = await runTool(tool("system_info"), {}, c);
    expect(res.ok).toBe(true);
    expect((res.data as any).model).toBe("GL-MT3000");
  });

  it("system_resources parses uptime/load/mem", async () => {
    const board = JSON.stringify({
      uptime: 12345,
      load: [9216, 7680, 6144],
      memory: { total: 256000000, free: 100000000 },
    });
    const c = ctx({ "ubus call system info": board });
    const res = await runTool(tool("system_resources"), {}, c);
    expect((res.data as any).uptimeSeconds).toBe(12345);
    expect((res.data as any).memory.total).toBe(256000000);
  });

  it("reboot is risky and returns a warning preview when unconfirmed", async () => {
    const c = ctx({});
    const res = await runTool(tool("reboot"), {}, c);
    expect(res.preview?.risk).toBe("risky");
    expect(res.preview?.warning).toMatch(/reboot/i);
    expect(c.ssh.exec).not.toHaveBeenCalled();
  });

  it("reboot executes when confirmed", async () => {
    const c = ctx({ reboot: "" });
    const res = await runTool(tool("reboot"), { confirm: true }, c);
    expect(res.ok).toBe(true);
    expect(c.ssh.exec).toHaveBeenCalledWith(router, "reboot", expect.anything());
  });
});
