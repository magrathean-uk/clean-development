# clean-development 0.6.0

Keeps G's Mac tidy while agents work.

- **Routing.** `~/dev/machine/env.zsh` sends every cache, build and temp file to one root: `/Volumes/4TB/machine/cache` when the 4TB is attached (detected by name plus a write probe), otherwise `~/dev/machine/cache`. Claude Code, Codex and claude-1..5 pin the choice per session.
- **Cleanup.** At session end a session's scratch is deleted (and, without the 4TB, its builds). Each turn, throttled housekeeping reaps finished sessions, prunes old builds (internal: idle 24 h; external: older than 14 days, weekly; Xcode DerivedData only after 14 days idle), prunes declared repo build/dependency folders of repos idle for 14 days, and keeps shared dependency caches under 30 GB per root (least recently used first).
- **Rules for agents.** The session-start message states the mode, the 5 GB rule when the 4TB is away, and any unexpected dot-folders in `~` or `~/dev` (reported, never deleted).

Install: `./install.sh --config`, merge `fragments/*.json` into the harness settings with `fragments/merge-hooks.py`, then `clean-development codex-trust --apply` and `clean-development doctor`. Policy values live in `~/dev/machine/storage.conf`.
