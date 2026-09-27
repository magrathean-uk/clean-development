# Executable discovery boundaries

`resolveExecutable(command, env, excludedDirectory, cwd)` is used by foreground
dispatch and command explanations. The optional fourth argument defaults to the
current process working directory; dispatch supplies the requested child cwd.

Relative PATH components are resolved against that cwd, not against the process
hosting the API. The selected PATH result is absolute so spawning with a different
cwd cannot accidentally resolve a relative component twice. The explicit command
path case uses the same cwd. Tool-specific workspace selectors, such as npm's
`--prefix`, do not change the executable lookup cwd.

Empty PATH components are still ignored. A caller that deliberately wants the
working directory searched must include `.` explicitly. The resolver does not
prepend a project directory or alter the user's environment.

## Candidate inspection

PATH discovery rejects directories, pipes, sockets and other special files before
opening them. Candidates must be regular files with executable access. File
symlinks remain supported, and the returned invocation path preserves the symlink
name: tools such as multi-call proxies may depend on their invoked basename.
Managed runtime directories, hard-linked copies of owned shims, and recognisable
generated shim prefixes remain excluded to avoid recursion.

At most 4,096 bytes of a candidate are read to recognise generated shims. The opened
handle is checked against the initial file identity/type, then rechecked together
with the pathname after reading. A replaced or changing candidate is skipped.
Unix opens use nonblocking mode so a regular file replaced by a FIFO after the
initial stat cannot block waiting for a pipe writer. No special-file handle is
read. Handles are closed on all inspection paths.

Execute-only regular files remain eligible when reading the prefix is denied;
the resolver repeats metadata and executable-access checks. Their contents cannot
be classified as a generated shim, just as before. Explicit caller-selected paths
remain explicit: they are resolved against cwd rather than searched or replaced
with another PATH candidate; normal process execution still validates them.

## Limits

This is defensive discovery, not a filesystem sandbox or a guarantee against all
same-user pathname races. Metadata calls on an unavailable network filesystem can
still block; there is no hard wall-clock timeout for arbitrary OS filesystem calls.
The selected executable can change after inspection, and a trusted tool can spawn
other programs or ignore routing variables. Inspection may read a small file prefix
but never executes the candidate or mutates files.

## Regression checks

```sh
node --test test/executable.test.js
npm run check
npm test
```

The tests cover a directory shadowing a real tool, a FIFO that previously hung
inspection, a regular-file-to-FIFO replacement, regular-file replacement after
open, bounded reads/descriptor closure, execute-only compatibility, symlink and
hard-link behaviour, relative PATH/cwd lookup, and prediction/execution agreement.
Unix-only FIFO cases run in disposable child processes with a fail-safe timeout;
portable cases also run in the native Windows gate.
