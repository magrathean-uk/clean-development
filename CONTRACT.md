# Clean Development contract

This is the public surface frozen for every 1.x release. Paths below are relative to this package unless they start with `~`. The runtime needs Node.js 20.12 or later; deployment targets macOS, with Claude Code and Codex hooks and environment routing for OpenCode.

1.0 freezes the command forms, flag meanings, exit-code causes, JSON field names and meanings, routing variables and selection rules, project schema v2, hook command and output envelope, and installed entry paths below. Release numbers, transaction IDs, measurements, hashes and diagnostic text are values, not fixed strings. Legacy schema v1 remains readable. Removing or renaming any of these promises needs 2.0 (see Compatibility); 1.x supports the set-up it was proven on, macOS with the configured external volume.

## CLI usage

```text
Usage: clean-development <command>
  report [--json] [--check]
  cleanup [--json] [--project DIR]
  cleanup --apply <id> [--skip N,...] [--project DIR] [--json]
  init [--write] [DIR]
  hook <session-start|stop|session-end> <claude|codex>
  version
  help | --help | -h
```

No arguments, or any help alias anywhere in the arguments, prints usage before validation or policy reads. Unknown commands and unsupported arguments fail, except that the hook form ignores trailing arguments. The hook form remains shipped and is used by the installed shim.

Report inventories both roots, drive free bytes, escaped caches and routing errors. Its check flag checks routing and policy only: no sizing, with empty drives, roots and caches arrays. Cleanup previews without writes; apply rescans and requires the same list ID, moving selected rows to their volume's Trash with a manifest. Skip values are unique positive comma-separated row numbers within that list, valid only with apply. The project flag adds that project's claims. Initialisation previews schema v2 or writes a new configuration exclusively; `--` ends its option parsing before a directory beginning with a hyphen. Version prints the release number.

Report also reads the final inventory written by the agent-home refresh to `~/dev/machine/state/clean-development/homes.txt`. Each line has the form `home <path> <claude|codex> <version|absent|disabled> <hook12> <skill12> [running-older]`, with the final marker optional. This is the line format read by 0.8.0. Paths can contain spaces. Hashes are 12 lowercase hexadecimal digits or `-` when missing. Numbered profiles report the plugin version selected for a new session. The `agent homes` text section counts versions matching the active runtime and lists every differing home, including absent and disabled entries, plus homes marked `running-older`. That marker means an older shared folder with different skill text remains available to running sessions. The inventory records the state at refresh time. Missing inventory yields an empty homes array and no section. Home version drift leaves report --check exit codes unchanged. The check reads the inventory without sizing storage.

## Installer usage

```text
usage: install.sh [--dry-run] [--config [--replace-config]] [--record-dir DIR] | --recover TRANSACTION_ID [--accept-current] | --rollback TRANSACTION_ID
```

Installer help aliases are `--help` and `-h`. Dry run validates and prints a plan without writing. Config installs the environment and a missing policy; replace-config deliberately replaces policy and requires config. Record-dir replaces the default rollback-record directory and may be relative to the working directory. Recover restores an unfinished transaction; accept-current requires recover and preserves reviewed conflicting edits. Rollback restores a committed transaction. Recover excludes install options; rollback excludes install and recovery options. Existing immutable runtime bytes are never replaced.

## Exit codes

| Code | Cause |
| --- | --- |
| 0 | Successful CLI operation, preview or help; hook events, including ignored events. Installer completed, previewed or returned a recovery result; inspect its status for preserved conflicts. |
| 1 | Report check found routing or policy errors; init refused an existing configuration; cleanup apply had item or manifest failures. Installer preflight, topology, lock, publication or transaction failure; installer launcher cannot find a supported Node. |
| 2 | Unknown CLI command, invalid arguments, invalid cleanup policy or another caught CLI exception. Installer option errors. |
| 3 | Cleanup apply refused a missing list ID or a rescan whose ID differs; no moves. |
| 127 | Runtime CLI launcher cannot find a supported Node. |

The hook launcher exits successfully when Node is unavailable, with a diagnostic on stderr. Installer recovery can exit successfully while reporting recovery-required; the status must be read before retrying. Correct the reported cause before a retry. A repeated init write retains the original file; repeated rollback refuses an already rolled-back transaction.

## JSON fields

Each row lists all fields of that object. A question mark means the field is present only on that branch. Arrays can be empty. Measurements use bytes, entry counts and newest mtime/ctime in milliseconds; unavailable sizes and free space are null.

| Object | Fields |
| --- | --- |
| report | mode, root, drives, roots, routing, caches, homes, errors |
| home | path, harness, version, hook, skill, runningOlder, restartReason |
| drive | name, path, free |
| measurement | path, bytes, count?, newest?, error? |
| routing | name, value, reason |
| preview | mode, root, items, skipped, id |
| item | path, kind, reason, bytes, count, newest |
| apply | status, moved, bytes, failed, volumes |
| moved | path, kind, reason, bytes, count, newest, destination, manifest |
| failed | path, error |
| volume | path, bytes, free |
| refused | status, error |

Report contains drive objects and measurement objects in roots and caches, routing rows for misrouted variables, and policy error strings. Preview is cleanup's read-only result: items are item objects, skipped holds diagnostics, and id is the 12-hex digest of the ordered list. Item kinds a to e mean merged clean worktree, completed job, project claim, quiet unclaimed active-root directory, and quiet unclaimed internal fallback directory. Apply returns moved, failed and volume rows; bytes totals successful moves. Refused is the apply refusal object, printed on stderr even with JSON requested. A missing apply ID, argument errors and policy exceptions print text on stderr instead of JSON.

Report's homes array holds home objects. `harness` is claude or codex, `version` is the next-session release, absent or disabled, and `hook` and `skill` are the recorded hashes. `runningOlder` is a boolean that reflects the `running-older` inventory marker. `restartReason` is `skill-text` or `none` when recorded in `~/dev/machine/state/clean-development/homes-restarts.json`. The sidecar stores the SHA-256 of the exact inventory bytes and one reason per row in inventory order. A missing, stale or invalid sidecar yields `unknown` and leaves the report's exit status unchanged. Report also accepts inventory rows written by 1.0.0 before the next home refresh.

## Routing exports

Notation: H is HOME, M is H/dev/machine, R is the selected cache root, K is the agent key or shell, W is the selected work root, V is the release version. R is the configured external cache when mounted and writable, otherwise the internal cache (default M/cache). W prefers the writable parent of LAB_ROOT below the mounted volume, then EXTERNAL_ROOT, otherwise M. EXTERNAL_VOLUME, LAB_ROOT and MODELS_ROOT below are policy values. All variables env.zsh exports are listed, including host-path and loader markers.

| Variable | Value |
| --- | --- |
| DEV | H/dev |
| DEVMACHINE | M |
| CLEAN_DEV_VERSION | V |
| CLEAN_DEV_MODE | external or internal |
| CLEAN_DEV_STAMP | mode, R and agent key separated by pipes; terminal key empty |
| CLEAN_DEV_WORK | W |
| DEVCACHE | R |
| CLEAN_DEV_SCRATCH | R/scratch/K; agents only |
| CLEAN_DEV_BUILDS | R/builds/K |
| TMPDIR | R/scratch/K/tmp for agents; host temporary directory for terminals |
| CLEAN_DEVELOPMENT_SCRATCH_ROOT | R/scratch/K |
| CLEAN_DEVELOPMENT_ROOT | R |
| CLEAN_DEVELOPMENT_CACHE_ROOT | R/deps |
| CLEAN_DEVELOPMENT_BUILD_ROOT | R/builds |
| DEVDRIVE | /Volumes/EXTERNAL_VOLUME/dev |
| DEV_CACHE_VOLUME | /Volumes/EXTERNAL_VOLUME |
| DEVLAB | LAB_ROOT |
| DEVMODELS | MODELS_ROOT |
| DEVLIBRARY | R/deps/library |
| XCODE_DERIVED_DATA_PATH | R/builds/DerivedData |
| SWIFTPM_SHARED_CACHE | R/deps/swiftpm |
| CLANG_MODULE_CACHE_PATH | R/deps/clang-modules |
| HOMEBREW_CACHE | R/deps/homebrew |
| XDG_CACHE_HOME | R/deps/xdg |
| GOCACHE | R/deps/go-build |
| GOMODCACHE | R/deps/go-mod |
| BUN_INSTALL_CACHE_DIR | R/deps/bun |
| pnpm_config_store_dir | R/deps/pnpm-store |
| npm_config_cache | R/deps/npm |
| YARN_CACHE_FOLDER | R/deps/yarn |
| UV_CACHE_DIR | R/deps/uv |
| PIP_CACHE_DIR | R/deps/pip |
| HF_HUB_CACHE | R/deps/huggingface/hub |
| HF_ASSETS_CACHE | R/deps/huggingface/assets |
| TORCH_HOME | R/deps/torch |
| NUGET_PACKAGES | R/deps/nuget |
| PYTHONPYCACHEPREFIX | R/deps/pycache |
| PLAYWRIGHT_BROWSERS_PATH | R/deps/playwright |
| PATH | M/bin prepended, duplicates and obsolete application-support bin removed |
| DEV_ENV_LOADED | 1 |

A nonempty Claude ID takes precedence over Codex, even when rejected. IDs need at least 12 ASCII letters, digits, underscores or hyphens. Tokens delimited by hyphens, underscores or either end must not equal unset, placeholder, changeme, dummy, example, stub, undefined, null, none or todo in all lower or all upper case. Mixed case and embedded words pass. The agent key is c- or x- plus the last 12 characters. A terminal gets the shell build key, no agent scratch export, and retains a valid host TMPDIR; missing, removable-media or inherited agent TMPDIR is repaired from macOS.

Every shell reselects the root. A matching inherited stamp keeps nonempty routed values; a changed stamp resets them. env.zsh creates missing routed directories under R and stays silent on stdout. Inspection mode creates nothing and skips the optional private environment file. Host toolchain homes and credentials stay host-managed.

## Project schema

This table describes every property in schemas/project-config.schema.json. Both versions are objects requiring schemaVersion and reject extra properties. A const numeric value has the indicated integer type; any means the legacy schema imposes no type restriction.

| Version | Key | Type |
| --- | --- | --- |
| both | $schema | string |
| both | schemaVersion | integer (const 1 or 2 matching version) |
| both | enabled | boolean |
| 2 | heavy | boolean |
| 2 | buildDirs | array of string |
| 2 | depDirs | array of string |
| 2 | notes | string |
| 1 | root | any |
| 1 | cacheRoot | any |
| 1 | buildRoot | any |
| 1 | scratchRoot | any |
| 1 | swiftpmWorkspaceRoot | any |
| 1 | retention | any |
| 1 | tools | any |

For v2 the schema sets enabled true and heavy false by default; directory arrays are unique, at most 16 strings of 1 to 199 characters. Their pattern excludes absolute paths, empty segments, trailing slashes, dot, dot-dot, .git segments and control characters. Notes has at most 500 characters; the schema URI is nonempty. These are schema constraints: cleanup's current claim reader does not enforce every pattern restriction. Legacy paths are compatibility data, not new cleanup authority.

## Hook command

```text
"$HOME/dev/machine/runtime/clean-development/active/bin/cd-hook" session-start <claude|codex>
```

The fragments register SessionStart only, with startup, resume, clear, compact and fork matchers, timeout 30 seconds. The hook reads no stdin and writes no state. Its target is one output line within one second, exiting 0. The line is JSON with hookSpecificOutput containing hookEventName equal to SessionStart and additionalContext containing the context text.

Open Claude and Codex sessions using this command reach the newly activated runtime on their next hook call. The command stays the same across releases.

## Hook context

```text
clean-development: mode=<mode>; root=<root>; free=<N GB|unknown>
```

Low space adds `; cleanup available: ask to review candidates`. Invalid policy adds `; storage.conf problems: using internal defaults`. Unexpected context failure uses `clean-development: storage context unavailable`. Stop, session-end and unrecognised event/harness combinations return 0 silently. The stable shim uses the installed CLI's hook form; it also returns 0 silently if its runtime or CLI is missing.

## Install layout

H, M, R and V have the routing meanings above. T is a unique UTC timestamp plus UUID transaction ID, F is the previous release or none, and I is a numeric backup index. These are installed locations, not paths inside the source package.

| Entry | Path |
| --- | --- |
| release | M/runtime/clean-development/V |
| rollback-installer | M/runtime/clean-development/V/installer.mjs |
| rollback-lock-module | M/runtime/clean-development/V/install-lock.mjs |
| cli | M/bin/clean-development |
| hook | M/runtime/clean-development/active/bin/cd-hook |
| environment | M/env.zsh |
| policy | M/storage.conf |
| claude | H/.claude/settings.json |
| codex | H/.codex/hooks.json |
| record | M/runtime/clean-development/rollback/rollback-T-from-F-to-V.md |
| receipt | M/state/clean-development/installations/T/receipt.json |
| backup | M/state/clean-development/installations/T/files/I |
| staging | M/runtime/clean-development/V.installing-T |
| install-lock | M/state/clean-development/install.lock |
| recovery-lock | M/state/clean-development/install-recovery.lock |
| log | M/state/clean-development/hook.log |
| optional-private | M/env.private.zsh |
| optional-colima | M/bin/colima |
| optional-childenv | M/state/clean-development/childenv-allow.list |
| optional-codex | M/state/clean-development/codex-homes.list |
| optional-claude-settings | M/state/clean-development/claude-settings.list |
| optional-claude-profiles | M/state/clean-development/claude-profiles.list |

Active is a directory holding a shim that selects the immutable version, rather than a symlink to the release. Config controls environment/policy installation and explicitly declared private sidecars; the package alone supplies no private sidecars. The default hook settings files are always merged. Installation creates deps, builds, scratch and trash under the internal root and, when active, the external root. Only the installer keeps transaction locks.

The monorepo installer publishes the Clean Development skill in an immutable snapshot for new numbered Claude sessions and merges the managed hook into shared settings while sessions are open. Running sessions can still read their previous snapshot. In already registered Codex homes, the installer stages the new version alongside previous versions. The installer preview and completed refresh print one `restart <home> <reason>` line per inventoried home. An enabled home reports `skill-text` when the source skill hash differs from the hash that home loads before the refresh. Other homes report `none`. The text report prints the same line with the recorded reason or `unknown`.

Each install creates a new rollback record before activation, containing the source commit (or an explicit unavailable marker for non-Git source), from/to versions, receipt, previous target and exact rollback command. Record-dir overrides only its directory. The command runs the release-local installer. The release digest covers both installer modules. Restoring an unfinished install removes its record. Receipts and backups remain for recovery. The shim, CLI and environment paths are the stable entry points. Internal receipt contents and transient lock bodies are not a new 1.0 public API.

## User variables

These inputs can be supplied by the user, host or agent. Some inherited routing exports above are also read: a matching `CLEAN_DEV_STAMP` preserves nonempty routed values, and the runtime checks or uses the relevant exports. Variables used only for test fault injection are not user settings.

| Variable | Meaning |
| --- | --- |
| CLEAN_DEV_NODE | Node executable to try first. The installer requires an absolute executable path to Node.js 20.12 or later; the runtime launchers try it before their other candidates. |
| DEV_ENV_INSPECT_ONLY | Set to `1` when sourcing env.zsh to suppress directory creation and loading the private environment file. |
| HOME | Home directory used for machine paths and policy expansion. The runtime falls back to the system home if HOME is not absolute. |
| PATH | Search path for Node and other commands; env.zsh puts M/bin first. |
| TMPDIR | Terminal temporary directory retained or repaired by env.zsh; agent shells try to route it to their scratch directory. The runtime checks and protects agent scratch. |
| CLAUDE_CODE_SESSION_ID | Claude agent identifier used to select and protect agent scratch; a nonempty value takes precedence over Codex. |
| CODEX_THREAD_ID | Codex agent identifier used to select and protect agent scratch when the Claude identifier is empty. |

## Storage settings

`~/dev/machine/storage.conf` is read as data by `machine/env.zsh` and `runtime/lib/conf.mjs`. Defaults below apply when a key is absent. HOME is the home directory; references to other keys use their resolved values.

| Key | Default | Meaning |
| --- | --- | --- |
| EXTERNAL_VOLUME | External | Name of the external volume. |
| EXTERNAL_ROOT | /Volumes/${EXTERNAL_VOLUME}/dev | External policy root and fallback work root. |
| EXTERNAL_CACHE | ${EXTERNAL_ROOT}/cache | External cache root. |
| INTERNAL_ROOT | $HOME/dev/machine/cache | Internal fallback cache root. |
| LAB_ROOT | /Volumes/${EXTERNAL_VOLUME}/dev/lab | Protected lab path and source for the preferred external work root. |
| MODELS_ROOT | /Volumes/${EXTERNAL_VOLUME}/models | Protected models path. |
| INTERNAL_MIN_FREE_GB | 40 | Free-space threshold in GiB below which the SessionStart context offers cleanup. |

### Ignored

`STORAGE_CONF_VERSION`, `SD_VOLUME`, `DEPS_CAP_GB`, `DEPS_MIN_IDLE_HOURS`, `EXTERNAL_BUILD_DAYS`, `EXTERNAL_PRUNE_EVERY_DAYS`, `INTERNAL_BUILD_IDLE_HOURS`, `SESSION_STALE_HOURS`, `BIG_DOWNLOAD_GB`, `DEV_TOP_ALLOW`, `HOME_DOT_ALLOW`, `HOME_DOTFILE_ALLOW`, `DEV_DOT_ALLOW` are accepted for compatibility. Their values do not control routing or runtime operations, although invalid numeric values invalidate the policy. Leave existing entries in users' files; other tools may use them.

## Compatibility

Every 1.x release keeps every item in this contract. Removing or renaming a contract item requires 2.0.
