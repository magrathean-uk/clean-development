# Storage inspection guarantees

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
