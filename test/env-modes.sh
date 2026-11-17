#!/bin/zsh
# clean-development: hermetic tests of machine/env.zsh in both storage modes, zsh and bash 3.2.
# Usage: test/env-modes.sh SIMDIR   (SIMDIR is created and must not exist; nothing outside it is written)
# The simulated external volume is SIMDIR/Volumes/External (same device, so "mounted" means the directory exists, as env.zsh checks).
emulate -L zsh
set -u
here="${0:A:h}"
plugin="${here:h}"
sim="${1:?usage: env-modes.sh SIMDIR}"; sim="${sim:a}"
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
EXT="$V/dev/cache"; INT="$H/dev/machine/cache"; STATE="$H/dev/machine/state"
DEF="$(/usr/bin/getconf DARWIN_USER_TEMP_DIR 2>/dev/null)"
pass=0; fail=0
ok() { if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else fail=$((fail+1)); print -r -- "FAIL $1: got [$2] want [$3]"; fi; }
z() { env -i HOME="$H" PATH=/usr/bin:/bin HOMEBREW_PREFIX=/opt/homebrew "$@"; }
get() { z "${@:2}" /bin/zsh -c "print -r -- \${$1-UNSET}" 2>/dev/null; }

# Every variable env.zsh must route to the cache root (the list report --check reads), plus
# any further route the file adds (read from it, so a new route is covered too).
routed=(DEVCACHE CLEAN_DEVELOPMENT_ROOT CLEAN_DEVELOPMENT_CACHE_ROOT CLEAN_DEVELOPMENT_BUILD_ROOT
  CLEAN_DEVELOPMENT_SCRATCH_ROOT CLEAN_DEV_BUILDS XCODE_DERIVED_DATA_PATH DEVLIBRARY SWIFTPM_SHARED_CACHE
  CLANG_MODULE_CACHE_PATH HOMEBREW_CACHE XDG_CACHE_HOME GOCACHE GOMODCACHE BUN_INSTALL_CACHE_DIR pnpm_config_store_dir
  npm_config_cache YARN_CACHE_FOLDER UV_CACHE_DIR PIP_CACHE_DIR HF_HUB_CACHE HF_ASSETS_CACHE TORCH_HOME NUGET_PACKAGES
  PYTHONPYCACHEPREFIX PLAYWRIGHT_BROWSERS_PATH)
routed=(${(u)routed} ${(f)"$(sed -n 's/^__cd_route \([A-Za-z_][A-Za-z0-9_]*\) "\$__cd_root.*/\1/p' "$plugin/machine/env.zsh")"})
routed=(${(u)routed})
SID=aaaaaaaa-bbbb-4ccc-8ddd-0123456789ab; KEY=c-0123456789ab  # gitleaks:allow
TID=019a2b3c-4d5e-7f60-8a9b-c0d1e2f3a4b5; XKEY=x-c0d1e2f3a4b5  # gitleaks:allow

# M matrix: terminal, Claude and Codex shells in both modes (zsh and bash 3.2).
#   Every routed variable is set and under the chosen root (nothing falls back to tool defaults), agent TMPDIR is its
#   scratch, terminal TMPDIR stays the macOS default, stdout is silent and a second source changes nothing.
for mode in present absent; do
  if [[ $mode == present ]]; then root="$EXT"; want=external; else root="$INT"; want=internal; fi
  for kind in terminal claude codex; do
    case $kind in
      terminal) ids=(TMPDIR="$DEF"); key="" ;;
      claude) ids=(CLAUDE_CODE_SESSION_ID=$SID TMPDIR="$DEF"); key=$KEY ;;
      codex) ids=(CODEX_THREAD_ID=$TID TMPDIR="$DEF"); key=$XKEY ;;
    esac
    c="$mode.$kind"; cell=(DEV_STORAGE_VOLUME_TEST=$mode $ids)
    ok $c.mode "$(get CLEAN_DEV_MODE $cell)" $want
    for sh in zsh bash; do
      if [[ $sh == zsh ]]; then run=(/bin/zsh -c); else run=(/bin/bash -c '. "$HOME/dev/machine/env.zsh"; "$@"' _ /bin/bash -c); fi
      # Fresh roots for every shell, mode and harness. External routing needs only its empty root present.
      rm -rf "$EXT" "$INT"
      mkdir -p "$EXT"
      # Inspection must create no folder or private-settings side effect, even on fresh roots.
      print -r -- ': > "$HOME/inspection-private-ran"' > "$H/dev/machine/env.private.zsh"
      before="$(find "$H" "$V" -print | LC_ALL=C sort)"
      z $cell DEV_ENV_INSPECT_ONLY=1 $run ':' >/dev/null 2>&1
      after="$(find "$H" "$V" -print | LC_ALL=C sort)"
      ok $c.$sh.inspect "$after" "$before"
      rm "$H/dev/machine/env.private.zsh"
      out="$(z $cell $run env 2>/dev/null)"
      bad=""
      for v in $routed; do
        val="$(print -r -- "$out" | sed -n "s|^$v=||p")"
        [[ "$val" == "$root" || "$val" == "$root/"* ]] || bad="$bad $v=$val"
      done
      ok $c.$sh.routed "${bad:-none}" none
      # Check every exported path under the root, including direct exports such as agent scratch and TMPDIR.
      missing=""
      for entry in ${(f)out}; do
        val="${entry#*=}"
        if [[ "$val" == "$root" || "$val" == "$root/"* ]]; then
          [[ -d "$val" ]] || missing="$missing ${entry%%=*}=$val"
        fi
      done
      ok $c.$sh.folders "${missing:-none}" none
      ok $c.$sh.nomkdir "$(z $cell $run 'mkdir() { printf "unexpected mkdir\n"; return 1; }; . "$HOME/dev/machine/env.zsh"' 2>/dev/null)" ""
      tmp="$(z $cell $run 'printf %s "${TMPDIR-UNSET}|${CLEAN_DEV_SCRATCH-UNSET}|${CLEAN_DEV_BUILDS-UNSET}"' 2>/dev/null)"
      if [[ -n $key ]]; then
        ok $c.$sh.tmp "$tmp" "$root/scratch/$key/tmp|$root/scratch/$key|$root/builds/$key"
      else
        ok $c.$sh.tmp "$tmp" "$DEF|UNSET|$root/builds/shell"
      fi
      ok $c.$sh.stdout "$(z $cell $run ':' 2>/dev/null)" ""
      a="$(z $cell $run 'env | LC_ALL=C sort' 2>/dev/null)"
      b="$(z $cell $run '. "$HOME/dev/machine/env.zsh"; env | LC_ALL=C sort' 2>/dev/null)"
      ok $c.$sh.idem "$( [[ -n "$a" && "$a" == "$b" ]] && print same || print differs)" same
    done
    [[ -n $key ]] && ok $c.scratchdir "$( [[ -d $root/scratch/$key/tmp ]] && print yes)" yes
    # Negative: a sloppy parent (no matching stamp) points routed variables outside the root; env.zsh corrects them.
    ok $c.sloppy "$(get npm_config_cache $cell npm_config_cache=/sloppy/npm)" "$root/deps/npm"
    ok $c.sloppyxdg "$(get XDG_CACHE_HOME $cell XDG_CACHE_HOME=$H/.cache)" "$root/deps/xdg"
    ok $c.sloppystamp "$(get DEVCACHE $cell DEVCACHE=/sloppy CLEAN_DEV_STAMP='other|/sloppy|')" "$root"
  done
done
# A failed mkdir leaves the shell usable; the next source retries after the obstruction is removed.
for sh in zsh bash; do
  if [[ $sh == zsh ]]; then run=(/bin/zsh -c); else run=(/bin/bash -c '. "$HOME/dev/machine/env.zsh"; "$@"' _ /bin/bash -c); fi
  rm -rf "$INT"
  mkdir -p "$INT/deps"
  : > "$INT/deps/npm"
  ok R.$sh.blocked "$(z DEV_STORAGE_VOLUME_TEST=absent TMPDIR="$DEF" $run 'set -e; . "$HOME/dev/machine/env.zsh"; printf "%s|%s" "$DEV_ENV_LOADED" "$([ -d "$npm_config_cache" ] && printf directory || printf blocked)"' 2>/dev/null)" '1|blocked'
  rm "$INT/deps/npm"
  ok R.$sh.retry "$(z DEV_STORAGE_VOLUME_TEST=absent TMPDIR="$DEF" $run '[ -d "$npm_config_cache" ] && printf directory' 2>/dev/null)" directory
done
# Terminal TMPDIR unset or empty is repaired to the macOS default in both modes and shells.
for mode in present absent; do
  for sh in zsh bash; do
    if [[ $sh == zsh ]]; then run=(/bin/zsh -c); else run=(/bin/bash -c '. "$HOME/dev/machine/env.zsh"; "$@"' _ /bin/bash -c); fi
    ok T.$mode.$sh.unset "$(z DEV_STORAGE_VOLUME_TEST=$mode $run 'printf %s "${TMPDIR-UNSET}"' 2>/dev/null)" "$DEF"
    ok T.$mode.$sh.empty "$(z DEV_STORAGE_VOLUME_TEST=$mode TMPDIR= $run 'printf %s "${TMPDIR-UNSET}"' 2>/dev/null)" "$DEF"
  done
done
ok M.nostate "$( [[ -e $STATE ]] && print written || print none)" none

# A host settings are left alone
ok A.hfhome "$(get HF_HOME)" UNSET
ok A.hfpreserve "$(get HF_HOME HF_HOME=/private/huggingface)" /private/huggingface
ok A.yarnglobal "$(get YARN_GLOBAL_FOLDER)" UNSET
ok A.cargo "$(get CARGO_HOME)" UNSET
ok A.hosttool "$(get CARGO_HOME CARGO_HOME=/custom/cargo)" /custom/cargo
ok A.xdgconfig "$(get XDG_CONFIG_HOME XDG_CONFIG_HOME=/custom/config)" /custom/config
ok A.xdgdata "$(get XDG_DATA_HOME XDG_DATA_HOME=/custom/data)" /custom/data
ok A.docker "$(get DOCKER_CONFIG DOCKER_CONFIG=/custom/docker)" /custom/docker
ok A.locale "$(get LANG LANG=fr_FR.UTF-8)" fr_FR.UTF-8
ok A.ollama "$(get OLLAMA_MODELS)" UNSET
ok A.ollamapreserve "$(get OLLAMA_MODELS OLLAMA_MODELS=/custom/models)" /custom/models
ok A.tart "$(get TART_HOME DEV_STORAGE_VOLUME_TEST=absent)" UNSET
ok A.colima "$(get COLIMA_HOME)" UNSET
ok A.lima "$(get LIMA_HOME DEV_STORAGE_VOLUME_TEST=absent)" UNSET
ok A.notmp "$(get TMPDIR)" "$DEF"
ok A.retiredsession "$(get CLEAN_DEV_SESSION CLEAN_DEV_SESSION=$KEY)" UNSET

# F precedence: an inherited matching stamp keeps a deliberate override; a mode change re-routes everything
ok F.keep "$(z /bin/zsh -c 'export npm_config_cache=/custom; /bin/zsh -c "print -r -- \$npm_config_cache"' 2>/dev/null)" /custom
ok F.modechange "$(z /bin/zsh -c 'export npm_config_cache=/custom; DEV_STORAGE_VOLUME_TEST=absent /bin/zsh -c "print -r -- \$npm_config_cache"' 2>/dev/null)" "$INT/deps/npm"
ok F.agentchild "$(z /bin/zsh -c 'export npm_config_cache=/custom; CLAUDE_CODE_SESSION_ID='$SID' /bin/zsh -c "print -r -- \$npm_config_cache"' 2>/dev/null)" "$EXT/deps/npm"

# H inspection never writes
ok H.mode "$(get CLEAN_DEV_MODE CLAUDE_CODE_SESSION_ID=ffffffff-0000-4000-8000-feedfacecafe DEV_ENV_INSPECT_ONLY=1)" external
ok H.nodir "$( [[ -e $EXT/scratch/c-feedfacecafe ]] && print made || print none)" none

# J PATH: machine command first, retired shim removed, user-managed paths retained
p="$(z PATH="$H/Library/Application Support/clean-development/bin:$H/dev/bin:/usr/bin:/bin" /bin/zsh -c 'print -r -- $PATH' 2>/dev/null)"
ok J.first "${p%%:*}" "$H/dev/machine/bin"
ok J.noshim "$( [[ ":$p:" == *"clean-development/bin"* ]] && print present || print gone)" gone
ok J.userbin "$( [[ ":$p:" == *":$H/dev/bin:"* ]] && print present || print gone)" present

# K terminal shell repairs an inherited TMPDIR on removable media, in agent scratch or missing
ok K.volumes "$(get TMPDIR TMPDIR=/Volumes/External/cache/scratch/tmp)" "$DEF"
ok K.scratch "$(get TMPDIR TMPDIR=$INT/scratch/$XKEY/tmp)" "$DEF"
ok K.missing "$(get TMPDIR TMPDIR=$sim/no-such-tmp)" "$DEF"

# L invalid storage.conf disables external storage without breaking the shell; retired keys stay valid
cp "$H/dev/machine/storage.conf" "$sim/storage.conf.bak"
print 'EXTERNAL_ROOT=relative/path' >> "$H/dev/machine/storage.conf"
ok L.mode "$(get CLEAN_DEV_MODE)" internal
ok L.loaded "$(get DEV_ENV_LOADED)" 1
cp "$sim/storage.conf.bak" "$H/dev/machine/storage.conf"
print 'UNKNOWN_POLICY_KEY=1' >> "$H/dev/machine/storage.conf"
ok L.unknown "$(get CLEAN_DEV_MODE)" internal
cp "$sim/storage.conf.bak" "$H/dev/machine/storage.conf"
printf '%s\n' STORAGE_CONF_VERSION=1 SD_VOLUME=SD DEPS_CAP_GB=1000000 DEPS_MIN_IDLE_HOURS=2 EXTERNAL_BUILD_DAYS=14 \
  EXTERNAL_PRUNE_EVERY_DAYS=7 INTERNAL_BUILD_IDLE_HOURS=24 SESSION_STALE_HOURS=24 'DEV_TOP_ALLOW="machine source"' \
  'HOME_DOTFILE_ALLOW=".zshrc .zshenv"' >> "$H/dev/machine/storage.conf"
ok L.retired "$(get CLEAN_DEV_MODE)" external
cp "$sim/storage.conf.bak" "$H/dev/machine/storage.conf"

# P DEV_STORAGE_VOLUME_TEST=present|mounted is the normal probe; it never fakes a mount
ok P.mounted "$(get CLEAN_DEV_MODE DEV_STORAGE_VOLUME_TEST=mounted)" external
mv "$V/dev/cache" "$V/dev/cache.unplugged"
ok P.presentnofake "$(get CLEAN_DEV_MODE DEV_STORAGE_VOLUME_TEST=present)" internal
ok P.agentaway "$(get TMPDIR CLAUDE_CODE_SESSION_ID=$SID)" "$INT/scratch/$KEY/tmp"
mv "$V/dev/cache.unplugged" "$V/dev/cache"
ok P.agentback "$(get TMPDIR CLAUDE_CODE_SESSION_ID=$SID)" "$EXT/scratch/$KEY/tmp"

# N both harness variables set keys on Claude; with CLAUDE_CODE_SESSION_ID blanked Codex's own thread id is used
NS=bbbbbbbb-bbbb-4bbb-8bbb-aabbccddeeff; NT=019a2b3c-4d5e-7f60-8a9b-112233445566
ok N.both "$(get CLEAN_DEV_BUILDS CLAUDE_CODE_SESSION_ID=$NS CODEX_THREAD_ID=$NT)" "$EXT/builds/c-aabbccddeeff"
ok N.blank "$(get TMPDIR CLAUDE_CODE_SESSION_ID= CODEX_THREAD_ID=$NT)" "$EXT/scratch/x-112233445566/tmp"

# O placeholder, short and non-ASCII ids get no key (terminal routing); deliberate 12+ character ids stay valid
ok O.placeholder "$(get TMPDIR CLAUDE_CODE_SESSION_ID=aaaaaaaa-to-be-unset)" "$DEF"
ok O.short "$(get CLEAN_DEV_SCRATCH CODEX_THREAD_ID=KEY1)" UNSET
ok O.stubtoken "$(get CLEAN_DEV_SCRATCH CODEX_THREAD_ID=ol2-stub-key)" UNSET
ok O.handset "$(get CLEAN_DEV_SCRATCH CODEX_THREAD_ID=maintree0001)" "$EXT/scratch/x-maintree0001"
ok O.utf8 "$(z LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 CODEX_THREAD_ID=019a2b3c-4d5e-7f60-8a9b-00000000000é /bin/bash -c '. "$HOME/dev/machine/env.zsh"; printf %s "${CLEAN_DEV_SCRATCH-UNSET}"' 2>/dev/null)" UNSET

# Agent ID rule matches report: each harness rejects short/placeholder/non-ASCII IDs, and accepts 12+ ASCII IDs.
for sh in zsh bash; do
  if [[ $sh == zsh ]]; then run=(/bin/zsh -c); else run=(/bin/bash -c '. "$HOME/dev/machine/env.zsh"; "$@"' _ /bin/bash -c); fi
  for harness in CODEX_THREAD_ID CLAUDE_CODE_SESSION_ID; do
    [[ $harness == CODEX_THREAD_ID ]] && prefix=x || prefix=c
    for id in '' KEY1 12345678901 aaaaaaaa-to-be-unset placeholder-123456789012 123456789012-STUB 123456789012_null_id é123456789012 bad/123456789012; do
      ok ID.$sh.$harness.$id "$(z "$harness=$id" TMPDIR="$DEF" $run 'printf %s "${CLEAN_DEV_SCRATCH-UNSET}|$TMPDIR"' 2>/dev/null)" "UNSET|$DEF"
    done
    for id in maintree0001 $TID myplaceholder123 id-MixedCase123; do
      tail="${id[-12,-1]}"
      ok ID.$sh.$harness.$id "$(z "$harness=$id" TMPDIR="$DEF" $run 'printf %s "${CLEAN_DEV_SCRATCH-UNSET}|$TMPDIR"' 2>/dev/null)" "$EXT/scratch/$prefix-$tail|$EXT/scratch/$prefix-$tail/tmp"
    done
    ok ID.$sh.precedence "$(z CLAUDE_CODE_SESSION_ID=KEY1 CODEX_THREAD_ID=$TID TMPDIR="$DEF" $run 'printf %s "${CLEAN_DEV_SCRATCH-UNSET}"' 2>/dev/null)" UNSET
  done
done

# R Python bytecode goes to the cache, never __pycache__ in the tree
if [[ -x /usr/bin/python3 ]] && /usr/bin/python3 -c 1 2>/dev/null; then
  mkdir -p "$sim/pyrepo" && print 'X = 1' > "$sim/pyrepo/pymod.py"
  z /bin/zsh -c "cd '$sim/pyrepo' && /usr/bin/python3 -c 'import pymod'" 2>/dev/null
  ok R.notree "$( [[ -e $sim/pyrepo/__pycache__ ]] && print present || print absent)" absent
  ok R.cached "$( ls $EXT/deps/pycache/**/pymod*.pyc(DN) 2>/dev/null | head -1 | grep -c pymod)" 1
fi

# U zsh checks mount identity (zstat, no fork): the fixture volume is a plain directory, so the strict switch routes
#   it internal in zsh; bash 3.2 keeps the existence and write checks.
ok U.strictzsh "$(get CLEAN_DEV_MODE DEV_STORAGE_VOLUME_TEST=strict)" internal
ok U.strictsession "$(get TMPDIR CLAUDE_CODE_SESSION_ID=$SID DEV_STORAGE_VOLUME_TEST=strict)" "$INT/scratch/$KEY/tmp"
ok U.strictbash "$(z DEV_STORAGE_VOLUME_TEST=strict /bin/bash -c '. "$HOME/dev/machine/env.zsh"; printf %s "$CLEAN_DEV_MODE"' 2>/dev/null)" external

# T CLEAN_DEV_WORK prefers a writable LAB_ROOT parent below the mount, then writable EXTERNAL_ROOT, else internal.
cp "$H/dev/machine/storage.conf" "$sim/storage.conf.worktree.bak"
sed "s#^LAB_ROOT=.*#LAB_ROOT=$V/not-created/lab#" "$sim/storage.conf.worktree.bak" > "$H/dev/machine/storage.conf"
ok T.customlab "$(get CLEAN_DEV_WORK)" "$V/dev"
sed "s#^LAB_ROOT=.*#LAB_ROOT=$V/work/lab#" "$sim/storage.conf.worktree.bak" > "$H/dev/machine/storage.conf"
mkdir -p "$V/work"
ok T.labparent "$(get CLEAN_DEV_WORK)" "$V/work"
chmod 500 "$V/work"
ok T.labparent-readonly "$(get CLEAN_DEV_WORK)" "$V/dev"
chmod 700 "$V/work"
chmod 500 "$V/dev"
ok T.labparent-extroot-readonly "$(get CLEAN_DEV_WORK)" "$V/work"
chmod 700 "$V/dev"
cp "$sim/storage.conf.worktree.bak" "$H/dev/machine/storage.conf"
ok T.external "$(get CLEAN_DEV_WORK)" "$V/dev"
ok T.session "$(get CLEAN_DEV_WORK CLAUDE_CODE_SESSION_ID=$SID)" "$V/dev"
ok T.absent "$(get CLEAN_DEV_WORK DEV_STORAGE_VOLUME_TEST=absent)" "$H/dev/machine"
chmod 500 "$V/dev"
ok T.readonly "$(get CLEAN_DEV_WORK)" "$H/dev/machine"
chmod 600 "$V/dev"
ok T.nosearch "$(get CLEAN_DEV_WORK)" "$H/dev/machine"
chmod 700 "$V/dev"

ok Z.nostate "$( [[ -e $STATE ]] && print written || print none)" none
print "env-modes: $pass passed, $fail failed"
exit $(( fail > 0 ))
