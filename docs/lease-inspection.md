# Read-only lease inspection

`status`, `doctor`, and a prune preview do not repair or remove state files. Lease inspection retains stale files as well as live and unrecognised files. Normal child completion still removes its own lease; abandoned leases are not automatically swept by an inspection command.

A recognised lease filename binds evidence to a workspace. Its observed state is:

- `active`: the recorded process responded to signal 0. No termination signal is sent.
- `stale`: the operating system specifically returned `ESRCH` (process absent).
- `unknown`: metadata could not be validated or the process could not be checked. Permission errors, invalid PIDs, corrupt or oversized JSON, non-regular files and substituted paths all conservatively protect the workspace.

Only stale leases are excluded from active-use protection. A corrupt matching filename is not discarded merely because it cannot be parsed. Unrecognised filenames do not claim a workspace and remain untouched. Collection directory symlinks continue to fail closed.

Reads are limited to 64 KiB per recognised lease. File type and opened-file identity are checked, with no-follow and nonblocking flags where available. These checks do not make the application a filesystem sandbox or eliminate all races on a hostile filesystem. Process IDs can be recycled; a live reused PID conservatively retains data rather than authorising deletion.

Pruning still requires its existing ownership, configured-root, age, pin and live-lease checks under the workspace lock immediately before removal. This change introduces no cleanup command, automatic deletion, state migration, new dependencies or release version.

Regression tests: `node --test test/lease-inspection.test.js test/prune.test.js`.
