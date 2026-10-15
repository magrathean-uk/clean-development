# Read-only diagnostics

`clean-development status --json` retains the schema version 1 `integrations`
array as recorded ownership data. Its additive `integrationHealth` field reports
the current configuration snapshot separately. An invalid or unreadable receipt
appears in `integrationHealth.receipt`; it does not hide the rest of storage
status. Setup, update and uninstall still use strict receipt validation before
authorizing any edit.

`setup` and `update` refuse to replace a recorded Codex TOML block when its
ownership markers are missing. An explicit `--repair-missing` opts into repair
only when Codex is selected, exactly one valid native entry is recorded, health
observes the block itself as missing, and the existing TOML file has no
conflicting markers or recognizable unmarked runtime block. Preview eligible
repairs with `setup --repair-missing --dry-run --json` or
`update --repair-missing --dry-run --json`; the report names only the agent,
configuration path and reason. Apply repeats the absence checks against the
current file. Partial, modified, ambiguous, changed-owner, unsupported or
unmarked owned remnants remain refusals. Grok's existing migration behavior is
unchanged.

Observed entries use these states:

| State | Observation |
| --- | --- |
| `present` | The recorded Claude hook command and lifecycle matcher, or normalized Codex/Grok block and supported shape, are present. |
| `missing` | The recorded configuration, owned hook/block, or selected receipt entry is absent. |
| `modified` | The owned content, lifecycle shape, configuration path, referent or TOML assignment scope changed. |
| `ambiguous` | Multiple receipt entries, owned hooks or block markers claim the same host installation. |
| `unavailable` | A bounded read failed, the target is not a supported regular file, or it changed during inspection. |

`recorded` distinguishes receipt entries from unrecorded hosts. `selected`
reflects the current configured agent list. Unrecorded Claude, Codex and Grok
hosts are reported separately as optional; their availability is not inferred.
A launcher observation checks its real file path only. Doctor checks the runtime
inventory separately.

`clean-development doctor --json` fails when a selected integration is broken,
missing, ambiguous or unavailable, or when an existing integration receipt is
invalid or unreadable. Unselected integrations and unrecorded optional hosts do
not determine its exit status. Every check includes observed state and a reason.

Inspection follows intentionally installed leaf symlinks only while they retain
the recorded referent; parent directories must be canonical real directories.
Metadata reads have the same 1 MiB bound as ownership operations. TOML hashes
normalize LF/CRLF line endings, and hashless legacy blocks must retain the
supported shape and installation runtime-bin prefix. Claude inspection preserves
all unrelated hooks and settings. Parse errors do not echo configuration bytes.

Surrounding TOML is checked by a bounded conservative syntax validator. Common
keys, tables, strings, booleans, numbers and arrays are supported. Inline tables,
array tables, datetime values and unsupported escapes are reported as
`unavailable`, with the unsupported-shape reason. This is not a full native host
schema validator; valid TOML can still contain an option a host rejects. An
unsupported form is uncertainty, not proof that the host configuration is invalid.

Status and session previews also expose effective `toolCoverage`. SwiftPM remains
opt-in and reports native `.build` when mixed output is not explicitly relocated.
Cache-only tools retain native script output. Configuration coverage does not
establish the current parent shell's environment or observed filesystem writes.

`DEV_ENV_INSPECT_ONLY=1` permits diagnostics and dry runs while rejecting writing
CLI operations, including `run --session skip`. Generic `env` requires runtime
preparation and is blocked; `env --tool` remains a read-only prediction. The
machine's `dev-env-inspect` exports paths without creating scratch or initializing
tools. It is an inspection route, not an execution sandbox for arbitrary programs.

These commands write nothing and never repair host settings or refresh runtime
receipts. Configuration presence does not prove an already-running host uses
that configuration. Shell startup and explicit command wrappers provide
independent routes. Live lifecycle acceptance and command output placement
require their separate fixtures described in [verification](verification.md).

## Storage and lifecycle-lock health

Doctor also reports a read-only `storage-identity` check. A missing global
identity receipt is healthy for unbound legacy storage only when no existing
workspace record carries a storage identity. Bound records with a missing
receipt fail the check. An unreadable or partial workspace record collection is
reported as `uncertain`; doctor does not infer that no binding exists. Explicit
`prepare` is the recovery path after inspecting the storage and records.
The scan is bounded to 4,096 directory entries and 64 KiB per workspace record;
exceeding either limit is reported as uncertain.

The `lifecycle-locks` check reports `setup.lock` and `runtime.lock` separately.
Absent locks and valid locks held by live processes are healthy; live locks have
status `active`. A verified owner PID that has exited is `stale`; malformed,
inaccessible, changed, or otherwise unverifiable lock state is `uncertain` and
fails the check. Doctor does not reclaim stale locks.

Sibling `.removal-guard` paths are inspected without following symlinks or
changing their contents. Any present guard has status `uncertain`. When a valid
live lock is also present, the check remains healthy because the guard may be
part of normal release in progress. Without a verifiable live lock, or when the
guard is malformed, the check fails and directs inspection. Doctor never
removes a guard.
