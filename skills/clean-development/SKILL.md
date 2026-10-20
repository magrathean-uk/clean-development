---
name: clean-development
description: Storage rules on G's Mac - where caches, builds, scratch, models and VMs go (4TB external vs internal fallback), the 5 GB download rule, session-end cleanup and the no-dot-folder policy. Use before large downloads, model pulls, VM or video work, unusual build output, cleanup, or any question about disk space or where files belong.
---

# Clean Development 0.6.0

Routing is already active in every shell: `~/.zshenv` loads `~/dev/machine/env.zsh`, and the clean-development hooks run at SessionStart, Stop and SessionEnd in Claude Code, Codex and claude-1..5. You do not need a wrapper command. The session-start message tells you the mode; `echo $CLEAN_DEV_MODE $DEVCACHE` shows it at any time.

## Modes (decided once per session, at session start)

- **external**: the `4TB` volume is mounted and `/Volumes/4TB/machine/cache` is writable. `DEVCACHE=/Volumes/4TB/machine/cache`.
- **internal**: anything else. `DEVCACHE=~/dev/machine/cache` on the internal disk. This is normal (the 4TB travels), not an error.
- The mode does not change mid-session. If the pinned 4TB disappears, shells fall back to internal and print one warning: stop large work and tell G. Nothing is copied back to the 4TB when it returns.

## Where things go

| What | Where | Lifetime |
| --- | --- | --- |
| Temp files, previews, verification copies | `$TMPDIR` = `$DEVCACHE/scratch/<session>/tmp` | deleted when the session ends |
| Throwaway build output you choose the path for (`--target-dir`, `-derivedDataPath`, `--scratch-path`, `-o`) | `$CLEAN_DEV_BUILDS` = `$DEVCACHE/builds/<session>` | internal: deleted at session end; external: kept, pruned after 14 days |
| Xcode DerivedData (default location) | `$XCODE_DERIVED_DATA_PATH` = `$DEVCACHE/builds/DerivedData` (Xcode preference follows the mode) | kept in both modes; pruned only when a project entry is idle for 14 days |
| Dependency caches (npm, pnpm store, yarn, bun, pip, uv, go, gradle, Hugging Face, torch, Homebrew, Playwright, XDG cache) | `$DEVCACHE/deps/<tool>` via the tool's own variable | shared, 30 GB LRU cap per root |
| Toolchains (rust/cargo, go, node, bun, pnpm, python, uv tools) | `~/dev/machine/toolchains` | permanent, internal |
| VMs (Tart, Lima), private labs | `/Volumes/4TB/dev/lab` (`$TART_HOME`, `$LIMA_HOME`, `$DEVLAB`) | 4TB only; unavailable in internal mode |
| Curated models | `/Volumes/4TB/models` (`$DEVMODELS`, Ollama `$OLLAMA_MODELS`) | 4TB only |
| Source, deliverables, evidence | the repo or the project's own folder | never treated as cache |

Never override the routed variables, never `unset` them, and never write caches, builds or temp files into `~`, `~/dev` or a repo outside its git-ignored build directories. If a tool insists on `~/.something`, look for its cache/home variable; if none exists, tell G.

## The 5 GB rule (internal mode)

Before any download, model pull, container or VM image, dataset or build likely to exceed 5 GB: stop, tell G the size and suggest waiting for the 4TB. Continue on the internal disk only if G says so. There is no hard block. In external mode, put large data on the 4TB and still say how big it is.

## Cleanup (automatic, do not duplicate it)

- Session end: this session's scratch is deleted; in internal mode also its builds and the repo build directories its `.clean-development.json` lists in `buildDirs` (only when git-ignored and no other live session works in that repo).
- Each turn's Stop hook, throttled: finished or 24 h idle sessions are reaped; internal session builds idle for 24 h are pruned and all internal session builds go when no internal session is live (Xcode DerivedData is never wiped, only aged out after 14 days); external builds older than 14 days are pruned weekly; declared `buildDirs`/`depDirs` of repos idle for 14 days are pruned; dependency caches are LRU-trimmed to 30 GB per root (nothing used in the last 2 h).
- You may delete files your task created. Do not delete other paths in `$DEVCACHE` by hand; preview with `clean-development housekeeping` and apply with `--apply` when G asks for a cleanup.

## Dot-folders

No new dot-folders in `~` or `~/dev` beyond the allowlist in `~/dev/machine/storage.conf`. The session-start message lists unexpected ones: report them to G and never delete them yourself.

## Commands

```sh
clean-development status [--sizes]   # mode, roots, free space, sessions, dot-folders, dead 4TB links
clean-development doctor             # installation health (hooks, trust, pins, GUI env, Xcode)
clean-development housekeeping       # preview the Stop-hook cleanup; --apply to run it now
clean-development init [--write]     # schema v2 .clean-development.json for the current repo
clean-development migrate --write .  # convert a schema v1 file
```

`.clean-development.json` (schema v2): `{"schemaVersion": 2, "enabled": true, "heavy": false, "buildDirs": [".build"], "depDirs": ["node_modules"]}`. `heavy: true` makes the session-start message warn about large work in internal mode. Paths are relative and must be git-ignored to be cleaned.

Dead symlinks in `~/dev/source` (for example `SpecieX`, which lives on the 4TB) are expected while the drive is away; do not remove or "fix" them. The SD card (`/Volumes/SD`) is optional slow storage only: no routing, no backups.
