# Changelog

## 0.6.1 (unreleased)

- Protect active fallback builds in every selector; reopen deferred-ended owners with versioned phase/generation metadata, fence stale snapshots/tagged events and canonicalise checkout identity. Refuse collisions/invalid ownership rather than replace another owner.
- Unify supported lifecycle cleanup/lease locking; remove age-based lock takeover, add explicit dead-owner recovery and fail-closed configuration/path admission. Reject redirected layout/trash directories; retain sources on rename failure.
- Parse storage policy as data in fork-free POSIX shell and Node; align path/numeric validation and preserve approved lab/model overrides.
- Add renewable explicit path leases and verified no-clobber single-file publication with durable receipts and retained source/recovery copies. These are not process supervision or an OS quota.
- Bound cooperative hook/Git/measurement work, retain deferred cleanup, and distinguish hook completion from queued/completed deletion. Batch deletion jobs per anchor to avoid per-entry Node process storms.
- Add immutable runtime publication, digest/permission receipts, policy-preserving configuration installation, strict flags, truthful preview and conflict-aware rollback/recovery. Retain previous releases and recovery data.
- Revalidate activation target topology, bytes and permissions at backup/activation; journal write intent only after conflict checks so rollback cannot claim pre-existing user edits. Make offline profile fixtures independent of TMPDIR aliases.
- Report bounded Git/rename deferrals with their repo paths and leave incomplete repository sweeps due instead of postponing them for a week. Keep the 200 ms Git bound; test both successful cleanup and explicit, fail-closed timeout deferral.
- Pin project development to Node 26.12.1 via `.node-version`; retain the tested minimum-runtime and project-schema compatibility contracts. No third-party npm/model dependency is introduced.
- Preserve Codex disablement/unknown state in offline and host trust refresh plus config rebuild; refuse positional preference changes without explicit review. Hook merges retain recovery bytes and unrelated handlers.
- Fix wider-tooling reprovision rollback so never-moved originals survive; retain failed replacement snapshots, journal outcomes and do not trim failed reprovision recovery data. Claude-tooling preview now performs no deployment.
- Expand diagnostics/support claims and regression coverage. OpenCode remains environment-only; its source client alias filters inherited session identity without claiming a reused server is repaired.

## 0.6.0 (20 Oct 2026)

Rewrite for one machine (G's Mac), replacing the 0.2-0.5 multi-host package (last public state: tag v0.5.0).

- Storage policy moves to `~/dev/machine/storage.conf`; env.zsh rewritten (fork-free session pin, stamp-based precedence, no exits, TMPDIR per session only).
- Mode detected by volume name plus a real write probe at session start and pinned per session; internal fallback is normal.
- New hooks: SessionStart (pin, context, time-boxed reap), Stop (async, throttled housekeeping), SessionEnd (immediate session cleanup) for Claude Code and Codex; same hooks for claude-1..5.
- Automatic cleanup per G's rules (Q30), 30 GB LRU cap on dependency caches, 14-day external build prune, repo build/dependency dirs via `.clean-development.json` v2 (`buildDirs`, `depDirs`, git-ignored only).
- No-dot-folder report for `~` and `~/dev` (allowlist includes `.aws`, `.insightface`, `.opencode`); `doctor` and `status` also list unmanaged top-level entries of each cache root.
- Every hook call appends one JSON line (`ts`, `harness`, `event`, `session_id`, `mode`) to `~/dev/machine/state/clean-development/events.jsonl` (rotated at 512 KB).
- Xcode DerivedData is never wiped by the last-session-out cleanup; it ages out after 14 days.
- `DEV_STORAGE_VOLUME_TEST=present` is accepted as an alias of `mounted`.
- Codex hook trust hashes computed (`codex-trust --apply`), so changed hooks run without a review click.
- Removed: command shims and `clean-development agent|session|setup|prune` consent flows (`run [--session X] -- CMD` stays as a no-policy shim that just execs CMD, for stale per-repo docs), per-host integrations (Cursor, Devin, Grok, Kimi, Hermes, Pi, OpenCode, Gemini), npm publishing. `pnpm_config_store_dir` replaces `npm_config_store_dir` (ignored by pnpm 12).
