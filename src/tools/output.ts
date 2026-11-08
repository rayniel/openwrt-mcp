import { z } from "zod";
import type { OutputReadInput, ToolDef } from "../types.js";

const readOutput: ToolDef = {
  name: "read_command_output",
  description:
    "Read a bounded byte range or line range from output archived locally by this MCP server. Output may contain sensitive router data.",
  schema: z.object({
    outputId: z.string(),
    stream: z.enum(["stdout", "stderr"]),
    mode: z.enum(["bytes", "lines"]).default("bytes"),
    offsetBytes: z.number().int().min(0).optional(),
    startLine: z.number().int().min(1).max(1_000_000).optional(),
    maxBytes: z.number().int().min(1).max(64 * 1024).default(16 * 1024),
    maxLines: z.number().int().min(1).max(1000).optional(),
  }),
  risk: () => "read",
  build: () => ({ commands: [] }),
  parse: () => ({}),
  runLocal: async (input: OutputReadInput, ctx) => {
    if (!ctx.outputArchive) throw new Error("local output archive is not configured");
    if (input.mode === "bytes" && (input.startLine !== undefined || input.maxLines !== undefined)) {
      throw new Error("startLine and maxLines are only valid in lines mode");
    }
    if (input.mode === "lines" && input.offsetBytes !== undefined) {
      throw new Error("offsetBytes is only valid in bytes mode");
    }
    return ctx.outputArchive.read(input);
  },
};

export const outputTools: ToolDef[] = [readOutput];
