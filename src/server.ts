import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext, ToolDef } from "./types.js";
import { runTool } from "./safety.js";
import { allTools } from "./tools/index.js";

export function buildServer(ctx: ToolContext, tools: ToolDef[] = allTools): McpServer {
  const server = new McpServer({ name: "openwrt-mcp", version: "0.1.0" });

  for (const def of tools) {
    // The tool's own params, plus the runner-managed router/confirm fields.
    if (!(def.schema instanceof z.ZodObject)) {
      throw new Error(`tool '${def.name}' must use a z.object schema`);
    }
    const base = def.schema.shape;
    let isRead: boolean;
    try {
      isRead = def.risk({} as any) === "read"; // best-effort; risk fns are param-light for read tools
    } catch {
      isRead = false; // fail safe: treat as non-read so confirm IS required
    }
    const shape: Record<string, z.ZodTypeAny> = {
      ...base,
      router: z.string().optional().describe("Target router name (defaults to the configured default)."),
    };
    if (!isRead) {
      shape.confirm = z
        .boolean()
        .optional()
        .describe(
          "Set true to request execution; omit/false for a preview. This parameter is not proof of human approval or SSH host trust.",
        );
    }

    server.tool(def.name, def.description, shape, async (args: Record<string, unknown>) => {
      const result = await runTool(def, args, ctx);
      return {
        isError: !result.ok,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    });
  }

  return server;
}
