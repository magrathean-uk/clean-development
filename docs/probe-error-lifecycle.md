# Probe process errors and cleanup evidence

A ChildProcess `error` event is not limited to a failed launch. Node also emits
it when a process cannot be killed. Treating every such event as a failed spawn
can incorrectly report that no cleanup is needed after a child has started.

The bounded probe capture now distinguishes these cases:

| Situation | Failure classification | Cleanup handling |
| --- | --- | --- |
| Launch fails before a PID exists | `spawn-failed` | No child termination needed. |
| Error after a PID was allocated | `process-failed` | Attempt bounded termination and wait for its result. |
| Error while timeout/output-limit/interrupt cleanup is already running | Original initiating reason | Continue the same termination attempt. |
| Termination is not established | Failure retained | `cleanupComplete: false`; the public probe retains its disposable fixture. |

The in-flight termination guard is set before invoking termination. Re-entrant
or repeated error events cannot start multiple termination attempts, overwrite
the initiating reason, or prematurely report cleanup complete. Error events
arriving after capture has settled are consumed without changing its result.
Timers, output streams and global signal listeners retain their existing bounded
lifecycle. This does not change ordinary command execution or foreground leases.

## Retained fixtures

The public probe already treats uncertain cleanup as
`cleanup: "retained-process-uncertain"` and returns the `retainedFixture` path.
Do not automatically remove that path merely because the capture promise ended.
Check for remaining processes before deciding to remove a retained fixture.
The fixture uses an isolated environment, but process groups and Windows taskkill
are still best-effort cleanup, not containment of an untrusted executable.

## Verification

Run `node --test test/probe-error-lifecycle.test.js`. Eight deterministic tests
simulate launch errors, post-launch errors, termination failures, repeated errors,
timeout/output-limit races and ordinary completion. They verify listener cleanup
and the public probe's retention behaviour without signalling real PIDs. The
same suite is required by the Windows contract workflow; its simulated failures
are not a claim that the operating system actually returned EPERM in that run.
Existing real-tool and real-process tests remain enabled and complementary.

There is no dependency, version bump, configuration migration, release or change
to managed-storage ownership. Revert the source, test and workflow changes to
roll back. This fix does not resolve or suppress separate shell-construction
security findings.

Contract: https://nodejs.org/api/child_process.html#event-error
