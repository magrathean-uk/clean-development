# clean-development (plugin + runtime, part of bolyki-dev)

Machine storage policy for G's Mac: routing (4TB external or internal fallback), session-end cleanup, the 5 GB rule and the no-dot-folder report, for Claude Code, Codex and claude-1..5. Version 0.6.0. ESM Node (>= 20.12), no dependencies.

## Layout

- `machine/env.zsh`, `machine/storage.conf`: installed to `~/dev/machine/` by `install.sh --config`. env.zsh must stay POSIX (zsh and bash 3.2 source it), print nothing on stdout, never exit, and stay fork-free on the hot path (pinned session shells).
- `runtime/`: hooks (`bin/cd-hook` -> `bin/cd-hook.mjs`) and CLI (`bin/clean-development`), installed to `~/dev/machine/runtime/clean-development/<version>/`. Hook commands in user settings point at that versioned path.
- `skills/clean-development/SKILL.md`: the agent-facing rules (model-invocable). `plugin.json` (OpenAI portable) and `.claude-plugin/plugin.json` ship only the skill; the plugin declares no hooks on purpose (no `hooks/` directory: both harnesses would auto-load `hooks/hooks.json`).
- `fragments/`: the hook blocks merged into `~/.claude/settings.json`, `~/.codex/hooks.json` and claude-work `shared/settings.json`, plus `merge-hooks.py`.
- `schemas/project-config.schema.json`: `.clean-development.json` schema v2 (v1 still read).

## Rules for changes

- Deletion only through `removeManaged` (strictly inside managed roots, rename to trash, detached delete). Repo directories only when declared in `buildDirs`/`depDirs` and git-ignored. Never delete source, toolchains, VMs, models or anything under `~/dev/porn`.
- Hooks never fail a session: catch, log to `~/dev/machine/state/clean-development/hook.log`, exit 0. SessionStart must stay well under 1 s; Codex SessionEnd is capped at 3 s.
- Session key derivation must match in `machine/env.zsh` and `runtime/lib/sessions.mjs` (harness letter + last 12 characters of `CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID`).
- Changing any hook command changes its Codex trust hash: re-run `clean-development codex-trust --apply` after installing.
- Version bumps: `runtime/VERSION`, `runtime/lib/conf.mjs` `VERSION`, `machine/env.zsh` `CLEAN_DEV_VERSION`, `plugin.json`, `.claude-plugin/plugin.json`, `package.json`, `fragments/*.json` paths, the bolyki-dev marketplace entries and the claude-work provisioning pin.

## Checks

Run all with a disposable directory (nothing outside it is written):

```sh
npm run check
CLEAN_DEV_TEST_DIR=/tmp/cd-test-$$ npm test     # node --test test/ and test/env-modes.sh
```

Tests use simulated homes and a simulated `Volumes/4TB`; never point them at the real home or the real volume.
