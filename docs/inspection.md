# Storage inspection guarantees

The machine's explicit `dev-env-inspect -- COMMAND` route exports selected paths
without making scratch directories or initializing tools. It preserves an active
session's missing or unwritable destination as visible inspection state. Normal
writing sessions remain strict. With `DEV_ENV_INSPECT_ONLY=1`, the CLI rejects
writing operations before preparation or child launch; supported diagnostics and
dry runs remain available. The marker is not a sandbox for arbitrary commands.
See [diagnostics](diagnostics.md) for the exact CLI boundary.

## Read-only lease inspection

Status and prune previews never remove stale lease files. A lease naming a dead
process is ignored for active-use reporting but retained on disk; normal live
leases are still removed by their owning wrapper on release. Inspection is not
lease garbage collection, and cannot erase a lease while a wrapper transfers it
to its child. This does not eliminate PID reuse or all process-lifecycle races.

Only an `ESRCH` process lookup establishes absence. Permission failures, unexpected
lookup failures, and matching unreadable or non-regular lease files conservatively
protect the named workspace. Unknown filenames remain ignored and untouched.
Ownership checks that fail during a filesystem race or I/O error report `missing`
or `unreadable`; neither is eligible for deletion. Apply still rechecks ownership,
age, pins and leases under the workspace lock.
