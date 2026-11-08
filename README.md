# openwrt-mcp

[English](README.md) | [中文说明与安装部署](README.zh-CN.md)

An MCP server for exploring and administering OpenWrt routers over SSH. It keeps
the existing typed tools and adds a bounded raw-command/script execution path,
local output archives, and explicit SSH host-key trust.

Names describe roles, not a virtualization environment: the **MCP host** runs
Node.js/Copilot, the **SSH server** accepts a reverse tunnel, and the client
device initiates it. A host can be a physical server, a virtual server or
another controlled Linux machine. The examples use the same machine for MCP
and the SSH server.

## One-command setup

Install Node.js 22+, npm, Git and Copilot CLI on the MCP host, then clone the
enhanced branch and open the wizard:

```sh
git clone --branch rayniel-improve-remote-diagnostics \
  https://github.com/rayniel/openwrt-mcp.git "$HOME/openwrt-mcp"
cd "$HOME/openwrt-mcp"
sh scripts/setup.sh
```

This opens a Chinese interactive wizard; no flags or JSON editing are needed.
Press Enter for the device name and tunnel port defaults, then provide an
existing host private key already authorized to log into OpenWrt. A conventional
key is suggested when available, but authorization is not assumed. After a
summary and confirmation, the wizard checks npm/Copilot CLI, builds, saves
private configuration and registers MCP. Existing-router updates default to
**no** and preserve other routers, readonly restrictions and advanced fields.

If the tunnel is ready, choose to enroll the device fingerprint in the same
flow. Otherwise skip it and run the same command later, choosing menu item
**2**. That item also handles reflashing/replacement; a single configured
device needs no repeated name, port or key input. Other menu items add/update
devices, rebuild/check registration, or print a review-only host SSH plan.
`node scripts/setup.mjs` without arguments opens the same wizard.

Node.js 22+, npm, Copilot CLI and device authorization remain prerequisites;
the wizard does not install system software, change sshd or accept host keys
for you. It runs only in an interactive terminal and must **not** be used as
the MCP stdio command. Existing parameter-based commands below remain supported.
See the [Chinese easy-mode guide](README.zh-CN.md#安装与维护向导推荐).

## Parameterized deployment helpers

The helpers are in the fork's `rayniel-improve-remote-diagnostics` branch;
cloning the default `master` does not provide these enhancements. No enhanced
npm release is available. Node.js 22+/npm and Copilot CLI run on the Linux host,
not on OpenWrt.

On the **host**, one command restores missing dependencies, builds, merges a
private router configuration, and explicitly registers the user-level MCP:

```bash
cd /path/to/openwrt-mcp/worktree
node scripts/setup.mjs setup --router lab-device --port 22022 \
  --identity "$HOME/.ssh/<device-login-key>" --register
node scripts/setup.mjs trust --router lab-device
```

The key must already be authorized to log into the device. `setup` does not
connect to it; run `trust` interactively only after the reverse tunnel is ready.
Configuration, trust and outputs default to private locations outside the
checkout. Registration records absolute paths, so no repeated exports are
needed. Existing routers require `--update-router` for replacement; other
routers are preserved. Existing different MCP registrations are never
overwritten. Choose actual tools with `--tools`; `*` is rejected. Use
`--readonly --tools system_info,dmesg` to restrict operation to typed reads.

Copy only `scripts/ssh-tunnel.sh` to the **OpenWrt device**, for example as
`/root/ssh-tunnel.sh`:

```sh
sh /root/ssh-tunnel.sh keygen
```

Keep the private key on the device and copy the printed **public** key to a
file on the host. The following host command prints a review-only authorization
and sshd restriction plan; it does not create users or change the SSH service:

```bash
node scripts/setup.mjs tunnel-plan --public-key /path/to/device-tunnel.pub \
  --port 22022
```

After an administrator reviews/applies that plan, on **OpenWrt**:

```sh
sh /root/ssh-tunnel.sh install \
  --host server.example.com --user owrt-tunnel --remote-port 22022
sh /root/ssh-tunnel.sh trust-host
# Verify the host fingerprint; Ctrl+C after interactive enrollment.
sh /root/ssh-tunnel.sh enable
```

`install` saves parameters and a procd service but does not start it. Subsequent
`start`, `trust-host` and service controls no longer need all connection parameters.
`stop`, `disable` and `status` act only on the marked service; `disable` does
not stop a running connection. `install --update` requires the full intended
parameters and only replaces managed files; then `enable` applies them, or use
explicit `--enable` during installation. This is atomic per file, not a
whole-install transaction; storage errors are reported and may leave a partial
update. The foreground SSH process strictly verifies known host keys and procd
reconnects after exit, without replaying MCP commands.

Use `configure` to add routers without rebuilding, `build` to update compiled
code, `show` to print a registration entry, or `register` separately.
`start` runs clean MCP stdio without trust prompts. Both helpers provide
`--help`. Host private paths must stay outside the checkout; existing
non-private directories require an operator review, not an automatic chmod.
Explicit `--request-timeout` only sets new registrations; use the host CLI's
MCP editor to review/change an existing registration's timeout.
See the [Chinese quickstart](README.zh-CN.md#参数化脚本快速部署推荐)
for defaults, optional ports/paths, approvals and manual administrator steps.

The script interfaces use role-neutral names without legacy aliases or
wrappers. `setup.sh`/`setup.mjs` handle installation and maintenance;
`ssh-tunnel.sh` handles the reverse SSH tunnel. Tunnel `--host`, `--user`,
`--port` and `--identity` select the SSH server and client key;
`--remote-port` selects its loopback listener, and `--local-host`/`--local-port`
select the target reachable from the client. In `setup.mjs`, those SSH options
instead select the device MCP logs into: its `--port` is the tunnel's
`--remote-port` when using the same host. Foreground tunneling remains POSIX;
service installation/control still requires OpenWrt procd.

## Run on a Linux host

**Use the fork's `rayniel-improve-remote-diagnostics` branch for these
enhancements.** Cloning the default `master` does not install them; the
enhancements have not been released as an npm package.

Install Node.js 22 or newer and Git using your host's approved package source.
The setup wizard handles the build and configuration. For manual installation,
clone and build the same branch:

```bash
git clone --branch rayniel-improve-remote-diagnostics \
  https://github.com/rayniel/openwrt-mcp.git ~/openwrt-mcp
cd ~/openwrt-mcp
npm ci
npm run build
```

For the manual configuration steps below, copy the example only when the
destination does not already exist, then edit it for the device:

```bash
cp -n openwrt-mcp.config.example.json ~/openwrt-mcp.config.json
chmod 600 ~/openwrt-mcp.config.json
```

The examples below use `~/openwrt-mcp` as the checkout path. Replace it, including
the absolute path in the MCP entry, with the actual worktree path when building
locally.

Edit the copied config. For an OpenWrt device that initiates a reverse SSH tunnel
to the host, configure MCP to connect to the host's loopback endpoint:

```json
{
  "routers": {
    "lab-device": {
      "host": "127.0.0.1",
      "port": 22022,
      "username": "root",
      "auth": { "type": "key", "privateKeyPath": "/home/<host-user>/.ssh/<device-key>" },
      "readonly": false,
      "default": true
    }
  }
}
```

The reverse tunnel is a separate, persistent service managed by the operator;
this MCP does not create or repair it. Bind its remote listener to `127.0.0.1`
on the host and restrict the tunnel account/key. Each MCP `exec` opens a fresh
remote shell, so `cd`, exported variables, and shell state do not persist across
calls.

For device-side Dropbear/OpenSSH commands, restricted host account setup, host-key
checks, and optional OpenWrt procd startup/reconnection, see the
[OpenWrt reverse SSH tunnel guide](README.zh-CN.md#在-openwrt-上建立反向-ssh-隧道).

Set `OPENWRT_MCP_CONFIG` to the config path in the Copilot CLI MCP entry. Keep
the config and SSH key private, use environment-variable references for
passwords where needed, and never commit real credentials.

## Copilot CLI MCP registration

Add a local **stdio** server entry in the Copilot CLI MCP configuration on the
host. The file location and tool-allowlist syntax can vary with CLI versions; use
the CLI's supported MCP configuration mechanism. Example entry:

```json
{
  "mcpServers": {
    "openwrt": {
      "type": "stdio",
      "command": "node",
      "args": ["/home/<host-user>/openwrt-mcp/dist/index.js"],
      "env": {
        "OPENWRT_MCP_CONFIG": "/home/<host-user>/openwrt-mcp.config.json",
        "OPENWRT_MCP_OUTPUT_DIR": "/home/<host-user>/.local/state/openwrt-mcp/outputs",
        "OPENWRT_MCP_TRUST_FILE": "/home/<host-user>/.config/openwrt-mcp/trusted-hosts.json"
      },
      "tools": ["run_command", "run_script", "read_command_output", "system_info", "dmesg"]
    }
  }
}
```

Only allowlist the tools needed for the current task. A client-side allowlist is
not a server-side authorization boundary, and `confirm: true` is a tool-call
parameter—not proof of human approval. The MCP client may provide its own
approval UI; review raw shell/script previews and use `readonly: true` when
execution should be blocked. `readonly` blocks raw shell and script execution
as well as typed mutations.

## First use and host-key changes

Before any SSH command can run, enroll the device's SSH host key once from the
host terminal:

```bash
cd ~/openwrt-mcp
OPENWRT_MCP_CONFIG=~/openwrt-mcp.config.json node dist/index.js trust lab-device
```

The command displays the observed SHA-256 fingerprint and asks for explicit
approval. First-use trust is TOFU and does not prove that the endpoint is the
intended device; compare the fingerprint with a trusted source such as the
device console whenever possible. The local trust database is stored outside
the repository at `~/.config/openwrt-mcp/trusted-hosts.json` by default, with
private directory/file permissions. Override it with `OPENWRT_MCP_TRUST_FILE`.
The server does not read or silently trust OpenSSH `known_hosts`.

If a device is replaced or reflashed and its key changes, the server refuses
that connection. Inspect the new device, then run the same `trust <router>`
command and explicitly approve updating the saved fingerprint. Host-key trust
is separate from permission to run a command.

## Execution and output behavior

- Typed tools keep their existing `data` values on normal, complete output.
  Results now also include an additive top-level `execution.steps` array with
  status and output metadata, **without `stdout` or `stderr` payloads**.
  Successful `run_command` and `run_script` calls return the full command
  result (including bounded stdout/stderr excerpts) only in `data`; their
  `execution.steps` also contain metadata only. Failed executions, archive
  failures, and output exceeding the excerpt limit return `ok: false` with
  full step results only in `execution.steps` and no `data`. That array retains
  prior output and unexecuted steps. Read raw failure output from
  `execution.steps`, not `data.steps`; the same raw output is never serialized
  in both places. Local output reads return their range only in `data`.
- Command outcomes distinguish `completed` (including non-zero exit codes),
  `connection_error`, `authentication_error`, `host_untrusted`,
  `host_key_mismatch`, `channel_error`, `timeout`, and `interrupted`. An unknown
  exit code is `null`, never assumed to be zero. Failed command sequences stop;
  results include completed steps and mark the remaining steps `not_executed`.
- `run_command` accepts `timeoutMs` from 1,000 to 600,000 (default 30,000).
  `run_script` sends a multi-line script over SSH stdin to `sh -s`, suitable for
  BusyBox. Both are raw, risky shell execution. Separate calls do not retain
  `cd` or environment changes.
- On timeout, the local SSH channel is closed where possible, but that does
  **not** prove the remote process was killed. A
  dispatched command that loses its connection is reported as interrupted and
  is never automatically replayed. A later call can reconnect normally.
  If timeout occurs before the exec callback arrives, dispatch remains
  `possibly_dispatched`; a late channel is drained and closed without sending
  script stdin or replaying the command. Later output does not alter the
  finalized result or archive.
- Stdout and stderr are streamed to the host-local archive. Results carry bounded
  head/tail excerpts, byte counts, truncation flags, and an opaque `outputId`.
  Each stream's excerpt uses an 8 KiB source-byte budget, including an inserted
  `\n[... output omitted ...]\n` marker between non-adjacent head and tail
  fragments. UTF-8 code points cut at excerpt boundaries are excluded rather
  than joined across the omitted region; the marker is not raw device output.
  `read_command_output` retrieves bounded byte or line ranges (at most 64 KiB
  per call). The archive has a 512 MiB total quota, a 16 MiB per-command cap,
  and seven-day retention; expired entries are cleaned during archive
  initialization. Storage failures are reported explicitly. If a limit is
  reached, the archive is marked truncated rather than presented as complete.
- Archive files are local to the host, not the router's flash, and are not
  automatically redacted. They may contain credentials, serials, addresses, or
  other sensitive diagnostics. Read and share only the ranges needed; no log is
  automatically forwarded to another model or service.

## Configuration

Copy `openwrt-mcp.config.example.json` and change the router host/port, SSH
authentication, and `readonly` setting. Password references use the
`${ENV_VAR}` form, for example:

```json
{
  "auth": { "type": "password", "password": "${ROUTER_PASSWORD}" }
}
```

Set `OPENWRT_MCP_CONFIG` to choose another config file. The SSH identity and
trust database are local host files and must not be added to Git.
