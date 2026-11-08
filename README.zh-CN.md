# openwrt-mcp 中文说明

[English](README.md) | [中文](README.zh-CN.md)

这是运行在 Linux 主机上的 OpenWrt SSH MCP 服务，适合频繁刷机、切换硬件和动态排查问题的场景。Copilot CLI 使用现有 typed 工具或通用命令、脚本工具连接设备，不需要模型每次重新编写 Python SSH 采集程序。

这里的“主机”是角色，不限定虚拟机：可以是物理服务器、虚拟服务器或其他受控 Linux 机器。`setup.sh` 在 **MCP 运行主机**执行；`ssh-tunnel.sh` 由客户端设备发起连接，`--host` 指定 **SSH 服务器**。下文为简化部署，示例把 MCP 和 SSH 服务器放在同一台主机上；OpenWrt 是受诊断设备。

**Node.js、npm 和 MCP 服务只安装在主机上。OpenWrt 需有 SSH 服务、发起反向连接用的 SSH 客户端和可用的 BusyBox `sh`，不需要安装 Python、Node.js、Copilot 或 SFTP。**

## 当前源码状态

增强代码位于个人 Fork [rayniel/openwrt-mcp](https://github.com/rayniel/openwrt-mcp) 的 `rayniel-improve-remote-diagnostics` 分支，没有发布增强版 npm 包。**请明确克隆这个分支；直接克隆默认 `master` 不会得到增强功能。**

下面的部署命令供你在主机上手动执行，示例不包含真实凭据。本会话没有安装全局 MCP、连接设备或实际部署到主机。

## 安装与维护向导（推荐）

**主机上不必记参数、不必填写 JSON，也不必自己执行构建和 MCP 注册命令。** 准备好 Node.js 22+、npm、Git 和 Copilot CLI 后，克隆增强分支并打开向导：

```sh
git clone --branch rayniel-improve-remote-diagnostics \
  https://github.com/rayniel/openwrt-mcp.git "$HOME/openwrt-mcp"
cd "$HOME/openwrt-mcp"
sh scripts/setup.sh
```

已有这个分支的源码时，无需重新克隆，在源码目录执行 `sh scripts/setup.sh` 即可。

这会打开中文向导。首次使用直接回车，按提示回答：

| 提示 | 怎么填 |
| --- | --- |
| 设备名字 | 直接回车，默认 `lab-device` |
| 反向隧道端口 | 常用 `22022`，直接回车；添加其他设备时自动建议未使用的端口 |
| 设备登录私钥路径 | 填主机上已有、能登录 OpenWrt 的私钥路径；发现常用密钥时给出建议，可回车选用，但不保证已在设备授权 |

核对摘要后确认，向导自动检查 npm/Copilot CLI、构建程序、保存私有设备配置并注册 MCP。**已有设备的修改默认不批准**；你需要输入 `y` 才会更新，其他设备、已有只读限制和高级字段保留。密钥内容不会打印，也不会自动安装到设备。

隧道已建立时，在同一个向导中选择现在确认设备指纹；仍会显示指纹并由你亲自确认。还没建好隧道就直接回车跳过，不用重装，之后再运行同一条命令，选 **2：刷机 / 换机后确认设备指纹**。单台设备无需重新输入名字、端口和密钥，多台设备只需选择编号。

日后仍只用 `sh scripts/setup.sh`：选 **1** 添加或修改设备，选 **2** 确认刷机后的新指纹，选 **3** 更新程序并检查 MCP 注册，选 **4** 生成主机隧道账户审核方案。菜单操作完成后退出，不需要让这个向导常驻；MCP 由主机上的 Copilot CLI 自动启动。

如果已有不同的同名 MCP 服务，向导保留它，只询问一个新名称，不覆盖现有服务。遇到错误会明确停止，不会假装安装完成或自动重试远端命令。Ctrl+C 可取消，已完成的操作不自动回滚。`node scripts/setup.mjs` 不加参数也会打开相同向导。

**前置条件仍需你准备：** 主机的 Node.js 22+、npm 和 Copilot CLI，以及设备登录密钥；脚本不使用 sudo、不自动安装系统软件。反向隧道、公钥授权和主机 SSH 管理员审核见[双端部署步骤](#参数化脚本快速部署推荐)。两端主机指纹不自动接受；通用命令和脚本仍需审阅及客户端审批。向导只用于普通交互终端，不能作为 MCP stdio 启动命令。

## 工作方式与四项改进

```text
主机上的 Copilot CLI
    → 主机上的 openwrt-mcp（stdio 子进程）
    → 127.0.0.1:<反向隧道端口>
    → OpenWrt SSH 服务

原始 stdout/stderr → 主机本地私有归档
有界摘要和执行状态 → Copilot；更多输出按需读取
```

| 改进 | 行为 |
| --- | --- |
| 完整执行结果 | 保留 stdout、stderr、退出码或 `null`、signal、耗时和派发状态；非零退出不会丢失 stdout。多步骤执行失败后停止，保留前序结果并标出未执行步骤。 |
| 通用命令与脚本 | `run_command` 支持有界超时；`run_script` 通过 SSH stdin 将多行脚本原样交给 `sh -s`，减少多层引用和转义。 |
| 本地输出归档 | 流式保存输出，返回有界头尾摘要、截断标记和不透明 `outputId`，再按行或字节读取需要的范围。 |
| 连接复用与设备信任 | 同一 router 复用 SSH 连接，每次 exec 使用独立通道；首次确认设备指纹，变化时拒绝连接并要求你重新确认，不自动重放已派发命令。 |

反向隧道由独立服务管理，MCP 本身不创建、保活或修复隧道。已有隧道可以继续使用；尚未建立时，按[下面的 OpenWrt 反向隧道步骤](#在-openwrt-上建立反向-ssh-隧道)操作。主机上的转发监听应绑定 `127.0.0.1`，不要把设备 SSH 转发端口直接暴露到公网。隧道账户的凭据和 MCP 登录 OpenWrt 的凭据是两回事。

## 参数化脚本快速部署（推荐）

主机推荐使用上面的 `sh scripts/setup.sh` 中文向导；`scripts/setup.mjs` 的参数命令继续保留给高级用法。`scripts/ssh-tunnel.sh` 是可单独复制到设备的 BusyBox/POSIX shell 脚本，负责隧道参数保存和 procd 管理。**这些脚本位于增强分支，默认 `master` 不包含它们。** 先按上面的命令克隆分支，准备主机的 Node.js 22+/npm，以及设备已有的 Dropbear/OpenSSH 客户端。

接口按 SSH 角色命名，不以某种部署环境命名；旧脚本名称和旧参数已删除，不保留兼容入口。

| `ssh-tunnel.sh` 参数 | 含义 | 默认值 |
| --- | --- | --- |
| `--host` / `--user` | 接收反向隧道的 SSH 服务器地址、登录账户 | 必填 |
| `--port` | SSH 服务器的连接端口 | `22` |
| `--remote-port` | 在 SSH 服务器回环接口上监听的转发端口 | `22022` |
| `--local-host` / `--local-port` | 客户端设备能访问的转发目标地址、端口 | `127.0.0.1:22` |
| `--identity` | 客户端用于登录 SSH 服务器的私钥文件 | `$HOME/.ssh/id_ssh_tunnel` |

`setup.mjs` 中的 `--host`、`--port`、`--user`、`--identity` 则用于 **MCP 登录设备**，不是外层隧道登录服务器。通过同机反向隧道访问设备时，MCP 的 `--port` 对应隧道的 `--remote-port`。脚本的前台连接可用于具备依赖的 POSIX 主机；`install`、`enable` 等服务管理命令仍专用于 OpenWrt procd，不会被改成其他系统的服务安装器。

自动化边界：主机的 MCP 安装、设备配置和显式 `--register` 可以自动执行；**主机 SSH 账户、公钥授权和 sshd 限制只生成待审核方案，不自动应用。** 两个方向的首次指纹确认仍由你完成，不自动接受，也不让模型代替确认。以下示例中的地址和密钥路径都需要替换。

### 1. OpenWrt：生成隧道公钥

通过已有的可信方式，仅把 `scripts/ssh-tunnel.sh` 复制到设备，例如 `/root/ssh-tunnel.sh`，不需要复制整个仓库或安装 Node/Python。在 **OpenWrt** 执行：

```sh
sh /root/ssh-tunnel.sh keygen
```

默认生成或复用 `/root/.ssh/id_ssh_tunnel`，stdout 只输出公钥整行，提示写到 stderr；不会覆盖已有私钥。把**公钥**复制成主机上的 `/path/to/device-tunnel.pub`，私钥留在设备。可用 `--identity /root/.ssh/another_tunnel_key` 指定其他专用密钥，旧固件需要时用 `--key-type ecdsa`。Dropbear 和 OpenSSH 私钥格式不同；不要把隧道私钥混用成 MCP 登录设备的私钥。

### 2. 生成 SSH 服务器审核方案

在含本轮修改的源码目录中执行 `sh scripts/setup.sh` 并选择 **4**，按提示提供公钥文件和隧道端口即可。也保留下列高级命令：

```bash
cd /path/to/openwrt-mcp/worktree
node scripts/setup.mjs tunnel-plan \
  --public-key /path/to/device-tunnel.pub --port 22022
```

默认账户名为 `owrt-tunnel`，可用 `--account` 修改。命令只打印公钥授权和 `sshd` 的 `Match User` 限制建议，不创建用户、不改文件、不重载服务。管理员按[下面的服务器授权步骤](#b-在-ssh-服务器授权公钥并限制隧道账户)审核应用，检查 `sshd -t` 和实际配置，再重载对应服务；保留原管理连接。账户只允许远程转发，监听限于 `127.0.0.1:22022`，不用 root、空密码或 sudo。

### 3. OpenWrt：保存参数，确认 SSH 服务器指纹，再启动

在 **OpenWrt** 执行：

```sh
sh /root/ssh-tunnel.sh install \
  --host server.example.com --user owrt-tunnel --remote-port 22022
sh /root/ssh-tunnel.sh trust-host
# 对照可信渠道确认主机指纹；登记后按 Ctrl+C 结束这个无远端命令的连接。
sh /root/ssh-tunnel.sh enable
```

`install` 默认保存到 `/etc/openwrt-mcp/tunnel.conf`，复制运行脚本并生成 `/etc/init.d/owrt-reverse-ssh`，**不立即连接、不启用开机启动**。`trust-host` 使用 SSH 客户端自己的 `known_hosts` 做交互登记；`enable` 才启用并启动 procd 服务，严格校验已登记的服务器主机密钥。主机指纹变化不会自动接受，需核验并按客户端规则处理旧记录，再运行 `trust-host`。

外层主机 SSH 不是 22 时加 `--port 2222`；设备 SSH 不在设备自己的 `127.0.0.1:22` 时加 `--local-host`、`--local-port`。如果 `keygen` 使用了其他密钥，`install` 也传相同 `--identity`。脚本按版本输出识别 Dropbear/OpenSSH，包括固件中指向客户端的符号链接；Dropbear 缺少严格校验或远程转发选项时拒绝启动，不能用关闭校验的参数绕过。

保存后无需每次重复连接参数：

```sh
sh /root/ssh-tunnel.sh status
sh /root/ssh-tunnel.sh stop
sh /root/ssh-tunnel.sh disable
# 再次启动：
sh /root/ssh-tunnel.sh enable
```

`stop` 停当前隧道；`disable` 只关开机启动，想两者都停需分别执行。procd 监督前台 SSH 进程，退出后每 15 秒尝试重新建隧道，**不重放 MCP 命令**。需要修改参数时，重跑 `install` 的完整参数并加 `--update`；它只允许覆盖自身标记的文件。之后执行 `enable` 应用并启动；也可在安装命令加显式 `--enable`。

只想临时前台连接、不要保存或 procd 时：

```sh
sh /root/ssh-tunnel.sh trust-host \
  --host server.example.com --user owrt-tunnel
sh /root/ssh-tunnel.sh start \
  --host server.example.com --user owrt-tunnel --remote-port 22022
```

前一条完成登记后需按 Ctrl+C，再运行后一条；`start` 保持前台，用 Ctrl+C 停止。连接参数不能与 `--config /absolute/path/tunnel.conf` 混用，避免误以为部分覆盖生效。每台设备使用不同主机转发端口，管理员的 `PermitListen`、设备的 `--remote-port` 和 MCP 的 `--port` 必须一致。

### 4. MCP 主机：用中文向导安装

先准备一份**能登录 OpenWrt** 的主机私钥，并确保设备已授权它；脚本不会向设备安装密钥。然后在 **主机** 的源码目录执行：

```bash
sh scripts/setup.sh
```

选择 **1**，常用名字和端口直接回车，提供设备登录私钥，核对并确认即可。向导自动构建、配置并注册 MCP，然后询问是否现在确认设备指纹；隧道就绪时选 `y`，不必再输入一条 `trust` 命令。详情见[安装与维护向导](#安装与维护向导推荐)。第一次信任仍最好对照设备串口/本地指纹；换机或刷机后运行同一条入口，选择 **2**。

高级用法 `node scripts/setup.mjs setup ... --register` 继续可用：它在当前源码目录缺少 `node_modules` 时执行 `npm ci`，然后 `npm run build`，原子合并当前用户的私有设备配置；显式 `--register` 再调用主机上的 `copilot mcp add`。不会 clone/fetch、提交、推送、发布或连接设备。默认连接主机的 `127.0.0.1:22022`、设备用户名 `root`，第一台设备自动设为默认。参数命令不打开向导，也不会自动确认信任。

默认路径为 `~/.config/openwrt-mcp/config.json`、`~/.config/openwrt-mcp/trusted-hosts.json`（信任库也支持 `XDG_CONFIG_HOME`）、`~/.local/state/openwrt-mcp/outputs`。注册项使用这些绝对路径和当前 Node 的绝对路径，不需要每次 export 环境变量或重新输入配置。使用自定义 `--config`、`--trust-file`、`--output-dir` 或 `--source` 时，后续命令也传相同路径。密钥、配置、信任和日志必须在源码目录之外。

默认只注册 `run_command,run_script,read_command_output,system_info,dmesg`；通用 shell/脚本仍是高风险操作，需要审阅和客户端审批。只用 typed 只读工具可以在 setup 中加：

```bash
node scripts/setup.mjs setup \
  --router lab-readonly --port 22023 \
  --identity "$HOME/.ssh/<device-login-key>" --readonly --register \
  --name openwrt-readonly --tools "system_info,dmesg"
```

`--tools` 校验当前构建实际存在的工具，不接受 `*`。`--request-timeout` 只设置新注册的客户端等待时间，默认 660,000 ms，不改变工具默认的 30,000 ms；同名注册已存在时不会覆盖，要改变等待时间或不同注册内容需在主机 Copilot CLI `/mcp edit` 审核修改，或者使用另一个 `--name`。不支持 `copilot mcp add` 的版本，可用 `show` 查看拟用 JSON，再按[手动注册说明](#5-在-copilot-cli-注册-stdio-mcp)合并，不覆盖其他服务。

常用主机命令：

| 目的 | 命令 |
| --- | --- |
| 添加第二台设备，不重复构建 | `node scripts/setup.mjs configure --router second --port 22023 --identity /absolute/device/key` |
| 明确切换默认设备 | 在 `configure` 完整参数后加 `--default` |
| 修改已有设备 | 在 `configure` 完整参数后加 `--update-router`；仅替换该 router，其余配置保留 |
| 只更新构建产物 | `node scripts/setup.mjs build` |
| 单独注册 / 查看拟用 JSON | `node scripts/setup.mjs register` / `node scripts/setup.mjs show` |
| 直接运行 stdio MCP | `node scripts/setup.mjs start`；不打印前导 stdout，也不读取交互信任输入 |
| 查看所有参数 | `node scripts/setup.mjs --help` / `sh /root/ssh-tunnel.sh --help` |

同样参数重复配置不重写文件；不同设备配置需明确 `--update-router`，不是隐式补丁，会替换该 router 的配置，包含认证方式、readonly 和可选额外字段。修改后重启 Copilot 的 MCP 子进程才能生效。主机信任、命令权限、timeout 不确定性和输出隐私仍遵循[下文的行为说明](#结果超时与大输出)。

脚本拒绝私有文件的符号链接和目录逃逸路径，拒绝把 `/`、`/tmp`、家目录等公共目录改为私有目录。主机已有私有目录权限过宽时会报错，须由你审核后调整，而非自动修改共享目录权限；OpenWrt 只收紧新建的专用目录和专用密钥文件，已有目录权限由管理员审核。配置更新有锁，文件写入失败明确报错，不自动清除未知锁。设备安装按文件原子替换，**不是整个安装的事务**；中途存储故障可能已更新部分文件，不能视为完整成功，需检查后重试；默认安装不会因此启动服务。

## 在 OpenWrt 上建立反向 SSH 隧道

这一节保留完整的手工配置参考；采用上面的脚本方案时，不需要再重复手工生成密钥、配置文件和 procd 服务，但主机 SSH 管理员审核仍需完成。以下操作分别标明在 **主机** 还是 **OpenWrt** 执行；先保留可用的主机管理连接和设备串口/本地恢复方式，不要在唯一的远程管理链路上未经核验就改 SSH 配置。

示例约定：

| 参数 | 示例 | 含义 |
| --- | --- | --- |
| 主机地址 | `server.example.com` | 替换为 OpenWrt 能主动连接的主机公网地址或域名 |
| 主机 SSH 端口 | `22` | 外层 SSH 隧道连接端口，不是设备转发端口 |
| 主机隧道账户 | `owrt-tunnel` | 专用、仅用于反向转发的公钥账户，不使用主机 root |
| 主机转发端口 | `22022` | 只监听 `127.0.0.1:22022`，MCP 连接此端口 |
| 设备 SSH 目标 | `127.0.0.1:22` | 这里的回环地址属于 **OpenWrt 设备**，不是主机 |

设备只需向主机的 SSH 端口建立出站连接，不需要在设备 WAN 上开放入站 SSH，也不需要为 `22022` 开放主机公网防火墙。主机的 SSH 入口仍需按你的网络和安全组策略放行。确认设备 SSH 服务能从设备自身的 `127.0.0.1:22` 访问；若实际端口不同或服务只绑定某个 LAN 地址，调整转发目标，而不是盲目对 WAN 开放 SSH。

### A. 在 OpenWrt 检查 SSH 客户端并生成隧道密钥

在设备终端执行：

```sh
command -v dbclient
command -v ssh
command -v dropbearkey
dbclient -V
dbclient -h
```

以下主流程使用 Dropbear 的 `dbclient`。有些固件将 Dropbear 客户端安装为 `ssh`；若没有 `dbclient`，用 `ssh -V` 或 `ssh -h` 识别实现，确认是 Dropbear 后把示例中的 `dbclient` 和 procd 的可执行路径替换为实际路径。**不能假定任意名为 `ssh` 的程序都支持 OpenSSH 参数。** 固件需包含客户端及远程端口转发支持；没有客户端时，通过与你固件版本、架构匹配的可信包源或固件构建补齐，不需要安装 Node/Python。

生成设备登录主机的专用密钥，不覆盖已有文件：

```sh
umask 077
mkdir -p /root/.ssh
chmod 700 /root/.ssh
if [ ! -e /root/.ssh/id_ssh_tunnel ]; then
  dropbearkey -t ed25519 -f /root/.ssh/id_ssh_tunnel
fi
chmod 600 /root/.ssh/id_ssh_tunnel
dropbearkey -y -f /root/.ssh/id_ssh_tunnel
```

复制输出中以 `ssh-ed25519` 开头的**公钥整行**到主机，私钥留在设备上。旧固件不支持 Ed25519 时，选用客户端和主机都支持的现代算法，例如 ECDSA；不要为了兼容开启过时的 SHA-1 签名算法。Dropbear 私钥格式与 OpenSSH 私钥不同，不能直接把这份私钥当成主机上 MCP 登录设备的私钥。

用于无人值守连接的私钥必须能非交互使用，因此它是设备上的敏感文件，应限制权限并给对应主机账户最小权限。刷机后如果这些文件未保留，需要重新生成并在主机更新该设备的授权公钥；不要把私钥烘焙进公开固件或提交 Git。

### B. 在 SSH 服务器授权公钥并限制隧道账户

由主机管理员按发行版账户策略创建 `owrt-tunnel` 专用账户和家目录，使其能用公钥认证。账户不需要 sudo 权限。账户锁定、PAM 或 `AllowUsers` 等策略也可能阻止公钥认证，按本机规则核验，不要通过设置空密码解决。

假设账户、同名主组和家目录分别为 `owrt-tunnel`、`owrt-tunnel`、`/home/owrt-tunnel`，在 **主机** 执行：

```bash
sudo install -d -o owrt-tunnel -g owrt-tunnel -m 700 /home/owrt-tunnel/.ssh
sudoedit /home/owrt-tunnel/.ssh/authorized_keys
sudo chown owrt-tunnel:owrt-tunnel /home/owrt-tunnel/.ssh/authorized_keys
sudo chmod 600 /home/owrt-tunnel/.ssh/authorized_keys
```

在编辑器中把设备公钥追加为独立一行，不覆盖已有授权。主机必须是支持下列选项的 OpenSSH 服务端；把限制合并到实际加载的 `sshd_config`，或其已启用的配置片段目录，不要覆盖整个 SSH 配置：

```text
Match User owrt-tunnel
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding remote
    AllowStreamLocalForwarding no
    GatewayPorts no
    PermitListen 127.0.0.1:22022
    MaxSessions 0
    PermitTTY no
    AllowAgentForwarding no
    X11Forwarding no
    ClientAliveInterval 30
    ClientAliveCountMax 3
Match all
```

`MaxSessions 0` 禁止该账户的 shell、exec 和 SFTP 会话，但仍允许 `-N` 端口转发；限制仅针对隧道账户，不影响主机的普通管理账户，也不影响 MCP 在内层 SSH 中登录 OpenWrt。`PermitListen` 只允许指定监听端口，`GatewayPorts no` 强制回环监听。

先验证语法，再检查该用户实际生效的配置：

```bash
sudo sshd -t
sudo sshd -T -C user=owrt-tunnel,host=device.example,addr=192.0.2.10 \
  | grep -E '^(authenticationmethods|allowtcpforwarding|gatewayports|permitlisten|maxsessions|clientaliveinterval|clientalivecountmax) '
```

`192.0.2.10` 是文档示例地址；如果还有按来源地址匹配的规则，替换成设备实际出口地址。有错误、选项不支持或实际配置与预期不符时先修正，**不要直接重启 SSH 或放宽为公网转发**。检查通过后，Debian/Ubuntu 通常执行 `sudo systemctl reload ssh`；其他发行版按实际服务名重载（常见为 `sshd`），保留现有管理会话和恢复入口。

### C. 在 OpenWrt 首次核验 SSH 服务器指纹

这里核验的是 **主机的 SSH 主机密钥**，与后面 MCP 核验 **OpenWrt 的主机密钥**是两个方向，不能混为一份信任库。

先从主机的可信管理终端获取实际 SSH 主机公钥指纹，例如：

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

若主机使用其他主机密钥，查看相应 `.pub` 文件。在 **OpenWrt** 独立交互终端执行首次连接：

```sh
dbclient -N -T -p 22 -i /root/.ssh/id_ssh_tunnel owrt-tunnel@server.example.com
```

对照主机的可信指纹后才确认保存。成功后命令保持前台连接而没有 shell，这是 `-N` 的预期行为；用 `Ctrl+C` 结束此次登记。确认已保存到该设备用户的 known-hosts 文件（root 通常为 `/root/.ssh/known_hosts`），之后使用同一个主机地址和 SSH 端口。

不要使用 `dbclient -y -y`、`StrictHostKeyChecking=no` 或无人核验的首次自动接受来省略校验。服务器主机密钥变化时，应从可信渠道核验并人工更新设备上的对应 known-hosts 记录，而不是在重连脚本中自动删除。

### D. 在 OpenWrt 前台建立反向转发

下面使用 `BatchMode`、`StrictHostKeyChecking` 和 `ExitOnForwardFailure`。不同 Dropbear 版本的扩展选项不一样；较新版本可用 `dbclient -o help` 查看支持项。先检查本机帮助和前台输出，**有 unknown/unsupported option 警告时不要直接套用无人值守示例**，应更新兼容客户端或使用下方 OpenSSH 版本，不要删掉校验选项继续部署。

在 **OpenWrt** 执行：

```sh
dbclient -N -T -K 30 -I 0 \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes \
  -i /root/.ssh/id_ssh_tunnel \
  -p 22 \
  -R 127.0.0.1:22022:127.0.0.1:22 \
  owrt-tunnel@server.example.com
```

`-R` 的含义是：在 **主机** 监听 `127.0.0.1:22022`，收到连接后经外层 SSH 隧道转交给 **OpenWrt** 的 `127.0.0.1:22`。`-K 30` 是 Dropbear 的保活间隔，帮助检测掉线，不是自动重连；`-I 0` 不因单纯空闲而退出。`ExitOnForwardFailure` 让监听端口申请失败时退出，避免“SSH 进程存在但转发没建好”的假成功；它不保证设备目标 SSH 服务可用。`BatchMode` 避免后台等待密码或交互确认。

先保持前台观察，**暂时不要加 `-f` 或 `&`**。在主机核验通过后再进入开机启动步骤。

如果设备已有的是 **OpenSSH 客户端**，可以改用：

```sh
ssh -N -T \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ConnectTimeout=15 \
  -i /root/.ssh/id_ssh_tunnel_openssh \
  -p 22 \
  -R 127.0.0.1:22022:127.0.0.1:22 \
  owrt-tunnel@server.example.com
```

此例要求另行准备 OpenSSH 格式的专用私钥，将其公钥授权到主机，并通过 OpenSSH 的交互连接核验、保存主机指纹。不要直接复用未经转换的 Dropbear 私钥，也不要把 Dropbear 的 `-K` 当成 OpenSSH 保活选项。二者择一运行，不要同时抢占同一主机监听端口。

### E. 在 MCP 主机验证，再接入 MCP

在 **主机** 执行：

```bash
ss -lnt '( sport = :22022 )'
```

确认监听仅为回环地址，没有 `0.0.0.0:22022` 或公网地址。监听存在还不代表内层 SSH 能用；按下文 MCP 安装步骤设置设备配置后，从主机交互终端执行：

```bash
node "$OPENWRT_MCP_SOURCE/dist/index.js" trust lab-device
```

核验的是经隧道访问到的 **OpenWrt** 主机指纹。随后再用 typed `system_info` 做实际认证与诊断验证。这里使用主机登录设备的密钥或密码，**不是设备用于登录主机的 `/root/.ssh/id_ssh_tunnel`**。

多设备使用不同的主机转发端口（例如 `22022`、`22023`）及相应 `PermitListen` 和 MCP router 配置。建议每设备独立隧道账户和密钥，避免某台设备占用其他设备的端口。

### F. 可选：用 OpenWrt procd 开机启动和掉线重连

只有前台连接、指纹和主机端口核验都通过后再配置。下面仅给出 **Dropbear 客户端**示例：在 OpenWrt 新建 `/etc/init.d/owrt-reverse-ssh`，如已有同名服务则先检查，别覆盖。替换主机地址、账户、端口和实际 `dbclient` 路径：

```sh
#!/bin/sh /etc/rc.common

START=99
STOP=10
USE_PROCD=1

start_service() {
    procd_open_instance
    procd_set_param command /usr/bin/dbclient \
        -N -T -K 30 -I 0 \
        -o BatchMode=yes \
        -o StrictHostKeyChecking=yes \
        -o ExitOnForwardFailure=yes \
        -i /root/.ssh/id_ssh_tunnel \
        -p 22 \
        -R 127.0.0.1:22022:127.0.0.1:22 \
        owrt-tunnel@server.example.com
    procd_set_param env HOME=/root
    procd_set_param respawn 3600 15 0
    procd_set_param stderr 1
    procd_close_instance
}
```

在 **OpenWrt** 执行：

```sh
chmod 700 /etc/init.d/owrt-reverse-ssh
sh -n /etc/init.d/owrt-reverse-ssh
```

语法无误后，先按 `Ctrl+C` 停掉 D 中的前台隧道，避免端口冲突，再执行：

```sh
/etc/init.d/owrt-reverse-ssh enable
/etc/init.d/owrt-reverse-ssh start
logread -e dbclient
```

进程必须保持前台，不能在 procd 的命令里加 `-f` 或 `&`。`respawn 3600 15 0` 使用 15 秒重连间隔、无限重试；即使启动时网络未就绪也继续尝试，认证错误或指纹变化仍然拒绝连接，不会自动接受新主机。

此处重连的是 **只负责转发的外层隧道**，不执行远端 shell 命令，也不会重放 MCP 已派发的诊断、重启或刷写操作。通过 `logread` 查看连接问题，不把重连日志循环追加到设备 Flash 文件。

停用、改参数或重新核验主机指纹时：

```sh
/etc/init.d/owrt-reverse-ssh stop
/etc/init.d/owrt-reverse-ssh disable
```

修改后可用 `restart` 重新加载，核验通过再 `enable`。刷机是否保留 init 脚本、隧道私钥和设备上的主机 known-hosts 由你的升级/备份策略决定，不保证自动保留；敏感文件不要写进公开源码或固件。

### 隧道故障速查

| 现象 | 优先检查 |
| --- | --- |
| OpenWrt 无法连接主机 | 出站路由/DNS、主机 SSH 端口、安全组/防火墙、专用账户策略 |
| 公钥认证失败 | 主机 `authorized_keys` 中的设备公钥、账户/文件权限、客户端密钥格式与算法 |
| 远程转发申请失败 | `PermitListen` 是否与明确的 `127.0.0.1:22022` 一致、端口是否被旧进程占用、转发是否被服务端禁用 |
| 主机监听出现公网地址 | 停止隧道，核验 `GatewayPorts no` 和实际 Match 配置，不能仅依赖客户端 `-R` 写了回环地址 |
| 有监听但设备 SSH 不通 | 设备端 `127.0.0.1:22` 是否可达；外层转发成功不等于内层设备服务正常 |
| 刷机后 MCP 指纹不符 | 核验的是设备新主机密钥，在主机运行 `trust lab-device`，不是改设备的主机 known-hosts |

参考：[Dropbear 客户端选项](https://manpages.debian.org/trixie/dropbear-bin/dbclient.1.en.html)、[OpenSSH 服务端限制](https://manpages.debian.org/trixie/openssh-server/sshd_config.5.en.html)、[OpenWrt procd 服务说明](https://openwrt.org/docs/guide-developer/procd-init-scripts)。不同固件和主机发行版需要按实际版本调整，本节没有在你的设备或主机上实测。

## 安装与部署

### 1. 准备 Linux 主机

使用主机的可信软件源安装 **Node.js 22 或更新版本、npm 和 Git**。已有合适版本无需重复安装：

```bash
node --version
npm --version
git --version
```

下文使用 Bash 和普通主机用户，不要求以 root 运行 MCP，也不需要 `npm install -g`。

### 2. 获取包含增强代码的源码并构建

**推荐直接克隆个人 Fork 的增强分支，然后运行向导。** 已有源码时不要覆盖工作目录；配置、密钥和原始日志始终放在仓库之外。

```bash
git clone --branch rayniel-improve-remote-diagnostics \
  https://github.com/rayniel/openwrt-mcp.git "$HOME/openwrt-mcp"
export OPENWRT_MCP_SOURCE="$HOME/openwrt-mcp"
cd "$OPENWRT_MCP_SOURCE"
sh scripts/setup.sh
```

下面保留手工部署参考；选择手工配置时，在相同源码目录构建：

```bash
cd "$OPENWRT_MCP_SOURCE"
npm ci
npm run build
test -f dist/index.js
```

需要自行核验源码时可另行运行 `npm test`。`npm ci` 使用已有 lockfile；构建产物位于 `dist`，后续 MCP 启动的是 `dist/index.js`，不是 TypeScript 源文件。

后文 MCP 配置示例使用 `/home/<host-user>/openwrt-mcp`。若你从其他 worktree 构建，替换为实际绝对路径，不要原样使用占位符。

### 3. 创建私有设备配置

让设备配置、信任库和输出归档位于源码目录之外：

```bash
umask 077
install -d -m 700 "$HOME/.config/openwrt-mcp"
install -d -m 700 "$HOME/.local/state/openwrt-mcp/outputs"
export OPENWRT_MCP_CONFIG="$HOME/.config/openwrt-mcp/config.json"
export OPENWRT_MCP_TRUST_FILE="$HOME/.config/openwrt-mcp/trusted-hosts.json"
export OPENWRT_MCP_OUTPUT_DIR="$HOME/.local/state/openwrt-mcp/outputs"
```

首次安装可从示例复制配置，**已有配置不要覆盖**：

```bash
cp -n "$OPENWRT_MCP_SOURCE/openwrt-mcp.config.example.json" "$OPENWRT_MCP_CONFIG"
chmod 600 "$OPENWRT_MCP_CONFIG"
```

用编辑器修改配置，例如设备通过反向隧道映射到主机的 `127.0.0.1:22022`：

```json
{
  "routers": {
    "lab-device": {
      "host": "127.0.0.1",
      "port": 22022,
      "username": "root",
      "auth": {
        "type": "key",
        "privateKeyPath": "/home/<host-user>/.ssh/<device-key>"
      },
      "readonly": false,
      "default": true
    }
  }
}
```

替换用户名、端口和私钥路径。该私钥必须能登录 OpenWrt，而不只是用于建立反向隧道；将已有私钥权限限制为 `600`。不要把密钥或真实配置写进仓库。

如果只允许现有 typed 只读工具，将 `readonly` 改为 `true`；此时即使传入 `confirm: true`，通用命令、脚本和 typed 写操作也不能执行。修改配置后需让 MCP 子进程重新启动才能加载新配置。

也支持密码认证：

```json
{
  "type": "password",
  "password": "${ROUTER_PASSWORD}"
}
```

这里是 `auth` 字段的替代值。密码由启动 MCP 的进程环境提供，不要用真实密码替换示例后提交文件。Copilot CLI 的 MCP 环境变量需按其版本和配置机制显式设置；不要假定当前终端中设置的秘密一定会传给子进程，也不要将密码放进命令行参数或排查日志。

配置多个设备时，为每个设备选择不同的 router 名称和对应的回环端口；只有一个设备应设置 `default: true`，也可以在每次工具调用中明确传入 `router`。

### 4. 首次确认设备主机指纹

先按[OpenWrt 反向隧道步骤](#在-openwrt-上建立反向-ssh-隧道)建立并核验隧道（已有可用隧道无需重建），再从 **主机的独立交互终端**执行：

```bash
node "$OPENWRT_MCP_SOURCE/dist/index.js" trust lab-device
```

命令读取并显示 SSH 主机的 SHA-256 指纹，然后询问是否信任。确认正确设备后输入 `y`，默认输入或拒绝不会更新信任。探测在认证前结束，不执行远端诊断命令。

首次信任属于 TOFU（首次使用时信任），**不保证第一次接触的端点就是正确设备**。能通过串口、设备本地终端或其他可信渠道核对指纹时，应先核对。

设备和指纹未改变时不会重复询问。换设备、刷机导致指纹变化，或修改了 router 的 host/port 后，连接会被阻止；核验新设备后再执行同一个命令显式登记或更新：

```bash
node "$OPENWRT_MCP_SOURCE/dist/index.js" trust lab-device
```

信任库原子写入本机文件，不读取或自动接受 OpenSSH `known_hosts`。**设备信任不等于允许写配置；模型也不能用 `confirm: true` 绕过设备信任。**

不要把 `trust` 交互放进 MCP stdio 启动命令，否则会抢占协议 stdin。用于登记的终端和 MCP 服务应使用同一个主机用户，以及相同的 `OPENWRT_MCP_CONFIG`、`OPENWRT_MCP_TRUST_FILE`。

### 5. 在 Copilot CLI 注册 stdio MCP

MCP 由主机上的 Copilot CLI 启动为本地子进程，不需要额外 HTTP 端口、Web 服务或 systemd MCP 守护进程。反向隧道的常驻服务仍由你独立管理。

支持 `copilot mcp add` 的版本可以在主机终端执行：

```bash
copilot mcp add openwrt --transport stdio \
  --tools "run_command,run_script,read_command_output,system_info,dmesg" \
  --timeout 660000 \
  --env "OPENWRT_MCP_CONFIG=$OPENWRT_MCP_CONFIG" \
  --env "OPENWRT_MCP_TRUST_FILE=$OPENWRT_MCP_TRUST_FILE" \
  --env "OPENWRT_MCP_OUTPUT_DIR=$OPENWRT_MCP_OUTPUT_DIR" \
  -- node "$OPENWRT_MCP_SOURCE/dist/index.js"
```

这条命令会在你执行时修改 **主机当前用户**的 Copilot CLI MCP 配置。本会话没有执行注册。若已有同名服务，先查看或编辑它，不要覆盖现有配置。客户端超时应大于工具的 `timeoutMs`，并给归档收尾留出时间；示例中的 660,000 ms 是客户端等待时间，不会改变远端命令默认 30,000 ms 的超时。

不支持该子命令的版本，可在主机的 Copilot CLI 内使用 `/mcp add`：选择 Local/STDIO，填写 `node /实际绝对路径/dist/index.js`、相同环境变量和上述工具白名单，然后保存。也可以把下列条目**合并**到现有 MCP 配置，不要用它覆盖其他服务器：

```json
{
  "mcpServers": {
    "openwrt": {
      "type": "stdio",
      "command": "node",
      "args": ["/home/<host-user>/openwrt-mcp/dist/index.js"],
      "env": {
        "OPENWRT_MCP_CONFIG": "/home/<host-user>/.config/openwrt-mcp/config.json",
        "OPENWRT_MCP_TRUST_FILE": "/home/<host-user>/.config/openwrt-mcp/trusted-hosts.json",
        "OPENWRT_MCP_OUTPUT_DIR": "/home/<host-user>/.local/state/openwrt-mcp/outputs"
      },
      "tools": ["run_command", "run_script", "read_command_output", "system_info", "dmesg"]
    }
  }
}
```

用户配置通常位于 `~/.copilot/mcp-config.json`，设置 `COPILOT_HOME` 时位置会变化。不同版本的字段和操作入口可能不同；以[官方 Copilot CLI MCP 文档](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)为准。若使用版本管理器安装 Node，确保 Copilot 启动环境能找到正确的 `node`，也可以将 `command` 改为 `command -v node` 显示的绝对路径。

按当前任务只启用需要的工具，避免默认启用 `*`。客户端白名单不是服务端授权边界；通用 shell 一直是高风险能力，需要你审阅命令或脚本并处理客户端许可提示。

### 6. 核验部署

在主机的 Copilot CLI 中使用 `/mcp` 或 `/mcp show openwrt` 查看状态和工具列表。然后先请求对 `lab-device` 调用 `system_info`，检查实际设备和结果；这一步会连接设备，应由你执行。

需要通用命令时，先预览，再审批。例如 `run_command` 输入：

```json
{
  "router": "lab-device",
  "command": "uname -a",
  "timeoutMs": 30000
}
```

不传 `confirm` 时仅返回预览；审阅后执行需要 `confirm: true`，但这个参数本身不是人类授权证明，仍需结合 Copilot 的权限机制使用。

多行脚本使用 `run_script`，例如：

```json
{
  "router": "lab-device",
  "script": "uname -a\ncat /etc/openwrt_release\n",
  "timeoutMs": 60000
}
```

脚本不需要再嵌套成 `sh -c '...'`。每次 exec 是独立 shell，跨调用不保留 `cd`、环境变量或 shell 状态。脚本内部的错误处理由脚本决定；需要遇错停止时显式编写相应的 shell 控制逻辑。

## 结果、超时与大输出

### JSON 返回位置

| 情况 | `data` | `execution.steps` |
| --- | --- | --- |
| typed 工具正常成功 | 保留原有解析结果 | 仅执行元数据，不重复返回 stdout/stderr |
| `run_command` / `run_script` 正常成功 | 完整 CommandResult，含有界 stdout/stderr | 仅执行元数据，不重复输出 |
| 执行失败、归档失败或输出超过摘要范围 | 不返回 | 包含各步骤完整结果、前序输出和 `not_executed` 步骤 |
| `read_command_output` 成功 | 本次读取的范围及读取元数据 | 不返回 |

失败输出读取 `execution.steps`，不是 `data.steps`。`ok: false` 不一定意味着远端命令失败：例如 `status: "completed"`、`code: 0` 但输出摘要截断时，需要读取归档再解释结果，不应因此重新执行命令。

`completed` 包括退出码 0 和非零；连接失败是 `connection_error`，认证失败是 `authentication_error`，未登记信任是 `host_untrusted`，指纹不符是 `host_key_mismatch`，exec 通道失败是 `channel_error`，超时是 `timeout`，派发后断连是 `interrupted`。退出码未知用 `null`，不会伪造为 0。

`dispatchState` 表示 `not_dispatched`（未派发）、`possibly_dispatched`（可能已派发）或 `dispatched`（已派发）。超时可能发生在 exec 回调返回之前，结果会保留不确定状态；晚到通道会排空、关闭，不再发送脚本 stdin，也不会修改已经结束的结果或归档。

### 超时和重试边界

`run_command` 和 `run_script` 的 `timeoutMs` 范围为 **1,000–600,000 ms**，默认 30,000 ms。到期只会尽可能关闭本地 SSH 通道，**不能据此断言远端进程已经被杀死**。

只有明确未派发的请求才允许有限恢复；任意已派发或可能已派发的命令都不自动重放，尤其是重启、刷写和写配置操作。失败后下一次独立调用可以重新连接，但先判断设备实际状态，不要盲目重复危险操作。

### 输出读取与隐私

stdout/stderr 流式写入主机本地归档。每个流的摘要使用 8 KiB 源字节预算；非连续的头尾之间插入 `\n[... output omitted ...]\n`，标记不是设备原始输出。UTF-8 字符不会跨省略区域拼接，截断边界的不完整字符会从摘要中剔除，原始归档仍可按需读取。

按行读取 `read_command_output`：

```json
{
  "outputId": "<从执行结果复制的 outputId>",
  "stream": "stderr",
  "mode": "lines",
  "startLine": 1,
  "maxLines": 100,
  "maxBytes": 16384
}
```

按字节读取：

```json
{
  "outputId": "<从执行结果复制的 outputId>",
  "stream": "stdout",
  "mode": "bytes",
  "offsetBytes": 0,
  "maxBytes": 16384
}
```

续读使用返回的 `nextOffsetBytes`；行模式也可使用 `nextLine`，但长行被字节上限截断时，使用字节游标续读更准确。不要自己拼路径，`outputId` 不是文件名或设备地址。

归档默认总配额 512 MiB、单次执行 stdout/stderr 合计上限 16 MiB、保留 7 天；读取请求上限 64 KiB，行模式每次最多 1,000 行。清理在归档初始化和后续创建归档时触发，不是一个独立后台定时任务。达到配额会明确标记归档截断，存储故障会返回归档错误；不能把摘要当成完整输出。

归档目录、文件分别限制为私有权限；读取拒绝非法 ID 和符号链接逃逸。归档失败或到期后可能没有可读取的 `outputId`，结果会显式反馈。日志存储在主机，不写回光猫 Flash。

**任意命令输出不会自动脱敏。** 本地日志可能含密码、设备标识、地址或其他敏感信息；返回的摘要和你请求读取的范围会进入模型上下文。只读取当前需要的部分，不要把原始归档、私钥、信任库或真实设备配置提交 Git，也不要额外上传给其他服务。

## 常见问题与维护

| 现象 | 检查方式 |
| --- | --- |
| 找不到 `dist/index.js` | 确认使用包含增强修改的源码目录，运行 `npm ci` 和 `npm run build`，核对 MCP 启动路径。 |
| MCP 启动找不到配置 | 在 MCP 条目的 `env` 中设置配置的绝对路径；不设置时默认读取进程工作目录下的 `openwrt-mcp.config.json`。 |
| `host_untrusted` / `host_key_mismatch` | 独立终端运行同一配置下的 `trust lab-device`，核验并显式确认；不要用工具 `confirm` 或关闭验证绕过。 |
| `connection_error` | 检查既有反向隧道、主机回环端口和设备 SSH 服务，不要把 MCP 当成隧道管理器。 |
| `authentication_error` | 检查用于登录设备的用户名和密钥/密码；主机指纹登记不代替设备认证。 |
| `readonly` 拒绝通用工具 | 这是预期行为。仅在允许 raw shell 时改为 `false`，重新启动 MCP 并保留客户端审批。 |
| 归档失败、截断或 ID 过期 | 检查主机磁盘、目录权限、容量/留存限制；已失去的原始数据无法靠再次读取恢复，不要盲目重跑命令。 |

更新包含增强代码的源码后，在对应目录重新构建，并重启 Copilot 的 MCP 子进程；保持主机私有配置和信任库不变。升级前先保存自己的未提交修改，不要用重置或覆盖工作目录的方式更新。停用时从 Copilot CLI 中禁用该 MCP 即可，不影响独立维护的反向隧道。

已有 typed 工具的正常 `data` 保持兼容，但升级后必须先登记设备主机信任。没有真实主机/设备凭据，本轮不能保证你的网络、认证、隧道或硬件部署已经通过实机验证。
