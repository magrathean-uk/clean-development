# Bounded lease evidence

This extends the read-only inspection rules in [inspection.md](inspection.md).
A lease is metadata used to retain an active build, not authority to read arbitrary
files or permission to delete data.

Inspection reads at most **64 KiB plus one overflow-detection byte** from each
recognised regular lease file. Reads use a file descriptor, handle short reads,
and close on success and every failure. The opened file must match the initial
stat by device, inode, size and change/modified timestamps. File metadata and path
identity are rechecked after reading. No-follow and nonblocking flags are used
where supported, so a substituted symlink or special file is not intentionally
followed or allowed to block a read.

A stale PID alone is insufficient: inspection checks the lease identity again
after the process lookup. A lease replaced while the wrapper transfers ownership
to its child therefore remains protected rather than being mistaken for an idle
build. A file already absent at initial inspection is still absent. A file that
disappears or changes after being opened is uncertain and conservatively retains
protection for that observation.

Oversized or malformed metadata, unsafe integer PIDs, changed files and I/O errors
protect the workspace named by a recognised lease filename. Only `ESRCH` with
unchanged, valid evidence drops active-use protection. No inspection reaps stale
lease files; normal wrapper completion still releases its own lease.

This is per-file bounded I/O, not a deadline for the whole registry. Filesystem
calls can stall, directory enumeration is not bounded by this change, inode/PID
reuse is possible and stat-based checks cannot eliminate every filesystem race.
Prune still applies the existing ownership, root, pin, age and live-lease checks
under its workspace lock. No migration or deletion is introduced by inspection.

## Apply-time registry boundary

An eligible preview is not authority to read or delete through its saved receipt
path. After acquiring the workspace lock, prune reopens the record through the
configured state collection and requires its derived path to equal the reviewed
`recordFile`. A workspace-registry symlink or non-directory replacement fails
closed with a validation error, even when its target contains an otherwise
matching receipt. A plan naming a receipt outside that collection is skipped.
The build and external receipt are retained; the workspace lock is released.

The freshly loaded record must still have the reviewed ownership ID and build
path. Marker verification, pins, live or uncertain leases, and the original age
checkpoint are checked before deletion. Missing or invalid receipts confer no
authority. These checks detect a registry replaced before the locked re-read;
they do not claim atomic protection against all same-user filesystem races
between validation and deletion.

Tests: `node --test test/bounded-leases.test.js test/inspection.test.js test/prune.test.js`.
