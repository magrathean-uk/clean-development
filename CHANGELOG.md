# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Compatibility can still change during `0.x` releases.

## [Unreleased]

### Fixed

- `doctor` checks every managed storage directory and verifies installed runtime files, launcher permissions, and the recorded Node executable instead of trusting an installation receipt alone.
- The public session API honors disabled project settings without creating managed storage, removes inherited routing on skip, and preserves user overrides. Project initialization cannot overwrite a configuration file created concurrently.
- Pruning retains corrupt ownership state, protects workspaces with unreadable leases, and revalidates workspace receipts and retention timestamps before deletion.
- Cargo recognizes inherited routing markers regardless of environment-variable casing and emits one canonical set of markers.
- Native Claude setup activates on forked sessions, matching the bundled hook configuration.
- CLI commands accept `--help`, describe session defaults, and reject unsupported environment formats and empty agent lists before making changes.

## [0.2.0] - 2026-09-19

### Added

- Read-only project stack detection and a consent-gated session plan with session-only, saved project settings, and skip choices.
- Static cache environment overlays for detected tools, while Cargo targets continue through workspace-aware ownership and lease routing.
- Interactive agent-launch prompts and explicit `--session` controls for automation; noninteractive launches default to session-only and never persist repository settings.
- A deterministic multi-language fixture lab and isolated real-tool smoke harness with recorded artifact checks.
- Native Grok Build command-prefix activation that restores managed shims after Grok captures its login-shell environment.

### Fixed

- Session-only activation leaves the repository unchanged, persistence writes only the exact reviewed `.clean-development.json`, and skip bypasses new runtime creation and managed routing. Preinstalled native shims remain available in pass-through mode.
- Codex CLI launchers now disable login-shell command execution so macOS `path_helper` cannot move native tools ahead of Clean Development's managed shims.
- Fresh native Codex integration owns the matching `allow_login_shell = false` setting. Existing user shell policies or conflicting login-shell choices are preserved and reported as launcher fallbacks.
- Generated shell activation now keeps the managed shim directory first, defaults native startup to pass-through `skip`, and preserves an inherited explicit session choice.
- Native Codex configuration starts in `skip`; routed launchers override it with the reviewed mode. Claude environment-file blocks are bound to the installed receipt owner and exact whole-line markers.
- Claude environment writes now require the owner on every active hook invocation. Disabled-project transitions use an integrity-tagged cleanup block, and the generic packaged hook remains inert without an owner.
- OpenCode launchers defer static cache variables to command shims so its additive environment hook can enter disabled projects safely; older fully routed parents fail closed instead of leaking cache routes.
- Runtime and integration receipts validate ownership, hashes, referents, and configuration-location bindings before update or removal.
- Directory-lock waiters now retry when the current owner releases the lock between an `EEXIST` result and validation, instead of failing with a transient `ENOENT`.
- Cargo routing now protects nested and explicit managed targets with stable ownership checks and active leases, including concurrent and cross-workspace use.
- Setup, preparation, pruning, executable probing, stale-lock handling, Windows argument forwarding, Yarn cache modes, and integration removal now fail closed on unsafe or ambiguous state.

## [0.1.0] - 2026-09-19

### Added

- Managed cache, build, and scratch roots with user, project, and environment configuration.
- Explicit `update` command for refreshing the durable runtime and configured agent integrations without changing the selected agent set.
- Per-checkout Cargo targets and shared caches for Go, Node package managers, Python package managers, .NET, Composer, ccache, and sccache.
- Zero-context agent launchers for 13 agent families and native adapters for Claude, Codex, Grok, OpenCode, and Pi.
- Active leases, workspace registry, pinning, and explicit dry-run-first pruning.
- Safe project-root preparation, mount-loss failure behavior, per-workspace mutation locks, and ownership-verified versioned uninstall receipts.
- Stable agent PATH activation with duplicate removal and npm/npx launcher fallback instead of persisting transient package-runner paths.
- Agent integration receipts bound to the exact config locations selected during setup, with fail-closed uninstall behavior.
- Explicit-only Claude and Codex management skills plus a skill-free Grok marketplace package.
- Portable, Codex, Claude-compatible, Cursor, Devin, Gemini, Grok, Kimi, Pi, OpenCode, and Hermes packaging metadata.
- Isolated tests, OSS governance, security, contribution, and release documentation.

### Fixed

- Explicit `setup --agents` selections now deactivate previously owned Claude, Codex, and Grok integrations that are no longer selected, while preserving unrelated configuration.
- Codex repo marketplace metadata now uses the current local `source` / `path` schema and is covered by the package check.
- Codex plugin UX metadata now uses an explicit-only starter prompt and cannot become a normal-session bootstrap instruction.
