#!/bin/sh
# Remove the retired Application Support runtime after the active hooks use the managed runtime.
# Preview with no arguments. --apply removes only its runtime subdirectory and preserves sibling data.
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
runtime="$old/runtime"
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
if [ -L "$runtime" ] || { [ -e "$runtime" ] && [ ! -d "$runtime" ]; }; then
  echo "remove-legacy: refusing a linked or non-directory runtime: $runtime" >&2
  exit 1
fi

needle='Application Support/clean-development'
referenced=0
incomplete=0
scan_file() {
  file=$1
  if [ ! -f "$file" ] || [ ! -r "$file" ]; then
    echo "remove-legacy: cannot inspect configured file: $file" >&2
    incomplete=1
    return
  fi
  if grep -F -q "$needle" "$file"; then
    if [ "$referenced" -eq 0 ]; then echo "remove-legacy: old runtime is still referenced by:" >&2; fi
    printf '  %s\n' "$file" >&2
    referenced=1
  else
    grep_status=$?
    if [ "$grep_status" -ne 1 ]; then
      echo "remove-legacy: cannot read configured file: $file" >&2
      incomplete=1
    fi
  fi
}

for file in "$HOME/.claude/settings.json" "$HOME/.codex/hooks.json" "$HOME/.codex/config.toml" \
  "$HOME/dev/machine/state/claude-work/shared/settings.json" "$HOME/dev/state/claude-work/shared/settings.json"; do
  if [ -f "$file" ] || [ -L "$file" ]; then scan_file "$file"; fi
done

# The installer can register additional Codex homes and Claude settings/profile files outside the defaults.
# An invalid or missing required entry makes the reference scan incomplete, so removal must stop.
scan_registry() {
  registry=$1
  kind=$2
  if [ ! -e "$registry" ] && [ ! -L "$registry" ]; then return; fi
  if [ ! -f "$registry" ] || [ ! -r "$registry" ]; then
    echo "remove-legacy: cannot read configuration registry: $registry" >&2
    incomplete=1
    return
  fi
  raw=
  while IFS= read -r raw || [ -n "$raw" ]; do
    value=$(printf '%s' "$raw" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    case "$value" in ''|\#*) continue ;; esac
    optional=0
    case "$value" in \?*) optional=1; value=${value#?} ;; esac
    value=$(printf '%s' "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    case "$value" in
      \~) resolved=$HOME ;;
      \~/*) resolved="$HOME/${value#\~/}" ;;
      /*) resolved=$value ;;
      *) echo "remove-legacy: invalid path in registry $registry: $value" >&2; incomplete=1; continue ;;
    esac
    if [ "$kind" = codex-home ]; then
      if [ -d "$resolved" ]; then
        found=0
        for file in "$resolved/config.toml" "$resolved/hooks.json"; do
          if [ -e "$file" ] || [ -L "$file" ]; then found=1; scan_file "$file"; fi
        done
        if [ "$found" -eq 0 ] && [ "$optional" -eq 0 ]; then
          echo "remove-legacy: configured Codex home has no hooks.json or config.toml: $resolved" >&2
          incomplete=1
        fi
      elif [ "$optional" -eq 0 ]; then
        echo "remove-legacy: configured Codex home is missing: $resolved" >&2
        incomplete=1
      fi
    elif [ -f "$resolved" ] || [ -L "$resolved" ]; then
      scan_file "$resolved"
    elif [ "$optional" -eq 0 ]; then
      echo "remove-legacy: configured settings file is missing: $resolved" >&2
      incomplete=1
    fi
  done < "$registry"
}

state="$HOME/dev/machine/state/clean-development"
scan_registry "$state/codex-homes.list" codex-home
scan_registry "$state/claude-settings.list" settings-file
scan_registry "$state/claude-profiles.list" settings-file
[ "$incomplete" -eq 0 ] || { echo "remove-legacy: reference scan was incomplete; refusing removal" >&2; exit 1; }
[ "$referenced" -eq 0 ] || exit 1

size() { [ -e "$1" ] && perl -e 'alarm shift; exec @ARGV' 120 du -sh "$1" 2>/dev/null | cut -f1 || echo "-"; }
printf '%-8s %s\n' "$(size "$runtime")" "$runtime"
[ "$apply" -eq 1 ] || { echo "preview only; run with --apply after reviewing the target"; exit 0; }
[ -d "$runtime" ] || { echo "remove-legacy: no legacy runtime found"; exit 0; }
/bin/rm -rf "$runtime"
echo "removed $runtime"
