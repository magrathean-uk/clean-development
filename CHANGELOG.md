# Changelog

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
