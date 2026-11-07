# Clean Development 0.6.8

Clean Development routes development caches and temporary files to configured storage, and manages cleanup at the end of supported coding sessions. It is designed for macOS workstations using Claude Code or Codex. OpenCode can use the environment routing, but does not have a native lifecycle cleanup integration.

The runtime has no npm dependencies and requires Node.js 20.12 or later. The installer uses `CLEAN_DEV_NODE` when set, then checks common install locations and `PATH`. The Codex hook merge and trust tools need Python 3.11 or later for the standard-library `tomllib` parser. Trust operations search `PATH` and common install locations; set `CLEAN_DEV_PYTHON` to an absolute interpreter path if needed. Clean Development does not publish an npm package; GitHub is the source distribution.

Clone the repository, then run the installer from its directory:

```sh
git clone https://github.com/magrathean-uk/clean-development.git
cd clean-development
```

## What it does

- Routes cache, build and scratch locations according to `machine/storage.conf`. An attached external volume can be used when its configured mount and cache pass checks; otherwise the configured internal cache is used.
- Tracks supported Claude Code and Codex sessions and removes only managed, disposable files after ownership and path checks.
- Protects long-running work with renewable path leases. The `publish` command copies one regular file to durable project storage, verifies it and leaves the source in place.
- Provides `status`, `doctor`, cleanup previews and recovery commands for inspecting the installed runtime and its state.

The project configuration file, `.clean-development.json`, lists Git-ignored build and dependency directories that may be cleaned. Invalid policy, uncertain ownership or unsafe paths fail closed for deletion. Clean Development is cooperative same-user software, not an OS sandbox or job supervisor.

## Installation

Review `machine/storage.conf` before installing. It is an editable macOS example, with an external volume named `External`, external cache under `/Volumes/External/dev/cache` and internal fallback under `~/dev/machine/cache`. Change the volume name and paths to match your setup. The default layout uses `~/dev/machine/` for configuration and state and `~/dev/source/` for repository discovery. The installer preserves an existing storage policy; it uses the repository example for a new installation or when `--replace-config` is explicitly supplied.

If Node is installed in a non-standard location, set `CLEAN_DEV_NODE` to its absolute path. Preview the configuration install:

```sh
./install.sh --dry-run --config
```

After reviewing the preview, install the runtime and environment files:

```sh
./install.sh --config
```

The installer writes under `~/dev/machine/`. It does not edit Claude Code or Codex settings. The portable environment file routes Clean Development cache, build and session scratch variables. It leaves your locale, existing XDG config/data/state locations, installed toolchain homes, model stores, VM homes, Docker config and telemetry preferences unchanged. `HF_HOME` also stays with the host because it may hold credentials; only `HF_HUB_CACHE` and `HF_ASSETS_CACHE` are routed to cache storage. Standalone installs do not set Colima's home or place a shim ahead of your existing Colima command.

Source `~/dev/machine/env.zsh` from the startup file used by your shell. For zsh, use `~/.zshenv`; for Bash, use the startup file your development tools load, such as `~/.bash_profile` or `~/.bashrc`:

```sh
# zsh, in ~/.zshenv
[ -r "$HOME/dev/machine/env.zsh" ] && . "$HOME/dev/machine/env.zsh"

# Bash, in ~/.bash_profile or ~/.bashrc
[ -r "$HOME/dev/machine/env.zsh" ] && . "$HOME/dev/machine/env.zsh"
```

Then merge only the relevant hook fragment into the harness configuration. Preview each merge first:

```sh
python3 fragments/merge-hooks.py fragments/claude-hooks.json "$HOME/.claude/settings.json" --dry-run
python3.11 fragments/merge-hooks.py fragments/codex-hooks.json "$HOME/.codex/hooks.json" --dry-run
```

Remove `--dry-run` to apply a reviewed merge. The helper preserves unrelated handlers and saves a recovery copy. The Codex merge needs Python 3.11 or later; the Claude merge can use Python 3. Run `clean-development codex-trust --apply` after installation if required by the Codex configuration. That command also needs Python 3.11 or later; set `CLEAN_DEV_PYTHON` if it is not found automatically. Review Codex trust changes before applying them.

The environment loader can also source `~/dev/machine/env.private.zsh` after standard routing. Treat it as trusted shell code and keep it portable across zsh and Bash. Inspection with `DEV_ENV_INSPECT_ONLY=1` never sources this extension. A standalone clone does not include or create the file, and its installer does not search parent directories. A source tree can explicitly opt in to a fixed set of known sidecars with `.clean-development-private-sidecars.json`; only listed files are read, and existing target files and symlinks are preserved. Sidecar sources must be regular files owned by the installer user and not writable by group or other users. For `clean-development run --clean-env`, additional non-secret variable names can be listed one per line in `~/dev/machine/state/clean-development/childenv-allow.list`. Harness identities and secret-like names remain excluded, and variables that require explicit `--keep` still need that option.

`doctor` checks the default `~/.codex` and `~/.claude/settings.json` only when their configuration files exist. Additional Codex homes, Claude settings files and Claude profile settings files can be listed in `codex-homes.list`, `claude-settings.list` and `claude-profiles.list` under `~/dev/machine/state/clean-development/`. Codex entries are home directories; the other entries are settings files. Use one absolute or `~/`-relative path per line. Entries are required by default; prefix a path with `?` when it is intentionally optional. Symlinks to regular settings files are followed for read-only checks.

Plugin installation makes the guidance skill available; it does not install the runtime or hooks. The plugin is optional. Confirm the active version and host setup with:

```sh
clean-development version
clean-development doctor --no-gui
```

Use `doctor --no-gui` unless launchd and Xcode cache locations have been configured separately; this package does not install a GUI environment helper. The doctor checks the startup files for the shell in `$SHELL` (zsh or Bash). Registry entries only enable read-only checks; they do not change authentication or settings.

## Storage and cleanup

The active `storage.conf` controls the external volume, internal fallback, cache limits, build retention, free-space threshold and report-only folder allowlists. These values are examples, not universal defaults. Do not override routing variables in child processes. The runtime uses variables such as `$DEVCACHE`, `$TMPDIR` and `$CLEAN_DEV_BUILDS` to expose the selected locations.

Use `clean-development housekeeping` or `clean-development reap` to inspect cleanup plans. These commands preview by default; use `--apply` only after reviewing the listed paths. Never use cache or scratch as the sole copy of unfinished work, rollback data or evidence. Publish important files into durable project storage and retain the completed receipt.

For installer recovery, `install.sh --recover ID` retries a failed rollback. If a user edit is the only remaining conflict, inspect it first and use `install.sh --recover ID --accept-current` to leave that current content untouched and finish recovery. For leases and verified publication, see [the 0.6.1+ command reference](skills/clean-development/references/0.6.1.md). For implementation boundaries and remaining host acceptance, see [the safety and acceptance guide](docs/safety-release.md).

## Development

```sh
npm run check
CLEAN_DEV_TEST_DIR="$(mktemp -d "$TMPDIR/clean-development.XXXXXX")" npm test
```

The tests use fabricated homes and volumes. They do not configure a live host, edit user harness settings or exercise a real removable volume. Parent-monorepo scripts are skipped unless CLEAN_DEV_TEST_PRIVATE_SOURCE=1 is explicitly set. See [CHANGELOG.md](CHANGELOG.md) for version history and release-specific changes.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the supported scope and contribution checks.

## Support scope

| Environment | Support |
|---|---|
| macOS, Claude Code | Native session lifecycle hooks when configured |
| macOS, Codex | Native session lifecycle hooks when configured |
| OpenCode | Environment routing only; no native cleanup lifecycle integration |
| Linux, Windows, other coding agents | Not supported as deployment targets by this version |

Linux CI runs source checks and isolated fixtures. It does not imply Linux runtime or deployment support.
