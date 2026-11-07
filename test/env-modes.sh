#!/bin/zsh
# clean-development 0.6.2: hermetic tests of machine/env.zsh in both storage modes, zsh and bash 3.2.
# Usage: test/env-modes.sh SIMDIR   (SIMDIR is created and must not exist; nothing outside it is written)
# The simulated external volume is SIMDIR/Volumes/External (same device, so "mounted" means the directory exists, as env.zsh checks).
emulate -L zsh
set -u
here="${0:A:h}"
plugin="${here:h}"
sim="${1:?usage: env-modes.sh SIMDIR}"
[[ -e "$sim" ]] && { print -u2 "refusing: $sim exists"; exit 2; }
# env.zsh takes the mount point as EXTERNAL_ROOT up to its first /Volumes/External, so a fixture below the real volume
# would be checked against the real mount (section U then routes external). Run it from the internal disk.
[[ "${sim:A}" == */Volumes/External* ]] && { print -u2 "refusing: $sim is below /Volumes/External; put CLEAN_DEV_TEST_DIR on the internal disk"; exit 2; }
mkdir -p "$sim/home/dev/machine" "$sim/Volumes/External/dev/cache" || exit 2
H="$sim/home"; V="$sim/Volumes/External"
sed -e "s#^EXTERNAL_ROOT=.*#EXTERNAL_ROOT=$V/dev#" -e "s#^LAB_ROOT=.*#LAB_ROOT=$V/dev/lab#" -e "s#^MODELS_ROOT=.*#MODELS_ROOT=$V/models#" \
  "$plugin/machine/storage.conf" > "$H/dev/machine/storage.conf"
cp "$plugin/machine/env.zsh" "$H/dev/machine/env.zsh"
print -r -- '[ -r "$HOME/dev/machine/env.zsh" ] && . "$HOME/dev/machine/env.zsh"' > "$H/.zshenv"
EXT="$V/dev/cache"; INT="$H/dev/machine/cache"
pass=0; fail=0
ok() { if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else fail=$((fail+1)); print -r -- "FAIL $1: got [$2] want [$3]"; fi; }
z() { env -i HOME="$H" PATH=/usr/bin:/bin HOMEBREW_PREFIX=/opt/homebrew "$@"; }
get() { z "${@:2}" /bin/zsh -c "print -r -- \${$1-UNSET}" 2>/dev/null; }

# A plain shell, external
ok A.mode "$(get CLEAN_DEV_MODE)" external
ok A.root "$(get DEVCACHE)" "$EXT"
ok A.npm "$(get npm_config_cache)" "$EXT/deps/npm"
ok A.pnpm "$(get pnpm_config_store_dir)" "$EXT/deps/pnpm-store"
ok A.hf "$(get HF_HUB_CACHE)" "$EXT/deps/huggingface/hub"
ok A.hfhome "$(get HF_HOME)" UNSET
ok A.hfpreserve "$(get HF_HOME HF_HOME=/private/huggingface)" /private/huggingface
ok A.yarnglobal "$(get YARN_GLOBAL_FOLDER)" UNSET
ok A.telemetry "$(get GH_TELEMETRY)" UNSET
ok A.xdg "$(get XDG_CACHE_HOME)" "$EXT/deps/xdg"
ok A.cargo "$(get CARGO_HOME)" UNSET
ok A.hosttool "$(get CARGO_HOME CARGO_HOME=/custom/cargo)" /custom/cargo
ok A.xdgconfig "$(get XDG_CONFIG_HOME XDG_CONFIG_HOME=/custom/config)" /custom/config
ok A.xdgdata "$(get XDG_DATA_HOME XDG_DATA_HOME=/custom/data)" /custom/data
ok A.docker "$(get DOCKER_CONFIG DOCKER_CONFIG=/custom/docker)" /custom/docker
ok A.locale "$(get LANG LANG=fr_FR.UTF-8)" fr_FR.UTF-8
ok A.ollama "$(get OLLAMA_MODELS)" UNSET
ok A.ollamapreserve "$(get OLLAMA_MODELS OLLAMA_MODELS=/custom/models)" /custom/models
ok A.dd "$(get XCODE_DERIVED_DATA_PATH)" "$EXT/builds/DerivedData"
ok A.tmp "$(get TMPDIR)" UNSET
ok A.session "$(get CLEAN_DEV_SESSION)" UNSET
ok A.compat "$(get CLEAN_DEVELOPMENT_BUILD_ROOT)" "$EXT/builds"
ok A.stdout "$(z /bin/zsh -c ':' 2>/dev/null)" ""

# B plain shell, internal (volume treated as absent)
ok B.mode "$(get CLEAN_DEV_MODE DEV_STORAGE_VOLUME_TEST=absent)" internal
ok B.root "$(get DEVCACHE DEV_STORAGE_VOLUME_TEST=absent)" "$INT"
ok B.uv "$(get UV_CACHE_DIR DEV_STORAGE_VOLUME_TEST=absent)" "$INT/deps/uv"
ok B.ollama "$(get OLLAMA_MODELS DEV_STORAGE_VOLUME_TEST=absent)" UNSET
ok B.tart "$(get TART_HOME DEV_STORAGE_VOLUME_TEST=absent)" UNSET

# C Claude session, external: scratch and pin
SID=aaaaaaaa-bbbb-4ccc-8ddd-0123456789ab; KEY=c-0123456789ab  # gitleaks:allow
ok C.tmp "$(get TMPDIR CLAUDE_CODE_SESSION_ID=$SID)" "$EXT/scratch/$KEY/tmp"
ok C.tmpdir "$( [[ -d $EXT/scratch/$KEY/tmp ]] && print yes)" yes
ok C.pin "$(sed -n 1p $H/dev/machine/state/clean-development/sessions/$KEY.mode)" external
ok C.builds "$(get CLEAN_DEV_BUILDS CLAUDE_CODE_SESSION_ID=$SID)" "$EXT/builds/$KEY"
ok C.scratchcompat "$(get CLEAN_DEVELOPMENT_SCRATCH_ROOT CLAUDE_CODE_SESSION_ID=$SID)" "$EXT/scratch/$KEY"

# D the volume disappears after the session used it: new shells use internal, warn once; it comes back: external again
mv "$V/dev/cache" "$V/dev/cache.unplugged"
w1="$(z CLAUDE_CODE_SESSION_ID=$SID /bin/zsh -c ':' 2>&1)"
w2="$(z CLAUDE_CODE_SESSION_ID=$SID /bin/zsh -c ':' 2>&1)"
ok D.warn "${w1:0:59}" "clean-development: the External volume is not available now"
ok D.once "$w2" ""
ok D.mode "$(get CLEAN_DEV_MODE CLAUDE_CODE_SESSION_ID=$SID)" internal
ok D.tmp "$(get TMPDIR CLAUDE_CODE_SESSION_ID=$SID)" "$INT/scratch/$KEY/tmp"
ok D.pinkept "$(sed -n 1p $H/dev/machine/state/clean-development/sessions/$KEY.mode)" external
mv "$V/dev/cache.unplugged" "$V/dev/cache"
ok D.back "$(get CLEAN_DEV_MODE CLAUDE_CODE_SESSION_ID=$SID)" external
ok D.backtmp "$(get TMPDIR CLAUDE_CODE_SESSION_ID=$SID)" "$EXT/scratch/$KEY/tmp"

# E storage follows the drive: a Codex session registered while the volume was absent routes external once it is back
TID=019a2b3c-4d5e-7f60-8a9b-c0d1e2f3a4b5; XKEY=x-c0d1e2f3a4b5  # gitleaks:allow
ok E.first "$(get CLEAN_DEV_MODE CODEX_THREAD_ID=$TID DEV_STORAGE_VOLUME_TEST=absent)" internal
ok E.pin "$(sed -n 1p $H/dev/machine/state/clean-development/sessions/$XKEY.mode)" internal
ok E.follows "$(get CLEAN_DEV_MODE CODEX_THREAD_ID=$TID)" external
ok E.tmp "$(get TMPDIR CODEX_THREAD_ID=$TID)" "$EXT/scratch/$XKEY/tmp"
ok E.away "$(get TMPDIR CODEX_THREAD_ID=$TID DEV_STORAGE_VOLUME_TEST=absent)" "$INT/scratch/$XKEY/tmp"
ok E.pinunchanged "$(sed -n 1p $H/dev/machine/state/clean-development/sessions/$XKEY.mode)" internal

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

# J PATH: machine command first, retired shim removed, user-managed paths retained
p="$(z PATH="$H/Library/Application Support/clean-development/bin:$H/dev/bin:/usr/bin:/bin" /bin/zsh -c 'print -r -- $PATH' 2>/dev/null)"
ok J.first "${p%%:*}" "$H/dev/machine/bin"
ok J.noshim "$( [[ ":$p:" == *"clean-development/bin"* ]] && print present || print gone)" gone
ok J.userbin "$( [[ ":$p:" == *":$H/dev/bin:"* ]] && print present || print gone)" present

# K plain shell repairs an inherited external-volume TMPDIR
t="$(get TMPDIR TMPDIR=/Volumes/External/cache/scratch/tmp)"
ok K.tmpfix "${t:0:8}" "/var/fol"
t="$(get TMPDIR TMPDIR=$INT/scratch/$XKEY/tmp)"
ok K.foreigninternal "${t:0:8}" "/var/fol"

# L invalid storage.conf disables external storage without breaking the shell
cp "$H/dev/machine/storage.conf" "$sim/storage.conf.bak"
print 'EXTERNAL_ROOT=relative/path' >> "$H/dev/machine/storage.conf"
ok L.mode "$(get CLEAN_DEV_MODE)" internal
ok L.loaded "$(get DEV_ENV_LOADED)" 1
cp "$sim/storage.conf.bak" "$H/dev/machine/storage.conf"

# M DEV_STORAGE_VOLUME_TEST=present|mounted is the normal probe (external here: the directory exists)
ok M.present "$(get CLEAN_DEV_MODE DEV_STORAGE_VOLUME_TEST=present)" external
ok M.mounted "$(get CLEAN_DEV_MODE DEV_STORAGE_VOLUME_TEST=mounted)" external
mv "$V/dev/cache" "$V/dev/cache.unplugged"
ok M.presentnofake "$(get CLEAN_DEV_MODE DEV_STORAGE_VOLUME_TEST=present)" internal
mv "$V/dev/cache.unplugged" "$V/dev/cache"

# N both harness variables set (a Codex started from a Claude shell, no filtering) keys on Claude; with
#   CLAUDE_CODE_SESSION_ID blanked (Codex shell_environment_policy.set) Codex's own thread id is used
NS=bbbbbbbb-bbbb-4bbb-8bbb-aabbccddeeff; NT=019a2b3c-4d5e-7f60-8a9b-112233445566
ok N.both "$(get CLEAN_DEV_SESSION CLAUDE_CODE_SESSION_ID=$NS CODEX_THREAD_ID=$NT)" c-aabbccddeeff
ok N.blank "$(get CLEAN_DEV_SESSION CLAUDE_CODE_SESSION_ID= CODEX_THREAD_ID=$NT)" x-112233445566
ok N.blanktmp "$(get TMPDIR CLAUDE_CODE_SESSION_ID= CODEX_THREAD_ID=$NT)" "$EXT/scratch/x-112233445566/tmp"

# O 0.6.2: placeholder and short ids get no key (plain-shell routing); deliberate 12+ character ids stay valid
ok O.placeholder "$(get CLEAN_DEV_SESSION CLAUDE_CODE_SESSION_ID=aaaaaaaa-to-be-unset)" UNSET
ok O.placeholdertmp "$(get TMPDIR CLAUDE_CODE_SESSION_ID=aaaaaaaa-to-be-unset)" UNSET
ok O.short "$(get CLEAN_DEV_SESSION CODEX_THREAD_ID=KEY1)" UNSET
ok O.stubtoken "$(get CLEAN_DEV_SESSION CODEX_THREAD_ID=ol2-stub-key)" UNSET
ok O.handset "$(get CLEAN_DEV_SESSION CODEX_THREAD_ID=maintree0001)" x-maintree0001
ok O.nopin "$( [[ -e $H/dev/machine/state/clean-development/sessions/c--to-be-unset.mode ]] && print written || print none)" none

# P 0.6.2 (R10): a clean child (no CLAUDE_* variables) keeps its session's routing through CLEAN_DEV_SESSION + stamp;
#   a session name without the matching stamp is ignored
ok P.inherit "$(z CLAUDE_CODE_SESSION_ID=$SID /bin/zsh -c 'env -i HOME="$HOME" PATH=/usr/bin:/bin CLEAN_DEV_SESSION="$CLEAN_DEV_SESSION" CLEAN_DEV_STAMP="$CLEAN_DEV_STAMP" /bin/zsh -c "print -r -- \$TMPDIR\|\$CLEAN_DEV_BUILDS\|\$DEVCACHE\|\${CLAUDE_CODE_SESSION_ID-none}"' 2>/dev/null)" "$EXT/scratch/$KEY/tmp|$EXT/builds/$KEY|$EXT|none"
ok P.nostamp "$(get TMPDIR CLEAN_DEV_SESSION=$KEY)" UNSET
ok P.wrongstamp "$(get TMPDIR CLEAN_DEV_SESSION=$KEY CLEAN_DEV_STAMP="external|$EXT|c-999999999999")" UNSET
ok P.foreignroot "$(get TMPDIR CLEAN_DEV_SESSION=$KEY CLEAN_DEV_STAMP="foreign|/other-root|$KEY")" UNSET
ok P.nopin "$(get TMPDIR CLEAN_DEV_SESSION=c-0000deadbeef CLEAN_DEV_STAMP="external|$EXT|c-0000deadbeef")" UNSET
ok P.bash "$(z CLAUDE_CODE_SESSION_ID=$SID /bin/bash -c '. "$HOME/dev/machine/env.zsh"; env -i HOME="$HOME" PATH=/usr/bin:/bin CLEAN_DEV_SESSION="$CLEAN_DEV_SESSION" CLEAN_DEV_STAMP="$CLEAN_DEV_STAMP" /bin/bash -c ". \"\$HOME/dev/machine/env.zsh\"; printf %s \"\$TMPDIR\""' 2>/dev/null)" "$EXT/scratch/$KEY/tmp"
ok P.utf8 "$(z LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 CODEX_THREAD_ID=019a2b3c-4d5e-7f60-8a9b-00000000000é /bin/bash -c '. "$HOME/dev/machine/env.zsh"; printf %s "${CLEAN_DEV_SESSION-UNSET}"' 2>/dev/null)" UNSET

# Q 0.6.2 (R5): a pin written by env.zsh (no hook ran) records why on its second line; readers use line one
QT=019a2b3c-4d5e-7f60-8a9b-0000000000aa
get CLEAN_DEV_MODE CODEX_THREAD_ID=$QT >/dev/null
ok Q.line1 "$(sed -n 1p $H/dev/machine/state/clean-development/sessions/x-0000000000aa.mode)" external
ok Q.line2 "$(sed -n 2p $H/dev/machine/state/clean-development/sessions/x-0000000000aa.mode)" "# env.zsh $EXT writable (test -w)"
ok Q.mode "$(get CLEAN_DEV_MODE CODEX_THREAD_ID=$QT)" external

# R 0.6.2 (R12): Python bytecode goes to the cache, never __pycache__ in the tree
ok R.prefix "$(get PYTHONPYCACHEPREFIX)" "$EXT/deps/pycache"
ok R.prefixint "$(get PYTHONPYCACHEPREFIX DEV_STORAGE_VOLUME_TEST=absent)" "$INT/deps/pycache"
if [[ -x /usr/bin/python3 ]] && /usr/bin/python3 -c 1 2>/dev/null; then
  mkdir -p "$sim/pyrepo" && print 'X = 1' > "$sim/pyrepo/pymod.py"
  z /bin/zsh -c "cd '$sim/pyrepo' && /usr/bin/python3 -c 'import pymod'" 2>/dev/null
  ok R.notree "$( [[ -e $sim/pyrepo/__pycache__ ]] && print present || print absent)" absent
  ok R.cached "$( ls $EXT/deps/pycache/**/pymod*.pyc(N) 2>/dev/null | head -1 | grep -c pymod)" 1
fi

# S 0.6.2 (R11): VM homes use external lab paths in both modes; env.zsh never creates them
ok S.colima "$(get COLIMA_HOME)" UNSET
ok S.colimaint "$(get COLIMA_HOME DEV_STORAGE_VOLUME_TEST=absent)" UNSET
ok S.lima "$(get LIMA_HOME DEV_STORAGE_VOLUME_TEST=absent)" UNSET
ok S.nocreate "$( [[ -e $V/dev/lab/VM/colima-home ]] && print made || print none)" none

# U 0.6.2: zsh checks mount identity (zstat, no fork): a cache directory on the same device as /Volumes is not the
#   mounted volume. The fixture volume is a plain directory, so the strict test switch must route it internal in zsh;
#   bash 3.2 keeps the existence and write checks.
ok U.strictzsh "$(get CLEAN_DEV_MODE DEV_STORAGE_VOLUME_TEST=strict)" internal
ok U.strictsession "$(get TMPDIR CLAUDE_CODE_SESSION_ID=$SID DEV_STORAGE_VOLUME_TEST=strict)" "$INT/scratch/$KEY/tmp"
ok U.strictbash "$(z DEV_STORAGE_VOLUME_TEST=strict /bin/bash -c '. "$HOME/dev/machine/env.zsh"; printf %s "$CLEAN_DEV_MODE"' 2>/dev/null)" external
ok U.fixture "$(get CLEAN_DEV_MODE)" external

# T 0.6.2: CLEAN_DEV_WORK follows LAB_ROOT's parent when it is an existing path below the mount; otherwise EXTERNAL_ROOT.
cp "$H/dev/machine/storage.conf" "$sim/storage.conf.worktree.bak"
sed "s#^LAB_ROOT=.*#LAB_ROOT=$V/not-created/lab#" "$H/dev/machine/storage.conf" > "$sim/storage.conf.worktree"
cp "$sim/storage.conf.worktree" "$H/dev/machine/storage.conf"
ok T.customlab "$(get CLEAN_DEV_WORK)" "$V/dev"
cp "$sim/storage.conf.worktree.bak" "$H/dev/machine/storage.conf"
sed "s#^LAB_ROOT=.*#LAB_ROOT=$V/work/lab#" "$H/dev/machine/storage.conf" > "$sim/storage.conf.worktree"
cp "$sim/storage.conf.worktree" "$H/dev/machine/storage.conf"
mkdir -p "$V/work"
ok T.labparent "$(get CLEAN_DEV_WORK)" "$V/work"
chmod 500 "$V/work"
ok T.labparent-readonly "$(get CLEAN_DEV_WORK)" "$V/dev"
chmod 700 "$V/work"
cp "$sim/storage.conf.worktree.bak" "$H/dev/machine/storage.conf"
mkdir -p "$V/dev"
ok T.external "$(get CLEAN_DEV_WORK)" "$V/dev"
ok T.session "$(get CLEAN_DEV_WORK CLAUDE_CODE_SESSION_ID=$SID)" "$V/dev"
ok T.absent "$(get CLEAN_DEV_WORK DEV_STORAGE_VOLUME_TEST=absent)" "$H/dev/machine"
chmod 500 "$V/dev"
ok T.readonly "$(get CLEAN_DEV_WORK)" "$H/dev/machine"
chmod 600 "$V/dev"
ok T.nosearch "$(get CLEAN_DEV_WORK)" "$H/dev/machine"
chmod 700 "$V/dev"

print "env-modes: $pass passed, $fail failed"
exit $(( fail > 0 ))
