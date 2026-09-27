# Storage and configuration

## User setup

```sh
clean-development setup --dry-run --root /absolute/path/to/clean-development --agents all
clean-development setup --root /absolute/path/to/clean-development --agents all
```

User configuration is written to:

- macOS: `~/Library/Application Support/clean-development/config.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/clean-development/config.json`
- Windows: `%APPDATA%\clean-development\config.json`

Runtime/state and disposable storage are separate. Platform data, config, and cache locations can be overridden with `CLEAN_DEVELOPMENT_DATA_HOME`, `CLEAN_DEVELOPMENT_CONFIG_HOME`, and `CLEAN_DEVELOPMENT_ROOT`.
Every override must be a non-empty absolute path. Application data/config overrides also refuse the filesystem root and the home directory itself.

Keep the data-home and agent-config choices available for setup updates and uninstall. Receipts that identify owned runtime files and native agent edits live in the data home and are bound to the resolved Claude, Codex, and Grok config files. If `CLEAN_DEVELOPMENT_DATA_HOME`, `XDG_DATA_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, or an equivalent platform location changes, rerun with the original value. A newly resolved empty state location or mismatched agent path is an error, not a successful removal.

## Project configuration

Place `.clean-development.json` at or above the working directory:

```json
{
  "$schema": "https://raw.githubusercontent.com/magrathean-uk/clean-development/main/schemas/project-config.schema.json",
  "schemaVersion": 1,
  "root": "/Volumes/DevCache/clean-development",
  "cacheRoot": "/Volumes/DevCache/caches",
  "buildRoot": "/Volumes/FastSSD/builds/my-app",
  "scratchRoot": "/Volumes/DevCache/scratch",
  "retention": {
    "buildDays": 30
  },
  "tools": {
    "cargo": true,
    "yarn": false
  }
}
```

`retention.buildDays` applies only to registered managed build directories. The scratch root is reserved for explicitly disposable work, but `0.2.0` does not create, register, or prune scratch entries automatically.

All configured paths must be absolute. Filesystem roots and the home directory itself are refused as managed roots.

After adding or changing project paths, prepare their base directories from that project:

```sh
clean-development prepare --dry-run
clean-development prepare
```

`prepare` reads the effective project configuration and does not rewrite user configuration. It creates only each configured leaf and the default children below an already available root. For a split destination such as `/Volumes/FastSSD/builds/my-app`, create and mount `/Volumes/FastSSD/builds` first. Requiring the direct parent prevents a missing external volume from being replaced by a newly created local directory tree.

## Session choices

```sh
clean-development session --dry-run --json
clean-development session --session persist --json
clean-development agent codex --session session-only -- exec "Run the tests"
clean-development run --session skip -- npm test
```

`session --dry-run` reports the detected project, manifest evidence, conflicting package-manager declarations, effective storage roots, environment preview, and exact proposed project configuration. It creates no runtime, storage directories, or project files and starts no command. Detection walks upward to the nearest supported project manifest or Git boundary, then inspects the filenames and supported metadata there. It does not recursively scan source, run project scripts, probe toolchains, or install dependencies. Multiple Node package managers are reported as a conflict; detection does not delete lockfiles or select a replacement manager.

`session`, `agent`, and `run` accept these choices:

| Choice | Behavior |
|---|---|
| `session-only` | Prepare configured managed base directories outside the detected project and apply detected shared-cache variables to the launched process. No project configuration is written. |
| `persist` | Apply the same routing and create only the reviewed `.clean-development.json` when it is absent. An existing file is left unchanged. |
| `skip` | Do not prepare storage or create a runtime. Launch the original command without Clean Development shims and remove unchanged environment values injected by the enclosing session. Explicit user overrides remain. |

An interactive terminal prompts when no choice is supplied or inherited; Enter selects `session-only`. Noninteractive execution defaults to `session-only`. An explicit `--session` wins over `CLEAN_DEVELOPMENT_SESSION_MODE`. The selected mode is inherited by children so nested launches do not ask again; `persist` is inherited as `session-only`, preventing the parent choice from authorizing another project's configuration write.

An effective project setting of `enabled: false` keeps routed choices unavailable and launches through the skip path without preparing managed storage.

Installed native integrations also use `skip` as their no-choice default. They may prepend the durable runtime directory so `clean-development` remains available, but supported shims pass through to the real executable until an explicit launcher or `run --session` selection is inherited. Native hooks do not treat noninteractive startup as consent. Codex launcher runs override the installed TOML default with the selected mode; shell-based helpers preserve an already inherited selection.

Persistence creates the file at the detected project root. The proposal contains schema version 1, `enabled: true`, and enabled detected tools; it does not save machine-specific root paths or a permanent consent choice. Inspect the exact JSON with `--dry-run` or the interactive prompt. Existing configuration, a symlink/non-file at the target, or a target or directory that changes after review is never silently overwritten. `persist` does not change agent settings, source manifests, lockfiles, or instruction files. Managed runtime/storage files can still be created outside the source tree when routing is applied.

Session-only and persist are unavailable when `root`, `cacheRoot`, `buildRoot`, or `scratchRoot` equals or sits inside the detected project. Move those destinations outside the repository and review the plan again. This prevents the default noninteractive choice from creating artifact directories in source.

The standalone `session` command reports or applies the selection and exits. It neither launches an agent nor exports variables into its parent shell; use `agent` or `run` for an environment inherited by a child command. An agent that invokes the management skill after it has started must route subsequent commands through `clean-development run --session ... -- COMMAND` or relaunch. Stable `clean-development-AGENT` launchers offer the interactive choice when no mode is inherited. An already-open native session inherits `skip`, so use the full `agent` or `run` command with an explicit `--session` option after approval.

The initial overlay contains shared-cache values for detected, enabled tools. An existing explicit tool variable is preserved unless force mode is selected. The overlay excludes `CARGO_TARGET_DIR`: the Cargo shim resolves each command's actual workspace and maintains its ownership record and active lease. Other supported shims remain available for tools invoked later, including tools absent from the initial detection.

## Precedence

From highest to lowest:

1. Command options such as `setup --root`.
2. `CLEAN_DEVELOPMENT_ROOT`, `CLEAN_DEVELOPMENT_CACHE_ROOT`, `CLEAN_DEVELOPMENT_BUILD_ROOT`, and `CLEAN_DEVELOPMENT_SCRATCH_ROOT`.
3. The nearest `.clean-development.json` found from the command cwd upward.
4. User configuration.
5. Platform defaults.

Tool variables such as `CARGO_TARGET_DIR`, `GOCACHE`, or `npm_config_cache` have a separate rule: an explicit non-empty value takes precedence over managed routing. An unchanged value recorded as injected by Clean Development is not an explicit override and may be rerouted or removed; see [inherited environment provenance](#inherited-environment-provenance). `CLEAN_DEVELOPMENT_FORCE=1` opts into replacing explicit values for that process.

## Workspace IDs

A Cargo build directory uses the nearest enclosing Cargo workspace root, or the nearest `Cargo.toml` when there is no workspace manifest. Its ID is the root basename plus the first ten hexadecimal characters of a SHA-256 digest of its canonical path, for example `my-app-a81f44c901`. Members of one Cargo workspace share a target tree; separate worktrees get separate mutable output even when their repository and branch names match.

The ID does not include the session, current commit, or branch. Warm builds remain reusable across agent sessions and commits, while the underlying compiler still performs its normal invalidation.

## Moving the root

Run setup again with the new root. New routed work uses the new destination. Existing data is not migrated, adopted, or deleted automatically. This avoids treating unknown prior files as product-owned.

If the root is on an external volume, mount it before running `setup`, `prepare`, or a routed session. Session preparation uses the same direct-parent requirement as `prepare`. A missing or unwritable volume is an error; normal tool runs never recreate a missing cache or build base and there is no hidden fallback that starts filling the home directory.

## Inherited environment provenance

Session overlays and command shims record the exact adapter values they inject in
`CLEAN_DEVELOPMENT_SESSION_ENV`. On a later supported command, an unchanged
recorded value may be rerouted for the current project. A value changed by the
user is preserved, including independently changed upper-case npm variables.
`skip` removes only unchanged injected values, not independent overrides.

Case variants are compared separately. For example, when an inherited
`npm_config_cache` still points at project A's managed cache and the user sets
`NPM_CONFIG_CACHE` to another path, the explicit upper-case value wins unless
force mode is selected. Running an unrelated adapter first must retain
provenance for the unchanged lower-case value. The next npm route, `skip`, or entry into a disabled project/tool removes
that injected spelling while preserving the override. A provenance entry is
forgotten only when no spelling retains its recorded value.

An explicit non-empty value such as `npm_config_cache=$HOME/.npm` is preserved
without guessing whether npm or the user set it. The same conservative rule
applies to npm/npx launch environments when provenance is unavailable. Unset or
empty variables remain eligible for routing; `CLEAN_DEVELOPMENT_FORCE=1` explicitly
overrides non-empty values. To opt into routing from an npm-injected environment,
unset its cache variable or deliberately use force mode. Older shared-cache
values without provenance are treated as explicit; older Cargo markers remain
recognised. The marker authorises no file creation or deletion by itself.
