---
name: clean-development
description: Storage rules on G's Mac - where caches, builds, scratch, models and VMs go (4TB external vs internal fallback), the 5 GB download rule, session-end cleanup and the no-dot-folder policy. Use before large downloads, model pulls, VM or video work, unusual build output, cleanup, or any question about disk space or where files belong.
---

# Clean Development 0.6.1

Routing is already active in every shell: `~/.zshenv` loads `~/dev/machine/env.zsh`, and the clean-development hooks run at SessionStart, Stop and SessionEnd in Claude Code, Codex and claude-1..5. You do not need a wrapper command. The session-start message tells you the mode; `echo $CLEAN_DEV_MODE $DEVCACHE` shows it at any time.

An updated skill does not install the runtime/hooks. Check `clean-development version` before using new commands. OpenCode has **environment-only** routing, not native session ownership/cleanup; a reused server may retain older environment. Never borrow a parent Claude/Codex identity or its `$TMPDIR`.

## Modes (decided once per session, at session start)

- **external**: the `4TB` volume is mounted and `/Volumes/4TB/machine/cache` is writable. `DEVCACHE=/Volumes/4TB/machine/cache`.
- **internal**: anything else. `DEVCACHE=~/dev/machine/cache` on the internal disk. This is normal (the 4TB travels), not an error.
- The initial mode is pinned. If pinned external storage disappears, later shells fall back internally and warn: stop large work and tell G. Subsequent shells may route externally again on reconnect; existing processes retain their own environment. Nothing is copied back.

## Where things go

| What | Where | Lifetime |
| --- | --- | --- |
| Temp files, previews, verification copies | `$TMPDIR` = `$DEVCACHE/scratch/<session>/tmp` | deleted when the session ends |
| Throwaway build output you choose the path for (`--target-dir`, `-derivedDataPath`, `--scratch-path`, `-o`) | `$CLEAN_DEV_BUILDS` = `$DEVCACHE/builds/<session>` | internal: deleted at session end; external: kept, pruned after 14 days |
| Xcode DerivedData (default location) | `$XCODE_DERIVED_DATA_PATH` = `$DEVCACHE/builds/DerivedData` (Xcode preference follows the mode) | kept in both modes; pruned only when a project entry is idle for 14 days |
| Dependency caches (npm, pnpm store, yarn, bun, pip, uv, go, gradle, Hugging Face, torch, Homebrew, Playwright, XDG cache) | `$DEVCACHE/deps/<tool>` via the tool's own variable | shared, best-effort 30 GB shallow-mtime cap; acquire a consumer lease for protected use |
| Toolchains (rust/cargo, go, node, bun, pnpm, python, uv tools) | `~/dev/machine/toolchains` | permanent, internal |
| VMs (Tart, Lima), private labs | configured `LAB_ROOT` (`$TART_HOME`, `$LIMA_HOME`, `$DEVLAB`); default `/Volumes/4TB/dev/lab` | default external-only; honour approved storage-policy exceptions |
| Curated models | configured `MODELS_ROOT` (`$DEVMODELS`); default `/Volumes/4TB/models` | default external-only; honour approved exceptions |
| Source, deliverables, evidence | the repo or the project's own folder | never treated as cache |

Never override the routed variables, never `unset` them, and never write caches, builds or temp files into `~`, `~/dev` or a repo outside its git-ignored build directories. If a tool insists on `~/.something`, look for its cache/home variable; if none exists, tell G.

## The 5 GB rule (internal mode)

Before any download, model pull, container or VM image, dataset or build likely to exceed 5 GB: stop, tell G the size and suggest waiting for the 4TB. Continue on the internal disk only if G says so. There is no hard block. In external mode, put large data on the 4TB and still say how big it is.

## Cleanup (automatic, do not duplicate it)

- Session end: this session's scratch is deleted; in internal mode also its builds and the repo build directories its `.clean-development.json` lists in `buildDirs` (only when git-ignored and no other live session works in that repo).
- Each turn's Stop hook, throttled: finished or apparently 24 h idle sessions become eligible; live generations and explicit leases veto deletion. Every build selector protects live keys on both roots, including fallback. DerivedData ages out after 14 days, never last-out wipes. Dependency eviction observes only shallow mtimes, not deep writes/reads; it is not a strict quota.
- Delete only disposable fixtures your task owns. Never delete the sole copy of unfinished work, rollback state or evidence because its directory is named cache. Do not delete other paths in `$DEVCACHE` by hand; preview housekeeping and apply only when G asks.
- Invalid configuration, redirected managed directories, unverifiable ownership and failed renames block cleanup. Do not bypass these checks or remove a busy lock. `doctor` and explicit dead-owner lock recovery are the supported route.

## Work and job lifetime

Keep unique candidates, patches, transaction predecessors and partial/final evidence in durable project storage, not session scratch. Before a long/quiet job or parent-child handoff uses paths, acquire a lease for **all** required scratch/build/cache/project paths:

```sh
clean-development leases create --path "$CLEAN_DEV_SCRATCH" --path "$CLEAN_DEV_BUILDS" --minutes 60 --owner 'job description' --apply
clean-development leases renew LEASE_ID --minutes 60 --apply
clean-development leases release LEASE_ID --apply
```

Record the returned ID and absolute handoff paths. Leases protect cleanup; they do not detach, supervise or keep processes alive. Renew before expiry (1-1440 minutes), release after consumers finish. Expiry is not success. If a cap conflicts with a preservation-only instruction, stop creating new fixtures, retain partial results and ask for a scoped policy decision; do not delete evidence or silently raise the cap.

`publish --source FILE --destination /durable/project/evidence/FILE --apply` verifies and publishes one regular file without deleting its source or overwriting different destination bytes. Pending/failed publication creates a non-expiring source hold, not an ordinary TTL lease. Inspect its receipt; release a recovery hold with `--recovery-confirmed --apply` only after the bytes are durably recovered/published. A directory needs explicit packaging/project-specific publication. The legacy `run --session ... --` shim adds no policy, lease or isolation.

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
