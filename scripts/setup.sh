#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' '本机尚未安装 Node.js。请先通过可信软件源安装 Node.js 22+ 和 npm，再运行此脚本。' >&2
    exit 1
fi

script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
exec node "$script_dir/setup.mjs" "$@"
