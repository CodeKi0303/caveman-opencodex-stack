#!/bin/sh
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node_command=${NODE_BINARY:-node}
if ! command -v "$node_command" >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 22.13 or newer is required. Install Node.js LTS, then run this file again.' >&2
  exit 1
fi
exec "$node_command" "$repo_dir/scripts/manage-launch.mjs" "$@"
