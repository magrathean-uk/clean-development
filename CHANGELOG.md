# Changelog

## 0.6.8 (7 November 2026)

- Makes the Node launcher work with common user installations and PATH, records the installer-selected runtime for GUI-launched hooks, and reports missing Node clearly.
- Doctor now supports zsh and Bash startup files, skips unconfigured Claude/Codex homes, treats the guidance plugin as optional, and follows symlinks to regular settings files during read-only registry checks.
- Explicit registry entries are required unless prefixed with ?, so absent optional profiles stay visible without failing health checks.
- Blocks a new install while an earlier activation receipt still needs recovery, preventing stale rollback from undoing a later installation.
- Keeps toolchain homes, VM and Docker settings, histories, telemetry switches and host-specific PATH filtering in the private environment extension. Standalone installs preserve existing host configuration and do not install the optional Colima shim.
- Makes private sidecar installation opt-in through a validated source manifest, keeps inspection mode from executing the private extension, and preserves existing HF credential locations while routing only model caches.
- Bounds synchronous Stop hooks to five seconds, matches doctor and release fragments, uses the configured worktree root, and adds conflict-aware installer recovery with `--accept-current`.
- Narrows the legacy remover to the retired runtime directory. It no longer names or removes private plugin marketplaces, skills or app paths.
- Documents the Python 3.11 requirement for Codex TOML operations and limits tests that read parent-source scripts to explicit private-source opt-in.

## 0.6.7 (7 November 2026)

- Completes the portable public release: runtime, installer, metadata, policies, examples and current documentation share the 0.6.7 identity.
- Supports home-relative paths in optional doctor registries for additional Codex homes, Claude settings and Claude profiles. Machine-specific profile inventories remain in the private monorepo extension.
- A source-tree manifest can install allow-listed private sidecars before activating the generic environment. Sidecars are created atomically and remain host-owned if they appear during installation.
- Repairs migrated routing and doctor fixtures, and retains the private Codex/Claude profile checks through explicit registries.

## 0.6.6 (7 November 2026)

- Claude Code Stop hooks are synchronous, matching Codex. This prevents a one-shot Claude invocation from terminating an asynchronous cleanup hook while it holds the lifecycle lock. Doctor checks managed Claude and Codex hook configuration.
- Release checks require synchronous Stop settings in both fragments. Merge coverage confirms an asynchronous Claude Stop is replaced while unrelated handlers remain unchanged.
- Public defaults and documentation now use configurable example paths and workspace allowlists. Host integrations can remain in the optional `~/dev/machine/env.private.zsh`; `run --clean-env` accepts additional non-secret variable names from its state allowlist.

## 0.6.5 (7 November 2026)

- Codex Stop hooks are synchronous so one-shot commands wait for lifecycle work to finish. Doctor checks the harness-specific setting.
- Repairs installation drift in packaged guidance. Host hook and profile settings remain user-managed.

## 0.6.4 (6 November 2026)

- Lock owners record a validated host boot identifier. Lifecycle and housekeeping locks from a previous boot can be reclaimed safely; same-boot dead or unverifiable owners still require explicit recovery.
- Recovery now uses shared and per-boot guards. Doctor distinguishes recoverable reboot leftovers from active, malformed or uncertain lock state.

## 0.6.3 (6 November 2026)

- Codex trust and hook merging parse TOML using the host's semantics, preserve disabled or positional hook preferences, and verify that a trust edit changes only the intended values.
- Release preflight exercises managed hook trust changes before runtime activation. Ambiguous or unsupported configuration is refused.

## 0.6.2 (6 November 2026)

- Storage routing follows the configured external volume on every shell, with an internal fallback. A session can own paths on both roots, and cleanup waits when a root it used is unavailable.
- Session liveness includes leases, running jobs, the recorded harness process and bounded activity evidence. Unknown activity does not grant deletion authority.
- The installer publishes immutable runtime versions and journals activation for conflict-aware recovery. The Colima helper pins the configured Lima home.

## 0.6.1 (30 October 2026)

- Adds bounded path leases and verified single-file publication with a durable source hold, no-overwrite behaviour and completion receipts.
- Adds cleanup ownership checks, guarded paths, recovery receipts and safer installer rollback. See [the 0.6.1 release record](docs/release-0.6.1.md).

## 0.6.0 (20 October 2026)

- Introduces the macOS-focused 0.6 series: configurable storage routing, Claude Code and Codex lifecycle hooks, and cleanup of managed caches and Git-ignored project build/dependency directories.
- Adds schema-v2 project configuration, status and doctor commands, and dependency cache retention controls.
- Removes the earlier multi-host, Windows, SwiftPM and npm package integrations. OpenCode is environment-only in the 0.6 series.
