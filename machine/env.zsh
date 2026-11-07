# Clean Development 0.6.8 environment routing for macOS.
# Loaded by EVERY zsh through ~/.zshenv (interactive or not, login or not; agent tool shells included), again at the end
# of ~/.zprofile (path_helper reorders PATH in login shells), and sourced by bash 3.2 scripts.
# Keep it POSIX: no zsh-only or bash-only syntax. Idempotent. Never prints to stdout, never exits, last command succeeds.
#
# Storage (single source: ~/dev/machine/storage.conf):
#   external mode  the configured $EXTERNAL_VOLUME is mounted and $EXTERNAL_CACHE is a writable directory
#                  -> DEVCACHE=$EXTERNAL_CACHE
#   internal mode  otherwise -> DEVCACHE=$INTERNAL_ROOT (~/dev/machine/cache). Normal, not an error.
#   Cache root layout: deps/ (shared dependency caches, 30 GB LRU cap), builds/ (build output), scratch/<session>/,
#   trash/ (pending deletes). Cleanup is done by the clean-development hooks, never by this file.
#
# Agent sessions (0.6.2+: storage follows the drive, per shell):
#   The session key comes from CLAUDE_CODE_SESSION_ID (Claude Code sets it in every Bash tool and hook process) or
#   CODEX_THREAD_ID (Codex sets it in every exec command): key = c-<last 12 chars> or x-<last 12 chars>.
#   A non-empty CLAUDE_CODE_SESSION_ID wins, so Codex's shell_environment_policy.set must blank it (CLAUDE_CODE_SESSION_ID
#   = ""): a Codex started from a Claude shell would otherwise inherit it and run in the Claude session's scratch.
#   Every shell decides the mode itself (fork-free probe below): the external volume when its cache is mounted and writable, the
#   internal disk otherwise. A session can therefore hold scratch and builds on both roots; the hooks record the roots
#   it used and clean its entries on both. ~/dev/machine/state/clean-development/sessions/<key>.mode registers the
#   session for cleanup (written by the SessionStart hook, or by the first shell when no hook ran); its first line is
#   the mode when it was written, never a routing order. A shell that finds the external volume gone after the session
#   used it warns once; that root's scratch and builds wait for the drive.
#   A session gets TMPDIR=$DEVCACHE/scratch/<key>/tmp and CLEAN_DEV_BUILDS=$DEVCACHE/builds/<key>.
#   CLEAN_DEV_WORK is the work root for worktrees, jobs and bundles: the configured external development root when mounted and writable, else
#   ~/dev/machine ($W/worktrees/<repo>/<task>, $W/jobs/<project>, $W/bundles/<repo>).
#   Ids shorter than 12 characters or with a placeholder token (unset, placeholder, stub, ...) get no key (plain shell).
#   With no harness id, an inherited CLEAN_DEV_SESSION is the key when CLEAN_DEV_STAMP ends in "|<that key>": a child
#   started with `clean-development run --clean-env` (no CLAUDE_* variables) keeps its session's scratch and builds.
#   Plain shells (Warp, launchd) detect the mode on every start (fork-free) and leave TMPDIR at the macOS default.
#
# Precedence: CLEAN_DEV_STAMP="<mode>|<root>|<key>" is exported. When an inherited stamp equals the one computed here,
#   the shell sits in a tree this file already routed, so a routing variable that arrives non-empty is KEPT (a script's
#   deliberate override survives nested zsh -c). Otherwise Clean Development routing variables are reset to the values
#   below (a sloppy parent is corrected; a mode change re-routes everything). Locale, toolchain homes, application
#   settings and other machine preferences are left to the host.
# Test only: DEV_STORAGE_VOLUME_TEST=absent treats the external volume as absent; =present (alias =mounted, the runtime's
#   name) is the normal probe: the external cache directory must exist and be writable (it never fakes a mount); =strict
#   applies the zsh device check to fixture volumes too (it can only make routing stricter).
#   DEV_ENV_INSPECT_ONLY=1 never writes (no mkdir, no pin) so inspection tools can source this file safely.

export DEV="$HOME/dev"
export DEVMACHINE="$DEV/machine"
export CLEAN_DEV_VERSION=0.6.8

# ---- storage.conf (defaults first; the file may override every key) -------------------------------------------
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
__cd_state="$DEVMACHINE/state/clean-development"

# ---- session key ------------------------------------------------------------------------------------------------
__cd_id=""; __cd_h=""; __cd_key=""; __cd_idbad=""
if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then __cd_id="$CLAUDE_CODE_SESSION_ID"; __cd_h=c
elif [ -n "${CODEX_THREAD_ID:-}" ]; then __cd_id="$CODEX_THREAD_ID"; __cd_h=x
elif [ -n "${CLEAN_DEV_SESSION:-}" ]; then
  # Inherit only a stamp this file could have written: "<mode>|<that mode's cache root>|<key>", with the key's pin
  # still present (a reaped session's leftover variables route nowhere).
  case "${CLEAN_DEV_SESSION:-}|${CLEAN_DEV_STAMP:-}" in
    [cx]-????????????"|external|$EXTERNAL_CACHE|$CLEAN_DEV_SESSION"|[cx]-????????????"|internal|$INTERNAL_ROOT|$CLEAN_DEV_SESSION")
      if [ -f "$__cd_state/sessions/$CLEAN_DEV_SESSION.mode" ] && [ ! -L "$__cd_state/sessions/$CLEAN_DEV_SESSION.mode" ]; then __cd_h="${CLEAN_DEV_SESSION%%-*}"; __cd_id="${CLEAN_DEV_SESSION#?-}"; fi ;;
  esac
fi
# Same rule as the runtime's sessionIdProblem (sessions.mjs): 12+ characters, no placeholder token.
if [ -n "$__cd_id" ]; then
  [ "${#__cd_id}" -ge 12 ] || __cd_idbad="shorter than 12 characters"
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
  # Explicit ASCII lists: bracket ranges are locale-dependent (bash 3.2 under UTF-8 accepted "é" in A-Z).
  case "$__cd_tail" in ''|*[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-]*) ;; *) __cd_key="$__cd_h-$__cd_tail" ;; esac
elif [ -n "$__cd_idbad" ]; then
  case $- in *i*) printf 'env.zsh: session id rejected (%s); this shell gets no session scratch or pin\n' "$__cd_idbad" >&2 ;; esac
fi

# ---- mode (fork-free probe: name-based path, directory present, writable) ----------------------------------------
__cd_why=""
__cd_ext_ok() {
  [ "${DEV_STORAGE_VOLUME_TEST:-}" = absent ] && { __cd_why="test: volume treated as absent"; return 1; }
  [ "$__cd_conf_ok" = 1 ] || { __cd_why="storage.conf invalid"; return 1; }
  [ -d "$EXTERNAL_CACHE" ] || { __cd_why="$EXTERNAL_CACHE missing"; return 1; }
  [ -w "$EXTERNAL_CACHE" ] && [ -x "$EXTERNAL_CACHE" ] || { __cd_why="$EXTERNAL_CACHE not writable (test -w)"; return 1; }
  # Mount identity (0.6.2: every shell routes by itself, so a stale mount point must not pass): in zsh, which runs every
  # agent shell, the zstat builtin compares devices without a fork, as the runtime does. The mount point must sit on a
  # different device from /Volumes and the cache on the mount point's. Bash 3.2 scripts keep the
  # existence and write checks. Fixture volumes (not /Volumes/<name>) skip the check unless the test asks for it.
  __cd_mp="${EXTERNAL_ROOT%%/Volumes/"$EXTERNAL_VOLUME"*}/Volumes/$EXTERNAL_VOLUME"
  if [ -n "${ZSH_VERSION:-}" ] && { [ "$__cd_mp" = "/Volumes/$EXTERNAL_VOLUME" ] || [ "${DEV_STORAGE_VOLUME_TEST:-}" = strict ]; } \
    && zmodload -F zsh/stat b:zstat 2>/dev/null; then
    __cd_dm=""; __cd_dp=""; __cd_dc=""
    zstat -A __cd_dm +device -- "$__cd_mp" 2>/dev/null; zstat -A __cd_dp +device -- "${__cd_mp%/*}" 2>/dev/null
    zstat -A __cd_dc +device -- "$EXTERNAL_CACHE" 2>/dev/null
    if [ -z "$__cd_dm" ] || [ "$__cd_dm" = "$__cd_dp" ] || [ "$__cd_dc" != "$__cd_dm" ]; then __cd_why="$__cd_mp is not a mounted volume (device check)"; return 1; fi
  fi
  __cd_why="$EXTERNAL_CACHE writable (test -w)"
}
__cd_mode=""; __cd_lost=0; __cd_pinned=""
# Every shell follows the drive: no pin decides the mode.
if __cd_ext_ok; then __cd_mode=external; else __cd_mode=internal; fi
if [ -n "$__cd_key" ]; then
  __cd_pin="$__cd_state/sessions/$__cd_key.mode"
  if [ -r "$__cd_pin" ]; then { IFS= read -r __cd_pinned < "$__cd_pin"; } 2>/dev/null; fi
  case "$__cd_pinned" in
    external|internal) ;;
    *)
      # Register the session for cleanup (no hook ran). Second line records why; readers use the first line only.
      if [ "${DEV_ENV_INSPECT_ONLY:-}" != 1 ]; then
        [ -d "$__cd_state/sessions" ] || mkdir -p "$__cd_state/sessions" 2>/dev/null
        { printf '%s\n# env.zsh %s\n' "$__cd_mode" "$__cd_why" > "$__cd_pin"; } 2>/dev/null
      fi
      ;;
  esac
  if [ "$__cd_pinned" = external ] && [ "$__cd_mode" = internal ]; then __cd_lost=1; fi
fi
if [ "$__cd_mode" = external ]; then __cd_root="$EXTERNAL_CACHE"; else __cd_root="$INTERNAL_ROOT"; fi
if [ "$__cd_lost" = 1 ] && [ ! -e "$__cd_state/sessions/$__cd_key.lost" ]; then
  printf 'clean-development: the %s volume is not available now; this shell uses internal storage (%s), where all development can continue. This session'"'"'s %s scratch and builds wait for the drive.\n' "$EXTERNAL_VOLUME" "$INTERNAL_ROOT" "$EXTERNAL_VOLUME" >&2
  if [ "${DEV_ENV_INSPECT_ONLY:-}" != 1 ]; then { : > "$__cd_state/sessions/$__cd_key.lost"; } 2>/dev/null; fi
fi

__cd_stamp="$__cd_mode|$__cd_root|$__cd_key"
__cd_keep=0
if [ "${CLEAN_DEV_STAMP:-}" = "$__cd_stamp" ]; then __cd_keep=1; fi
# __cd_route NAME VALUE: export NAME=VALUE, except inside an already-routed tree (same stamp) where a non-empty
# inherited NAME is kept.
__cd_route() {
  if [ "$__cd_keep" = 1 ]; then
    eval "__cd_cur=\${$1:-}"
    if [ -n "$__cd_cur" ]; then eval "export $1"; return 0; fi
  fi
  eval "$1=\$2; export $1"
}
CLEAN_DEV_MODE="$__cd_mode"; CLEAN_DEV_STAMP="$__cd_stamp"
# Work root (worktrees, jobs, bundles): the configured external development tree when its cache is mounted and writable.
CLEAN_DEV_WORK="$DEVMACHINE"
if [ "$__cd_mode" = external ] && [ -d "${LAB_ROOT%/*}" ] && [ -w "${LAB_ROOT%/*}" ] && [ -x "${LAB_ROOT%/*}" ]; then CLEAN_DEV_WORK="${LAB_ROOT%/*}"; fi
export CLEAN_DEV_MODE CLEAN_DEV_STAMP CLEAN_DEV_WORK
__cd_route DEVCACHE "$__cd_root"

# ---- session scratch and builds ------------------------------------------------------------------------------------
if [ -n "$__cd_key" ]; then
  CLEAN_DEV_SESSION="$__cd_key"
  CLEAN_DEV_SCRATCH="$__cd_root/scratch/$__cd_key"
  CLEAN_DEV_BUILDS="$__cd_root/builds/$__cd_key"
  export CLEAN_DEV_SESSION CLEAN_DEV_SCRATCH CLEAN_DEV_BUILDS
  if [ ! -d "$CLEAN_DEV_SCRATCH/tmp" ] && [ "${DEV_ENV_INSPECT_ONLY:-}" != 1 ]; then
    (umask 077; mkdir -p "$CLEAN_DEV_SCRATCH/tmp") 2>/dev/null
  fi
  if [ -d "$CLEAN_DEV_SCRATCH/tmp" ] || [ "${DEV_ENV_INSPECT_ONLY:-}" = 1 ]; then
    TMPDIR="$CLEAN_DEV_SCRATCH/tmp"; export TMPDIR
  else
    case $- in *i*) printf 'env.zsh: could not create session scratch %s; TMPDIR left unchanged\n' "$CLEAN_DEV_SCRATCH/tmp" >&2 ;; esac
  fi
  __cd_route CLEAN_DEVELOPMENT_SCRATCH_ROOT "$CLEAN_DEV_SCRATCH"
else
  unset CLEAN_DEV_SESSION CLEAN_DEV_SCRATCH CLEAN_DEV_BUILDS
  # Plain shells keep the macOS per-user TMPDIR. Repair an inherited TMPDIR that is missing, on removable media or the
  # retired legacy scratch path (the GUI domain used to carry an external-volume cache path).
  case "${TMPDIR:-}" in
    '') ;;
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

unset -f __cd_route __cd_ext_ok __cd_path_front
unset __cd_conf_ok __cd_p __cd_state __cd_id __cd_idbad __cd_why __cd_h __cd_key __cd_pre __cd_tail __cd_pin __cd_pinned __cd_mode __cd_lost __cd_root __cd_mp __cd_dm __cd_dp __cd_dc \
  __cd_stamp __cd_keep __cd_cur __cd_fix_tmp __cd_defined __cd_line __cd_k __cd_v __cd_expand __cd_rest __cd_result __cd_name __cd_repl __cd_cache
unset STORAGE_CONF_VERSION EXTERNAL_VOLUME EXTERNAL_ROOT EXTERNAL_CACHE INTERNAL_ROOT LAB_ROOT MODELS_ROOT SD_VOLUME \
  DEPS_CAP_GB DEPS_MIN_IDLE_HOURS EXTERNAL_BUILD_DAYS EXTERNAL_PRUNE_EVERY_DAYS INTERNAL_BUILD_IDLE_HOURS \
  SESSION_STALE_HOURS BIG_DOWNLOAD_GB INTERNAL_MIN_FREE_GB DEV_TOP_ALLOW HOME_DOT_ALLOW HOME_DOTFILE_ALLOW DEV_DOT_ALLOW

# Marker: this file ran to the end in this process (not fed to launchd).
export DEV_ENV_LOADED=1
:
