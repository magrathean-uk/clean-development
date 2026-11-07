# Clean Development implementation context

Clean Development provides storage routing and session cleanup for configured developer workstations. Version 0.6.8 is ESM Node.js, supports Node 20.12 or newer and has no npm dependencies. Claude Code and Codex have native lifecycle integrations; OpenCode has environment routing only, with no native lifecycle adapter. The packaged storage policy is an editable example, not a universal machine configuration.

## Layout and runtime contracts

- `machine/env.zsh` and `machine/storage.conf` are installed to `~/dev/machine/` by `install.sh --config`. `env.zsh` is sourced by zsh and Bash 3.2; its hot path is POSIX-compatible, silent and fork-free. It optionally sources a user-managed `~/dev/machine/env.private.zsh` extension. Extra child environment names for `run --clean-env` are configured in `state/clean-development/childenv-allow.list`.
- Additional Codex homes, shared Claude settings and Claude profile files are declared in `state/clean-development/codex-homes.list`, `claude-settings.list` and `claude-profiles.list`. Codex entries name home directories; the Claude entries name settings files. Registries accept absolute or `~/`-relative paths, and a `?` prefix marks an optional entry. Profile settings retain the stale and asynchronous handler checks.
- `runtime/` contains hooks (`bin/cd-hook` delegates to `bin/cd-hook.mjs`) and CLI (`bin/clean-development`). Installation uses immutable `~/dev/machine/runtime/clean-development/<version>/` releases; hook commands name the stable shim `~/dev/machine/runtime/clean-development/active/bin/cd-hook`, which dispatches through the installed CLI launcher and installer-selected Node runtime.
- `skills/clean-development/SKILL.md` is the agent-facing skill. `plugin.json` and `.claude-plugin/plugin.json` package the skill. Hook installation is separate from plugin auto-loading.
- `fragments/` contains hook blocks for Claude Code and Codex plus the recovery-aware `merge-hooks.py` helper.
- `schemas/project-config.schema.json` defines schema v2; the reader also supports v1.

`removeManaged` requires an independently trusted anchor, refuses redirected layout/trash directories and retains sources on rename failure. Deletion workers write separate completion receipts. The shared lifecycle lock fences selection/rename, start/resume/end and explicit leases; stale locks require explicit dead-owner recovery, never age takeover; the one automatic takeover is a lifecycle/housekeeping lock whose owner recorded a valid `bootId` other than the current `kern.bootsessionuuid`, reclaimed under this boot's outer guard `lock-recovery.<bootId>.lock` plus the shared `lock-recovery.lock` (which every recovery protocol, 0.6.3 included, holds while it unlinks) with inode/device/token checks, and logged to hook.log (`locks.mjs` `withLifecycleLock`); a shared guard with another boot's id is reclaimed under the outer guard. Wall-clock evidence (acquiredAt before `kern.boottime`, which XNU shifts on clock sets) is reported, never acted on. New JSON pins carry state version, phase and generation; legacy pins remain readable. Project build/dependency directories are registered by `buildDirs` and `depDirs`. Hooks return exit 0 on errors. Liveness (0.6.2) also counts leases, running `*.pid` jobs and the harness process by pid plus start time; weak evidence (harness process, `.mode`-only stub) is capped at 7 idle days and an incomplete observation at 30; ended Codex threads keep scratch for their resume window. Placeholder and short session ids are refused with the same rule in `env.zsh` and `sessions.mjs`; existing rejected pins get a 7-day all-signal quiet window, not permanence. Storage follows the drive per shell: pins register sessions for cleanup and never decide routing; `ownedRoots` lists the roots a session used, and a pin waits while one of them is away. Colima runs through `machine/colima`, which pins LIMA_HOME to `$COLIMA_HOME/_lima`; `vm colima-rehome` only renames stopped instances within one volume. SessionStart has a subsecond target and Codex SessionEnd a 3-second host deadline; cooperative budgets do not interrupt blocked kernel filesystem calls.

The session-key algorithm in `machine/env.zsh` and `runtime/lib/sessions.mjs` uses a harness letter and the final 12 characters of `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID` (or an inherited `CLEAN_DEV_SESSION` whose `CLEAN_DEV_STAMP` matches). Codex trust hashes depend on hook command text, which stays at the version-less shim path across upgrades. The command `clean-development codex-trust --apply` updates that trust configuration. Claude Code and Codex Stop hooks must be synchronous in 0.6.8; doctor checks effective managed hook configuration.

Release identity is recorded in `runtime/VERSION`, `runtime/lib/conf.mjs`, `machine/env.zsh`, the plugin manifests and `package.json`; hook fragments use the version-less shim path. `scripts/check-release.mjs` checks the package metadata. Keep `storage.conf` keys compatible with older environment readers, which fail closed and select internal routing on invalid policy.

`installer.mjs` stages immutable releases and journals activation/rollback under machine state. An unfinished receipt blocks new installs until recovery is resolved. `--config` preserves existing storage policy; `--replace-config` is explicit. Do not install, merge live hooks or exercise real mounts as part of source validation. `docs/safety-release.md` records remaining acceptance gates.

## Command references

```sh
npm run check
CLEAN_DEV_TEST_DIR="$TMPDIR/cd-test-$$" npm test
```

The tests provide simulated homes and a simulated `Volumes/External`.
