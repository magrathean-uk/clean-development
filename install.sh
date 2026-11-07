#!/bin/sh
# Source-only entry. --dry-run never creates directories, probes storage or invokes integration helpers.
set -eu
src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
node="${CLEAN_DEV_NODE:-}"
if [ -z "$node" ] || [ ! -x "$node" ]; then
  node=""
  for n in "$HOME/dev/machine/toolchains/node/current/bin/node" "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$n" ]; then node="$n"; break; fi
  done
fi
if [ -z "$node" ]; then node=$(command -v node 2>/dev/null || true); fi
[ -n "$node" ] && [ -x "$node" ] || { echo "install.sh: Node.js 20.12 or later not found; set CLEAN_DEV_NODE or install Node on PATH" >&2; exit 1; }
"$node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major < 20 || (major === 20 && minor < 12) ? 1 : 0)' \
  || { echo "install.sh: Node.js 20.12 or later is required (CLEAN_DEV_NODE=$node)" >&2; exit 1; }
exec "$node" "$src/installer.mjs" "$@"
