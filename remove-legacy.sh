#!/bin/sh
# clean-development 0.6.0: remove the 0.2.1-0.5.0 installation after every hook points at 0.6.0.
#   remove-legacy.sh           preview (lists what would go, with sizes)
#   remove-legacy.sh --apply   remove it
# Refuses while any harness settings file still references the old runtime path.
set -u
apply=0; [ "${1:-}" = "--apply" ] && apply=1
old="$HOME/Library/Application Support/clean-development"
refs=""
for f in "$HOME/.claude/settings.json" "$HOME/.codex/hooks.json" "$HOME/.codex/config.toml" \
         "$HOME/dev/machine/state/claude-work/shared/settings.json" "$HOME/dev/state/claude-work/shared/settings.json"; do
  [ -f "$f" ] && grep -q 'Application Support/clean-development' "$f" && refs="$refs $f"
done
if [ -n "$refs" ]; then echo "remove-legacy: still referenced by:$refs (merge the 0.6.0 hooks first)" >&2; exit 1; fi

claude_bin="$HOME/.local/bin/claude"
codex_bin="/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
size() { [ -e "$1" ] && perl -e 'alarm shift; exec @ARGV' 120 du -sh "$1" 2>/dev/null | cut -f1 || echo "-"; }
paths="$old|$HOME/.claude/plugins/cache/clean-development-dev|$HOME/.codex/plugins/cache/clean-development-dev|$HOME/.codex/skills/clean-development"
echo "$paths" | tr '|' '\n' | while IFS= read -r p; do printf '%-8s %s\n' "$(size "$p")" "$p"; done
[ "$apply" = 1 ] || { echo "preview only; run with --apply"; exit 0; }

# Harness-managed removals first (they also update installed_plugins.json / config.toml).
if [ -x "$claude_bin" ]; then
  "$claude_bin" plugin uninstall clean-development@clean-development-dev >/dev/null 2>&1 || true
  "$claude_bin" plugin marketplace remove clean-development-dev >/dev/null 2>&1 || true
fi
if [ -x "$codex_bin" ]; then
  "$codex_bin" plugin remove clean-development@clean-development-dev >/dev/null 2>&1 || true
  "$codex_bin" plugin marketplace remove clean-development-dev >/dev/null 2>&1 || true
fi
echo "$paths" | tr '|' '\n' | while IFS= read -r p; do
  [ -e "$p" ] || continue
  /bin/chmod -R -P u+w "$p" 2>/dev/null
  /bin/rm -rf "$p" && echo "removed $p"
done
exit 0
