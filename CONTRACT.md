# Clean Development contract

This is the public surface proposed for the 1.0 freeze. Paths below are relative to this package unless they start with `~`. The runtime needs Node.js 20.12 or later; deployment targets macOS, with Claude Code and Codex hooks and environment routing for OpenCode.

1.0 freezes the command forms, flag meanings, exit-code causes, JSON field names and meanings, routing variables and selection rules, project schema v2, hook command and output envelope, and installed entry paths below. Release numbers, transaction IDs, measurements, hashes and diagnostic text are values, not fixed strings. Legacy schema v1 remains readable. Changes to these promises after 1.0 need an explicit compatibility decision; no deprecation period or wider platform support is decided here.

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

Report also reads `~/dev/machine/state/clean-development/homes.txt`, when present. This package does not write it: an agent-home refresh outside the package (one that updates the plugin in several agent homes) writes its final inventory there, one `home <path> <claude|codex> <version|absent|disabled> <hook12> <skill12>` line per home, with an optional trailing `running-older`. Paths can contain spaces; hashes are 12 lowercase hexadecimal digits or `-` when missing. Numbered profiles report the plugin version selected for a new session. The `agent homes` text section counts versions matching the active runtime and lists every differing home, including absent and disabled entries, plus homes marked `running-older`. That marker means an older shared folder remains available to running sessions. Inventory is a refresh snapshot, not a live session probe. Missing inventory yields an empty homes array and no section. Home version drift does not change report --check exit codes; the check still reads this small file without sizing storage.

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
| home | path, harness, version, hook, skill, runningOlder |
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

Report's homes array holds home objects. Harness is claude or codex; version is the next-session release, absent or disabled; hook and skill are the recorded hashes. runningOlder is a boolean, independent of whether the next-session version is current: it marks a home whose running sessions still use an older plugin folder after the refresh installed a newer one for new sessions. Report only reads these fields; how a refresh publishes plugins and hooks is outside this contract.

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

Each install creates a new rollback record before activation, containing the source commit (or an explicit unavailable marker for non-Git source), from/to versions, receipt, previous target and exact rollback command. Record-dir overrides only its directory. Current records can survive a failed transaction that restored activation, and their command uses the source checkout; publishing must resolve those backlog concerns. The shim, CLI and environment paths are the stable entry points; receipts and backups remain for recovery. Internal receipt contents and transient lock bodies are not a new 1.0 public API.
