# Changelog

## 1.0.1

- First public 1.x release. The internal 1.0.0 release added a field to the agent-home inventory that the 0.8.0 report rejected after a package rollback. This release restores the 0.8.0 line format and records restart reasons in a sidecar.
- The monorepo's `dev-parity` checks both release-local rollback modules against their package sources.

## 1.0.0

- Bundles the rollback installer and lock module in each release so the recorded command works after the source package is removed.
- Removes the rollback record when an unfinished installation is restored.
- Passes the report check option from the CLI to the report function.
- Installs without restarting running sessions, refreshing the shared Clean Development hook and skill for numbered Claude profiles while preserving their previous snapshots.
- Prints per-home restart reasons in the monorepo installer and report based on changes to the skill text loaded by each enabled home.
- Freezes the interface in `CONTRACT.md` for 1.x: removing or renaming a contract item requires 2.0.

## 0.8.0

- Fixes terminal TMPDIR preservation and validates the whole session ID as at least 12 ASCII letters, digits, underscores or hyphens. Routing and report share this rule and reject lower- or uppercase placeholder tokens delimited by hyphens, underscores or either end.
- Makes `report --check` inspect routing only, without sizing roots or inspecting Trash, receipts or project configuration.
- Adds `install.sh --record-dir DIR` and one rollback record per install, named `rollback-<id>-from-<F>-to-<V>.md`, defaulting to `~/dev/machine/runtime/clean-development/rollback/`.
- Records the command, installer, routing, schema and hook contract in `CONTRACT.md`, checked for drift by the test suite.
- Lists agent homes in `report` whose next-session plugin version differs from the active release or whose running sessions still use an older plugin, from an inventory file that an agent-home refresh outside this package writes; without the file the section is omitted.
- Validated in disposable macOS VMs with the external drive attached and absent: fresh installs, upgrades from 0.7.1 and rollback, with active versions and routing checked in terminal, Claude and Codex shells.
- Adds milestone and six-hour tidying guidance, including stopping VMs and simulators and retaining evidence.

- Removes the unused legacy removal script and its tests.
- Removes the unused project configuration template.
- Removes the obsolete release test and skill metadata.
- Removes unused installer lock setters and the retired command list: the commands removed in 0.7.0 now exit 2 as unknown commands.

## 0.7.1

- Creates missing exported cache, build and scratch folders under the selected root in terminal, Claude and Codex shells, in external and internal modes.
- Keeps inspection side-effect free and uses directory tests to avoid running `mkdir` for folders that already exist.
- Extends the environment fixtures to check fresh roots, inspection, repeated sourcing and retry after a folder could not be created.

## 0.7.0

- Keeps three things: `env.zsh` routing, the read-only `report` and `cleanup` commands, and a SessionStart hook that prints one context line.
- Adds `cleanup --apply <id> [--skip N,...] [--project DIR]`, which moves approved items to the Trash of their own volume with a `MANIFEST.txt`, refuses with exit 3 when the list changed, and never deletes.
- Removes the session, lease, lock and reap machinery: session pins and ownership, the lifecycle and housekeeping locks and their recovery, `reap`, `housekeeping`, `prune`, `sizes` and the cleanup workers, receipts and trash directories.
- Removes the commands `run`, `env`, `doctor`, `status`, `reap`, `locks`, `leases`, `reconcile`, `publish`, `vm`, `codex-trust`, `sizes`, `migrate`, `prune` and `housekeeping`; each exits 2 with `retired in 0.7.0`.
- Removes the Stop and SessionEnd hooks. The Claude and Codex fragments carry the SessionStart entry only, and `merge-hooks.py` removes stale managed Stop and SessionEnd handlers.
- Removes verified publication, renewable path leases, the Codex trust tooling and the registry files under the state directory (`codex-homes.list`, `claude-settings.list`, `claude-profiles.list`, `childenv-allow.list`).
- Drops from `env.zsh` the session pin, the `.mode` registration and the `run --clean-env` support; `storage.conf` drops keys nothing reads. In internal mode dependency caches and builds route to the internal root.
- Removes `docs/safety-release.md`, `docs/release-0.6.1.md`, `docs/hook-command-compatibility.md` and `skills/clean-development/references/0.6.1.md`, and rewrites the README, skill and policy snippet for the smaller product. The skill says when to offer a cleanup.
- Moves the installer's transaction lock helpers to `install-lock.mjs`, outside the runtime.

## 0.6.11

- Holds the lifecycle and housekeeping locks, the shared guard, this boot's outer guard and the installer locks with a kernel flock (`lockFormat: 2`). The lock file is published complete through a temp file and `link`, and the owner releases it through its own held descriptor, so a lock left by a killed owner reads as free instead of jamming later sessions.
- Supports the kernel lock only on the system volume's filesystem type (APFS). On any other state filesystem the hook logs one `unsupported` line per pass and skips lifecycle work, `install.sh --config` stops with the unsupported reason, and doctor fails with the reason and the `mount` line.
- Reclaims a lifecycle or housekeeping lock whose flock is free, under the outer guard and the shared guard, with inode, device and token checks. A live owner, whether running or stopped, is never reclaimed, and neither pid lookups nor wall-clock evidence count as proof. Legacy same-boot bodies stay on the explicit route, a legacy body from another boot keeps the reboot reclaim, and empty or unparseable lock files are refused by every recovery route and need a manual repair with every session closed.
- Makes installer locks follow the same rule: `install.sh --config` takes over a free format-2 installer lock, an unfinished installer transaction keeps `install.sh --recover <id>`, and the installer and owner release validate the complete lock body before acting on it.
- Records each lock owner's pid, token, acquisition time, boot id and boot time, lock format, harness, session and event in the lock body, so busy and recovery log lines name who held it.
- Writes a stage record under `passes/` for every lifecycle pass. A pass killed inside a stage is logged as `killed: last stage <stage> +<ms>ms`, a pass that finishes over budget is logged as an overrun naming its slowest stage, and every synchronous helper child is bounded by the pass deadline.
- Adds `clean-development locks --recover outer-guard --apply` for a stranded outer guard of this boot with a dead legacy owner or a free format-2 flock, and keeps the explicit recovery for legacy locks and guards, which are not reclaimed automatically, except that a readable legacy lock or shared guard whose body proves a reboot keeps its automatic reboot recovery, unchanged from 0.6.8.
- Adds `clean-development reconcile [--wait <s>] [--apply] [--json]`, which waits for every process of the outgoing release after a release switch, inspects the locks and guards, recovers residue under the guard proofs with `--apply`, and prints `reconciled: <version> complete` once no residue remains. Legacy locks and guards keep the explicit route, and a release switch, whether an activation or a rollback, is followed by reconciliation.
- Classifies processes in reconcile as incoming, outgoing or unknown by the installed release whose script they run, so a detached cleanup worker of the incoming release never delays a switch, and an outgoing release's orphan lister ends by its own bound.
- Shares cleanup progress under the Stop and SessionEnd budget: one inventory of session keys per pass, a share of the Stop budget reserved for reap, cursors that rotate between passes so every key and orphan snapshot is reached, and a detached lister for orphaned scratch.
- Bounds the session-start wait for a busy lifecycle lock and gives the skipped and person-facing start texts their own wording, instead of one text for every busy case.
- Reads a held lock body completely before validating it, and treats a body that is oversized, changed during the read or not valid UTF-8 as unreadable instead of parsing a prefix.
- Leaves an empty or unparseable lock file, and a legacy installer lock outside an install transaction, alone: neither the automatic reclaim nor an explicit recovery touches them, and they need a manual repair with every session closed.
- Words reconcile's advice for a lock file that only a manual repair clears as "manual repair with every session closed", without naming a tool path or a person.
- Removes the dependency cap, its Stop `caps` stage and the `caps` stamp. A `storage.conf` that still sets `DEPS_CAP_GB` or `DEPS_MIN_IDLE_HOURS` stays valid and is ignored.
- Makes child process timeouts whole milliseconds, so a fractional deadline no longer makes a Stop reap throw.
- Records the reason `lifecycle locked` on the `blocked` receipt of a Stop pass that finds the lifecycle lock busy.

## 0.6.8 (7 November 2026)

- Makes installer and runtime launchers enforce Node.js 20.12 or later, retain the installer-selected path for GUI-launched hooks, and report missing Node clearly.
- Skips unsupported Node installations during auto-detection, rejects invalid explicit `CLEAN_DEV_NODE` paths, and keeps lifecycle hook exit status successful if Node is unavailable.
- Doctor now supports zsh and Bash startup files, skips unconfigured Claude/Codex homes, treats the guidance plugin as optional, and follows symlinks to regular settings files during read-only registry checks.
- Explicit registry entries are required unless prefixed with ?, so absent optional profiles stay visible without failing health checks.
- Blocks a new install while an earlier activation receipt still needs recovery, preventing stale rollback from undoing a later installation.
- Keeps toolchain homes, VM and Docker settings, histories, telemetry switches and host-specific PATH filtering in the private environment extension. Standalone installs preserve existing host configuration and do not install the optional Colima shim.
- Makes private sidecar installation opt-in through a validated source manifest, keeps inspection mode from executing the private extension, and preserves existing HF credential locations while routing only model caches.
- Bounds synchronous Stop hooks to five seconds, matches doctor and release fragments, uses the configured worktree root, and adds conflict-aware installer recovery with `--accept-current`.
- Narrows legacy removal to the retired `runtime` subdirectory, preserves sibling configuration and receipt files, and checks every registered settings file for old references.
- Refuses Colima rehomes that would move disks referenced by any Lima instance, and requires `COLIMA_HOME` to match the configured VM home; rollback rechecks destination-home disk users before moving a disk back.
- Clarifies that new shells follow the mounted-volume state even when an earlier session pin owns paths on another root.
- Keeps host-managed Cargo toolchain caches outside automatic pruning unless `CLEAN_DEV_CARGO_CACHE_HOME` explicitly opts them in.
- Treats conflict-preserving installer recovery as complete in `doctor`, recognises copied Colima shim headers, and syntax-checks the exact manifest-listed sidecar source.
- Runs the storage write retry before taking the shared lifecycle lock, then rechecks external storage under the lock.
- Makes GUI launchd/Xcode checks opt-in with `doctor --gui`; derives `CLEAN_DEV_WORK` from a writable parent of `LAB_ROOT`, falls back to writable `EXTERNAL_ROOT`, and uses `~/dev/machine` if neither is available.
- Keeps worktrees under either the external or internal work root in doctor, and requires zsh routing in `.zshenv`.
- Shares shell-safe hook parsing across doctor and Codex trust, preserves shell-escaped apostrophes in absolute paths, requires exact installed shim path spelling, and limits absolute trust entries to the installed runtime root.
- Makes repository metadata inventory opt-in for general installs; the optional private environment extension can keep it enabled on a configured workstation.
- Retires stale internal-only ownership entries while external storage is away, and external-used/legacy entries once every root is inspectable; fresh internal sessions record their storage history.
- Uses internal `/tmp` for the documented test fixture example so it works with external-volume session routing.
- Documents the Python 3.11 requirement for Codex TOML operations and limits tests that read parent-source scripts to explicit private-source opt-in.

## 0.6.7 (7 November 2026)

- Completes the portable public release: runtime, installer, metadata, policies, examples and current documentation share the 0.6.7 identity.
- Supports home-relative paths in optional doctor registries for additional Codex homes, Claude settings and Claude profiles. Additional profile inventories can be managed through user-configured registries.
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
- Adds cleanup ownership checks, guarded paths, recovery receipts and safer installer rollback.

## 0.6.0 (20 October 2026)

- Introduces the macOS-focused 0.6 series: configurable storage routing, Claude Code and Codex lifecycle hooks, and cleanup of managed caches and Git-ignored project build/dependency directories.
- Adds schema-v2 project configuration, status and doctor commands, and dependency cache retention controls.
- Removes the earlier multi-host, Windows, SwiftPM and npm package integrations. OpenCode is environment-only in the 0.6 series.
