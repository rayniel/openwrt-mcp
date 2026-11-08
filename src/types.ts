export type RiskClass = "read" | "mutate" | "risky";

export type ExecutionStatus =
  | "completed"
  | "connection_error"
  | "authentication_error"
  | "host_untrusted"
  | "host_key_mismatch"
  | "channel_error"
  | "timeout"
  | "interrupted";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  durationMs: number;
  status: ExecutionStatus;
  dispatchState: "not_dispatched" | "possibly_dispatched" | "dispatched";
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputPartial: boolean;
  outputId?: string;
  archiveStatus: "complete" | "truncated" | "failed" | "not_configured";
  archiveError?: string;
  error?: string;
}

export type OutputStreamName = "stdout" | "stderr";

export interface OutputCaptureResult {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputId?: string;
  archiveStatus: CommandResult["archiveStatus"];
  archiveError?: string;
}

export interface OutputCapture {
  append(stream: OutputStreamName, chunk: Buffer, source?: { pause(): void; resume(): void }): void;
  finish(): Promise<OutputCaptureResult>;
}

export interface OutputArchive {
  createCapture(): Promise<OutputCapture>;
  read(input: OutputReadInput): Promise<OutputReadResult>;
}

export interface HostTrust {
  get(router: RouterConfig): Promise<{ fingerprint?: string; reason?: string }>;
}

export interface OutputReadInput {
  outputId: string;
  stream: OutputStreamName;
  mode: "bytes" | "lines";
  offsetBytes?: number;
  startLine?: number;
  maxBytes: number;
  maxLines?: number;
}

export interface OutputReadResult {
  outputId: string;
  stream: OutputStreamName;
  mode: "bytes" | "lines";
  archiveStatus: "complete" | "truncated";
  archiveError?: string;
  archivedBytes: number;
  observedBytes: number;
  content: string;
  offsetBytes: number;
  nextOffsetBytes: number;
  startLine?: number;
  nextLine?: number;
  linesRead?: number;
  truncated: boolean;
}

export type AuthConfig =
  | { type: "key"; privateKeyPath: string; passphrase?: string }
  | { type: "password"; password: string };

export interface RouterConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthConfig;
  readonly: boolean;
  default: boolean;
}

// The only network boundary. Mocked in every tool test.
export interface SshExecutor {
  exec(
    router: RouterConfig,
    command: string,
    opts?: { timeoutMs?: number; stdin?: string }
  ): Promise<CommandResult>;
}

export interface ToolContext {
  ssh: SshExecutor;
  resolveRouter(name?: string): RouterConfig;
  outputArchive?: OutputArchive;
}

// A single declarative tool definition. The runner (safety.ts) interprets it.
export interface ToolDef<I = any> {
  name: string;
  description: string;
  // zod schema for the tool's own params (NOT including confirm/router, which the runner adds)
  schema: import("zod").ZodType<I>;
  // per-command SSH timeout override in milliseconds (defaults to 30000)
  timeoutMs?: number;
  // risk is a function because e.g. uci_commit is "risky" for network/firewall, else "mutate"
  risk(input: I): RiskClass;
  // shell commands to execute (in order) when running/confirming
  build(input: I): { commands: string[]; stdin?: string; warning?: string };
  runLocal?(input: I, ctx: ToolContext): Promise<unknown>;
  // parse raw command outputs into the structured tool result
  parse(outputs: CommandResult[], input: I): unknown;
  // OPTIONAL: read-only commands run during an unconfirmed preview (e.g. `uci changes`)
  previewCommands?(input: I): string[];
  // OPTIONAL: turn preview command outputs into human-readable diff text
  previewParse?(outputs: CommandResult[], input: I): string;
}
