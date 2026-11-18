# Clean Development 1.0.1 environment routing for macOS.
# Loaded by EVERY zsh through ~/.zshenv (interactive or not, login or not; agent tool shells included), again at the end
# of ~/.zprofile (path_helper reorders PATH in login shells), and sourced by bash 3.2 scripts.
# Keep it POSIX: no zsh-only or bash-only syntax. Idempotent. Never prints to stdout, never exits, last command succeeds.
# It creates missing routed folders under the cache root (nothing at all with DEV_ENV_INSPECT_ONLY=1).
#
# Storage (single source: ~/dev/machine/storage.conf):
#   external mode  the configured $EXTERNAL_VOLUME is mounted and $EXTERNAL_CACHE is a writable directory
#                  -> DEVCACHE=$EXTERNAL_CACHE
#   internal mode  otherwise -> DEVCACHE=$INTERNAL_ROOT (~/dev/machine/cache). Normal, not an error. Dependency caches
#                  and builds route to the internal root too; nothing falls back to tool defaults.
#   Cache root layout: deps/ (shared dependency caches), builds/ (build output), scratch/<key>/tmp (agent TMPDIR).
#   Every shell decides the mode itself (fork-free probe below), so storage follows the drive.
#
# Agent shells: CLAUDE_CODE_SESSION_ID (Claude Code sets it in every Bash tool and hook process) or CODEX_THREAD_ID
#   (Codex sets it in every exec command) names the key: c-<last 12 chars> or x-<last 12 chars>. A non-empty
#   CLAUDE_CODE_SESSION_ID wins, so Codex's shell_environment_policy.set blanks it. Ids shorter than 12 characters or
#   with a placeholder token (unset, placeholder, stub, ...) get no key. An agent shell gets
#   TMPDIR=$DEVCACHE/scratch/<key>/tmp and CLEAN_DEV_BUILDS=$DEVCACHE/builds/<key>.
# Terminal shells (Warp, launchd, scripts) keep the macOS per-user TMPDIR, repaired only when it is missing or on
#   removable media, and get CLEAN_DEV_BUILDS=$DEVCACHE/builds/shell.
# CLEAN_DEV_WORK is the work root for worktrees, jobs and bundles: a writable parent of LAB_ROOT below the mounted
#   volume, otherwise writable EXTERNAL_ROOT, otherwise ~/dev/machine
#   ($W/worktrees/<repo>/<task>, $W/jobs/<project>, $W/bundles/<repo>).
#
# Precedence: CLEAN_DEV_STAMP="<mode>|<root>|<key>" is exported. When an inherited stamp equals the one computed here,
#   the shell sits in a tree this file already routed, so a routing variable that arrives non-empty is KEPT (a script's
#   deliberate override survives nested zsh -c). Otherwise Clean Development routing variables are reset to the values
#   below (a sloppy parent is corrected; a mode change re-routes everything). Locale, toolchain homes, application
#   settings and other machine preferences are left to the host.
# Test only: DEV_STORAGE_VOLUME_TEST=absent treats the external volume as absent; =present (alias =mounted, the runtime's
#   name) is the normal probe: the external cache directory must exist and be writable (it never fakes a mount); =strict
#   applies the zsh device check to fixture volumes too (it can only make routing stricter).
#   DEV_ENV_INSPECT_ONLY=1 never writes (no mkdir, no env.private.zsh) so inspection tools can source this file safely.

export DEV="$HOME/dev"
export DEVMACHINE="$DEV/machine"
export CLEAN_DEV_VERSION=1.0.1

# ---- storage.conf (defaults first; the file may override every key) -------------------------------------------
# The accepted key set matches the runtime's reader, so one file stays valid for both. Only the path keys route here;
# the other keys are validated and ignored (keys the sample no longer carries stay accepted for existing files).
unset STORAGE_CONF_VERSION EXTERNAL_VOLUME EXTERNAL_ROOT EXTERNAL_CACHE INTERNAL_ROOT LAB_ROOT MODELS_ROOT SD_VOLUME \
  DEPS_CAP_GB DEPS_MIN_IDLE_HOURS EXTERNAL_BUILD_DAYS EXTERNAL_PRUNE_EVERY_DAYS INTERNAL_BUILD_IDLE_HOURS \
  SESSION_STALE_HOURS BIG_DOWNLOAD_GB INTERNAL_MIN_FREE_GB DEV_TOP_ALLOW HOME_DOT_ALLOW HOME_DOTFILE_ALLOW DEV_DOT_ALLOW
EXTERNAL_VOLUME=External
EXTERNAL_ROOT=/Volumes/External/dev
EXTERNAL_CACHE=/Volumes/External/dev/cache
INTERNAL_ROOT="$DEVMACHINE/cache"
LAB_ROOT=/Volumes/External/dev/lab
MODELS_ROOT=/Volumes/External/models
SD_VOLUME=
__cd_conf_ok=1
# storage.conf is data, not a shell programme. Parse without forks or evaluating file contents.
# Only validated variable NAMES enter eval; substituted values are never parsed as shell syntax.
__cd_defined='|HOME|'
if [ -r "$DEVMACHINE/storage.conf" ]; then
  while IFS= read -r __cd_line || [ -n "$__cd_line" ]; do
    __cd_line="${__cd_line#"${__cd_line%%[![:space:]]*}"}"
    __cd_line="${__cd_line%"${__cd_line##*[![:space:]]}"}"
    case "$__cd_line" in ''|\#*) continue ;; *=*) ;; *) __cd_conf_ok=0; continue ;; esac
    __cd_k="${__cd_line%%=*}"; __cd_v="${__cd_line#*=}"
    case "$__cd_k" in
      STORAGE_CONF_VERSION|EXTERNAL_VOLUME|EXTERNAL_ROOT|EXTERNAL_CACHE|INTERNAL_ROOT|LAB_ROOT|MODELS_ROOT|SD_VOLUME|\
      DEPS_CAP_GB|DEPS_MIN_IDLE_HOURS|EXTERNAL_BUILD_DAYS|EXTERNAL_PRUNE_EVERY_DAYS|INTERNAL_BUILD_IDLE_HOURS|\
      SESSION_STALE_HOURS|BIG_DOWNLOAD_GB|INTERNAL_MIN_FREE_GB|DEV_TOP_ALLOW|HOME_DOT_ALLOW|HOME_DOTFILE_ALLOW|DEV_DOT_ALLOW) ;;
      *) __cd_conf_ok=0; continue ;;
    esac
    case "$__cd_v" in *'`'*|*'$('* ) __cd_conf_ok=0; continue ;; esac
    __cd_expand=1
    case "$__cd_v" in
      \') __cd_conf_ok=0; continue ;;
      \'*) case "$__cd_v" in *\') __cd_v="${__cd_v#\'}"; __cd_v="${__cd_v%\'}"; __cd_expand=0 ;; *) __cd_conf_ok=0; continue ;; esac ;;
      \") __cd_conf_ok=0; continue ;;
      \"*) case "$__cd_v" in *\") __cd_v="${__cd_v#\"}"; __cd_v="${__cd_v%\"}" ;; *) __cd_conf_ok=0; continue ;; esac ;;
      *[[:space:]]*) __cd_conf_ok=0; continue ;;
    esac
    if [ "$__cd_expand" = 1 ]; then
      __cd_rest="$__cd_v"; __cd_result=''
      while :; do
        case "$__cd_rest" in *'$'*) ;; *) break ;; esac
        __cd_result="$__cd_result${__cd_rest%%\$*}"; __cd_rest="${__cd_rest#*\$}"
        case "$__cd_rest" in
          \{*\}*) __cd_name="${__cd_rest%%\}*}"; __cd_name="${__cd_name#\{}"; __cd_rest="${__cd_rest#*\}}" ;;
          \{*) __cd_conf_ok=0; __cd_rest=''; break ;;
          *) __cd_name="${__cd_rest%%[!A-Za-z0-9_]*}"; __cd_rest="${__cd_rest#"$__cd_name"}" ;;
        esac
        case "$__cd_name" in ''|[0-9]*|*[!A-Za-z0-9_]*) __cd_conf_ok=0; __cd_rest=''; break ;; esac
        case "$__cd_defined" in *"|$__cd_name|"*) eval "__cd_repl=\${$__cd_name-}" ;; *) __cd_conf_ok=0; __cd_repl='' ;; esac
        __cd_result="$__cd_result$__cd_repl"
      done
      __cd_v="$__cd_result$__cd_rest"
    fi
    eval "$__cd_k=\$__cd_v"
    __cd_defined="$__cd_defined$__cd_k|"
  done < "$DEVMACHINE/storage.conf"
fi
# The runtime computes dependent defaults in the same order when keys are omitted.
case "$__cd_defined" in *'|EXTERNAL_ROOT|'*) ;; *) EXTERNAL_ROOT="/Volumes/$EXTERNAL_VOLUME/dev" ;; esac
case "$__cd_defined" in *'|EXTERNAL_CACHE|'*) ;; *) EXTERNAL_CACHE="$EXTERNAL_ROOT/cache" ;; esac
case "$__cd_defined" in *'|LAB_ROOT|'*) ;; *) LAB_ROOT="/Volumes/$EXTERNAL_VOLUME/dev/lab" ;; esac
case "$__cd_defined" in *'|MODELS_ROOT|'*) ;; *) MODELS_ROOT="/Volumes/$EXTERNAL_VOLUME/models" ;; esac
case "$EXTERNAL_VOLUME" in ''|*/*|.|..) __cd_conf_ok=0 ;; esac
for __cd_k in EXTERNAL_ROOT EXTERNAL_CACHE INTERNAL_ROOT LAB_ROOT MODELS_ROOT; do
  eval "__cd_p=\${$__cd_k-}"
  case "$__cd_p" in /*) ;; *) __cd_conf_ok=0 ;; esac
  case "/$__cd_p/" in */../*|*/./*) __cd_conf_ok=0 ;; esac
  while :; do
    case "$__cd_p" in *//*) __cd_p="${__cd_p%%//*}/${__cd_p#*//}" ;; *) break ;; esac
  done
  while [ "$__cd_p" != / ]; do
    case "$__cd_p" in */) __cd_p="${__cd_p%/}" ;; *) break ;; esac
  done
  eval "$__cd_k=\$__cd_p"
done
case "$EXTERNAL_ROOT" in */Volumes/"$EXTERNAL_VOLUME"|*/Volumes/"$EXTERNAL_VOLUME"/*) ;; *) __cd_conf_ok=0 ;; esac
case "$EXTERNAL_CACHE" in "$EXTERNAL_ROOT"/*) ;; *) __cd_conf_ok=0 ;; esac
for __cd_k in DEPS_CAP_GB DEPS_MIN_IDLE_HOURS EXTERNAL_BUILD_DAYS EXTERNAL_PRUNE_EVERY_DAYS INTERNAL_BUILD_IDLE_HOURS SESSION_STALE_HOURS BIG_DOWNLOAD_GB INTERNAL_MIN_FREE_GB; do
  # Absent numeric keys use the runtime defaults; supplied values are non-negative plain decimals.
  case "$__cd_defined" in *"|$__cd_k|"*)
    eval "__cd_v=\${$__cd_k-}"
    case "$__cd_v" in ''|.|*[!0-9.]*|*.*.*) __cd_conf_ok=0 ;; esac ;;
  esac
done
for __cd_cache in "$INTERNAL_ROOT" "$EXTERNAL_CACHE"; do
  case "$__cd_cache" in /) __cd_conf_ok=0 ;; esac
  for __cd_p in "$HOME" "$DEV" "$DEVMACHINE" "$DEV/source" "$LAB_ROOT" "$MODELS_ROOT"; do
    case "$__cd_p/" in "$__cd_cache/"*) __cd_conf_ok=0 ;; esac
  done
  case "$__cd_cache/" in /|"$DEV/source/"*|"$DEVMACHINE/state/"*|"$DEVMACHINE/toolchains/"*|"$LAB_ROOT/"*|"$MODELS_ROOT/"*) __cd_conf_ok=0 ;; esac
done
case "$INTERNAL_ROOT/" in "$EXTERNAL_CACHE/"*) __cd_conf_ok=0 ;; esac
case "$EXTERNAL_CACHE/" in "$INTERNAL_ROOT/"*) __cd_conf_ok=0 ;; esac
if [ "$__cd_conf_ok" != 1 ]; then
  case $- in *i*) printf 'env.zsh: storage.conf is invalid (paths must be absolute, EXTERNAL_ROOT under /Volumes/%s); external storage disabled\n' "$EXTERNAL_VOLUME" >&2 ;; esac
  INTERNAL_ROOT="$DEVMACHINE/cache"
fi

# ---- agent key ----------------------------------------------------------------------------------------------------
__cd_id=""; __cd_h=""; __cd_key=""; __cd_idbad=""
if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then __cd_id="$CLAUDE_CODE_SESSION_ID"; __cd_h=c
elif [ -n "${CODEX_THREAD_ID:-}" ]; then __cd_id="$CODEX_THREAD_ID"; __cd_h=x
fi
# 12+ ASCII letters/digits/_/-, no lower- or uppercase placeholder token at hyphen/underscore boundaries.
if [ -n "$__cd_id" ]; then
  [ "${#__cd_id}" -ge 12 ] || __cd_idbad="shorter than 12 characters"
  # Explicit ASCII list: bracket ranges are locale-dependent (bash 3.2 under UTF-8 accepted "é" in A-Z).
  case "$__cd_id" in *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-]*) __cd_idbad="non-ASCII or invalid character" ;; esac
  case "-$__cd_id-" in
    *[-_]unset[-_]*|*[-_]UNSET[-_]*|*[-_]placeholder[-_]*|*[-_]PLACEHOLDER[-_]*|*[-_]changeme[-_]*|*[-_]CHANGEME[-_]*|\
    *[-_]dummy[-_]*|*[-_]DUMMY[-_]*|*[-_]example[-_]*|*[-_]EXAMPLE[-_]*|*[-_]stub[-_]*|*[-_]STUB[-_]*|\
    *[-_]undefined[-_]*|*[-_]UNDEFINED[-_]*|*[-_]null[-_]*|*[-_]NULL[-_]*|*[-_]none[-_]*|*[-_]NONE[-_]*|*[-_]todo[-_]*|*[-_]TODO[-_]*)
      __cd_idbad="placeholder value" ;;
  esac
fi
if [ -n "$__cd_id" ] && [ -z "$__cd_idbad" ]; then
  __cd_pre="${__cd_id%????????????}"
  if [ "$__cd_pre" = "$__cd_id" ]; then __cd_tail="$__cd_id"; else __cd_tail="${__cd_id#"$__cd_pre"}"; fi
  __cd_key="$__cd_h-$__cd_tail"
elif [ -n "$__cd_idbad" ]; then
  case $- in *i*) printf 'env.zsh: agent id rejected (%s); this shell gets no agent scratch\n' "$__cd_idbad" >&2 ;; esac
fi

# ---- mode (fork-free probe: name-based path, directory present, writable) ----------------------------------------
__cd_ext_ok() {
  [ "${DEV_STORAGE_VOLUME_TEST:-}" = absent ] && return 1
  [ "$__cd_conf_ok" = 1 ] || return 1
  [ -d "$EXTERNAL_CACHE" ] || return 1
  [ -w "$EXTERNAL_CACHE" ] && [ -x "$EXTERNAL_CACHE" ] || return 1
  # Mount identity (a stale mount point must not pass): in zsh, which runs every agent shell, the zstat builtin compares
  # devices without a fork, as the runtime does. The mount point must sit on a different device from /Volumes and the
  # cache on the mount point's. Bash 3.2 scripts keep the existence and write checks. Fixture volumes (not
  # /Volumes/<name>) skip the check unless the test asks for it.
  if [ -n "${ZSH_VERSION:-}" ] && { [ "$__cd_mp" = "/Volumes/$EXTERNAL_VOLUME" ] || [ "${DEV_STORAGE_VOLUME_TEST:-}" = strict ]; } \
    && zmodload -F zsh/stat b:zstat 2>/dev/null; then
    __cd_dm=""; __cd_dp=""; __cd_dc=""
    zstat -A __cd_dm +device -- "$__cd_mp" 2>/dev/null; zstat -A __cd_dp +device -- "${__cd_mp%/*}" 2>/dev/null
    zstat -A __cd_dc +device -- "$EXTERNAL_CACHE" 2>/dev/null
    if [ -z "$__cd_dm" ] || [ "$__cd_dm" = "$__cd_dp" ] || [ "$__cd_dc" != "$__cd_dm" ]; then return 1; fi
  fi
  return 0
}
__cd_mp="${EXTERNAL_ROOT%%/Volumes/"$EXTERNAL_VOLUME"*}/Volumes/$EXTERNAL_VOLUME"
if __cd_ext_ok; then __cd_mode=external; __cd_root="$EXTERNAL_CACHE"; else __cd_mode=internal; __cd_root="$INTERNAL_ROOT"; fi

__cd_stamp="$__cd_mode|$__cd_root|$__cd_key"
__cd_keep=0
if [ "${CLEAN_DEV_STAMP:-}" = "$__cd_stamp" ]; then __cd_keep=1; fi
# Create routed folders only under the selected root; host-managed locations stay untouched.
__cd_ensure_dir() {
  if [ "${DEV_ENV_INSPECT_ONLY:-}" != 1 ]; then
    case "$1" in "$__cd_root"|"$__cd_root"/*) [ -d "$1" ] || mkdir -p "$1" 2>/dev/null || : ;; esac
  fi
  return 0
}
# __cd_route NAME VALUE: export NAME=VALUE, except inside an already-routed tree (same stamp) where a non-empty
# inherited NAME is kept.
__cd_route() {
  __cd_cur=""
  if [ "$__cd_keep" = 1 ]; then eval "__cd_cur=\${$1:-}"; fi
  if [ -z "$__cd_cur" ]; then __cd_cur="$2"; fi
  eval "$1=\$__cd_cur; export $1"
  __cd_ensure_dir "$__cd_cur"
}
CLEAN_DEV_MODE="$__cd_mode"; CLEAN_DEV_STAMP="$__cd_stamp"
# Work root: prefer LAB_ROOT's writable parent below the mounted volume; fall back to writable EXTERNAL_ROOT.
CLEAN_DEV_WORK="$DEVMACHINE"
if [ "$__cd_mode" = external ]; then
  __cd_lab_parent="${LAB_ROOT%/*}"
  __cd_work=""
  case "$__cd_lab_parent" in
    "$__cd_mp"/*) if [ -d "$__cd_lab_parent" ] && [ -w "$__cd_lab_parent" ] && [ -x "$__cd_lab_parent" ]; then __cd_work="$__cd_lab_parent"; fi ;;
  esac
  if [ -z "$__cd_work" ] && [ -d "$EXTERNAL_ROOT" ] && [ -w "$EXTERNAL_ROOT" ] && [ -x "$EXTERNAL_ROOT" ]; then __cd_work="$EXTERNAL_ROOT"; fi
  if [ -n "$__cd_work" ]; then CLEAN_DEV_WORK="$__cd_work"; fi
fi
export CLEAN_DEV_MODE CLEAN_DEV_STAMP CLEAN_DEV_WORK
__cd_route DEVCACHE "$__cd_root"
unset CLEAN_DEV_SESSION  # retired 0.6.x name; nothing reads it

# ---- agent scratch and builds; terminal TMPDIR -------------------------------------------------------------------
if [ -n "$__cd_key" ]; then
  CLEAN_DEV_SCRATCH="$__cd_root/scratch/$__cd_key"
  CLEAN_DEV_BUILDS="$__cd_root/builds/$__cd_key"
  export CLEAN_DEV_SCRATCH CLEAN_DEV_BUILDS
  __cd_ensure_dir "$CLEAN_DEV_BUILDS"
  if [ ! -d "$CLEAN_DEV_SCRATCH/tmp" ] && [ "${DEV_ENV_INSPECT_ONLY:-}" != 1 ]; then
    (umask 077; mkdir -p "$CLEAN_DEV_SCRATCH/tmp") 2>/dev/null
  fi
  if [ -d "$CLEAN_DEV_SCRATCH/tmp" ] || [ "${DEV_ENV_INSPECT_ONLY:-}" = 1 ]; then
    TMPDIR="$CLEAN_DEV_SCRATCH/tmp"; export TMPDIR
  else
    case $- in *i*) printf 'env.zsh: could not create agent scratch %s; TMPDIR left unchanged\n' "$CLEAN_DEV_SCRATCH/tmp" >&2 ;; esac
  fi
  __cd_route CLEAN_DEVELOPMENT_SCRATCH_ROOT "$CLEAN_DEV_SCRATCH"
else
  unset CLEAN_DEV_SCRATCH
  __cd_route CLEAN_DEV_BUILDS "$__cd_root/builds/shell"
  # Terminal shells keep the macOS per-user TMPDIR. Repair an inherited TMPDIR that is missing, on removable media or
  # an agent scratch path (the GUI domain used to carry an external-volume cache path).
  case "${TMPDIR:-}" in
    '') __cd_fix_tmp=1 ;;
    /Volumes/*|"$DEV/cache"|"$DEV/cache/"*|"$INTERNAL_ROOT/scratch"|"$INTERNAL_ROOT/scratch/"*|"$EXTERNAL_CACHE/scratch"|"$EXTERNAL_CACHE/scratch/"*) __cd_fix_tmp=1 ;;
    *) if [ -d "$TMPDIR" ]; then __cd_fix_tmp=0; else __cd_fix_tmp=1; fi ;;
  esac
  if [ "${__cd_fix_tmp:-0}" = 1 ]; then
    TMPDIR="$(/usr/bin/getconf DARWIN_USER_TEMP_DIR 2>/dev/null)"
    if [ -n "$TMPDIR" ]; then export TMPDIR; else unset TMPDIR; fi
  fi
  __cd_route CLEAN_DEVELOPMENT_SCRATCH_ROOT "$__cd_root/scratch/shell"
fi

# ---- names the repos and scripts already read (kept for compatibility; no logic change in any repo) ---------------
__cd_route CLEAN_DEVELOPMENT_ROOT "$__cd_root"
__cd_route CLEAN_DEVELOPMENT_CACHE_ROOT "$__cd_root/deps"
__cd_route CLEAN_DEVELOPMENT_BUILD_ROOT "$__cd_root/builds"
__cd_route DEVDRIVE "/Volumes/$EXTERNAL_VOLUME/dev"
__cd_route DEV_CACHE_VOLUME "/Volumes/$EXTERNAL_VOLUME"
__cd_route DEVLAB "$LAB_ROOT"
__cd_route DEVMODELS "$MODELS_ROOT"
__cd_route DEVLIBRARY "$__cd_root/deps/library"
__cd_route XCODE_DERIVED_DATA_PATH "$__cd_root/builds/DerivedData"
__cd_route SWIFTPM_SHARED_CACHE "$__cd_root/deps/swiftpm"
__cd_route CLANG_MODULE_CACHE_PATH "$__cd_root/deps/clang-modules"

# ---- application cache roots that Clean Development manages (follow the selected mode) ----------------------------
__cd_route HOMEBREW_CACHE "$__cd_root/deps/homebrew"
__cd_route XDG_CACHE_HOME "$__cd_root/deps/xdg"
__cd_route GOCACHE "$__cd_root/deps/go-build"
__cd_route GOMODCACHE "$__cd_root/deps/go-mod"
__cd_route BUN_INSTALL_CACHE_DIR "$__cd_root/deps/bun"
# pnpm 12 reads pnpm_config_store_dir (`pnpm store path`); npm_config_store_dir is ignored. Keep the store separate
# from the user's existing PNPM_HOME.
__cd_route pnpm_config_store_dir "$__cd_root/deps/pnpm-store"
__cd_route npm_config_cache "$__cd_root/deps/npm"
# Yarn Classic reads YARN_CACHE_FOLDER. Berry's globalFolder is a host tool home and remains unchanged.
__cd_route YARN_CACHE_FOLDER "$__cd_root/deps/yarn"
__cd_route UV_CACHE_DIR "$__cd_root/deps/uv"
__cd_route PIP_CACHE_DIR "$__cd_root/deps/pip"
# HF_HOME may contain an access token, so leave it unchanged and route only cache directories.
__cd_route HF_HUB_CACHE "$__cd_root/deps/huggingface/hub"
__cd_route HF_ASSETS_CACHE "$__cd_root/deps/huggingface/assets"
__cd_route TORCH_HOME "$__cd_root/deps/torch"
__cd_route NUGET_PACKAGES "$__cd_root/deps/nuget"
# Python bytecode goes to the cache, not __pycache__ in repos (bytecode in a tree changes its content identity).
__cd_route PYTHONPYCACHEPREFIX "$__cd_root/deps/pycache"
__cd_route PLAYWRIGHT_BROWSERS_PATH "$__cd_root/deps/playwright"

# ---- PATH: expose the installed Clean Development command; preserve host toolchain and application paths. -----------
__cd_path_front() {
  __np=""
  for __e in "$@"; do
    [ -n "$__e" ] || continue
    case ":$__np:" in *":$__e:"*) ;; *) __np="${__np:+$__np:}$__e" ;; esac
  done
  __old="${PATH:-}"
  while [ -n "$__old" ]; do
    case $__old in *:*) __e="${__old%%:*}"; __old="${__old#*:}" ;; *) __e="$__old"; __old="" ;; esac
    [ -n "$__e" ] || continue
    case "$__e" in "$HOME/Library/Application Support/clean-development/bin") continue ;; esac
    case ":$__np:" in *":$__e:"*) ;; *) __np="${__np:+$__np:}$__e" ;; esac
  done
  PATH="$__np"
  unset __np __old __e
}
__cd_path_front "$DEVMACHINE/bin"
export PATH

# Optional host-specific settings are trusted shell code. Inspection mode must remain read-only and side-effect free.
if [ "${DEV_ENV_INSPECT_ONLY:-}" != 1 ] && [ -r "$DEVMACHINE/env.private.zsh" ]; then . "$DEVMACHINE/env.private.zsh"; fi

unset -f __cd_ensure_dir __cd_route __cd_ext_ok __cd_path_front
unset __cd_conf_ok __cd_p __cd_id __cd_idbad __cd_h __cd_key __cd_pre __cd_tail __cd_mode __cd_root __cd_mp __cd_dm __cd_dp __cd_dc \
  __cd_stamp __cd_keep __cd_cur __cd_fix_tmp __cd_defined __cd_line __cd_k __cd_v __cd_expand __cd_rest __cd_result __cd_name __cd_repl __cd_cache __cd_work __cd_lab_parent
unset STORAGE_CONF_VERSION EXTERNAL_VOLUME EXTERNAL_ROOT EXTERNAL_CACHE INTERNAL_ROOT LAB_ROOT MODELS_ROOT SD_VOLUME \
  DEPS_CAP_GB DEPS_MIN_IDLE_HOURS EXTERNAL_BUILD_DAYS EXTERNAL_PRUNE_EVERY_DAYS INTERNAL_BUILD_IDLE_HOURS \
  SESSION_STALE_HOURS BIG_DOWNLOAD_GB INTERNAL_MIN_FREE_GB DEV_TOP_ALLOW HOME_DOT_ALLOW HOME_DOTFILE_ALLOW DEV_DOT_ALLOW

# Marker: this file ran to the end in this process (not fed to launchd).
export DEV_ENV_LOADED=1
:
