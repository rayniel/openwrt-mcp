import type { ToolDef, ToolContext, CommandResult, RiskClass } from "./types.js";

export interface RunInput {
  router?: string;
  confirm?: boolean;
  [k: string]: unknown;
}

export interface RunResult {
  ok: boolean;
  data?: unknown;
  execution?: { steps: (ExecutedStep | Omit<ExecutedStep, "stdout" | "stderr">)[] };
  preview?: { commands: string[]; diff?: string; warning?: string; risk: RiskClass };
  error?: string;
}

interface ExecutedStep extends Omit<CommandResult, "status"> {
  index: number;
  command: string;
  status: CommandResult["status"] | "not_executed";
}

interface ExecutionReport {
  outputs: CommandResult[];
  steps: ExecutedStep[];
  failedIndex?: number;
}

async function execAll(
  ctx: ToolContext,
  router: ReturnType<ToolContext["resolveRouter"]>,
  commands: string[],
  timeoutMs: number = 30000,
  stdin?: string,
): Promise<ExecutionReport> {
  const results: CommandResult[] = [];
  const steps: ExecutedStep[] = [];
  for (let index = 0; index < commands.length; index += 1) {
    const cmd = commands[index];
    const r = await ctx.ssh.exec(router, cmd, {
      timeoutMs,
      ...(index === 0 && stdin !== undefined ? { stdin } : {}),
    });
    results.push(r);
    steps.push({ index, command: cmd, ...r });
    if (r.status !== "completed" || r.code !== 0) {
      for (let skipped = index + 1; skipped < commands.length; skipped += 1) {
        steps.push({
          index: skipped,
          command: commands[skipped],
          stdout: "",
          stderr: "",
          code: null,
          signal: null,
          durationMs: 0,
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          outputPartial: false,
          archiveStatus: "not_configured",
          status: "not_executed",
          dispatchState: "not_dispatched",
          error: "not executed because an earlier step failed",
        });
      }
      return { outputs: results, steps, failedIndex: index };
    }
  }
  return { outputs: results, steps };
}

function failure(report: ExecutionReport): RunResult {
  const failed = report.steps[report.failedIndex ?? 0];
  if (!failed) return { ok: false, error: "execution failed without a command result" };
  const summary =
    failed.status === "completed"
      ? failed.code === null
        ? "command completed without an exit code"
        : `command failed (exit code ${failed.code})`
      : `command ${failed.status.replaceAll("_", " ")}`;
  return {
    ok: false,
    error: `${summary}: ${failed.command}${failed.error ? ` (${failed.error})` : ""}`,
    execution: { steps: report.steps },
  };
}

function incompleteOutput(report: ExecutionReport): RunResult | undefined {
  const failedArchive = report.steps.find((step) => step.archiveStatus === "failed");
  if (failedArchive) {
    return {
      ok: false,
      error: `command completed but output archival failed: ${
        failedArchive.archiveError ?? failedArchive.command
      }`,
      execution: { steps: report.steps },
    };
  }
  const truncated = report.steps.find((step) => step.stdoutTruncated || step.stderrTruncated);
  if (truncated) {
    return {
      ok: false,
      error: `command output exceeded the in-memory excerpt; retrieve outputId ${
        truncated.outputId ?? "(unavailable)"
      } with read_command_output before interpreting it`,
      execution: { steps: report.steps },
    };
  }
}

function success(def: ToolDef, report: ExecutionReport, input: unknown): RunResult {
  return {
    ok: true,
    data: def.parse(report.outputs, input),
    execution: {
      steps: report.steps.map(({ stdout, stderr, ...metadata }) => metadata),
    },
  };
}

export async function runTool(
  def: ToolDef,
  rawInput: RunInput,
  ctx: ToolContext
): Promise<RunResult> {
  try {
    const { router: routerName, confirm, ...rawParsed } = rawInput;
    const input = (def.schema as any)?.parse ? (def.schema as any).parse(rawParsed) : rawParsed;
    if (def.runLocal) return { ok: true, data: await def.runLocal(input, ctx) };
    const router = ctx.resolveRouter(routerName);
    const risk = def.risk(input);

    const timeoutInput =
      typeof input === "object" && input !== null && "timeoutMs" in input
        ? (input as { timeoutMs?: unknown }).timeoutMs
        : undefined;
    const timeoutMs = typeof timeoutInput === "number" ? timeoutInput : def.timeoutMs ?? 30000;

    if (risk === "read") {
      const built = def.build(input);
      const report = await execAll(ctx, router, built.commands, timeoutMs, built.stdin);
      if (report.failedIndex !== undefined) return failure(report);
      const outputFailure = incompleteOutput(report);
      if (outputFailure) return outputFailure;
      return success(def, report, input);
    }

    // mutate or risky
    if (!confirm) {
      const built = def.build(input);
      let diff: string | undefined;
      if (def.previewCommands) {
        const pcmds = def.previewCommands(input);
        const pout = await execAll(ctx, router, pcmds, timeoutMs);
        if (pout.failedIndex !== undefined) return failure(pout);
        const outputFailure = incompleteOutput(pout);
        if (outputFailure) return outputFailure;
        diff = def.previewParse
          ? def.previewParse(pout.outputs, input)
          : pout.outputs.map((o) => o.stdout).join("\n");
      }
      return { ok: true, preview: { commands: built.commands, diff, warning: built.warning, risk } };
    }

    if (router.readonly) {
      return { ok: false, error: `router '${router.name}' is readonly; mutation blocked` };
    }

    const built = def.build(input);
    const report = await execAll(ctx, router, built.commands, timeoutMs, built.stdin);
    if (report.failedIndex !== undefined) return failure(report);
    const outputFailure = incompleteOutput(report);
    if (outputFailure) return outputFailure;
    return success(def, report, input);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
