# Read-only diagnostics

`clean-development status --json` retains the schema version 1 `integrations`
array as recorded ownership data. Its additive `integrationHealth` field reports
the current configuration snapshot separately. An invalid or unreadable receipt
appears in `integrationHealth.receipt`; it does not hide the rest of storage
status. Setup, update and uninstall still use strict receipt validation before
authorizing any edit.

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
