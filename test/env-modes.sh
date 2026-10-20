#!/bin/zsh
# clean-development 0.6.0: hermetic tests of machine/env.zsh in both storage modes, zsh and bash 3.2.
# Usage: test/env-modes.sh SIMDIR   (SIMDIR is created and must not exist; nothing outside it is written)
# The simulated 4TB is SIMDIR/Volumes/4TB (same device, so "mounted" means the directory exists, as env.zsh checks).
emulate -L zsh
set -u
here="${0:A:h}"
plugin="${here:h}"
sim="${1:?usage: env-modes.sh SIMDIR}"
[[ -e "$sim" ]] && { print -u2 "refusing: $sim exists"; exit 2; }
mkdir -p "$sim/home/dev/machine" "$sim/Volumes/4TB/machine/cache" || exit 2
H="$sim/home"; V="$sim/Volumes/4TB"
sed -e "s#^EXTERNAL_ROOT=.*#EXTERNAL_ROOT=$V/machine#" -e "s#^LAB_ROOT=.*#LAB_ROOT=$V/dev/lab#" -e "s#^MODELS_ROOT=.*#MODELS_ROOT=$V/models#" \
  "$plugin/machine/storage.conf" > "$H/dev/machine/storage.conf"
cp "$plugin/machine/env.zsh" "$H/dev/machine/env.zsh"
print -r -- '[ -r "$HOME/dev/machine/env.zsh" ] && . "$HOME/dev/machine/env.zsh"' > "$H/.zshenv"
EXT="$V/machine/cache"; INT="$H/dev/machine/cache"
pass=0; fail=0
ok() { if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else fail=$((fail+1)); print -r -- "FAIL $1: got [$2] want [$3]"; fi; }
z() { env -i HOME="$H" PATH=/usr/bin:/bin HOMEBREW_PREFIX=/opt/homebrew "$@"; }
get() { z "${@:2}" /bin/zsh -c "print -r -- \${$1-UNSET}" 2>/dev/null; }

# A plain shell, external
ok A.mode "$(get CLEAN_DEV_MODE)" external
ok A.root "$(get DEVCACHE)" "$EXT"
ok A.npm "$(get npm_config_cache)" "$EXT/deps/npm"
ok A.pnpm "$(get pnpm_config_store_dir)" "$EXT/deps/pnpm-store"
ok A.hf "$(get HF_HOME)" "$EXT/deps/huggingface"
ok A.xdg "$(get XDG_CACHE_HOME)" "$EXT/deps/xdg"
ok A.cargo "$(get CARGO_HOME)" "$H/dev/machine/toolchains/rust/cargo"
ok A.ollama "$(get OLLAMA_MODELS)" "$V/models/ollama"
ok A.dd "$(get XCODE_DERIVED_DATA_PATH)" "$EXT/builds/DerivedData"
ok A.tmp "$(get TMPDIR)" UNSET
ok A.session "$(get CLEAN_DEV_SESSION)" UNSET
ok A.compat "$(get CLEAN_DEVELOPMENT_BUILD_ROOT)" "$EXT/builds"
ok A.stdout "$(z /bin/zsh -c ':' 2>/dev/null)" ""

# B plain shell, internal (volume treated as absent)
ok B.mode "$(get CLEAN_DEV_MODE DEV_STORAGE_VOLUME_TEST=absent)" internal
ok B.root "$(get DEVCACHE DEV_STORAGE_VOLUME_TEST=absent)" "$INT"
ok B.uv "$(get UV_CACHE_DIR DEV_STORAGE_VOLUME_TEST=absent)" "$INT/deps/uv"
ok B.ollama "$(get OLLAMA_MODELS DEV_STORAGE_VOLUME_TEST=absent)" "$INT/deps/ollama"
ok B.tart "$(get TART_HOME DEV_STORAGE_VOLUME_TEST=absent)" "$V/dev/lab/VM/tart-home"

# C Claude session, external: scratch and pin
SID=aaaaaaaa-bbbb-4ccc-8ddd-0123456789ab; KEY=c-0123456789ab  # gitleaks:allow
ok C.tmp "$(get TMPDIR CLAUDE_CODE_SESSION_ID=$SID)" "$EXT/scratch/$KEY/tmp"
ok C.tmpdir "$( [[ -d $EXT/scratch/$KEY/tmp ]] && print yes)" yes
ok C.pin "$(cat $H/dev/machine/state/clean-development/sessions/$KEY.mode)" external
ok C.builds "$(get CLEAN_DEV_BUILDS CLAUDE_CODE_SESSION_ID=$SID)" "$EXT/builds/$KEY"
ok C.scratchcompat "$(get CLEAN_DEVELOPMENT_SCRATCH_ROOT CLAUDE_CODE_SESSION_ID=$SID)" "$EXT/scratch/$KEY"

# D the pinned volume disappears: fall back to internal, warn once
mv "$V/machine/cache" "$V/machine/cache.unplugged"
w1="$(z CLAUDE_CODE_SESSION_ID=$SID /bin/zsh -c ':' 2>&1)"
w2="$(z CLAUDE_CODE_SESSION_ID=$SID /bin/zsh -c ':' 2>&1)"
ok D.warn "${w1:0:42}" "clean-development: the 4TB volume disappea"
ok D.once "$w2" ""
ok D.mode "$(get CLEAN_DEV_MODE CLAUDE_CODE_SESSION_ID=$SID)" internal
ok D.tmp "$(get TMPDIR CLAUDE_CODE_SESSION_ID=$SID)" "$INT/scratch/$KEY/tmp"
ok D.pinkept "$(cat $H/dev/machine/state/clean-development/sessions/$KEY.mode)" external
mv "$V/machine/cache.unplugged" "$V/machine/cache"

# E Codex session started while the volume is absent stays internal after reconnection (decided once)
TID=019a2b3c-4d5e-7f60-8a9b-c0d1e2f3a4b5; XKEY=x-c0d1e2f3a4b5  # gitleaks:allow
ok E.first "$(get CLEAN_DEV_MODE CODEX_THREAD_ID=$TID DEV_STORAGE_VOLUME_TEST=absent)" internal
ok E.pinned "$(get CLEAN_DEV_MODE CODEX_THREAD_ID=$TID)" internal
ok E.tmp "$(get TMPDIR CODEX_THREAD_ID=$TID)" "$INT/scratch/$XKEY/tmp"

# F precedence: inherited stamp keeps a deliberate override; a foreign value without stamp is corrected
ok F.keep "$(z /bin/zsh -c 'export npm_config_cache=/custom; /bin/zsh -c "print -r -- \$npm_config_cache"' 2>/dev/null)" /custom
ok F.reset "$(get npm_config_cache npm_config_cache=/sloppy)" "$EXT/deps/npm"
ok F.modechange "$(z /bin/zsh -c 'export npm_config_cache=/custom; DEV_STORAGE_VOLUME_TEST=absent /bin/zsh -c "print -r -- \$npm_config_cache"' 2>/dev/null)" "$INT/deps/npm"

# G bash 3.2 sources the same file with the same result
ok G.bash "$(z /bin/bash -c '. "$HOME/dev/machine/env.zsh"; printf %s "$DEVCACHE|$npm_config_cache|$CLEAN_DEV_MODE"' 2>/dev/null)" "$EXT|$EXT/deps/npm|external"
ok G.bashsession "$(z CLAUDE_CODE_SESSION_ID=$SID /bin/bash -c '. "$HOME/dev/machine/env.zsh"; printf %s "$TMPDIR"' 2>/dev/null)" "$EXT/scratch/$KEY/tmp"

# H inspection never writes
ok H.mode "$(get CLEAN_DEV_MODE CLAUDE_CODE_SESSION_ID=ffffffff-0000-4000-8000-feedfacecafe DEV_ENV_INSPECT_ONLY=1)" external
ok H.nopin "$( [[ -e $H/dev/machine/state/clean-development/sessions/c-feedfacecafe.mode ]] && print written || print none)" none
ok H.nodir "$( [[ -e $EXT/scratch/c-feedfacecafe ]] && print made || print none)" none

# I idempotent: sourcing twice changes nothing
a="$(z /bin/zsh -c 'env | sort' 2>/dev/null)"; b="$(z /bin/zsh -c '. "$HOME/dev/machine/env.zsh"; env | sort' 2>/dev/null)"
ok I.idem "$( [[ "$a" == "$b" ]] && print same || print differs)" same

# J PATH: machine bin first, retired shim dir and ~/dev/bin dropped
p="$(z PATH="$H/Library/Application Support/clean-development/bin:$H/dev/bin:/usr/bin:/bin" /bin/zsh -c 'print -r -- $PATH' 2>/dev/null)"
ok J.first "${p%%:*}" "$H/dev/machine/bin"
ok J.noshim "$( [[ ":$p:" == *"clean-development/bin"* || ":$p:" == *":$H/dev/bin:"* ]] && print present || print gone)" gone

# K plain shell repairs an inherited 4TB TMPDIR
t="$(get TMPDIR TMPDIR=/Volumes/4TB/cache/scratch/tmp)"
ok K.tmpfix "${t:0:8}" "/var/fol"

# L invalid storage.conf disables external storage without breaking the shell
cp "$H/dev/machine/storage.conf" "$sim/storage.conf.bak"
print 'EXTERNAL_ROOT=relative/path' >> "$H/dev/machine/storage.conf"
ok L.mode "$(get CLEAN_DEV_MODE)" internal
ok L.loaded "$(get DEV_ENV_LOADED)" 1
cp "$sim/storage.conf.bak" "$H/dev/machine/storage.conf"

# M DEV_STORAGE_VOLUME_TEST=present|mounted is the normal probe (external here: the directory exists)
ok M.present "$(get CLEAN_DEV_MODE DEV_STORAGE_VOLUME_TEST=present)" external
ok M.mounted "$(get CLEAN_DEV_MODE DEV_STORAGE_VOLUME_TEST=mounted)" external
mv "$V/machine/cache" "$V/machine/cache.unplugged"
ok M.presentnofake "$(get CLEAN_DEV_MODE DEV_STORAGE_VOLUME_TEST=present)" internal
mv "$V/machine/cache.unplugged" "$V/machine/cache"

# N both harness variables set (a Codex started from a Claude shell, no filtering) keys on Claude; with
#   CLAUDE_CODE_SESSION_ID blanked (Codex shell_environment_policy.set) Codex's own thread id is used
NS=bbbbbbbb-bbbb-4bbb-8bbb-aabbccddeeff; NT=019a2b3c-4d5e-7f60-8a9b-112233445566
ok N.both "$(get CLEAN_DEV_SESSION CLAUDE_CODE_SESSION_ID=$NS CODEX_THREAD_ID=$NT)" c-aabbccddeeff
ok N.blank "$(get CLEAN_DEV_SESSION CLAUDE_CODE_SESSION_ID= CODEX_THREAD_ID=$NT)" x-112233445566
ok N.blanktmp "$(get TMPDIR CLAUDE_CODE_SESSION_ID= CODEX_THREAD_ID=$NT)" "$EXT/scratch/x-112233445566/tmp"

print "env-modes: $pass passed, $fail failed"
exit $(( fail > 0 ))
