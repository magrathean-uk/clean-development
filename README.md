# Clean Development 0.8.0

Clean Development routes development caches, build output and scratch files to configured storage, and helps clear them safely. It is designed for macOS workstations using Claude Code or Codex. OpenCode can use the environment routing.

It has three parts: `env.zsh` routing, two commands (`report` and `cleanup`) and a SessionStart hook that prints one context line. Nothing runs at the end of a session and nothing deletes files: cleanup only moves approved items to the volume Trash.

The runtime has no npm dependencies and requires Node.js 20.12 or later. The installer accepts `CLEAN_DEV_NODE` as an absolute path to a supported Node.js executable; otherwise it checks common install locations and `PATH`. The Claude hook merge helper uses Python 3; the Codex merge needs Python 3.11 or later for `tomllib`. Clean Development does not publish an npm package; GitHub is the source distribution.

```sh
git clone https://github.com/magrathean-uk/clean-development.git
cd clean-development
```

See [CONTRACT.md](CONTRACT.md) for the public surface proposed for the 1.0 freeze.

## What it does

- Routes cache, build and scratch locations according to `machine/storage.conf`. The external volume is used when it is mounted and its cache directory is writable; otherwise the internal root is used, and dependency caches and builds still go there.
- `clean-development report` prints free space on both drives, the size of each root, routing variables that point outside the root and known cache folders outside the root. It never writes. `report --check` exits 1 when a routing variable is outside the root.
- `clean-development cleanup` lists what could be cleared and never changes anything. `cleanup --apply <id>` moves the approved items to the Trash.
- The SessionStart hook prints one line: mode, root, free space, and a cleanup offer when a drive is filling.

## Install

```sh
./install.sh --dry-run --config
```

After reviewing the preview, install the runtime and environment files:

```sh
./install.sh --config
```

The installer places an immutable versioned copy under `~/dev/machine/runtime/clean-development/<version>` and switches `active`. It refreshes the managed hooks in `~/.claude/settings.json` and `~/.codex/hooks.json` to SessionStart only, preserving unrelated entries. Codex positional preferences that need remapping block installation. `--config` keeps an existing storage policy; `--replace-config` replaces it on purpose. Before switching, it writes one rollback record with the previous active target and the rollback command to `~/dev/machine/runtime/clean-development/rollback/` (`--record-dir DIR` chooses another directory), retaining older release directories. If an install fails part way, `install.sh --recover ID` restores its activation files; when a user edit is the only conflict, inspect it first and add `--accept-current` to leave that content untouched. `install.sh --rollback ID` restores a committed installation's previous activation files and hooks, preserving conflicting user edits for review.

The environment file routes `XDG_CACHE_HOME` and leaves your locale, XDG config, data and state locations, installed toolchain homes, model stores, VM homes, Docker config and telemetry preferences unchanged. `HF_HOME` stays with the host because it may hold credentials; only `HF_HUB_CACHE` and `HF_ASSETS_CACHE` are routed. `CARGO_HOME` and `RUSTUP_HOME` remain host-managed.

Source `~/dev/machine/env.zsh` from the startup file your shell loads (`~/.zshenv` for zsh, `~/.bash_profile` or `~/.bashrc` for Bash):

```sh
[ -r "$HOME/dev/machine/env.zsh" ] && . "$HOME/dev/machine/env.zsh"
```

For additional profiles, use the standalone hook merger with the chosen settings file. These previews use the default files:

```sh
python3 fragments/merge-hooks.py fragments/claude-hooks.json "$HOME/.claude/settings.json" --dry-run
python3 fragments/merge-hooks.py fragments/codex-hooks.json "$HOME/.codex/hooks.json" --dry-run
```

Remove `--dry-run` to apply a reviewed merge. The helper preserves unrelated handlers, saves a recovery copy and removes stale managed Stop and SessionEnd handlers from earlier versions. The fragments carry the SessionStart entry only.

The environment loader can also source `~/dev/machine/env.private.zsh` after standard routing. Treat it as trusted shell code and keep it portable across zsh and Bash.

Plugin installation makes the guidance skill available; it does not install the runtime or hooks. Confirm the active version with:

```sh
clean-development version
```

## Storage and cleanup

The active `storage.conf` sets the external volume, the internal fallback, the free-space threshold and the report-only folder allowlists. These values are examples, not universal defaults. Do not override routing variables in child processes. `$DEVCACHE`, `$TMPDIR`, `$CLEAN_DEV_BUILDS` and `$CLEAN_DEV_WORK` expose the selected locations. `$TMPDIR` is routed to session scratch in agent shells only; a terminal shell keeps the macOS default. Sourcing `env.zsh` creates each routed folder under the root it exports, so a fresh shell on either drive gets usable folders; `DEV_ENV_INSPECT_ONLY=1` creates nothing.

`cleanup` lists these kinds of item: worktrees whose branch is merged and that are clean, job folders that carry `.done`, a project's own build and dependency folders (with `--project DIR`), and unclaimed folders under the root's `builds/` or `scratch/` that have not changed for 7 days. It never lists the roots, `deps/`, symlinks, the current shell's own build and scratch folders, or anything changed in the last 24 hours. The output ends with `list: <id>`.

`cleanup --apply <id> [--skip N,...] [--project DIR]` rescans, and refuses with exit 3 and moves nothing when the id no longer matches. Each item is moved into the Trash of its own volume under `clean-development-<UTC stamp>/` with a `MANIFEST.txt`. A move across volumes fails the item; it never copies. The output prints the bytes moved and each volume's free space. Space comes back only when the Trash is emptied.

Never use cache or scratch as the sole copy of unfinished work, rollback data or evidence.

## Development

```sh
npm run check
CLEAN_DEV_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cdt.XXXXXX")" npm test
```

The tests use fabricated homes and volumes under a unique fixture directory; they do not configure a live host or edit user harness settings. See [CHANGELOG.md](CHANGELOG.md) for version history and [CONTRIBUTING.md](CONTRIBUTING.md) for the supported scope.

## Support scope

| Environment | Support |
|---|---|
| macOS, Claude Code | Routing, `report`, `cleanup`, SessionStart line |
| macOS, Codex | Routing, `report`, `cleanup`, SessionStart line |
| OpenCode | Environment routing only |
| Linux, Windows, other coding agents | Not supported as deployment targets by this version |

Linux CI runs source checks and isolated fixtures. It does not imply Linux runtime support.
