# ~/dev/machine/env.zsh - THE environment file for this Mac (clean-development 0.6.1).
# Loaded by EVERY zsh through ~/.zshenv (interactive or not, login or not; agent tool shells included), again at the end
# of ~/.zprofile (path_helper reorders PATH in login shells), and sourced by bash 3.2 (dev-env-launchctl, scripts).
# Keep it POSIX: no zsh-only or bash-only syntax. Idempotent. Never prints to stdout, never exits, last command succeeds.
#
# Storage (single source: ~/dev/machine/storage.conf):
#   external mode  the $EXTERNAL_VOLUME volume (4TB) is mounted and $EXTERNAL_CACHE is a writable directory
#                  -> DEVCACHE=$EXTERNAL_CACHE (/Volumes/4TB/machine/cache)
#   internal mode  otherwise -> DEVCACHE=$INTERNAL_ROOT (~/dev/machine/cache). Normal, not an error.
#   Cache root layout: deps/ (shared dependency caches, 30 GB LRU cap), builds/ (build output), scratch/<session>/,
#   trash/ (pending deletes). Cleanup is done by the clean-development hooks, never by this file.
#
# Agent sessions (decided once per session):
#   The session key comes from CLAUDE_CODE_SESSION_ID (Claude Code sets it in every Bash tool and hook process) or
#   CODEX_THREAD_ID (Codex sets it in every exec command): key = c-<last 12 chars> or x-<last 12 chars>.
#   A non-empty CLAUDE_CODE_SESSION_ID wins, so Codex's shell_environment_policy.set must blank it (CLAUDE_CODE_SESSION_ID
#   = ""): a Codex started from a Claude shell would otherwise inherit it and run in the Claude session's scratch.
#   The mode is pinned in ~/dev/machine/state/clean-development/sessions/<key>.mode, written by the SessionStart hook
#   (strict mount + write probe) or, if no hook ran, by the first shell of the session. Later shells read the pin
#   (no fork). If a pinned external volume disappears, the shell falls back to internal storage and warns once.
#   A session gets TMPDIR=$DEVCACHE/scratch/<key>/tmp and CLEAN_DEV_BUILDS=$DEVCACHE/builds/<key>.
#   Plain shells (Warp, launchd) detect the mode on every start (fork-free) and leave TMPDIR at the macOS default.
#
# Precedence: CLEAN_DEV_STAMP="<mode>|<root>|<key>" is exported. When an inherited stamp equals the one computed here,
#   the shell sits in a tree this file already routed, so a routing variable that arrives non-empty is KEPT (a script's
#   deliberate override survives nested zsh -c). Otherwise every routing variable is reset to the value below (a sloppy
#   parent is corrected; a mode change re-routes everything). Always forced: LANG, DEV, DEVMACHINE, CLEAN_DEV_*, TMPDIR in
#   sessions, telemetry and history switches, PATH order.
# Test only: DEV_STORAGE_VOLUME_TEST=absent treats the external volume as absent; =present (alias =mounted, the runtime's
#   name) is the normal probe: the external cache directory must exist and be writable (it never fakes a mount).
#   DEV_ENV_INSPECT_ONLY=1 never writes (no mkdir, no pin) so inspection tools can source this file safely.
# GUI apps: ~/dev/machine/bin/dev-env-launchctl feeds the exported variables to launchd (not TMPDIR, not CLEAN_DEV_STAMP).

export LANG=en_US.UTF-8
export DEV="$HOME/dev"
export DEVMACHINE="$DEV/machine"
export CLEAN_DEV_VERSION=0.6.1

# ---- storage.conf (defaults first; the file may override every key) -------------------------------------------
unset STORAGE_CONF_VERSION EXTERNAL_VOLUME EXTERNAL_ROOT EXTERNAL_CACHE INTERNAL_ROOT LAB_ROOT MODELS_ROOT SD_VOLUME \
  DEPS_CAP_GB DEPS_MIN_IDLE_HOURS EXTERNAL_BUILD_DAYS EXTERNAL_PRUNE_EVERY_DAYS INTERNAL_BUILD_IDLE_HOURS \
  SESSION_STALE_HOURS BIG_DOWNLOAD_GB INTERNAL_MIN_FREE_GB HOME_DOT_ALLOW HOME_DOTFILE_ALLOW DEV_DOT_ALLOW
EXTERNAL_VOLUME=4TB
EXTERNAL_ROOT=/Volumes/4TB/machine
EXTERNAL_CACHE=/Volumes/4TB/machine/cache
INTERNAL_ROOT="$DEVMACHINE/cache"
LAB_ROOT=/Volumes/4TB/dev/lab
MODELS_ROOT=/Volumes/4TB/models
SD_VOLUME=SD
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
      SESSION_STALE_HOURS|BIG_DOWNLOAD_GB|INTERNAL_MIN_FREE_GB|HOME_DOT_ALLOW|HOME_DOTFILE_ALLOW|DEV_DOT_ALLOW) ;;
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
case "$__cd_defined" in *'|EXTERNAL_ROOT|'*) ;; *) EXTERNAL_ROOT="/Volumes/$EXTERNAL_VOLUME/machine" ;; esac
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
__cd_id=""; __cd_h=""; __cd_key=""
if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then __cd_id="$CLAUDE_CODE_SESSION_ID"; __cd_h=c
elif [ -n "${CODEX_THREAD_ID:-}" ]; then __cd_id="$CODEX_THREAD_ID"; __cd_h=x
fi
if [ -n "$__cd_id" ]; then
  __cd_pre="${__cd_id%????????????}"
  if [ "$__cd_pre" = "$__cd_id" ]; then __cd_tail="$__cd_id"; else __cd_tail="${__cd_id#"$__cd_pre"}"; fi
  case "$__cd_tail" in ''|*[!A-Za-z0-9_-]*) ;; *) __cd_key="$__cd_h-$__cd_tail" ;; esac
fi

# ---- mode (fork-free probe: name-based path, directory present, writable) ----------------------------------------
__cd_ext_ok() {
  [ "${DEV_STORAGE_VOLUME_TEST:-}" = absent ] && return 1
  [ "$__cd_conf_ok" = 1 ] || return 1
  [ -d "$EXTERNAL_CACHE" ] && [ -w "$EXTERNAL_CACHE" ] && [ -x "$EXTERNAL_CACHE" ]
}
__cd_mode=""; __cd_lost=0
if [ -n "$__cd_key" ]; then
  __cd_pin="$__cd_state/sessions/$__cd_key.mode"
  if [ -r "$__cd_pin" ]; then { IFS= read -r __cd_mode < "$__cd_pin"; } 2>/dev/null; fi
  case "$__cd_mode" in
    external) __cd_ext_ok || { __cd_mode=internal; __cd_lost=1; } ;;
    internal) ;;
    *)
      if __cd_ext_ok; then __cd_mode=external; else __cd_mode=internal; fi
      if [ "${DEV_ENV_INSPECT_ONLY:-}" != 1 ]; then
        [ -d "$__cd_state/sessions" ] || mkdir -p "$__cd_state/sessions" 2>/dev/null
        { printf '%s\n' "$__cd_mode" > "$__cd_pin"; } 2>/dev/null
      fi
      ;;
  esac
else
  if __cd_ext_ok; then __cd_mode=external; else __cd_mode=internal; fi
fi
if [ "$__cd_mode" = external ]; then __cd_root="$EXTERNAL_CACHE"; else __cd_root="$INTERNAL_ROOT"; fi
if [ "$__cd_lost" = 1 ] && [ ! -e "$__cd_state/sessions/$__cd_key.lost" ]; then
  printf 'clean-development: the %s volume disappeared during this session; this shell now uses internal storage (%s). Stop large work; this session'"'"'s external scratch and builds are unavailable.\n' "$EXTERNAL_VOLUME" "$INTERNAL_ROOT" >&2
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
export CLEAN_DEV_MODE CLEAN_DEV_STAMP
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
  # retired ~/dev/cache scratch (the GUI domain used to carry /Volumes/4TB/cache/scratch/tmp).
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
__cd_route BOLYKI_SOURCE_ROOT "$DEV/source"
__cd_route BOLYKI_DEV_LIBS "$__cd_root/deps/library"
__cd_route XCODE_DERIVED_DATA_PATH "$__cd_root/builds/DerivedData"
__cd_route SWIFTPM_SHARED_CACHE "$__cd_root/deps/swiftpm"
__cd_route CLANG_MODULE_CACHE_PATH "$__cd_root/deps/clang-modules"

# ---- build host preferences (~/dev/machine/build-host.env may override; build placement only) ----------------------
BUILD_HOST=mac
REMOTE_BUILD_FALLBACK=disabled
WEBSITE_BUILD_RUNNER=magrathean-websites-mac
WEBSITE_BUILD_RUNNER_NAME=bolyki-mac-magrathean-websites
WEBSITE_BUILD_CPUS=12
WEBSITE_BUILD_NODE_HEAP_MB=8192
if [ -r "$DEVMACHINE/build-host.env" ]; then . "$DEVMACHINE/build-host.env"; fi
__cd_route DEV_BUILD_HOST "$BUILD_HOST"
__cd_route DEV_REMOTE_BUILD_FALLBACK "$REMOTE_BUILD_FALLBACK"
__cd_route DEV_WEBSITE_BUILD_RUNNER "$WEBSITE_BUILD_RUNNER"
__cd_route DEV_WEBSITE_BUILD_RUNNER_NAME "$WEBSITE_BUILD_RUNNER_NAME"
__cd_route DEV_WEBSITE_BUILD_CPUS "$WEBSITE_BUILD_CPUS"
__cd_route DEV_WEBSITE_BUILD_NODE_HEAP_MB "$WEBSITE_BUILD_NODE_HEAP_MB"
unset BUILD_HOST REMOTE_BUILD_FALLBACK WEBSITE_BUILD_RUNNER WEBSITE_BUILD_RUNNER_NAME WEBSITE_BUILD_CPUS WEBSITE_BUILD_NODE_HEAP_MB

# ---- Homebrew (fixed prefix on Apple silicon; shellenv forks brew, so only when the shell lacks it) ------------------
if [ "${DEV_ENV_INSPECT_ONLY:-}" != 1 ] && [ -z "${HOMEBREW_PREFIX:-}" ] && [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi
__cd_route HOMEBREW_CACHE "$__cd_root/deps/homebrew"
export HOMEBREW_NO_ANALYTICS=1

# ---- XDG: config stays in ~/.config (allow-listed); cache follows the mode; data and state are internal -------------
__cd_route XDG_CONFIG_HOME "$HOME/.config"
__cd_route XDG_CACHE_HOME "$__cd_root/deps/xdg"
__cd_route XDG_DATA_HOME "$DEVMACHINE/state/share"
__cd_route XDG_STATE_HOME "$DEVMACHINE/state/state"
# Tools write here without creating the parent (zsh cdr: $XDG_DATA_HOME/zsh/chpwd-recent-dirs), so make sure it exists.
if [ "${DEV_ENV_INSPECT_ONLY:-}" != 1 ] && [ ! -d "$XDG_DATA_HOME/zsh" ]; then
  mkdir -p "$XDG_DATA_HOME/zsh" "$XDG_STATE_HOME" 2>/dev/null
fi
# Not routable: Blender hardcodes ~/.thumbnails (allow-listed in storage.conf).

# ---- toolchains (internal, never on removable media) and dependency caches (follow the mode) -----------------------
__cd_route CARGO_HOME "$DEVMACHINE/toolchains/rust/cargo"
__cd_route RUSTUP_HOME "$DEVMACHINE/toolchains/rust/rustup"
__cd_route GOPATH "$DEVMACHINE/toolchains/go/path"
__cd_route GOCACHE "$__cd_root/deps/go-build"
__cd_route GOMODCACHE "$__cd_root/deps/go-mod"
__cd_route BUN_INSTALL "$DEVMACHINE/toolchains/bun"
__cd_route BUN_INSTALL_CACHE_DIR "$__cd_root/deps/bun"
__cd_route PNPM_HOME "$DEVMACHINE/toolchains/pnpm"
# pnpm 12 reads pnpm_config_store_dir (verified: `pnpm store path`); npm_config_store_dir is ignored. Without it the
# store defaults to $PNPM_HOME/store, inside the toolchain.
__cd_route pnpm_config_store_dir "$__cd_root/deps/pnpm-store"
__cd_route npm_config_cache "$__cd_root/deps/npm"
# Yarn is not installed; classic reads YARN_CACHE_FOLDER, Berry keeps its default global cache in globalFolder.
__cd_route YARN_CACHE_FOLDER "$__cd_root/deps/yarn"
__cd_route YARN_GLOBAL_FOLDER "$__cd_root/deps/yarn-berry"
__cd_route UV_CACHE_DIR "$__cd_root/deps/uv"
__cd_route UV_PYTHON_INSTALL_DIR "$DEVMACHINE/toolchains/python"
__cd_route UV_TOOL_DIR "$DEVMACHINE/toolchains/uv-tools"
__cd_route UV_TOOL_BIN_DIR "$DEVMACHINE/toolchains/uv-tools/bin"
__cd_route PIP_CACHE_DIR "$__cd_root/deps/pip"
__cd_route HF_HOME "$__cd_root/deps/huggingface"
__cd_route TORCH_HOME "$__cd_root/deps/torch"
if [ "$__cd_mode" = external ]; then __cd_route OLLAMA_MODELS "$MODELS_ROOT/ollama"; else __cd_route OLLAMA_MODELS "$__cd_root/deps/ollama"; fi
__cd_route GRADLE_USER_HOME "$__cd_root/deps/gradle"
__cd_route NUGET_PACKAGES "$__cd_root/deps/nuget"
__cd_route DOTNET_CLI_HOME "$DEVMACHINE/state/dotnet"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
__cd_route BUNDLE_USER_HOME "$DEVMACHINE/state/bundle"
__cd_route GEM_HOME "$DEVMACHINE/state/gem"
__cd_route GEM_SPEC_CACHE "$DEVMACHINE/state/gem/specs"
__cd_route MPLCONFIGDIR "$__cd_root/deps/matplotlib"
__cd_route PLAYWRIGHT_BROWSERS_PATH "$__cd_root/deps/playwright"

# ---- VM lab and infra. The lab is 4TB-only in both modes: when it is absent these fail loudly instead of creating
# ~/.tart or ~/.lima. Colima and Docker config stay internal. ----------------------------------------------------------
__cd_route TART_HOME "$LAB_ROOT/VM/tart-home"
__cd_route LIMA_HOME "$LAB_ROOT/VM/lima-home"
__cd_route COLIMA_HOME "$DEVMACHINE/state/colima"
__cd_route DOCKER_CONFIG "$DEVMACHINE/cloud/docker"
__cd_route WINEPREFIX "$DEVMACHINE/state/wine"
__cd_route TESLATLAS_LAB "$LAB_ROOT/teslatlas-v7"
__cd_route TESLATLAS_HEAVY_BUILD_LOCK "$LAB_ROOT/teslatlas-v7/locks/heavy-build"

# ---- cloud and service CLIs (config and tokens in ~/dev/machine/cloud, mode 700; secret values live in 1Password) ---
__cd_route AWS_CONFIG_FILE "$DEVMACHINE/cloud/aws/config"
__cd_route AWS_SHARED_CREDENTIALS_FILE "$DEVMACHINE/cloud/aws/credentials"
# Not routable (aws-cli): ~/.aws/cli/cache and ~/.aws/sso/cache for SSO and assume-role.
__cd_route GH_CONFIG_DIR "$DEVMACHINE/cloud/gh"
__cd_route CLOUDSDK_CONFIG "$DEVMACHINE/cloud/gcloud"
__cd_route RCLONE_CONFIG "$DEVMACHINE/cloud/rclone/rclone.conf"
__cd_route OP_CONFIG_DIR "$DEVMACHINE/cloud/op"
__cd_route AZURE_CONFIG_DIR "$DEVMACHINE/cloud/azure"
__cd_route ASC_CONFIG_PATH "$DEVMACHINE/cloud/asc/config.json"
__cd_route ASC_WEB_SESSION_CACHE_DIR "$DEVMACHINE/cloud/asc/web"
export ASC_TELEMETRY_DISABLED=1
__cd_route CLAUDE_CODE_PLUGIN_DIRS "$DEVMACHINE/tools/claude-mods/grok-ui"

# ---- other native application homes ----------------------------------------------------------------------------------
__cd_route DSH_HOME "$DEVMACHINE/state/dsh"
__cd_route GROK_HOME "$DEVMACHINE/state/grok"
__cd_route T3CODE_HOME "$DEVMACHINE/state/t3"
__cd_route SAND_DATA_ROOT "$DEVMACHINE/state/grokbot"
# Claude (~/.claude, ~/.claude.json) and Codex (~/.codex) keep their default homes; never set CLAUDE_CONFIG_DIR or CODEX_HOME
# here (claude-1..5 set CLAUDE_CONFIG_DIR per child themselves).

# ---- history and REPL files out of ~ (zsh keeps ~/.zsh_history) -------------------------------------------------------
export LESSHISTFILE=/dev/null
export NODE_REPL_HISTORY=""
__cd_route PYTHON_HISTORY "$DEVMACHINE/state/python_history"
__cd_route SQLITE_HISTORY "$DEVMACHINE/state/sqlite_history"

# ---- telemetry and phone-home switches (plain exports, forced) --------------------------------------------------------
# Deliberately NOT set: DO_NOT_TRACK, DISABLE_TELEMETRY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC (Claude Code would stop
# feature-flag fetching). Claude's own switches live in the env block of ~/.claude/settings.json; Codex's in config.toml.
export GH_TELEMETRY=false
export NEXT_TELEMETRY_DISABLED=1
export HF_HUB_DISABLE_TELEMETRY=1
export SUPERPOWERS_DISABLE_TELEMETRY=1
export IMPECCABLE_NO_TELEMETRY=1
export ARCHIFY_UPDATE_CHECK_DISABLED=1
export BLENDER_MCP_DISABLE_TELEMETRY=1
export WRANGLER_SEND_METRICS=false
export PIP_DISABLE_PIP_VERSION_CHECK=1
export npm_config_update_notifier=false

# ---- PATH: own scripts, toolchains, ~/.local/bin (claude launcher), Homebrew. Listed directories move to the front, each
# appears once, empty entries go, and the retired clean-development 0.5.0 shim directory and ~/dev/bin are dropped. ----
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
    case "$__e" in "$HOME/Library/Application Support/clean-development/bin"|"$DEV/bin") continue ;; esac
    case ":$__np:" in *":$__e:"*) ;; *) __np="${__np:+$__np:}$__e" ;; esac
  done
  PATH="$__np"
  unset __np __old __e
}
__cd_path_front "$DEVMACHINE/bin" "$GROK_HOME/bin" "$DEVMACHINE/toolchains/node/current/bin" "$CARGO_HOME/bin" \
  "$BUN_INSTALL/bin" "$PNPM_HOME" "$GOPATH/bin" "$HOME/.local/bin" \
  "${HOMEBREW_PREFIX:+$HOMEBREW_PREFIX/bin}" "${HOMEBREW_PREFIX:+$HOMEBREW_PREFIX/sbin}"
export PATH

# JUPITER kit ssh goes through the route wrapper: VPS-held master first, Mac master as fallback (porn project, 18 Oct 2026).
export KIT_SSH="$DEVMACHINE/bin/jupiter-kit-ssh"

unset -f __cd_route __cd_ext_ok __cd_path_front
unset __cd_conf_ok __cd_p __cd_state __cd_id __cd_h __cd_key __cd_pre __cd_tail __cd_pin __cd_mode __cd_lost __cd_root \
  __cd_stamp __cd_keep __cd_cur __cd_fix_tmp __cd_defined __cd_line __cd_k __cd_v __cd_expand __cd_rest __cd_result __cd_name __cd_repl __cd_cache
unset STORAGE_CONF_VERSION EXTERNAL_VOLUME EXTERNAL_ROOT EXTERNAL_CACHE INTERNAL_ROOT LAB_ROOT MODELS_ROOT SD_VOLUME \
  DEPS_CAP_GB DEPS_MIN_IDLE_HOURS EXTERNAL_BUILD_DAYS EXTERNAL_PRUNE_EVERY_DAYS INTERNAL_BUILD_IDLE_HOURS \
  SESSION_STALE_HOURS BIG_DOWNLOAD_GB INTERNAL_MIN_FREE_GB HOME_DOT_ALLOW HOME_DOTFILE_ALLOW DEV_DOT_ALLOW

# skills-sync (agent-skills/tuning): Codex reads user skills only from ~/.agents/skills (Q42). Claude's ~/.claude/skills
# is per-skill symlinks into the same master, so both install targets are the master. 02 is the single owner of this file.
export SKILLS_CODEX_DIR="$HOME/.agents/skills"
export SKILLS_CLAUDE_DIR="$HOME/.agents/skills"

# Marker: this file ran to the end in this process (not fed to launchd).
export DEV_ENV_LOADED=1
:
