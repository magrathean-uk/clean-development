# Clean Development implementation context

Clean Development provides storage routing, a read-only report and an approved cleanup for configured developer workstations. It is ESM Node.js, supports Node 20.12 or newer and has no npm dependencies. The packaged storage policy is an editable example, not a universal machine configuration.

## Layout and runtime contracts

- `machine/env.zsh` and `machine/storage.conf` are installed to `~/dev/machine/` by `install.sh --config`. `env.zsh` is sourced by zsh and Bash 3.2, is POSIX-compatible, idempotent and silent on stdout, and creates the routed folders it exports (nothing under `DEV_ENV_INSPECT_ONLY=1`). It chooses the root (external when the volume is mounted and its cache is writable, otherwise internal) and routes the cache, build and scratch variables into it. Agent shells (`CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID` set) get `TMPDIR` in scratch; a terminal shell keeps the macOS `TMPDIR`. It can source a user-managed `~/dev/machine/env.private.zsh` outside inspection mode.
- `runtime/bin/clean-development` is the CLI: `report [--json] [--check]` (read-only), `cleanup [--json] [--project DIR]` (read-only) and `cleanup --apply <id> [--skip N,...] [--project DIR]` (moves to the volume Trash with a `MANIFEST.txt`; no code path unlinks or deletes), plus `init`, `version` and `help`. Unknown commands, including those removed in 0.7.0, exit 2 with `unknown command <name>; use --help`.
- `runtime/bin/cd-hook` prints one SessionStart context line and exits 0; stop and session-end exit 0 silently. It writes nothing. `fragments/` carries the SessionStart entry for Claude Code and Codex plus the `merge-hooks.py` helper.
- Installation uses immutable versioned copies under `~/dev/machine/runtime/clean-development/<version>/`. Each release includes `installer.mjs` and its transaction lock module, `install-lock.mjs`, for rollback. Hook commands name the stable shim `~/dev/machine/runtime/clean-development/active/bin/cd-hook`.
- `skills/clean-development/SKILL.md` is the agent-facing skill. `plugin.json` and `.claude-plugin/plugin.json` package it. Hook installation is separate from plugin auto-loading.
- `schemas/project-config.schema.json` defines schema v2 of `.clean-development.json` (`buildDirs`, `depDirs`); the reader also supports v1.

Version identity is recorded in `runtime/VERSION`, `runtime/lib/conf.mjs`, `machine/env.zsh`, the plugin manifests and `package.json`; the version checker under `scripts/` checks the package metadata. Keep `storage.conf` keys compatible with older environment readers, which select internal routing on invalid policy.

`installer.mjs` stages immutable versioned copies and journals activation and rollback under machine state; an unfinished receipt blocks new installs until recovered. Do not install, merge live hooks or exercise real mounts as part of source validation.

## Command references

```sh
npm run check
CLEAN_DEV_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cdt.XXXXXX")" npm test
```

The tests provide simulated homes and volumes. Keep fixtures on an internal path below `$TMPDIR`.
