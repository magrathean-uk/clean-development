# Foreground child lifecycle

Ordinary `run`, tool-shim and agent invocations use one foreground child with
inherited stdio, cwd and environment. Native executable arguments are passed as
an array; Windows batch wrappers use the separate tested quoting adapter.

## Completion and signals

A failed spawn can emit `error` and `close` without `exit`. The runner handles
both termination paths, settles once and removes only its own SIGINT/SIGTERM
listeners. Repeated failed launches do not accumulate process-wide handlers or
leave signal forwarding active after the command has ended. Unrelated handlers
remain installed. Concurrent launches each retain their own handlers; repeated
SIGINT and SIGTERM events forward the original signal to each active direct child.

A signal-delivery error is not proof of process termination. The runner waits for
exit/close instead of prematurely allowing its caller to release build leases.
The first asynchronous child error is retained until termination. Normal numeric
exit codes and conventional `128 + signal number` results are preserved.

## Ownership callback failure

The internal synchronous `onSpawn` callback runs immediately for a positive child
PID, before command dispatch releases its workspace locks. It is not called for
a failed launch without a PID. Cargo uses this boundary to transfer active leases
to the actual child PID.

If that callback throws (for example, a lease write fails), the runner requests
SIGTERM and escalates to SIGKILL after 250 ms if it has not observed termination.
It rejects with the original callback error **after** the child exits/closes,
not immediately after requesting a kill. This keeps caller cleanup from releasing
ownership while the failed launch is still running. The escalation timer is
cleared on completion. Ordinary successful launches have no execution timeout.

This is not a hard deadline: signalling can fail, a child can be stuck in a kernel
operation, and the runner deliberately keeps waiting rather than falsely reporting
that the child stopped. Signals address only the direct child. Detached descendants
and arbitrary tool-created process trees need their own lifecycle control; this
runner is not a process sandbox or the separate bounded diagnostic-probe runner.

## Reproduce

```sh
node --test test/process-runner.test.js
npm run check
npm test
```

Tests exercise repeated ENOENT failures, invalid cwd/arguments, Unix permission
failures, callback failure and escalation, error/close ordering, unrelated listener
preservation, concurrent/repeated signal forwarding and an actual POSIX SIGINT
round trip. Windows executes the portable contracts; native batch argv and probe
process-tree contracts remain separate tests.

Reference contract: Node.js `child_process`, especially the `error`, `exit` and
`close` event distinctions: https://nodejs.org/api/child_process.html
