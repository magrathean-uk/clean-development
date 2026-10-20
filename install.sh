#!/bin/sh
# clean-development 0.6.0 installer. Idempotent. Never touches harness settings (those are merged by the config steps).
#   install.sh             install the runtime to ~/dev/machine/runtime/clean-development/<version> and the CLI wrapper,
#                          create state and cache directories
#   install.sh --config    also install machine/env.zsh and machine/storage.conf to ~/dev/machine (old copies are kept
#                          in ~/dev/machine/state/clean-development/backup/)
set -eu
src=$(cd "$(dirname "$0")" && pwd -P)
ver=$(cat "$src/runtime/VERSION")
m="$HOME/dev/machine"
node="${CLEAN_DEV_NODE:-$m/toolchains/node/current/bin/node}"
[ -x "$node" ] || { echo "install.sh: node not found at $node (set CLEAN_DEV_NODE)" >&2; exit 1; }
"$node" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)' \
  || { echo "install.sh: node >= 20.12 required" >&2; exit 1; }

dest="$m/runtime/clean-development/$ver"
tmp="$dest.installing.$$"
mkdir -p "$m/runtime/clean-development"
rm -rf "$tmp"
cp -R "$src/runtime" "$tmp"
for f in "$tmp"/lib/*.mjs "$tmp"/bin/*.mjs; do "$node" --check "$f"; done
sh -n "$tmp/bin/cd-hook"; sh -n "$tmp/bin/clean-development"
chmod 755 "$tmp/bin/cd-hook" "$tmp/bin/clean-development"
if [ -d "$dest" ]; then rm -rf "$dest.old.$$"; mv "$dest" "$dest.old.$$"; fi
mv "$tmp" "$dest"
rm -rf "$dest.old.$$"

mkdir -p "$m/bin" "$m/state/clean-development/sessions" "$m/state/clean-development/stamps"
chmod 700 "$m/state/clean-development" "$m/state/clean-development/sessions"
cat > "$m/bin/clean-development" <<EOF
#!/bin/sh
exec '$dest/bin/clean-development' "\$@"
EOF
chmod 755 "$m/bin/clean-development"

if [ "${1:-}" = "--config" ]; then
  b="$m/state/clean-development/backup/$(date +%Y%m%dT%H%M%S)"
  mkdir -p "$b"
  for f in env.zsh storage.conf; do
    if [ -f "$m/$f" ] && ! cmp -s "$m/$f" "$src/machine/$f"; then cp -p "$m/$f" "$b/$f"; fi
    cp "$src/machine/$f" "$m/$f.new.$$" && chmod 644 "$m/$f.new.$$" && mv "$m/$f.new.$$" "$m/$f"
  done
  zsh -n "$m/env.zsh"
  rmdir "$b" 2>/dev/null || echo "previous config kept in $b"
fi

# Cache roots: internal always; external only when /Volumes/<name> is a real mount (never create it on the boot disk).
"$node" --input-type=module -e "
import { loadConf } from '$dest/lib/conf.mjs';
import { detect, ensureLayout } from '$dest/lib/storage.mjs';
const c = loadConf(); if (!c.valid) { console.error('storage.conf: ' + c.errors.join('; ')); process.exit(1); }
ensureLayout(c.internalRoot);
const d = detect(c, process.env);
if (d.mode === 'external') ensureLayout(c.externalCache);
console.log('clean-development ' + c.version + ' installed at $dest; mode now ' + d.mode + ' (' + d.reason + ')');
"
