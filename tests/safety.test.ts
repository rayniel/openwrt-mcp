import { describe, it, expect, vi } from "vitest";
import { runTool } from "../src/safety.js";
import type { ToolDef, ToolContext, RouterConfig, CommandResult } from "../src/types.js";

const router: RouterConfig = {
  name: "home", host: "h", port: 22, username: "root",
  auth: { type: "password", password: "x" }, readonly: false, default: true,
};

function ctxWith(execImpl: (r: RouterConfig, c: string) => Promise<CommandResult>): ToolContext {
  return { ssh: { exec: vi.fn(execImpl) }, resolveRouter: () => router };
}
const result = (
  stdout: string,
  stderr = "",
  code: number | null = 0,
  status: CommandResult["status"] = "completed",
): CommandResult => ({
  stdout, stderr, code, signal: null, durationMs: 1, status,
  dispatchState: status === "completed" ? "dispatched" : "not_dispatched",
  stdoutBytes: Buffer.byteLength(stdout),
  stderrBytes: Buffer.byteLength(stderr),
  stdoutTruncated: false,
  stderrTruncated: false,
  outputPartial: false,
  archiveStatus: "not_configured",
});
const ok = (stdout: string): CommandResult => result(stdout);

const readTool: ToolDef = {
  name: "r", description: "", schema: {} as any,
  risk: () => "read",
  build: () => ({ commands: ["echo hi"] }),
  parse: (o) => ({ out: o[0].stdout.trim() }),
};

const mutateTool: ToolDef = {
  name: "m", description: "", schema: {} as any,
  risk: () => "mutate",
  build: () => ({ commands: ["uci set foo=bar"] }),
  parse: () => ({ done: true }),
  previewCommands: () => ["uci changes"],
  previewParse: (o) => o[0].stdout,
};

describe("runTool", () => {
  it("read tool executes and parses immediately", async () => {
    const ctx = ctxWith(async () => ok("hi"));
    const res = await runTool(readTool, {}, ctx);
    expect(res).toMatchObject({ ok: true, data: { out: "hi" } });
    expect(res.execution?.steps[0]).toMatchObject({ command: "echo hi", code: 0 });
    expect(res.execution?.steps[0]).not.toHaveProperty("stdout");
    expect(res.execution?.steps[0]).not.toHaveProperty("stderr");
  });

  it("unconfirmed mutate returns a preview and does NOT run build commands", async () => {
    const exec = vi.fn(async () => ok("network.lan.proto='dhcp'"));
    const ctx: ToolContext = { ssh: { exec }, resolveRouter: () => router };
    const res = await runTool(mutateTool, { confirm: false }, ctx);
    expect(res.ok).toBe(true);
    expect(res.preview?.commands).toEqual(["uci set foo=bar"]);
    expect(res.preview?.diff).toContain("network.lan.proto");
    expect(exec).toHaveBeenCalledTimes(1); // only the preview command
    expect(exec).toHaveBeenCalledWith(router, "uci changes", expect.anything());
  });

  it("confirmed mutate executes build commands", async () => {
    const exec = vi.fn(async () => ok(""));
    const ctx: ToolContext = { ssh: { exec }, resolveRouter: () => router };
    const res = await runTool(mutateTool, { confirm: true }, ctx);
    expect(res).toMatchObject({ ok: true, data: { done: true } });
    expect(exec).toHaveBeenCalledWith(router, "uci set foo=bar", expect.anything());
  });

  it("readonly router blocks confirmed mutation", async () => {
    const ro = { ...router, readonly: true };
    const ctx: ToolContext = { ssh: { exec: vi.fn(async () => ok("")) }, resolveRouter: () => ro };
    const res = await runTool(mutateTool, { confirm: true }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/readonly/i);
  });

  it("non-zero exit code becomes a structured error", async () => {
    const ctx = ctxWith(async () => result("useful stdout", "boom", 1));
    const res = await runTool(readTool, {}, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exit code 1/);
    expect(res).not.toHaveProperty("data");
    expect(res.execution?.steps[0]).toMatchObject({
      stdout: "useful stdout",
      stderr: "boom",
      code: 1,
      status: "completed",
    });
  });

  it("connection failure becomes a structured result", async () => {
    const ctx = ctxWith(async () => result("", "", null, "connection_error"));
    const res = await runTool(readTool, {}, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/connection error/);
    expect(res).not.toHaveProperty("data");
    expect(res.execution?.steps[0].code).toBeNull();
  });

  it("stops a command sequence and reports later commands as not executed", async () => {
    const multi: ToolDef = {
      ...readTool,
      build: () => ({ commands: ["first", "stop here", "not sent"] }),
    };
    const exec = vi.fn()
      .mockResolvedValueOnce(result("first output"))
      .mockResolvedValueOnce(result("failure output", "bad", 7));
    const res = await runTool(multi, {}, { ssh: { exec }, resolveRouter: () => router });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(res).not.toHaveProperty("data");
    expect(res.execution?.steps).toHaveLength(3);
    expect(res.execution?.steps[0]).toMatchObject({ stdout: "first output", code: 0 });
    expect(res.execution?.steps[1]).toMatchObject({ stdout: "failure output", stderr: "bad", code: 7 });
    expect(res.execution?.steps[2]).toMatchObject({
      command: "not sent",
      status: "not_executed",
      dispatchState: "not_dispatched",
    });
  });

  it("risky preview includes the warning from build()", async () => {
    const riskyTool: ToolDef = {
      name: "x", description: "", schema: {} as any,
      risk: () => "risky",
      build: () => ({ commands: ["reboot"], warning: "router will reboot" }),
      parse: () => ({ ok: true }),
    };
    const ctx = ctxWith(async () => ok(""));
    const res = await runTool(riskyTool, {}, ctx);
    expect(res.preview?.warning).toBe("router will reboot");
    expect(res.preview?.risk).toBe("risky");
  });
});
