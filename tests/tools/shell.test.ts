import { describe, it, expect, vi } from "vitest";
import { shellTools } from "../../src/tools/shell.js";
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
const tool = (name = "run_command") => shellTools.find((t) => t.name === name)!;

describe("run_command", () => {
  it("is risky and previews the exact command unconfirmed", async () => {
    const c = ctx();
    const res = await runTool(tool(), { command: "rm -rf /tmp/x" }, c);
    expect(res.preview?.risk).toBe("risky");
    expect(res.preview?.commands).toEqual(["rm -rf /tmp/x"]);
    expect(res.preview?.warning).toMatch(/arbitrary|raw|review/i);
    expect(c.ssh.exec).not.toHaveBeenCalled();
  });

  it("executes verbatim when confirmed and returns stdout/stderr/code", async () => {
    const c = ctx({ "uname -a": "Linux OpenWrt\n" });
    const res = await runTool(tool(), { command: "uname -a", timeoutMs: 120000, confirm: true }, c);
    expect(res.data).toMatchObject({
      stdout: "Linux OpenWrt\n", stderr: "", code: 0, status: "completed",
    });
    expect(c.ssh.exec).toHaveBeenCalledWith(
      router,
      "uname -a",
      expect.objectContaining({ timeoutMs: 120000 }),
    );
  });

  it("sends a multi-line script unchanged over stdin to sh -s", async () => {
    const c = ctx();
    const script = "cd /tmp\nprintf '%s\\n' 'a b'\n";
    await runTool(tool("run_script"), { script, confirm: true }, c);
    expect(c.ssh.exec).toHaveBeenCalledWith(
      router,
      "sh -s",
      expect.objectContaining({ stdin: script }),
    );
  });

  it("previews the complete script as risky and enforces a bounded timeout", async () => {
    const c = ctx();
    const script = "echo review-me";
    const preview = await runTool(tool("run_script"), { script }, c);
    expect(preview.preview?.risk).toBe("risky");
    expect(preview.preview?.warning).toContain(script);
    expect(c.ssh.exec).not.toHaveBeenCalled();

    const invalid = await runTool(tool(), { command: "true", timeoutMs: 900000 }, c);
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toMatch(/600000/);
  });

  it("does not allow readonly routers to execute raw shell or scripts", async () => {
    const c = ctx();
    c.resolveRouter = () => ({ ...router, readonly: true });
    const command = await runTool(tool(), { command: "true", confirm: true }, c);
    const script = await runTool(tool("run_script"), { script: "true", confirm: true }, c);
    expect(command.ok).toBe(false);
    expect(script.ok).toBe(false);
    expect(c.ssh.exec).not.toHaveBeenCalled();
  });
});
