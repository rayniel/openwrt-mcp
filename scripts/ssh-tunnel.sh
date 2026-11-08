#!/bin/sh
# Managed by openwrt-mcp/scripts/ssh-tunnel.sh
set -eu

fail() {
    printf 'openwrt-mcp tunnel: %s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'HELP'
Usage: sh scripts/ssh-tunnel.sh <command> [options]

  keygen     Generate/reuse a dedicated tunnel key; print PUBLIC key only
  trust-host Interactive SSH server host-key confirmation (Ctrl+C after enrollment)
  start      Strict foreground reverse tunnel; no remote command
  install    Save parameters and a procd service; never overwrite unless --update
  enable     Enable and start the installed procd service
  stop       Stop only the installed tunnel service
  disable    Disable automatic startup (use stop as well to end a running tunnel)
  status     Check whether the installed service is running

Connection: --host HOST --user USER [--port 22] [--remote-port 22022]
            [--local-host 127.0.0.1] [--local-port 22]
            [--identity "$HOME/.ssh/id_ssh_tunnel"] [--client PATH]
Keygen:     --key-type ed25519|ecdsa
Saved:      --config PATH (cannot be mixed with connection parameters)
Install:    --state-dir /etc/openwrt-mcp --init-dir /etc/init.d [--update] [--enable]

No passwords, insecure host-key flags, remote shell commands or package installs.
The SSH server fingerprint must be enrolled before non-interactive start/enable.
--port is the server SSH port; --remote-port listens on its loopback interface.
--local-host/--local-port select the target reachable from the client device.
start works on POSIX hosts; install/service controls require OpenWrt procd.
HELP
}

[ "$#" -gt 0 ] || { usage; exit 0; }
action=$1
shift
case "$action" in
    --help|help) usage; exit 0 ;;
    keygen|trust-host|start|install|enable|stop|disable|status) ;;
    *) fail "unknown command '$action'; use --help" ;;
esac

host=
user=
port=22
remote_port=22022
local_host=127.0.0.1
local_port=22
home=${HOME:-/root}
identity="$home/.ssh/id_ssh_tunnel"
client=
key_type=ed25519
state_dir=/etc/openwrt-mcp
init_dir=/etc/init.d
config=
update=0
activate=0
connection_options=0
seen=" "

while [ "$#" -gt 0 ]; do
    option=$1
    shift
    [ "$option" != "--help" ] || { usage; exit 0; }
    case "$seen" in *" $option "*) fail "duplicate option $option" ;; esac
    seen="$seen$option "
    case "$option" in
        --update) [ "$action" = install ] || fail "--update is only valid for install"; update=1; continue ;;
        --enable) [ "$action" = install ] || fail "--enable is only valid for install"; activate=1; continue ;;
        --host|--user|--port|--remote-port|--local-host|--local-port|--identity|--client|--key-type|--state-dir|--init-dir|--config) ;;
        *) fail "unsupported option '$option'" ;;
    esac
    case "$action" in
        keygen)
            case "$option" in --identity|--client|--key-type) ;; *) fail "$option is not valid for keygen" ;; esac
            ;;
        enable|stop|disable|status)
            [ "$option" = --init-dir ] || fail "$option is not valid for service controls"
            ;;
        trust-host|start)
            case "$option" in --init-dir) fail "$option is only valid for install/service controls" ;; esac
            ;;
    esac
    [ "$#" -gt 0 ] || fail "$option requires a value"
    value=$1
    shift
    case "$value" in --*) fail "$option requires a value" ;; esac
    case "$option" in
        --host) host=$value; connection_options=1 ;;
        --user) user=$value; connection_options=1 ;;
        --port) port=$value; connection_options=1 ;;
        --remote-port) remote_port=$value; connection_options=1 ;;
        --local-host) local_host=$value; connection_options=1 ;;
        --local-port) local_port=$value; connection_options=1 ;;
        --identity) identity=$value; connection_options=1 ;;
        --client) client=$value; connection_options=1 ;;
        --key-type) [ "$action" = keygen ] || fail "--key-type is only valid for keygen"; key_type=$value ;;
        --state-dir) state_dir=$value ;;
        --init-dir) init_dir=$value ;;
        --config) config=$value ;;
    esac
done

validate_path() {
    case "$1" in /*) ;; *) fail "$2 must be an absolute path" ;; esac
    case "$1" in *//*|*/./*|*/../*|*/.|*/..|?*/) fail "$2 must use a normalized absolute path without trailing slashes or dot segments" ;; esac
    case "$1" in *'
'*|*"$(printf '\r')"*) fail "$2 cannot contain newlines" ;; esac
    [ "$2" != --client ] || return 0
    ancestor=${1%/*}
    [ -n "$ancestor" ] || ancestor=/
    while [ "$ancestor" != / ]; do
        [ ! -L "$ancestor" ] || fail "$2 has a symlinked ancestor: $ancestor"
        ancestor=${ancestor%/*}
        [ -n "$ancestor" ] || ancestor=/
    done
}

validate_host() {
    case "$1" in ""|-*|*[!A-Za-z0-9.-]*) fail "$2 must be an IPv4 address or DNS hostname" ;; esac
}

validate_port() {
    case "$1" in ""|*[!0-9]*|??????*) fail "$2 must be an integer from 1 to 65535" ;; esac
    [ "$1" -ge 1 ] && [ "$1" -le 65535 ] || fail "$2 must be between 1 and 65535"
}

regular_file() {
    [ ! -L "$1" ] && [ -f "$1" ] && [ -r "$1" ] || fail "$2 must be a readable regular file, not a symlink"
}

private_dir() {
    case "$1" in /|/tmp|/etc|/root|/home|/usr|/var) fail "choose a dedicated private subdirectory: $1" ;; esac
    [ ! -L "$1" ] || fail "private directory must not be a symlink: $1"
    if [ ! -e "$1" ]; then
        mkdir -p "$1"
        chmod 700 "$1"
    fi
    [ -d "$1" ] && [ ! -L "$1" ] || fail "unsafe private directory: $1"
}

validate_path "$state_dir" --state-dir
validate_path "$init_dir" --init-dir
service="$init_dir/owrt-reverse-ssh"
case "$action" in
    enable|stop|disable|status)
        [ "$connection_options" -eq 0 ] && [ -z "$config" ] || fail "service controls do not accept connection parameters"
        regular_file "$service" "installed procd service"
        grep -Fxq '# Managed by openwrt-mcp/scripts/ssh-tunnel.sh' "$service" || fail "refusing to control an unrelated service"
        case "$action" in
            enable) "$service" enable; "$service" start ;;
            status)
                if "$service" running; then printf 'Tunnel service is running.\n'
                else fail "tunnel service is not running"; fi
                ;;
            *) "$service" "$action" ;;
        esac
        exit 0
        ;;
esac

if [ -z "$config" ] && [ "$connection_options" -eq 0 ] && [ "$action" != keygen ]; then
    if [ -f "$state_dir/tunnel.conf" ]; then config="$state_dir/tunnel.conf"; fi
fi
if [ -n "$config" ]; then
    [ "$connection_options" -eq 0 ] || fail "--config cannot be mixed with connection parameters"
    validate_path "$config" --config
    regular_file "$config" configuration
    grep -Fxq '# Managed by openwrt-mcp/scripts/ssh-tunnel.sh' "$config" || fail "unrecognized tunnel configuration"
    config_keys=" "
    while IFS='=' read -r name value || [ -n "$name" ]; do
        case "$name" in ""|\#*) continue ;; esac
        case "$config_keys" in *" $name "*) fail "duplicate configuration field $name" ;; esac
        config_keys="$config_keys$name "
        case "$name" in
            host) host=$value ;;
            user) user=$value ;;
            port) port=$value ;;
            remote_port) remote_port=$value ;;
            local_host) local_host=$value ;;
            local_port) local_port=$value ;;
            identity) identity=$value ;;
            client) client=$value ;;
            home) home=$value ;;
            *) fail "unknown configuration field $name" ;;
        esac
    done < "$config"
    for required in host user port remote_port local_host local_port identity client home; do
        case "$config_keys" in *" $required "*) ;; *) fail "missing configuration field $required" ;; esac
    done
fi

validate_path "$identity" --identity
validate_path "$home" HOME
export HOME="$home"
if [ -z "$client" ]; then
    if command -v dbclient >/dev/null 2>&1; then client=$(command -v dbclient)
    elif command -v ssh >/dev/null 2>&1; then client=$(command -v ssh)
    else fail "no SSH client found; supply --client or install a compatible firmware client"; fi
else
    client=$(command -v "$client") || fail "SSH client not found"
fi
validate_path "$client" --client
[ -f "$client" ] && [ -x "$client" ] || fail "SSH client must be an executable file (firmware symlinks are supported)"
if version=$("$client" -V 2>&1); then :; else :; fi
case "$version" in
    *Dropbear*) client_kind=dropbear ;;
    *OpenSSH*) client_kind=openssh ;;
    *) fail "cannot identify SSH implementation; neither Dropbear nor OpenSSH reported" ;;
esac

if [ "$action" = keygen ]; then
    case "$key_type" in ed25519|ecdsa) ;; *) fail "--key-type must be ed25519 or ecdsa" ;; esac
    [ ! -L "$identity" ] || fail "identity must not be a symlink"
    private_dir "$(dirname "$identity")"
    umask 077
    if [ ! -e "$identity" ]; then
        if [ "$client_kind" = dropbear ]; then
            command -v dropbearkey >/dev/null 2>&1 || fail "dropbearkey is missing"
            dropbearkey -t "$key_type" -f "$identity" >&2
        else
            command -v ssh-keygen >/dev/null 2>&1 || fail "ssh-keygen is missing"
            [ ! -e "$identity.pub" ] && [ ! -L "$identity.pub" ] || fail "public key path already exists"
            ssh-keygen -q -t "$key_type" -N '' -f "$identity"
        fi
    fi
    regular_file "$identity" identity
    chmod 600 "$identity"
    printf 'PUBLIC key for the SSH server authorized_keys; keep the private file on the client:\n' >&2
    if [ "$client_kind" = dropbear ]; then
        public_output=$(dropbearkey -y -f "$identity") || fail "could not read the Dropbear public key"
        public_key=$(printf '%s\n' "$public_output" | awk '$1 == "ssh-ed25519" || $1 ~ /^ecdsa-sha2-nistp(256|384|521)$/ { print }')
        [ -n "$public_key" ] || fail "no supported public key was returned"
        case "$public_key" in *'
'*) fail "multiple public key lines were returned" ;; esac
        printf '%s\n' "$public_key"
    else
        ssh-keygen -y -f "$identity"
    fi
    exit 0
fi

validate_host "$host" --host
case "$user" in ""|-*|*[!A-Za-z0-9_.-]*) fail "--user must be a valid dedicated SSH server account name" ;; esac
[ "$user" != root ] || fail "use a dedicated non-root SSH tunnel account"
validate_host "$local_host" --local-host
validate_port "$port" --port
validate_port "$remote_port" --remote-port
[ "$remote_port" -ge 1024 ] || fail "--remote-port must be >=1024 for the non-root server account"
validate_port "$local_port" --local-port
regular_file "$identity" identity

if [ "$client_kind" = dropbear ]; then
    if help=$("$client" -h 2>&1); then :; else :; fi
    printf '%s\n' "$help" | grep -q -- '-R' || fail "Dropbear client lacks remote port forwarding"
    if extended=$("$client" -o help 2>&1); then :; else :; fi
    for required in BatchMode StrictHostKeyChecking ExitOnForwardFailure; do
        printf '%s\n' "$extended" | grep -qw "$required" || fail "Dropbear lacks $required; use a compatible client, not insecure flags"
    done
fi

if [ "$action" = trust-host ]; then
    printf 'Verify the SSH server fingerprint out-of-band before accepting it. Ctrl+C after enrollment.\n' >&2
    exec "$client" -N -T -o StrictHostKeyChecking=ask -i "$identity" -p "$port" "$user@$host"
fi
if [ "$action" = start ]; then
    forward="127.0.0.1:$remote_port:$local_host:$local_port"
    if [ "$client_kind" = dropbear ]; then
        exec "$client" -N -T -K 30 -I 0 -o BatchMode=yes -o StrictHostKeyChecking=yes \
            -o ExitOnForwardFailure=yes -i "$identity" -p "$port" -R "$forward" "$user@$host"
    else
        exec "$client" -N -T -o BatchMode=yes -o StrictHostKeyChecking=yes \
            -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
            -o ConnectTimeout=15 -i "$identity" -p "$port" -R "$forward" "$user@$host"
    fi
fi

shell_quote() {
    printf "'"
    printf '%s' "$1" | sed "s/'/'\\\\''/g"
    printf "'"
}

umask 077
private_dir "$state_dir"
[ ! -L "$init_dir" ] || fail "init directory must not be a symlink"
mkdir -p "$init_dir"
runtime="$state_dir/tunnel.sh"
saved="$state_dir/tunnel.conf"
regular_file "$0" "this script"
lock="$state_dir/.install-lock"
mkdir "$lock" || fail "another installation is active, or a stale .install-lock needs review"
runtime_tmp=
saved_tmp=
service_tmp=
cleanup() {
    [ -z "$runtime_tmp" ] || rm -f "$runtime_tmp"
    [ -z "$saved_tmp" ] || rm -f "$saved_tmp"
    [ -z "$service_tmp" ] || rm -f "$service_tmp"
    rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
for file in "$runtime" "$saved" "$service"; do
    [ ! -L "$file" ] || fail "refusing to replace a symlink: $file"
    if [ -e "$file" ]; then
        [ "$update" -eq 1 ] || fail "existing installation; review it and pass --update"
        regular_file "$file" "managed file"
        grep -Fxq '# Managed by openwrt-mcp/scripts/ssh-tunnel.sh' "$file" || fail "refusing to overwrite an unrelated file: $file"
    fi
done
runtime_tmp=$(mktemp "$state_dir/.runtime.XXXXXX")
saved_tmp=$(mktemp "$state_dir/.config.XXXXXX")
service_tmp=$(mktemp "$init_dir/.owrt-reverse-ssh.XXXXXX")
cat "$0" > "$runtime_tmp"
{
    printf '# Managed by openwrt-mcp/scripts/ssh-tunnel.sh\n'
    printf 'host=%s\nuser=%s\nport=%s\nremote_port=%s\n' "$host" "$user" "$port" "$remote_port"
    printf 'local_host=%s\nlocal_port=%s\nidentity=%s\nclient=%s\nhome=%s\n' "$local_host" "$local_port" "$identity" "$client" "$home"
} > "$saved_tmp"
{
    printf '#!/bin/sh /etc/rc.common\n# Managed by openwrt-mcp/scripts/ssh-tunnel.sh\n\n'
    printf 'START=99\nSTOP=10\nUSE_PROCD=1\n\nstart_service() {\n    procd_open_instance\n'
    printf '    procd_set_param command /bin/sh %s start --config %s\n' "$(shell_quote "$runtime")" "$(shell_quote "$saved")"
    printf '    procd_set_param file %s %s\n' "$(shell_quote "$runtime")" "$(shell_quote "$saved")"
    printf '    procd_set_param respawn 3600 15 0\n    procd_set_param stderr 1\n    procd_close_instance\n}\n'
} > "$service_tmp"
chmod 700 "$runtime_tmp" "$service_tmp"
chmod 600 "$saved_tmp"
sh -n "$runtime_tmp"
sh -n "$service_tmp"
mv -f "$runtime_tmp" "$runtime" || fail "could not replace the runtime; review the installation before retrying"
runtime_tmp=
mv -f "$saved_tmp" "$saved" || fail "could not replace saved parameters; the runtime may have been updated, but no service was started"
saved_tmp=
mv -f "$service_tmp" "$service" || fail "could not replace the service; parameters were updated, but no service was started"
service_tmp=
printf 'Saved tunnel parameters: %s\nSaved procd service: %s\n' "$saved" "$service" >&2
printf 'SSH server host trust must already be enrolled before enable/start. No SSH server, firewall or key was changed.\n' >&2
if [ "$activate" -eq 1 ]; then
    "$service" enable
    "$service" start
fi
