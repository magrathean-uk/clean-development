#!/bin/sh
# Remove the retired Application Support runtime after the active hooks use the managed runtime.
# Preview with no arguments. --apply removes only this one legacy runtime directory.
set -eu

if [ "$#" -gt 1 ]; then
  echo "usage: remove-legacy.sh [--apply]" >&2
  exit 2
fi
apply=0
if [ "$#" -eq 1 ]; then
  [ "$1" = "--apply" ] || { echo "usage: remove-legacy.sh [--apply]" >&2; exit 2; }
  apply=1
fi
case "$HOME" in /*) ;; *) echo "remove-legacy: HOME must be an absolute path" >&2; exit 1 ;; esac
[ "$HOME" != "/" ] || { echo "remove-legacy: refusing root HOME" >&2; exit 1; }

library="$HOME/Library"
support="$library/Application Support"
old="$support/clean-development"
for parent in "$library" "$support"; do
  if [ -L "$parent" ] || { [ -e "$parent" ] && [ ! -d "$parent" ]; }; then
    echo "remove-legacy: refusing a linked or non-directory parent: $parent" >&2
    exit 1
  fi
done
if [ -L "$old" ] || { [ -e "$old" ] && [ ! -d "$old" ]; }; then
  echo "remove-legacy: refusing a linked or non-directory target: $old" >&2
  exit 1
fi

referenced=0
for file in "$HOME/.claude/settings.json" "$HOME/.codex/hooks.json" "$HOME/.codex/config.toml"; do
  if [ -f "$file" ] && grep -q 'Application Support/clean-development' "$file"; then
    if [ "$referenced" -eq 0 ]; then echo "remove-legacy: old runtime is still referenced by:" >&2; fi
    printf '  %s\n' "$file" >&2
    referenced=1
  fi
done
[ "$referenced" -eq 0 ] || exit 1

size() { [ -e "$1" ] && perl -e 'alarm shift; exec @ARGV' 120 du -sh "$1" 2>/dev/null | cut -f1 || echo "-"; }
printf '%-8s %s\n' "$(size "$old")" "$old"
[ "$apply" -eq 1 ] || { echo "preview only; run with --apply after reviewing the target"; exit 0; }
[ -d "$old" ] || { echo "remove-legacy: no legacy runtime found"; exit 0; }
/bin/rm -rf "$old"
echo "removed $old"
