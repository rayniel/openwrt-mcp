#!/usr/bin/env node
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createInterface } from "node:readline/promises";

const sourceDefault = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultTools = "run_command,run_script,read_command_output,system_info,dmesg";
const commonOptions = ["source", "config", "trust-file", "output-dir"];
const optionsByCommand = {
  wizard: commonOptions,
  setup: [...commonOptions, "router", "identity", "host", "port", "user", "readonly", "default", "update-router", "register", "name", "tools", "request-timeout"],
  configure: [...commonOptions, "router", "identity", "host", "port", "user", "readonly", "default", "update-router"],
  build: ["source"],
  trust: [...commonOptions, "router"],
  start: commonOptions,
  register: [...commonOptions, "name", "tools", "request-timeout"],
  show: [...commonOptions, "name", "tools"],
  "tunnel-plan": ["account", "public-key", "port"],
};
const booleanOptions = new Set(["readonly", "default", "update-router", "register"]);

function usage() {
  console.log(`Easy mode: sh scripts/setup.sh (Chinese interactive wizard, no parameters)
Usage: node scripts/setup.mjs [command] [options]

  wizard       Interactive setup and maintenance; default when no command is given
  setup        Build and add a router; --register also adds the Copilot MCP entry
  configure    Add/update a router without building
  build        Restore missing dependencies and build the current source
  trust        Run interactive device host-key enrollment in this terminal
  start        Start the MCP stdio server (no interactive trust prompts)
  register     Add a user-level Copilot CLI entry; never overwrite an existing one
  show         Print the intended MCP entry without modifying configuration
  tunnel-plan  Print a server administrator review plan; never create users or edit sshd

Router options: --router NAME --identity PATH [--port 22022] [--host 127.0.0.1]
                [--user root] [--readonly] [--default] [--update-router]
Paths:          --source PATH --config PATH --trust-file PATH --output-dir PATH
Registration:   --name openwrt --tools ${defaultTools}
                --request-timeout 660000
Tunnel plan:    --account owrt-tunnel --public-key PATH [--port 22022]

Requires Node.js >=22. No passwords are accepted as command-line arguments.
SSH trust and command approval remain separate. setup does not connect to a device.`);
}

function parseArgs(argv) {
  const [command, ...args] = argv;
  if (!command) return { command: "wizard", options: {} };
  if (command === "--help" || args.includes("--help")) return { command: "help", options: {} };
  const allowed = optionsByCommand[command];
  if (!allowed) throw new Error(`unknown command '${command}'; use --help`);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const name = argument.startsWith("--") ? argument.slice(2) : "";
    if (!allowed.includes(name)) throw new Error(`unsupported option '${argument}' for ${command}`);
    if (Object.hasOwn(options, name)) throw new Error(`duplicate option --${name}`);
    if (booleanOptions.has(name)) {
      options[name] = true;
    } else {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
      options[name] = value;
    }
  }
  if (command === "setup" && !options.register && ["name", "tools", "request-timeout"].some((name) => Object.hasOwn(options, name))) {
    throw new Error("setup registration options require --register");
  }
  return { command, options };
}

function resolvePath(value) {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
  if (/[\0\r\n]/.test(expanded)) throw new Error("paths cannot contain control characters");
  return path.resolve(expanded);
}

function settings(options) {
  const paths = {
    source: resolvePath(options.source ?? sourceDefault),
    config: resolvePath(options.config ?? process.env.OPENWRT_MCP_CONFIG ?? path.join(homedir(), ".config", "openwrt-mcp", "config.json")),
    trust: resolvePath(options["trust-file"] ?? process.env.OPENWRT_MCP_TRUST_FILE ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "openwrt-mcp", "trusted-hosts.json")),
    output: resolvePath(options["output-dir"] ?? process.env.OPENWRT_MCP_OUTPUT_DIR ?? path.join(homedir(), ".local", "state", "openwrt-mcp", "outputs")),
  };
  for (const file of [paths.config, paths.trust, paths.output]) {
    if (insideDirectory(paths.source, file)) throw new Error("device configuration, trust and output paths must be outside the source checkout");
  }
  return paths;
}

function insideDirectory(directory, file) {
  const relative = path.relative(directory, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validateName(value, label) {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    throw new Error(`${label} must be 1-64 letters, digits, dots, underscores or hyphens, starting with a letter or digit`);
  }
  return value;
}

function integer(value, min, max, label) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

async function fileInfo(file) {
  try {
    return await lstat(file);
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    throw err;
  }
}

async function privateDirectory(directory) {
  const shared = [path.parse(directory).root, homedir(), tmpdir(), "/etc", "/home", "/usr", "/var"];
  if (shared.some((item) => path.resolve(item) === directory)) {
    throw new Error(`choose a dedicated private subdirectory, not a shared/root directory: ${directory}`);
  }
  await rejectSymlinkAncestors(directory);
  const before = await fileInfo(directory);
  if (before && (before.isSymbolicLink() || !before.isDirectory())) {
    throw new Error(`private directory must not be a symlink or file: ${directory}`);
  }
  if (before && process.platform !== "win32" && (before.mode & 0o077) !== 0) {
    throw new Error(`existing private directory needs owner-only permissions; review it before chmod 700: ${directory}`);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const after = await lstat(directory);
  if (after.isSymbolicLink() || !after.isDirectory()) throw new Error(`unsafe private directory: ${directory}`);
  if (!before) await chmod(directory, 0o700);
}

async function rejectSymlinkAncestors(file) {
  let current = file;
  for (;;) {
    if ((await fileInfo(current))?.isSymbolicLink()) throw new Error(`refusing a symlink in the private path: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function readJson(file) {
  await rejectSymlinkAncestors(file);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    throw err;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error(`configuration must be a regular file smaller than 1 MiB: ${file}`);
    const text = await handle.readFile("utf8");
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`configuration is not valid JSON: ${file}`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`configuration must be a JSON object: ${file}`);
    return value;
  } finally {
    await handle.close();
  }
}

async function editJson(file, transform) {
  await privateDirectory(path.dirname(file));
  const info = await fileInfo(file);
  if (info && (info.isSymbolicLink() || !info.isFile())) throw new Error(`refusing to replace a symlink or non-file: ${file}`);
  const lockPath = `${file}.lock`;
  const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let temporary;
  try {
    const before = await readJson(file);
    const after = transform(before);
    if (isDeepStrictEqual(before, after)) return false;
    temporary = `${file}.${process.pid}.tmp`;
    const output = await open(temporary, "wx", 0o600);
    try {
      await output.writeFile(`${JSON.stringify(after, null, 2)}\n`);
      await output.sync();
    } finally {
      await output.close();
    }
    if (!isDeepStrictEqual(before, await readJson(file))) throw new Error(`configuration changed concurrently; rerun after reviewing it: ${file}`);
    const current = await fileInfo(file);
    if (current?.isSymbolicLink()) throw new Error(`configuration became a symlink: ${file}`);
    await rename(temporary, file);
    temporary = undefined;
    return true;
  } finally {
    if (temporary) await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    const forwardInterrupt = () => child.kill("SIGINT");
    const forwardTermination = () => child.kill("SIGTERM");
    process.on("SIGINT", forwardInterrupt);
    process.on("SIGTERM", forwardTermination);
    const cleanup = () => {
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTermination);
    };
    child.once("error", (err) => {
      cleanup();
      reject(new Error(`could not start ${command}: ${err.message}`));
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(`${command} ended with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}`));
    });
  });
}

async function build(paths) {
  const manifest = await readJson(path.join(paths.source, "package.json"));
  if (manifest?.name !== "openwrt-mcp") throw new Error("--source must point to the openwrt-mcp source checkout");
  if (process.platform === "win32") throw new Error("build/setup require a Linux host; use npm.cmd run build on Windows");
  if (!(await fileInfo(path.join(paths.source, "node_modules")))) {
    console.error("Restoring locked dependencies in the source checkout...");
    await run("npm", ["ci"], { cwd: paths.source });
  }
  console.error("Building the current checkout (no clone, fetch, commit or push)...");
  await run("npm", ["run", "build"], { cwd: paths.source });
}

async function routerConfig(options) {
  const name = validateName(options.router, "router");
  if (!options.identity) throw new Error("--identity must name an existing device-login private key");
  const key = resolvePath(options.identity);
  const keyInfo = await fileInfo(key);
  if (!keyInfo || keyInfo.isSymbolicLink() || !keyInfo.isFile()) throw new Error("--identity must be an existing regular file, not a symlink");
  const host = options.host ?? "127.0.0.1";
  if (!host || /[\s\0]/.test(host)) throw new Error("--host must be a hostname or IP without whitespace");
  return {
    name,
    value: {
      host,
      port: integer(options.port ?? 22022, 1, 65535, "port"),
      username: validateName(options.user ?? "root", "user"),
      auth: { type: "key", privateKeyPath: key },
      readonly: options.readonly === true,
    },
  };
}

function updatedInventory(before, router, options) {
  const inventory = before ?? { routers: {} };
  if (!inventory.routers || typeof inventory.routers !== "object" || Array.isArray(inventory.routers)) throw new Error("existing configuration must contain a routers object");
  const previous = inventory.routers[router.name];
  const isDefault = options.default === true || previous?.default === true || Object.keys(inventory.routers).length === 0;
  const nextRouter = { ...router.value, default: isDefault };
  if (previous && !isDeepStrictEqual(previous, nextRouter) && !options["update-router"]) {
    throw new Error(`router '${router.name}' already has different settings; review them and use --update-router to replace only that router`);
  }
  const routers = { ...inventory.routers };
  if (options.default) {
    for (const name of Object.keys(routers)) routers[name] = { ...routers[name], default: false };
  }
  routers[router.name] = nextRouter;
  return { ...inventory, routers };
}

async function configure(paths, router, options) {
  await privateDirectory(path.dirname(paths.trust));
  await privateDirectory(paths.output);
  const changed = await editJson(paths.config, (before) => updatedInventory(before, router, options));
  console.error(`${changed ? "Saved" : "Unchanged"} router '${router.name}' in ${paths.config}`);
}

function environment(paths) {
  return {
    ...process.env,
    OPENWRT_MCP_CONFIG: paths.config,
    OPENWRT_MCP_TRUST_FILE: paths.trust,
    OPENWRT_MCP_OUTPUT_DIR: paths.output,
  };
}

async function entry(paths, options) {
  const executable = path.join(paths.source, "dist", "index.js");
  if (!(await fileInfo(executable))) throw new Error("dist/index.js is missing; run the build or setup command first");
  const tools = (options.tools ?? defaultTools).split(",");
  if (!tools.length || tools.some((name) => !/^[a-z][a-z0-9_]*$/.test(name)) || new Set(tools).size !== tools.length) {
    throw new Error("--tools must be a comma-separated list of distinct tool names; wildcard '*' is not accepted");
  }
  const { allTools } = await import(pathToFileURL(path.join(paths.source, "dist", "tools", "index.js")).href);
  const available = new Set(allTools.map((tool) => tool.name));
  const unknown = tools.filter((name) => !available.has(name));
  if (unknown.length) throw new Error(`unknown tools in this build: ${unknown.join(", ")}`);
  return {
    type: "stdio",
    command: process.execPath,
    args: [executable],
    env: {
      OPENWRT_MCP_CONFIG: paths.config,
      OPENWRT_MCP_TRUST_FILE: paths.trust,
      OPENWRT_MCP_OUTPUT_DIR: paths.output,
    },
    tools,
  };
}

async function register(paths, options) {
  const name = validateName(options.name ?? "openwrt", "MCP name");
  const timeout = integer(options["request-timeout"] ?? 660000, 1000, 3600000, "request-timeout");
  const desired = await entry(paths, options);
  const clientConfig = path.join(process.env.COPILOT_HOME ?? path.join(homedir(), ".copilot"), "mcp-config.json");
  const clientInfo = await fileInfo(clientConfig);
  if (clientInfo?.isSymbolicLink()) throw new Error(`refusing a symlinked Copilot configuration: ${clientConfig}`);
  const current = await readJson(clientConfig);
  if (current?.mcpServers !== undefined && (typeof current.mcpServers !== "object" || current.mcpServers === null || Array.isArray(current.mcpServers))) {
    throw new Error("existing Copilot configuration has an invalid mcpServers object");
  }
  const existing = current?.mcpServers?.[name];
  if (existing) {
    if (sameRegistration(existing, desired)) {
      if (options["request-timeout"] !== undefined) throw new Error(`MCP '${name}' already exists; use Copilot /mcp edit ${name} to review or change its client timeout`);
      console.error(`MCP '${name}' is already registered; no configuration changed.`);
      return;
    }
    throw new Error(`MCP '${name}' already exists with different settings; use Copilot /mcp edit ${name} or choose another --name`);
  }
  await run("copilot", [
    "mcp", "add", name, "--transport", "stdio",
    "--tools", desired.tools.join(","), "--timeout", String(timeout),
    ...Object.entries(desired.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    "--", desired.command, ...desired.args,
  ]);
  console.error(`Registered MCP '${name}' via Copilot CLI. No device connection was requested.`);
}

function sameRegistration(existing, desired) {
  return ["local", "stdio"].includes(existing.type) && isDeepStrictEqual(
    { command: existing.command, args: existing.args, env: existing.env, tools: existing.tools },
    { command: desired.command, args: desired.args, env: desired.env, tools: desired.tools },
  );
}

async function prompt(label, defaultValue = "", validate = (value) => value) {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const abort = new AbortController();
  readline.once("SIGINT", () => abort.abort());
  readline.once("close", () => abort.abort());
  try {
    for (;;) {
      const answer = await readline.question(`${label}${defaultValue ? ` [${defaultValue}]` : ""}：`, { signal: abort.signal });
      const value = answer.trim() || defaultValue;
      try {
        return validate(value);
      } catch (err) {
        console.error(`输入无效：${err.message}`);
      }
    }
  } catch (err) {
    if (err.name === "AbortError") throw new Error("向导已取消；已完成的操作不会自动撤销。");
    throw err;
  } finally {
    readline.close();
  }
}

function yesNo(value) {
  if (/^y(es)?$/i.test(value)) return true;
  if (/^n(o)?$/i.test(value)) return false;
  throw new Error("请输入 y 或 n。");
}

async function chooseRouter(paths) {
  const inventory = await readJson(paths.config);
  const routers = inventory?.routers;
  if (!routers || typeof routers !== "object" || Array.isArray(routers) || !Object.keys(routers).length) {
    throw new Error("尚未配置设备，请重新打开向导并选择 1。");
  }
  const names = Object.keys(routers);
  if (names.length === 1) return validateName(names[0], "router");
  names.forEach((name, index) => console.error(`${index + 1}. ${name}`));
  const defaultIndex = Math.max(0, names.findIndex((name) => routers[name]?.default));
  const selected = await prompt("选择设备编号", String(defaultIndex + 1), (value) => integer(value, 1, names.length, "设备编号"));
  return validateName(names[selected - 1], "router");
}

async function wizardRegister(paths) {
  const clientFile = path.join(process.env.COPILOT_HOME ?? path.join(homedir(), ".copilot"), "mcp-config.json");
  const current = await readJson(clientFile);
  const desired = await entry(paths, {});
  const matching = Object.entries(current?.mcpServers ?? {}).find(([, definition]) =>
    definition && typeof definition === "object" && sameRegistration(definition, desired),
  );
  if (matching) {
    await register(paths, { name: matching[0] });
    return matching[0];
  }
  const existing = current?.mcpServers?.openwrt;
  let name = "openwrt";
  if (existing && !sameRegistration(existing, desired)) {
    console.error("已存在不同的 openwrt MCP 注册，向导不会覆盖它；请给本次注册选择另一个名称。");
    name = await prompt("新的 MCP 名称", "openwrt-local", (value) => {
      validateName(value, "MCP name");
      if (current.mcpServers[value]) throw new Error("该名称已存在，请换一个。");
      return value;
    });
  }
  await register(paths, { name });
  return name;
}

async function wizardTrust(paths, name) {
  const executable = path.join(paths.source, "dist", "index.js");
  if (!(await fileInfo(executable))) throw new Error("程序尚未构建，请重新打开向导并选择 1 或 3。");
  console.error("即将连接隧道端口，仅读取设备主机指纹，不执行诊断命令。");
  console.error("先核对设备串口/本地指纹，再在下一步输入 y；向导不会代替你确认。");
  await run(process.execPath, [executable, "trust", name], { env: environment(paths) });
}

async function wizardSetup(paths) {
  const before = await readJson(paths.config);
  if (before && (!before.routers || typeof before.routers !== "object" || Array.isArray(before.routers))) {
    throw new Error("现有配置缺少有效 routers 对象；请先检查配置，向导不会覆盖它。");
  }
  const routers = before?.routers ?? {};
  const defaultRouter = Object.keys(routers).find((name) => routers[name]?.default);
  const name = await prompt("给设备取个英文名字", defaultRouter ?? "lab-device", (value) => validateName(value, "router"));
  const previous = routers[name];
  let nextPort = 22022;
  const occupied = new Set(Object.values(routers).map((router) => router.port));
  while (occupied.has(nextPort) && nextPort <= 65535) nextPort += 1;
  if (!previous && nextPort > 65535) throw new Error("没有可用的默认隧道端口，请检查现有设备配置。");
  const port = await prompt("反向隧道端口", String(previous?.port ?? nextPort), (value) => integer(value, 1024, 65535, "port"));
  let suggestedKey = previous?.auth?.type === "key" ? previous.auth.privateKeyPath : undefined;
  if (!suggestedKey) {
    for (const candidate of ["id_ed25519", "id_rsa"]) {
      const file = path.join(homedir(), ".ssh", candidate);
      const info = await fileInfo(file);
      if (info?.isFile() && !info.isSymbolicLink()) {
        suggestedKey = file;
        break;
      }
    }
  }
  console.error("选择本机用于登录 OpenWrt 的已有私钥，不是 OpenWrt 登录 SSH 服务器的隧道密钥。");
  console.error("私钥须已在设备授权，且可供 MCP 非交互使用；向导不会读取并展示私钥。");
  let key;
  for (;;) {
    key = await prompt("设备登录私钥路径", suggestedKey ?? "", resolvePath);
    const info = await fileInfo(key);
    if (!info?.isFile() || info.isSymbolicLink()) {
      console.error("未找到该普通文件，或它是符号链接，请重新输入路径。");
      continue;
    }
    if (insideDirectory(paths.source, key)) {
      console.error("私钥必须放在源码目录之外，请重新输入路径。");
      continue;
    }
    break;
  }
  const options = {
    router: name, identity: key, port,
    host: previous?.host ?? "127.0.0.1",
    user: previous?.username ?? "root",
    readonly: previous?.readonly === true,
    "update-router": true,
  };
  const router = await routerConfig(options);
  router.value = { ...previous, ...router.value };
  if (previous?.auth?.type === "key" && previous.auth.privateKeyPath === key) {
    router.value.auth = { ...previous.auth, ...router.value.auth };
  }
  updatedInventory(before, router, options);
  console.error(`\n设备：${name}，地址：${router.value.host}:${port}，登录用户：${router.value.username}`);
  console.error(router.value.readonly ? "保留只读限制，通用 shell 不可执行。" : "启用通用命令/脚本，但每次执行仍需审阅和客户端审批。");
  console.error("将构建程序、保存私有配置并注册当前用户的 Copilot MCP；不改服务器 SSH 服务。");
  const confirmed = await prompt(
    previous ? "更新这个设备并继续安装？其他设备和已有高级字段将保留 (y/n)" : "确认安装 (y/n)",
    previous ? "n" : "y", yesNo,
  );
  if (!confirmed) {
    console.error("已取消，未构建、写配置或注册。");
    return;
  }
  await run("npm", ["--version"]);
  await run("copilot", ["--version"]);
  await build(paths);
  await configure(paths, router, options);
  const registration = await wizardRegister(paths);
  console.error(`\n构建、配置和 MCP 注册完成（${registration}）。`);
  if (await prompt("反向隧道已建立，现在确认设备指纹 (y/n)", "n", yesNo)) {
    await wizardTrust(paths, name);
    console.error("设备信任步骤完成；打开或重启本机的 Copilot CLI 即可使用。");
  } else {
    console.error("已保留安装结果，尚未确认设备信任；隧道就绪后再次运行同一命令，选择 2。");
  }
}

async function wizard(paths) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("中文向导只用于交互终端。请在本机终端执行 sh scripts/setup.sh；MCP 必须使用 dist/index.js 或显式 start，不要把向导作为 stdio 服务器。");
  }
  console.error(`\nopenwrt-mcp 安装与维护向导
直接回车采用默认值，无需填写 JSON 或记住参数；Ctrl+C 取消。
1. 首次安装 / 添加或修改设备
2. 刷机 / 换机后确认设备指纹
3. 更新程序并检查 MCP 注册
4. 生成 SSH 服务器隧道账户审核方案（不自动修改 SSH）
0. 退出`);
  const choice = await prompt("请选择", "1", (value) => integer(value, 0, 4, "菜单编号"));
  if (choice === 0) return;
  if (choice === 1) return wizardSetup(paths);
  if (choice === 2) return wizardTrust(paths, await chooseRouter(paths));
  if (choice === 3) {
    await run("npm", ["--version"]);
    await run("copilot", ["--version"]);
    await build(paths);
    const name = await wizardRegister(paths);
    console.error(`程序更新和 MCP 注册检查完成（${name}）；请重启本机 Copilot 的 MCP 子进程。`);
    return;
  }
  const publicKey = await prompt("OpenWrt 隧道公钥文件路径", "", resolvePath);
  const port = await prompt("反向隧道端口", "22022", (value) => integer(value, 1024, 65535, "port"));
  console.error("下面是管理员待审核方案；未创建账户或修改 SSH 配置。");
  await tunnelPlan({ "public-key": publicKey, port: String(port) });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function tunnelPlan(options) {
  const account = validateName(options.account ?? "owrt-tunnel", "account");
  if (account === "root") throw new Error("use a dedicated non-root tunnel account");
  const port = integer(options.port ?? 22022, 1024, 65535, "port");
  if (!options["public-key"]) throw new Error("--public-key must name the device's PUBLIC key file (never its private key)");
  const keyFile = resolvePath(options["public-key"]);
  const handle = await open(keyFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let publicKey;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16384) throw new Error("public key must be a regular file smaller than 16 KiB");
    publicKey = (await handle.readFile("utf8")).trim();
  } finally {
    await handle.close();
  }
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]+)?$/.test(publicKey)) {
    throw new Error("--public-key must contain exactly one OpenSSH-format public key line");
  }
  console.log(`REVIEW ONLY: no user, authorized_keys, sshd configuration or firewall was changed.
Use the administrator's account policy to create ${account} with a home and public-key login.
Do not use an empty password or grant sudo. Preserve an existing management session.

Append this PUBLIC key to that account's authorized_keys (do not overwrite other keys):
${publicKey}

Merge the following into the sshd configuration that the SSH server actually loads:
Match User ${account}
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding remote
    AllowStreamLocalForwarding no
    GatewayPorts no
    PermitListen 127.0.0.1:${port}
    MaxSessions 0
    PermitTTY no
    AllowAgentForwarding no
    X11Forwarding no
    ClientAliveInterval 30
    ClientAliveCountMax 3
Match all

Review file ownership/permissions, then validate before reloading sshd:
sudo sshd -t
sudo sshd -T -C ${shellQuote(`user=${account},host=device.example,addr=192.0.2.10`)}

Replace the example source address when checking address-based Match rules.
Only reload the correct SSH service after checks pass. Do not expose port ${port} publicly.`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "help") return usage();
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js >=22 is required on the MCP host");
  if (command === "tunnel-plan") return tunnelPlan(options);
  const paths = settings(options);
  if (command === "wizard") return wizard(paths);
  if (command === "build") return build(paths);
  if (command === "setup" || command === "configure") {
    const router = await routerConfig(options);
    if (insideDirectory(paths.source, router.value.auth.privateKeyPath)) throw new Error("device private keys must be outside the source checkout");
    updatedInventory(await readJson(paths.config), router, options);
    if (command === "setup") await build(paths);
    await configure(paths, router, options);
    if (options.register) await register(paths, options);
    console.error("Next: use this helper's trust command in a terminal after the tunnel is ready.");
    return;
  }
  if (command === "show") {
    return console.log(JSON.stringify({ mcpServers: { [validateName(options.name ?? "openwrt", "MCP name")]: await entry(paths, options) } }, null, 2));
  }
  if (command === "register") return register(paths, options);
  const executable = path.join(paths.source, "dist", "index.js");
  if (!(await fileInfo(executable))) throw new Error("dist/index.js is missing; run build or setup first");
  const args = command === "trust" ? [executable, "trust", validateName(options.router, "router")] : [executable];
  await run(process.execPath, args, { env: environment(paths) });
}

main().catch((err) => {
  console.error(`openwrt-mcp setup: ${err.message}`);
  process.exitCode = 1;
});
