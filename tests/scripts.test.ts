import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const setupScript = path.resolve("scripts", "setup.mjs");
const setupLauncher = path.resolve("scripts", "setup.sh");
const tunnelScript = path.resolve("scripts", "ssh-tunnel.sh");
const temporary: string[] = [];
const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\sh.exe" : "/bin/sh";

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "openwrt-mcp-scripts-"));
  temporary.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupFixture() {
  const root = await workspace();
  const source = path.join(root, "source with spaces");
  const config = path.join(root, "private", "config.json");
  const key = path.join(root, "device key");
  const trust = path.join(root, "private", "trusted-hosts.json");
  const output = path.join(root, "output");
  const copilotHome = path.join(root, "copilot");
  await mkdir(path.join(source, "dist"), { recursive: true });
  await mkdir(path.join(source, "dist", "tools"));
  await mkdir(copilotHome);
  await writeFile(key, "MOCK PRIVATE KEY");
  await writeFile(path.join(source, "package.json"), '{"name":"openwrt-mcp","type":"module"}');
  await writeFile(path.join(source, "dist", "tools", "index.js"), 'export const allTools = ["run_command","run_script","read_command_output","system_info","dmesg"].map(name=>({name}));');
  await writeFile(path.join(source, "dist", "index.js"), `
if (process.argv[2] === "trust") {
  process.stdout.write(JSON.stringify({args:process.argv.slice(2),config:process.env.OPENWRT_MCP_CONFIG,trust:process.env.OPENWRT_MCP_TRUST_FILE}));
} else {
  process.stdin.pipe(process.stdout);
}
`);
  const common = ["--source", source, "--config", config, "--trust-file", trust, "--output-dir", output];
  const run = (command: string, args: string[] = [], input?: string, env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [setupScript, command, ...common, ...args], {
      encoding: "utf8",
      input,
      timeout: 10000,
      env: { ...process.env, COPILOT_HOME: copilotHome, ...env },
    });
  return { root, source, config, key, trust, output, copilotHome, common, run };
}

async function wizardFixture(answers: string[]) {
  const fixture = await setupFixture();
  const home = path.join(fixture.root, "home");
  await mkdir(home);
  const preload = path.join(fixture.root, "wizard-console.mjs");
  const commands = path.join(fixture.root, "wizard-commands.jsonl");
  await writeFile(preload, `
import childProcess from "node:child_process";
import readline from "node:readline/promises";
import promises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync } from "node:fs";
const answers = JSON.parse(process.env.TEST_WIZARD_ANSWERS);
Object.defineProperty(process.stdin, "isTTY", {value:true});
Object.defineProperty(process.stderr, "isTTY", {value:true});
// Mock Linux prerequisite checks only; no deployment commands run on this host.
Object.defineProperty(process, "platform", {value:"linux"});
os.homedir = () => process.env.TEST_WIZARD_HOME;
const originalStat = promises.lstat;
promises.lstat = async (...args) => {
  const info = await originalStat(...args);
  if (info.isDirectory()) info.mode &= ~0o077;
  return info;
};
readline.createInterface = () => {
  const reader = new EventEmitter();
  reader.question = async (label) => {
    if (!answers.length) throw new Error("test ran out of answers");
    const answer = answers.shift();
    process.stderr.write(label + answer + "\\n");
    if (answer === "__CANCEL__") {
      const error = new Error("cancelled");
      error.name = "AbortError";
      throw error;
    }
    return answer;
  };
  reader.close = () => reader.emit("close");
  return reader;
};
childProcess.spawn = (command, args, options) => {
  const trust = command === process.execPath && args[1] === "trust";
  if (!["npm","copilot"].includes(command) && !trust) throw new Error("unexpected subprocess");
  appendFileSync(process.env.TEST_WIZARD_COMMANDS, JSON.stringify({
    command,args,stdio:options.stdio,
    config:options.env?.OPENWRT_MCP_CONFIG,trust:options.env?.OPENWRT_MCP_TRUST_FILE
  }) + "\\n");
  if (command === "npm" && args[0] === "ci") mkdirSync(path.join(options.cwd, "node_modules"), {mode:0o700});
  const child = new EventEmitter();
  child.kill = () => true;
  queueMicrotask(() => child.emit("exit",
    command === process.env.TEST_WIZARD_FAIL_COMMAND ? 7 :
    trust ? Number(process.env.TEST_WIZARD_TRUST_EXIT ?? 0) : 0, null));
  return child;
};
syncBuiltinESMExports();
`);
  const env = {
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    TEST_WIZARD_ANSWERS: JSON.stringify(answers),
    TEST_WIZARD_COMMANDS: commands,
    TEST_WIZARD_HOME: home,
  };
  const run = (extra: NodeJS.ProcessEnv = {}) => fixture.run("wizard", [], undefined, { ...env, ...extra });
  const recorded = async () => {
    try {
      return (await readFile(commands, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
      throw err;
    }
  };
  return { ...fixture, home, env, runWizard: run, recorded };
}

describe("Host one-command Chinese wizard with local console/subprocess mocks", () => {
  it("rejects non-terminal input rather than consuming MCP protocol stdin", async () => {
    const result = spawnSync(process.execPath, [setupScript], {
      encoding: "utf8", input: '{"jsonrpc":"2.0"}\n', timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("中文向导只用于交互终端");
  });

  it("opens the wizard without any command or arguments and can exit without changes", async () => {
    const fixture = await wizardFixture(["invalid", "0"]);
    const result = spawnSync(process.execPath, [setupScript], {
      encoding: "utf8", timeout: 10000,
      env: {
        ...process.env, ...fixture.env,
        OPENWRT_MCP_CONFIG: fixture.config,
        OPENWRT_MCP_TRUST_FILE: fixture.trust,
        OPENWRT_MCP_OUTPUT_DIR: fixture.output,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("安装与维护向导");
    expect(result.stderr).toContain("输入无效");
    expect(await fixture.recorded()).toEqual([]);
    await expect(lstat(fixture.config)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs with defaults using only an existing key path and leaves trust pending", async () => {
    const fixture = await wizardFixture([]);
    const result = fixture.runWizard({
      TEST_WIZARD_ANSWERS: JSON.stringify(["", "", "", fixture.key, "y", ""]),
    });
    expect(result.status, result.stderr).toBe(0);
    const config = JSON.parse(await readFile(fixture.config, "utf8"));
    expect(config.routers["lab-device"]).toMatchObject({
      host: "127.0.0.1", port: 22022, username: "root", readonly: false,
      auth: { type: "key", privateKeyPath: fixture.key },
    });
    const commands = await fixture.recorded();
    expect(commands.map((call) => [call.command, ...call.args.slice(0, 2)])).toEqual([
      ["npm", "--version"], ["copilot", "--version"], ["npm", "ci"],
      ["npm", "run", "build"], ["copilot", "mcp", "add"],
    ]);
    expect(result.stderr).toContain("尚未确认设备信任");
    expect(result.stderr).not.toContain("即可使用");
  });

  it("suggests a conventional private key but delegates trust to a separate terminal subprocess", async () => {
    const fixture = await wizardFixture(["1", "", "", "", "y", "y"]);
    await mkdir(path.join(fixture.home, ".ssh"));
    const key = path.join(fixture.home, ".ssh", "id_ed25519");
    await writeFile(key, "MOCK PRIVATE KEY NEVER DISPLAY");
    const result = fixture.runWizard();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(fixture.config, "utf8")).routers["lab-device"].auth.privateKeyPath).toBe(key);
    const calls = await fixture.recorded();
    const trust = calls.at(-1);
    expect(trust).toMatchObject({
      command: process.execPath, args: [path.join(fixture.source, "dist", "index.js"), "trust", "lab-device"],
      stdio: "inherit", config: fixture.config, trust: fixture.trust,
    });
    expect(trust.args).not.toContain("--confirm");
    expect(result.stderr).not.toContain("MOCK PRIVATE KEY");
  });

  it("reprompts invalid values and performs no installation if the user declines", async () => {
    const fixture = await wizardFixture([]);
    const result = fixture.runWizard({
      TEST_WIZARD_ANSWERS: JSON.stringify([
        "1", "bad name", "lab", "0", "22023", path.join(fixture.root, "missing key"), fixture.key, "n",
      ]),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("输入无效");
    expect(result.stderr).toContain("未找到该普通文件");
    expect(result.stderr).toContain("已取消");
    expect(await fixture.recorded()).toEqual([]);
    await expect(lstat(fixture.config)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not install or change configuration if the console is interrupted", async () => {
    const fixture = await wizardFixture(["1", "__CANCEL__"]);
    const result = fixture.runWizard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("向导已取消");
    expect(await fixture.recorded()).toEqual([]);
    await expect(lstat(fixture.config)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires explicit confirmation to update a router and preserves readonly and advanced fields", async () => {
    const fixture = await wizardFixture([]);
    expect(fixture.run("configure", ["--router", "lab", "--identity", fixture.key, "--readonly"]).status).toBe(0);
    const original = JSON.parse(await readFile(fixture.config, "utf8"));
    original.routers.lab.extraOption = "preserve";
    original.routers.lab.auth.localOption = "preserve";
    await writeFile(fixture.config, JSON.stringify(original));
    const declined = fixture.runWizard({
      TEST_WIZARD_ANSWERS: JSON.stringify(["1", "", "22023", "", ""]),
    });
    expect(declined.status, declined.stderr).toBe(0);
    expect(JSON.parse(await readFile(fixture.config, "utf8"))).toEqual(original);
    expect(await fixture.recorded()).toEqual([]);
    const updated = fixture.runWizard({
      TEST_WIZARD_ANSWERS: JSON.stringify(["1", "", "22023", "", "y", "n"]),
    });
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(await readFile(fixture.config, "utf8")).routers.lab).toMatchObject({
      port: 22023, readonly: true, extraOption: "preserve",
      auth: { localOption: "preserve" },
    });
  });

  it("remembers an existing router for reflashing and reports a declined or failed trust step", async () => {
    const fixture = await wizardFixture(["2"]);
    expect(fixture.run("configure", ["--router", "lab", "--identity", fixture.key]).status).toBe(0);
    const before = await readFile(fixture.config, "utf8");
    const result = fixture.runWizard({ TEST_WIZARD_TRUST_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("设备信任步骤完成");
    expect(await readFile(fixture.config, "utf8")).toBe(before);
    expect((await fixture.recorded()).map((call) => call.args)).toEqual([
      [path.join(fixture.source, "dist", "index.js"), "trust", "lab"],
    ]);
  });

  it("assigns a new loopback port for a second router and keeps other registrations intact", async () => {
    const fixture = await wizardFixture([]);
    expect(fixture.run("configure", ["--router", "first", "--identity", fixture.key]).status).toBe(0);
    const existing = { mcpServers: { openwrt: { type: "stdio", command: "other-server" }, other: { command: "keep" } } };
    const client = path.join(fixture.copilotHome, "mcp-config.json");
    await writeFile(client, JSON.stringify(existing));
    const result = fixture.runWizard({
      TEST_WIZARD_ANSWERS: JSON.stringify(["1", "second", "", fixture.key, "y", "openwrt", "", "n"]),
    });
    expect(result.status, result.stderr).toBe(0);
    const inventory = JSON.parse(await readFile(fixture.config, "utf8"));
    expect(inventory.routers.first.port).toBe(22022);
    expect(inventory.routers.second.port).toBe(22023);
    expect(JSON.parse(await readFile(client, "utf8"))).toEqual(existing);
    const registration = (await fixture.recorded()).find((call) => call.command === "copilot" && call.args[0] === "mcp");
    expect(registration.args.slice(0, 3)).toEqual(["mcp", "add", "openwrt-local"]);
  });

  it("does not claim installation succeeded if a prerequisite command fails", async () => {
    const fixture = await wizardFixture([]);
    const result = fixture.runWizard({
      TEST_WIZARD_ANSWERS: JSON.stringify(["1", "", "", fixture.key, "y"]),
      TEST_WIZARD_FAIL_COMMAND: "copilot",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exit code 7");
    expect(result.stderr).not.toContain("构建、配置和 MCP 注册完成");
    await expect(lstat(fixture.config)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reuses a matching registration under another name during updates without asking for another name", async () => {
    const fixture = await wizardFixture(["3"]);
    const desired = JSON.parse(fixture.run("show").stdout).mcpServers.openwrt;
    const client = path.join(fixture.copilotHome, "mcp-config.json");
    const before = {
      mcpServers: { openwrt: { type: "stdio", command: "other-server" }, "openwrt-local": desired },
    };
    await writeFile(client, JSON.stringify(before));
    const result = fixture.runWizard();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("openwrt-local");
    expect(result.stderr).not.toContain("新的 MCP 名称");
    expect(JSON.parse(await readFile(client, "utf8"))).toEqual(before);
    expect((await fixture.recorded()).filter((call) => call.command === "copilot" && call.args[0] === "mcp")).toEqual([]);
  });

  it("offers a review-only tunnel plan without administrator or SSH subprocesses", async () => {
    const fixture = await wizardFixture([]);
    const publicKey = path.join(fixture.root, "public.key");
    await writeFile(publicKey, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZha2U= lab\n");
    const result = fixture.runWizard({
      TEST_WIZARD_ANSWERS: JSON.stringify(["4", publicKey, ""]),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("REVIEW ONLY");
    expect(result.stdout).toContain("PermitListen 127.0.0.1:22022");
    expect(await fixture.recorded()).toEqual([]);
  });

  it("keeps the no-parameter launcher portable and forwards help without consuming stdin", async () => {
    expect(await readFile(setupLauncher, "utf8")).not.toContain("\r");
    const result = spawnSync(shell, [setupLauncher, "--help"], {
      encoding: "utf8", timeout: 10000,
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Easy mode: sh scripts/setup.sh");
  });
});

describe("Host deployment helper", () => {
  it("uses host/user/identity option names and rejects removed setup options", async () => {
    const fixture = await setupFixture();
    const configured = fixture.run("configure", [
      "--router", "lab", "--host", "192.0.2.20", "--user", "admin", "--identity", fixture.key,
    ]);
    expect(configured.status, configured.stderr).toBe(0);
    expect(JSON.parse(await readFile(fixture.config, "utf8")).routers.lab).toMatchObject({
      host: "192.0.2.20", username: "admin", auth: { privateKeyPath: fixture.key },
    });
    const before = await readFile(fixture.config, "utf8");
    for (const option of ["--key", "--username"]) {
      const removed = fixture.run("configure", ["--router", "lab", option, fixture.key]);
      expect(removed.status).toBe(1);
      expect(removed.stderr).toContain("unsupported option");
    }
    expect(await readFile(fixture.config, "utf8")).toBe(before);
    for (const oldName of ["vm.mjs", "vm.sh", "openwrt.sh"]) {
      await expect(lstat(path.resolve("scripts", oldName))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("creates private router configuration and keeps identical reruns unchanged", async () => {
    const fixture = await setupFixture();
    const args = ["--router", "lab", "--identity", fixture.key, "--readonly"];
    const first = fixture.run("configure", args);
    expect(first.status, first.stderr).toBe(0);
    const initial = await readFile(fixture.config, "utf8");
    expect(JSON.parse(initial).routers.lab).toMatchObject({
      host: "127.0.0.1",
      port: 22022,
      default: true,
      readonly: true,
      auth: { type: "key", privateKeyPath: fixture.key },
    });
    const again = fixture.run("configure", args);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stderr).toContain("Unchanged");
    expect(await readFile(fixture.config, "utf8")).toBe(initial);
    if (process.platform !== "win32") {
      expect((await lstat(fixture.config)).mode & 0o777).toBe(0o600);
      expect((await lstat(fixture.output)).mode & 0o777).toBe(0o700);
    }
  });

  it("preserves other routers and requires explicit consent before replacing one", async () => {
    const fixture = await setupFixture();
    expect(fixture.run("configure", ["--router", "first", "--identity", fixture.key]).status).toBe(0);
    const existing = JSON.parse(await readFile(fixture.config, "utf8"));
    existing.localOption = "keep";
    existing.routers.other = { host: "local", auth: { type: "password", password: "DO-NOT-PRINT" }, default: false };
    await writeFile(fixture.config, JSON.stringify(existing));
    const denied = fixture.run("configure", ["--router", "first", "--identity", fixture.key, "--port", "22023"]);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain("--update-router");
    expect(denied.stderr + denied.stdout).not.toContain("DO-NOT-PRINT");
    expect(JSON.parse(await readFile(fixture.config, "utf8"))).toEqual(existing);

    const updated = fixture.run("configure", ["--router", "second", "--identity", fixture.key, "--port", "22023", "--default"]);
    expect(updated.status, updated.stderr).toBe(0);
    const inventory = JSON.parse(await readFile(fixture.config, "utf8"));
    expect(inventory.localOption).toBe("keep");
    expect(inventory.routers.other).toEqual(existing.routers.other);
    expect(inventory.routers.first.default).toBe(false);
    expect(inventory.routers.second).toMatchObject({ port: 22023, default: true });
    const replacement = fixture.run("configure", ["--router", "first", "--identity", fixture.key, "--port", "22024", "--update-router"]);
    expect(replacement.status, replacement.stderr).toBe(0);
    expect(JSON.parse(await readFile(fixture.config, "utf8")).routers.first.port).toBe(22024);
  });

  it("rejects invalid arguments and malformed configurations without overwriting them", async () => {
    const fixture = await setupFixture();
    const invalid = fixture.run("configure", ["--router", "lab", "--identity", fixture.key, "--port", "0"]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("port");
    await mkdir(path.dirname(fixture.config), { recursive: true });
    await writeFile(fixture.config, "{invalid-with-secret");
    const malformed = fixture.run("configure", ["--router", "lab", "--identity", fixture.key]);
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain("not valid JSON");
    expect(malformed.stderr).not.toContain("invalid-with-secret");
    expect(await readFile(fixture.config, "utf8")).toBe("{invalid-with-secret");
    expect(fixture.run("configure", ["--router", "lab", "--identity", fixture.key, "--confirm"]).status).toBe(1);
  });

  it("keeps MCP startup stdout clean and only invokes trust when requested", async () => {
    const fixture = await setupFixture();
    const protocol = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n';
    const started = fixture.run("start", [], protocol);
    expect(started.status, started.stderr).toBe(0);
    expect(started.stdout).toBe(protocol);
    expect(started.stderr).toBe("");
    const trusted = fixture.run("trust", ["--router", "lab"]);
    expect(trusted.status, trusted.stderr).toBe(0);
    expect(JSON.parse(trusted.stdout)).toEqual({
      args: ["trust", "lab"],
      config: fixture.config,
      trust: fixture.trust,
    });
  });

  it("prints a tool allowlist and rejects wildcards without changing client configuration", async () => {
    const fixture = await setupFixture();
    const shown = fixture.run("show", ["--tools", "system_info,dmesg"]);
    expect(shown.status, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout).mcpServers.openwrt).toMatchObject({
      type: "stdio",
      command: process.execPath,
      args: [path.join(fixture.source, "dist", "index.js")],
      tools: ["system_info", "dmesg"],
    });
    expect(fixture.run("show", ["--tools", "*"]).status).toBe(1);
    expect(fixture.run("show", ["--tools", "not_a_real_tool"]).status).toBe(1);
  });

  it("registers via the native CLI with separated arguments and never overwrites an existing server", async () => {
    const fixture = await setupFixture();
    const preload = path.join(fixture.root, "fake-cli.mjs");
    const log = path.join(fixture.root, "cli-args.json");
    await writeFile(preload, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
const original = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (command !== "copilot") return original(command, args, options);
  writeFileSync(process.env.TEST_CLI_LOG, JSON.stringify({command,args}));
  const child = new EventEmitter();
  child.kill = () => true;
  queueMicrotask(() => child.emit("exit", Number(process.env.TEST_CLI_EXIT ?? 0), null));
  return child;
};
syncBuiltinESMExports();
`);
    const mock = { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, TEST_CLI_LOG: log };
    const registered = fixture.run("register", [], undefined, mock);
    expect(registered.status, registered.stderr).toBe(0);
    const request = JSON.parse(await readFile(log, "utf8"));
    expect(request.command).toBe("copilot");
    expect(request.args).toContain(`OPENWRT_MCP_CONFIG=${fixture.config}`);
    expect(request.args).toContain("660000");
    expect(request.args.slice(-2)).toEqual([process.execPath, path.join(fixture.source, "dist", "index.js")]);
    const failed = fixture.run("register", [], undefined, { ...mock, TEST_CLI_EXIT: "8" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("exit code 8");

    const clientConfig = path.join(fixture.copilotHome, "mcp-config.json");
    const existing = { mcpServers: { other: { type: "http", url: "https://example.invalid" }, openwrt: { command: "other" } } };
    await writeFile(clientConfig, JSON.stringify(existing));
    await rm(log);
    const denied = fixture.run("register", [], undefined, mock);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain("already exists");
    expect(JSON.parse(await readFile(clientConfig, "utf8"))).toEqual(existing);
    const entry = JSON.parse(fixture.run("show").stdout).mcpServers.openwrt;
    await writeFile(clientConfig, JSON.stringify({ mcpServers: { openwrt: entry } }));
    const repeated = fixture.run("register", [], undefined, mock);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(repeated.stderr).toContain("already registered");
    const timeoutUpdate = fixture.run("register", ["--request-timeout", "700000"], undefined, mock);
    expect(timeoutUpdate.status).toBe(1);
    expect(timeoutUpdate.stderr).toContain("client timeout");
  });

  it("only prints a restricted Host tunnel plan and never starts administrator commands", async () => {
    const fixture = await setupFixture();
    const publicKey = path.join(fixture.root, "device.pub");
    await writeFile(publicKey, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZha2U= lab\n");
    const planned = spawnSync(process.execPath, [setupScript, "tunnel-plan", "--account", "owrt-tunnel", "--public-key", publicKey, "--port", "22023"], {
      encoding: "utf8", timeout: 10000,
    });
    expect(planned.status, planned.stderr).toBe(0);
    expect(planned.stdout).toContain("REVIEW ONLY");
    expect(planned.stdout).toContain("PermitListen 127.0.0.1:22023");
    expect(planned.stdout).toContain("GatewayPorts no");
    expect(planned.stdout).toContain("MaxSessions 0");
    await writeFile(publicKey, "MOCK PRIVATE KEY");
    const privateFile = spawnSync(process.execPath, [setupScript, "tunnel-plan", "--public-key", publicKey], { encoding: "utf8", timeout: 10000 });
    expect(privateFile.status).toBe(1);
    expect(privateFile.stdout).toBe("");
    expect(privateFile.stderr).not.toContain("MOCK PRIVATE KEY");
  });

  it.skipIf(process.platform === "win32")("setup runs bounded local build commands without connecting a device", async () => {
    const fixture = await setupFixture();
    const bin = path.join(fixture.root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_BUILD_LOG"\n');
    await chmod(path.join(bin, "npm"), 0o700);
    const buildLog = path.join(fixture.root, "build.log");
    const result = fixture.run("setup", ["--router", "lab", "--identity", fixture.key], undefined, {
      PATH: `${bin}:${process.env.PATH}`, TEST_BUILD_LOG: buildLog,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(buildLog, "utf8")).toBe("ci\nrun build\n");
    expect(JSON.parse(await readFile(fixture.config, "utf8")).routers.lab.host).toBe("127.0.0.1");
  });

  it("refuses source-private paths, stale locks and symlinked configuration ancestors", async () => {
    const fixture = await setupFixture();
    const locked = path.join(fixture.root, "locked");
    await mkdir(locked, { mode: 0o700 });
    const lockedConfig = path.join(locked, "config.json");
    await writeFile(`${lockedConfig}.lock`, "another process");
    const base = ["--router", "lab", "--identity", fixture.key];
    const blocked = spawnSync(process.execPath, [
      setupScript, "configure", "--source", fixture.source, "--config", lockedConfig,
      "--trust-file", fixture.trust, "--output-dir", fixture.output, ...base,
    ], { encoding: "utf8", timeout: 10000 });
    expect(blocked.status).toBe(1);
    expect(await readFile(`${lockedConfig}.lock`, "utf8")).toBe("another process");

    const privateInSource = spawnSync(process.execPath, [
      setupScript, "configure", "--source", fixture.source,
      "--config", path.join(fixture.source, "secrets.json"), ...base,
    ], { encoding: "utf8", timeout: 10000 });
    expect(privateInSource.status).toBe(1);
    expect(privateInSource.stderr).toContain("outside the source checkout");

    const target = path.join(fixture.root, "target");
    const link = path.join(fixture.root, "linked");
    await mkdir(target);
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    const throughLink = spawnSync(process.execPath, [
      setupScript, "configure", "--source", fixture.source,
      "--config", path.join(link, "config.json"), ...base,
    ], { encoding: "utf8", timeout: 10000 });
    expect(throughLink.status).toBe(1);
    expect(throughLink.stderr).toContain("symlink");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("preserves the previous configuration when an atomic replacement fails", async () => {
    const fixture = await setupFixture();
    const original = fixture.run("configure", ["--router", "lab", "--identity", fixture.key]);
    expect(original.status, original.stderr).toBe(0);
    const before = await readFile(fixture.config, "utf8");
    const preload = path.join(fixture.root, "storage-error.mjs");
    await writeFile(preload, `
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
promises.rename = async () => { throw new Error("simulated atomic storage failure"); };
syncBuiltinESMExports();
`);
    const failed = fixture.run("configure", [
      "--router", "lab", "--identity", fixture.key, "--port", "22023", "--update-router",
    ], undefined, { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("simulated atomic storage failure");
    expect(await readFile(fixture.config, "utf8")).toBe(before);
    const recovered = fixture.run("configure", ["--router", "lab", "--identity", fixture.key]);
    expect(recovered.status, recovered.stderr).toBe(0);
  });

  it.skipIf(process.platform === "win32")("never chmods an existing shared directory or follows a key symlink", async () => {
    const fixture = await setupFixture();
    const shared = path.join(fixture.root, "shared");
    await mkdir(shared, { mode: 0o755 });
    const before = (await lstat(shared)).mode;
    const denied = spawnSync(process.execPath, [
      setupScript, "configure", "--source", fixture.source,
      "--config", path.join(shared, "config.json"), "--router", "lab", "--identity", fixture.key,
    ], { encoding: "utf8", timeout: 10000 });
    expect(denied.status).toBe(1);
    expect((await lstat(shared)).mode).toBe(before);
    const link = path.join(fixture.root, "key-link");
    await symlink(fixture.key, link);
    const linkedKey = fixture.run("configure", ["--router", "lab", "--identity", link]);
    expect(linkedKey.status).toBe(1);
    expect(linkedKey.stderr).toContain("not a symlink");
  });
});

function shellPath(file: string): string {
  if (process.platform !== "win32") return file;
  const normalized = file.replace(/\\/g, "/");
  return normalized.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

async function tunnelFixture() {
  const root = await workspace();
  const bin = path.join(root, "bin");
  const key = path.join(root, ".ssh", "tunnel key");
  const log = path.join(root, "arguments.bin");
  const home = path.join(root, "home");
  await mkdir(bin);
  await mkdir(home);
  await mkdir(path.dirname(key));
  await writeFile(key, "MOCK KEY");
  const client = path.join(bin, "client");
  await writeFile(client, `#!/bin/sh
case "$*" in
  -V) printf '%s\\n' "\${TEST_CLIENT_KIND:-Dropbear}"; exit 0 ;;
  -h) printf '%s\\n' '-R remote forwarding'; exit 0 ;;
  '-o help')
    printf '%s\\n' BatchMode StrictHostKeyChecking
    [ "\${TEST_MISSING_OPTION:-0}" = 1 ] || printf '%s\\n' ExitOnForwardFailure
    exit 0 ;;
esac
printf '%s\\0' "$@" > "$TEST_TUNNEL_LOG"
exit "\${TEST_CLIENT_EXIT:-0}"
`);
  await chmod(client, 0o700);
  await writeFile(path.join(bin, "dropbearkey"), `#!/bin/sh
key=
generate=0
while [ "$#" -gt 0 ]; do
  case "$1" in -t) generate=1; shift 2 ;; -f) key=$2; shift 2 ;; *) shift ;; esac
done
if [ "$generate" = 1 ]; then printf 'GENERATED MOCK KEY' > "$key"; fi
printf '%s\\n' 'Public key portion is:' 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZha2U= lab' 'Fingerprint: MOCK'
`);
  await chmod(path.join(bin, "dropbearkey"), 0o700);
  const common = ["--host", "server.example.com", "--user", "owrt-tunnel", "--identity", shellPath(key), "--client", shellPath(client)];
  const environment = {
    ...process.env,
    HOME: shellPath(home),
    PATH: process.platform === "win32" ? `${bin};${process.env.PATH}` : `${bin}:${process.env.PATH}`,
    TEST_TUNNEL_LOG: shellPath(log),
  };
  const run = (action: string, args: string[] = common, env: NodeJS.ProcessEnv = {}) =>
    spawnSync(shell, [tunnelScript, action, ...args], {
      encoding: "utf8",
      env: { ...environment, ...env },
      timeout: 10000,
    });
  const argumentsRead = async () => (await readFile(log, "utf8")).split("\0").filter(Boolean);
  return { root, bin, key, log, home, client, common, environment, run, argumentsRead };
}

describe("OpenWrt tunnel helper with local fake SSH clients", () => {
  it("separates server SSH port, remote listener and client-local forwarding target", async () => {
    const fixture = await tunnelFixture();
    const started = fixture.run("start", [
      ...fixture.common, "--port", "2222", "--remote-port", "22024",
      "--local-host", "192.0.2.15", "--local-port", "2223",
    ]);
    expect(started.status, started.stderr).toBe(0);
    const args = await fixture.argumentsRead();
    expect(args.slice(-5)).toEqual([
      "-p", "2222", "-R", "127.0.0.1:22024:192.0.2.15:2223", "owrt-tunnel@server.example.com",
    ]);
  }, 30000);

  it("rejects all deleted tunnel parameters and command names before making an SSH request", async () => {
    const fixture = await tunnelFixture();
    for (const option of [
      "--vm-host", "--vm-user", "--vm-port", "--listen-port",
      "--device-host", "--device-port", "--key",
    ]) {
      const removed = fixture.run("start", [option, "unused"]);
      expect(removed.status).toBe(1);
      expect(removed.stderr).toContain("unsupported option");
    }
    const removedCommand = fixture.run("trust-vm");
    expect(removedCommand.status).toBe(1);
    expect(removedCommand.stderr).toContain("unknown command");
    await expect(lstat(fixture.log)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30000);

  it("uses exact strict Dropbear arguments and an SSH server loopback listener", async () => {
    expect(await readFile(tunnelScript, "utf8")).not.toContain("\r");
    const fixture = await tunnelFixture();
    const started = fixture.run("start", [...fixture.common, "--port", "2222", "--remote-port", "22023"]);
    expect(started.status, started.stderr).toBe(0);
    expect(await fixture.argumentsRead()).toEqual([
      "-N", "-T", "-K", "30", "-I", "0", "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes",
      "-i", shellPath(fixture.key), "-p", "2222",
      "-R", "127.0.0.1:22023:127.0.0.1:22", "owrt-tunnel@server.example.com",
    ]);
  }, 30000);

  it("selects OpenSSH keepalive options without passing Dropbear flags", async () => {
    const fixture = await tunnelFixture();
    const started = fixture.run("start", fixture.common, { TEST_CLIENT_KIND: "OpenSSH_9.9" });
    expect(started.status, started.stderr).toBe(0);
    const args = await fixture.argumentsRead();
    expect(args).toContain("ServerAliveInterval=30");
    expect(args).toContain("ServerAliveCountMax=3");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).not.toContain("-K");
  }, 30000);

  it("only allows interactive host confirmation for the separate trust action", async () => {
    const fixture = await tunnelFixture();
    const trusted = fixture.run("trust-host");
    expect(trusted.status, trusted.stderr).toBe(0);
    const args = await fixture.argumentsRead();
    expect(args).toContain("StrictHostKeyChecking=ask");
    expect(args).not.toContain("BatchMode=yes");
    expect(args).not.toContain("-R");
    expect(trusted.stderr).toContain("out-of-band");
  }, 30000);

  it("fails closed for unsupported clients/options, bad ports and remote usernames", async () => {
    const fixture = await tunnelFixture();
    for (const result of [
      fixture.run("start", fixture.common, { TEST_MISSING_OPTION: "1" }),
      fixture.run("start", fixture.common, { TEST_CLIENT_KIND: "unknown-client" }),
      fixture.run("start", [...fixture.common, "--remote-port", "0"]),
      fixture.run("start", fixture.common.map((value) => value === "owrt-tunnel" ? "root" : value)),
      fixture.run("start", [...fixture.common, "-y"]),
    ]) {
      expect(result.status).toBe(1);
      expect(result.stderr).not.toBe("");
    }
    const failed = fixture.run("start", fixture.common, { TEST_CLIENT_EXIT: "9" });
    expect(failed.status).toBe(9);
  }, 30000);

  it("generates a missing key once and emits only a reusable public-key line", async () => {
    const fixture = await tunnelFixture();
    await rm(fixture.key);
    const args = ["--identity", shellPath(fixture.key), "--client", shellPath(fixture.client)];
    const generated = fixture.run("keygen", args);
    expect(generated.status, generated.stderr).toBe(0);
    expect(generated.stdout.trim()).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZha2U= lab");
    const key = await readFile(fixture.key, "utf8");
    const repeated = fixture.run("keygen", args);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(await readFile(fixture.key, "utf8")).toBe(key);
    expect(repeated.stdout).toBe(generated.stdout);
  }, 30000);

  it("installs portable saved settings and refuses unrelated files or implicit overwrite", async () => {
    const fixture = await tunnelFixture();
    const state = path.join(fixture.root, "state with ' quote");
    const init = path.join(fixture.root, "init");
    const installArgs = [...fixture.common, "--state-dir", shellPath(state), "--init-dir", shellPath(init)];
    const installed = fixture.run("install", installArgs);
    expect(installed.status, installed.stderr).toBe(0);
    const saved = path.join(state, "tunnel.conf");
    const service = path.join(init, "owrt-reverse-ssh");
    const serviceText = await readFile(service, "utf8");
    const savedText = await readFile(saved, "utf8");
    expect(savedText).toContain("host=server.example.com\nuser=owrt-tunnel\nport=22\nremote_port=22022\n");
    expect(savedText).toContain("local_host=127.0.0.1\nlocal_port=22\nidentity=");
    expect(savedText).not.toContain("vm_");
    expect(serviceText).toContain("respawn 3600 15 0");
    expect(serviceText).toContain("procd_set_param file");
    const syntax = spawnSync(shell, ["-n", service], { encoding: "utf8", timeout: 10000 });
    expect(syntax.status, syntax.stderr).toBe(0);
    const procdLog = path.join(fixture.root, "procd.bin");
    const interpreted = spawnSync(shell, ["-c", `
procd_open_instance() { :; }
procd_close_instance() { :; }
procd_set_param() { printf '%s\\0' "$@" >> "$TEST_PROCD_LOG"; }
. "$1"
start_service
`, "procd-test", shellPath(service)], {
      encoding: "utf8",
      timeout: 10000,
      env: { ...fixture.environment, TEST_PROCD_LOG: shellPath(procdLog) },
    });
    expect(interpreted.status, interpreted.stderr).toBe(0);
    expect((await readFile(procdLog, "utf8")).split("\0").filter(Boolean).slice(0, 6)).toEqual([
      "command", "/bin/sh", shellPath(path.join(state, "tunnel.sh")), "start", "--config", shellPath(saved),
    ]);
    const runSaved = fixture.run("start", ["--config", shellPath(saved)]);
    expect(runSaved.status, runSaved.stderr).toBe(0);
    expect(await fixture.argumentsRead()).toContain("127.0.0.1:22022:127.0.0.1:22");
    const duplicate = fixture.run("install", installArgs);
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain("--update");
    const updated = fixture.run("install", [...installArgs, "--update"]);
    expect(updated.status, updated.stderr).toBe(0);
    await writeFile(service, "# unrelated existing service\n");
    const unrelated = fixture.run("install", [...installArgs, "--update"]);
    expect(unrelated.status).toBe(1);
    expect(await readFile(service, "utf8")).toBe("# unrelated existing service\n");
  }, 30000);

  it("does not source shell code from saved configuration or ignore mixed overrides", async () => {
    const fixture = await tunnelFixture();
    const state = path.join(fixture.root, "state");
    const init = path.join(fixture.root, "init");
    const installed = fixture.run("install", [...fixture.common, "--state-dir", shellPath(state), "--init-dir", shellPath(init)]);
    expect(installed.status, installed.stderr).toBe(0);
    const saved = path.join(state, "tunnel.conf");
    const text = await readFile(saved, "utf8");
    await writeFile(saved, text.replace("host=server.example.com", "host=server.example.com; echo injected"));
    const invalid = fixture.run("start", ["--config", shellPath(saved)]);
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).not.toContain("injected");
    const mixed = fixture.run("start", ["--config", shellPath(saved), "--remote-port", "22024"]);
    expect(mixed.status).toBe(1);
    expect(mixed.stderr).toContain("cannot be mixed");
    await writeFile(saved, text.replace("host=server.example.com", "vm_host=server.example.com"));
    const removedField = fixture.run("start", ["--config", shellPath(saved)]);
    expect(removedField.status).toBe(1);
    expect(removedField.stderr).toContain("unknown configuration field vm_host");
  }, 30000);

  it("does not activate on install and controls only the marked service", async () => {
    const fixture = await tunnelFixture();
    const state = path.join(fixture.root, "state");
    const init = path.join(fixture.root, "init");
    expect(fixture.run("install", [...fixture.common, "--state-dir", shellPath(state), "--init-dir", shellPath(init)]).status).toBe(0);
    await expect(lstat(fixture.log)).rejects.toMatchObject({ code: "ENOENT" });
    const controlLog = path.join(fixture.root, "controls.log");
    const service = path.join(init, "owrt-reverse-ssh");
    await writeFile(service, `#!/bin/sh
# Managed by openwrt-mcp/scripts/ssh-tunnel.sh
printf '%s\\n' "$1" >> "$TEST_CONTROL_LOG"
exit "\${TEST_CONTROL_EXIT:-0}"
`);
    await chmod(service, 0o700);
    const controls = ["--init-dir", shellPath(init)];
    const env = { TEST_CONTROL_LOG: shellPath(controlLog) };
    expect(fixture.run("enable", controls, env).status).toBe(0);
    expect(await readFile(controlLog, "utf8")).toBe("enable\nstart\n");
    expect(fixture.run("stop", controls, env).status).toBe(0);
    expect(fixture.run("disable", controls, env).status).toBe(0);
    const stopped = fixture.run("status", controls, { ...env, TEST_CONTROL_EXIT: "1" });
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toContain("not running");
    await writeFile(service, "#!/bin/sh\nexit 0\n");
    const unrelated = fixture.run("stop", controls, env);
    expect(unrelated.status).toBe(1);
    expect(unrelated.stderr).toContain("unrelated");
  }, 30000);

  it("rejects normalized-path escapes, unrelated options and an existing install lock", async () => {
    const fixture = await tunnelFixture();
    for (const args of [
      ["--identity", "/tmp/../key", "--client", shellPath(fixture.client)],
      ["--identity", "/tmp/key", "--client", shellPath(fixture.client)],
      ["--identity", shellPath(fixture.key), "--client", shellPath(fixture.client), "--port", "22"],
    ]) {
      expect(fixture.run("keygen", args).status).toBe(1);
    }
    const state = path.join(fixture.root, "state");
    const init = path.join(fixture.root, "init");
    await mkdir(state);
    await mkdir(path.join(state, ".install-lock"));
    const locked = fixture.run("install", [...fixture.common, "--state-dir", shellPath(state), "--init-dir", shellPath(init)]);
    expect(locked.status).toBe(1);
    expect(locked.stderr).toContain(".install-lock");
    expect((await lstat(path.join(state, ".install-lock"))).isDirectory()).toBe(true);
  }, 30000);
});
