#!/bin/sh
# Source-only entry. --dry-run never creates directories, probes storage or invokes integration helpers.
set -eu
src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
node="${CLEAN_DEV_NODE:-$HOME/dev/machine/toolchains/node/current/bin/node}"
[ -x "$node" ] || { echo "install.sh: node not found at $node (set CLEAN_DEV_NODE)" >&2; exit 1; }
exec "$node" "$src/installer.mjs" "$@"
