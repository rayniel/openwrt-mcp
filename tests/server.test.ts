import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildServer } from "../src/server.js";
import { allTools } from "../src/tools/index.js";
import { shellTools } from "../src/tools/shell.js";
import type { ToolContext, ToolDef, RouterConfig, CommandResult } from "../src/types.js";

const router: RouterConfig = {
  name: "home", host: "h", port: 22, username: "root",
  auth: { type: "password", password: "x" }, readonly: false, default: true,
};

describe("allTools registry", () => {
  it("contains all categories with unique names", () => {
    const names = allTools.map((t) => t.name);
    expect(names).toContain("system_info");
    expect(names).toContain("uci_set");
    expect(names).toContain("run_command");
    expect(names).toContain("run_script");
    expect(names).toContain("read_command_output");
    expect(new Set(names).size).toBe(names.length); // no duplicates
    expect(names.length).toBeGreaterThanOrEqual(24);
  });
});

describe("buildServer", () => {
  it("registers a tool per definition without throwing", () => {
    const ctx: ToolContext = {
      ssh: {
        exec: vi.fn(async (): Promise<CommandResult> => ({
          stdout: "", stderr: "", code: 0, signal: null, durationMs: 1,
          status: "completed", dispatchState: "dispatched",
          stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
          outputPartial: false,
          archiveStatus: "not_configured",
        })),
      },
      resolveRouter: () => router,
    };
    const server = buildServer(ctx);
    expect(server).toBeDefined();
  });

  describe.each(["run_command", "run_script"])("%s JSON output contract", (name) => {
    it.each(["success", "nonzero", "timeout", "archive_failure", "truncated"])(
      "serializes stdout and stderr only once for %s",
      async (outcome) => {
        const stdout = `stdout-single-copy:${"a".repeat(6000)}`;
        const stderr = `stderr-single-copy:${"b".repeat(6000)}`;
        const result: CommandResult = {
          stdout,
          stderr,
          code: outcome === "timeout" ? null : outcome === "nonzero" ? 7 : 0,
          signal: null,
          durationMs: 1,
          status: outcome === "timeout" ? "timeout" : "completed",
          dispatchState: "dispatched",
          stdoutBytes: outcome === "truncated" ? 12000 : Buffer.byteLength(stdout),
          stderrBytes: outcome === "truncated" ? 12000 : Buffer.byteLength(stderr),
          stdoutTruncated: outcome === "truncated",
          stderrTruncated: outcome === "truncated",
          outputPartial: outcome === "timeout" || outcome === "truncated" || outcome === "archive_failure",
          archiveStatus: outcome === "archive_failure" ? "failed" : "complete",
          ...(outcome === "archive_failure" ? { archiveError: "disk full" } : {
            outputId: "12345678-1234-4123-8123-123456789abc",
          }),
        };
        const ctx: ToolContext = {
          ssh: { exec: vi.fn(async () => result) },
          resolveRouter: () => router,
        };
        const server = buildServer(ctx, shellTools);
        const client = new Client({ name: "output-contract-test", version: "1.0.0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        try {
          await server.connect(serverTransport);
          await client.connect(clientTransport);
          const response = CallToolResultSchema.parse(await client.callTool({
            name,
            arguments: {
              ...(name === "run_command" ? { command: "diagnose" } : { script: "diagnose\n" }),
              confirm: true,
            },
          }));
          expect(response.isError).toBe(outcome !== "success");
          expect(response.content).toHaveLength(1);
          const content = response.content[0];
          if (content.type !== "text") throw new Error("expected a JSON text response");
          const json = content.text;
          const parsed = JSON.parse(json);
          expect(json.split(stdout)).toHaveLength(2);
          expect(json.split(stderr)).toHaveLength(2);
          expect(json.match(/"stdout":/g)).toHaveLength(1);
          expect(json.match(/"stderr":/g)).toHaveLength(1);
          if (outcome === "success") {
            expect(parsed.data).toMatchObject({ stdout, stderr, code: 0 });
            expect(parsed.execution.steps[0]).not.toHaveProperty("stdout");
            expect(parsed.execution.steps[0]).not.toHaveProperty("stderr");
          } else {
            expect(parsed).not.toHaveProperty("data");
            expect(parsed.execution.steps[0]).toMatchObject(result);
          }
        } finally {
          await client.close();
          await server.close();
        }
      },
    );
  });

  it("serializes failed multi-command output once and retains prior and unexecuted steps", async () => {
    const previous: CommandResult = {
      stdout: `previous-output:${"a".repeat(6000)}`,
      stderr: "previous-warning",
      code: 0,
      signal: null,
      durationMs: 1,
      status: "completed",
      dispatchState: "dispatched",
      stdoutBytes: Buffer.byteLength(`previous-output:${"a".repeat(6000)}`),
      stderrBytes: Buffer.byteLength("previous-warning"),
      stdoutTruncated: false,
      stderrTruncated: false,
      outputPartial: false,
      archiveStatus: "complete",
    };
    const failed: CommandResult = {
      ...previous,
      stdout: `failed-output:${"b".repeat(6000)}`,
      stderr: "failed-warning",
      stdoutBytes: Buffer.byteLength(`failed-output:${"b".repeat(6000)}`),
      stderrBytes: Buffer.byteLength("failed-warning"),
      code: 9,
    };
    const exec = vi.fn().mockResolvedValueOnce(previous).mockResolvedValueOnce(failed);
    const parse = vi.fn();
    const tool: ToolDef = {
      name: "sequence_output_test",
      description: "Test sequential execution results",
      schema: z.object({}),
      risk: () => "read",
      build: () => ({ commands: ["first", "fail", "not sent"] }),
      parse,
    };
    const server = buildServer({ ssh: { exec }, resolveRouter: () => router }, [tool]);
    const client = new Client({ name: "sequence-output-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const response = CallToolResultSchema.parse(
        await client.callTool({ name: tool.name, arguments: {} }),
      );
      expect(response.isError).toBe(true);
      const content = response.content[0];
      if (content.type !== "text") throw new Error("expected a JSON text response");
      const json = content.text;
      const parsed = JSON.parse(json);
      expect(parsed).not.toHaveProperty("data");
      expect(parsed.execution.steps).toHaveLength(3);
      expect(parsed.execution.steps[0]).toMatchObject(previous);
      expect(parsed.execution.steps[1]).toMatchObject(failed);
      expect(parsed.execution.steps[2]).toMatchObject({
        command: "not sent",
        status: "not_executed",
        dispatchState: "not_dispatched",
        code: null,
      });
      for (const payload of [previous.stdout, previous.stderr, failed.stdout, failed.stderr]) {
        expect(json.split(payload)).toHaveLength(2);
      }
      expect(exec).toHaveBeenCalledTimes(2);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
