#!/bin/sh
# Source-only entry. --dry-run never creates directories, probes storage or invokes integration helpers.
set -eu
src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
node_ok() {
  [ -x "$1" ] && "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major < 20 || (major === 20 && minor < 12) ? 1 : 0)' >/dev/null 2>&1
}
node=""
if [ -n "${CLEAN_DEV_NODE:-}" ]; then
  case "$CLEAN_DEV_NODE" in /*) ;; *) echo "install.sh: CLEAN_DEV_NODE must be an absolute path" >&2; exit 1 ;; esac
  [ -x "$CLEAN_DEV_NODE" ] || { echo "install.sh: CLEAN_DEV_NODE is not executable: $CLEAN_DEV_NODE" >&2; exit 1; }
  node_ok "$CLEAN_DEV_NODE" || { echo "install.sh: CLEAN_DEV_NODE must be Node.js 20.12 or later: $CLEAN_DEV_NODE" >&2; exit 1; }
  node=$CLEAN_DEV_NODE
else
  path_node=$(command -v node 2>/dev/null || true)
  for n in "$HOME/dev/machine/toolchains/node/current/bin/node" "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node "$path_node"; do
    if [ -n "$n" ] && node_ok "$n"; then node=$n; break; fi
  done
  [ -n "$node" ] || { echo "install.sh: Node.js 20.12 or later not found; install a supported Node on PATH or set CLEAN_DEV_NODE to its absolute path" >&2; exit 1; }
fi
exec "$node" "$src/installer.mjs" "$@"
