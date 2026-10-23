# Clean Development implementation context

Storage routing and session cleanup for G's Mac, covering Claude Code, Codex and numbered Claude profiles. Version 0.6.0 is ESM Node.js, supports Node 20.12 or newer and has no npm dependencies.

## Layout and runtime contracts

- `machine/env.zsh` and `machine/storage.conf` are installed to `~/dev/machine/` by `install.sh --config`. `env.zsh` is sourced by zsh and Bash 3.2; its hot path is POSIX-compatible, silent and fork-free.
- `runtime/` contains hooks (`bin/cd-hook` delegates to `bin/cd-hook.mjs`) and CLI (`bin/clean-development`). Installation uses `~/dev/machine/runtime/clean-development/<version>/` and versioned hook paths.
- `skills/clean-development/SKILL.md` is the agent-facing skill. `plugin.json` and `.claude-plugin/plugin.json` package the skill. Hook installation is separate from plugin auto-loading.
- `fragments/` contains blocks for Claude, Codex and claude-work settings plus `merge-hooks.py`.
- `schemas/project-config.schema.json` defines schema v2; the reader also supports v1.

`removeManaged` implements managed-root cleanup using a trash rename and detached deletion. Project build/dependency directories are registered by `buildDirs` and `depDirs`. Hooks log to `~/dev/machine/state/clean-development/hook.log`; their runtime design returns exit 0 on errors. SessionStart has a subsecond target and Codex SessionEnd has a 3-second host deadline.

The session-key algorithm in `machine/env.zsh` and `runtime/lib/sessions.mjs` uses a harness letter and the final 12 characters of `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`. Codex trust hashes depend on hook command text. The command `clean-development codex-trust --apply` updates that trust configuration.

Version references appear in `runtime/VERSION`, `runtime/lib/conf.mjs`, `machine/env.zsh`, both plugin manifests, `package.json`, fragment paths, marketplace entries and the claude-work provisioning pin.

## Command references

```sh
npm run check
CLEAN_DEV_TEST_DIR="$TMPDIR/cd-test-$$" npm test
```

The tests provide simulated homes and a simulated `Volumes/4TB`.
