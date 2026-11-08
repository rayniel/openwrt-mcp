import { z } from "zod";
import type { ToolDef, CommandResult } from "../types.js";

const timeoutSchema = z
  .number()
  .int()
  .min(1000)
  .max(600000)
  .optional()
  .describe("Execution timeout in milliseconds (1,000 to 600,000; default 30,000).");

const runCommand: ToolDef = {
  name: "run_command",
  description: "Run one arbitrary shell command on the router. Risky escape hatch.",
  schema: z.object({ command: z.string(), timeoutMs: timeoutSchema }),
  risk: () => "risky",
  build: (i: { command: string }) => ({
    commands: [i.command],
    warning:
      "This runs an arbitrary/raw command on the router. Review the exact command above before confirming.",
  }),
  parse: (o: CommandResult[]) => o[0],
};

const runScript: ToolDef = {
  name: "run_script",
  description:
    "Run a multi-line BusyBox sh script sent over SSH stdin. Raw shell execution is risky; separate calls do not retain shell state.",
  schema: z.object({
    script: z.string().min(1).max(65536),
    timeoutMs: timeoutSchema,
  }),
  risk: () => "risky",
  build: (i: { script: string }) => ({
    commands: ["sh -s"],
    stdin: i.script,
    warning:
      "This runs an arbitrary/raw shell script through sh -s on the router. Review the exact script below before confirming.\n\n" +
      i.script,
  }),
  parse: (o: CommandResult[]) => o[0],
};

export const shellTools: ToolDef[] = [runCommand, runScript];
