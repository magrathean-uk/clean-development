# Explicit installed-tool probes

```sh
# Read-only plan: no processes, temporary directories or managed-storage writes.
node bin/clean-development.js probe --tool npm --json

# Explicit execution of a fixed query in disposable storage.
node bin/clean-development.js probe --tool npm --execute --json
node bin/clean-development.js probe --tool go --execute --timeout-ms 10000
node bin/clean-development.js probe --tool uv --execute
```

`probe` complements `explain` and `doctor`; neither of those commands starts a
probe. A tool name is required and limited to npm, Go and uv. Arbitrary commands,
package installs, project scripts and compilation are not accepted. Cargo builds
remain the responsibility of the existing offline smoke/fixture harness.

## What a successful probe proves

The selected installed executable reports the same disposable cache paths that the
production adapter assigned. It does **not** demonstrate write access or free space
on your configured drive, actual compiler/cache artifacts, project-specific native
configuration, shims in a parent shell, resumed sessions, subagents or a GUI agent.
Use the existing doctor for configured-directory checks and the offline fixture
harness for real compiler/package artifacts. There are no model calls.

The report separates `configuredRouting` (a prediction for the original project)
from `observations` (paths queried in a temporary fixture). Do not interpret the
latter as your real managed storage. Missing configured storage is not created.
`testedAt` and the parsed tool version identify the observation, not an ongoing
health guarantee. The version parser currently expects three numeric components;
unrecognised responses fail instead of inventing a supported version.

## Boundaries

The plan uses the same configuration and adapter decisions as `explain`. Inherited
skip, disabled tools/projects and blocked routes do not execute. Explicit cache
overrides remain `preserved-override` and are not probed. Explicit force mode can
select the adapter, but its probe still uses disposable storage, never the original
override directory. A missing executable is `unavailable`; nothing is installed.

Execution starts only with `--execute` (or API `execute: true`). It uses a new
private temporary project and home, empty npm user/global configuration, native
offline controls and the existing environment adapter. Go fixture telemetry is disabled before the first process starts by seeding the
documented local telemetry directory with its `off` mode file. The path query
must confirm `GOTELEMETRY=off`; the real user's telemetry settings are never read
or changed. This avoids Go's ordinary asynchronous telemetry sidecar writing into
a fixture after the queried command has exited. The mode-file contract is
verified against Go 1.27.1; unrecognised native responses fail closed.

Only executable search and
essential OS variables are copied; secrets, proxies and runtime preload variables
such as `NODE_OPTIONS` are not forwarded. The native commands are:

| Tool | Path query | Version query |
| --- | --- | --- |
| npm | `config get cache` | `--version` |
| Go | `env -json GOCACHE GOMODCACHE GOTELEMETRY` | `version` |
| uv | `cache dir --offline --no-config` | `--version` |

Each query has a combined stdout/stderr cap of 64 KiB and a default timeout of
5,000 ms, configurable from 100 to 30,000 ms. This is per command; execution normally
uses two commands. The Go probe requires Go 1.23 or later. Capturing is asynchronous so an exited wrapper leaving an open
pipe does not defeat the timeout. On interruption, timeout or excess output, POSIX
process-group termination or Windows OS `taskkill /T /F` is attempted. A failed or
uncertain termination retains the fixture and reports it rather than pretending
cleanup succeeded. A temporary directory is removed only if its root identity still
matches the directory created by the probe. A replaced or undeletable root is
retained as a failure with its path for manual inspection.

On POSIX, an ordinary command closing its output pipes is not enough: descendants
can ignore those pipes and keep using the fixture. A non-signalling process-group
existence check must confirm absence before that completion permits deletion.
A remaining group or a lookup error retains the fixture; a successful native exit
then reports `cleanup-uncertain`. The native exit code and captured output remain
unchanged. An uncertain path query does not launch the version query. No late
termination signal is sent to a reaped child's potentially reused PID or group.
This check cannot account for descendants that escape the original process group;
Windows process-tree behaviour is unchanged.

These are native offline controls and best-effort process cleanup, **not** a network,
process or filesystem sandbox. A selected executable or shim must be trusted. A
hostile descendant can escape a POSIX group; Windows cleanup depends on OS process
tree visibility and permissions. A native executable can ignore offline controls.
Configuration/executable metadata reads and filesystem calls have no hard OS I/O
deadline. No environment or project source is intentionally uploaded or persisted.
Local paths in JSON may be sensitive; review before sharing.

## Output contract

JSON schema 1 includes `kind: "isolated-routing-probe"`, `tool`, `status`,
`executed`, selected `executable`, `configuredRouting`, fixed `query`, command
limits, `toolVersion`, `observations`, `cleanup`, `scope` and `limitations`.
`executed` means execution was attempted, not necessarily that process creation
succeeded. A failure adds a bounded `reason`; retained fixtures add
`retainedFixture`; cleanup errors include only an allowlisted `cleanupErrorCode`,
not the native error text. A successful Go check also records `fixtureTelemetry: "off"`. Raw child stderr, arbitrary stdout and stack traces are not
included in the report. Validated observed paths are included for comparison.

`status` is `not-tested`, `observed-working`, `preserved-override`, `skipped`,
`disabled`, `blocked`, `unavailable`, `mismatch` or `failed`. Only `observed-working`
means a matching executed query. A read-only plan or an intentionally inactive route
returns exit 0; blocked, unavailable, mismatched and failed outcomes return exit 1.
An interrupted query returns exit 130 for SIGINT or 143 for SIGTERM. Invalid CLI options fail before fixture
creation. Temporary locations inside the project, managed storage or application
state/configuration are blocked before allocation, including canonical aliases.
Existing CLI error handling applies to invalid configuration.

```js
import { planProbe, probeTool, formatProbe } from 'clean-development/api';
const plan = planProbe('npm');
const observation = await probeTool('npm', { execute: true, timeoutMs: 5000 });
console.log(formatProbe(observation));
```

API options also accept `cwd` and `env`. The environment object is not mutated.
Relevant tests: `test/probe.test.js` and `test/probe-process.test.js`.
Primary contracts: https://docs.npmjs.com/cli/v11/commands/npm-config/,
https://pkg.go.dev/cmd/go#hdr-Print_Go_environment_information,
https://docs.astral.sh/uv/reference/cli/#uv-cache-dir, and
https://nodejs.org/api/child_process.html, https://go.dev/doc/telemetry and
https://github.com/golang/go/blob/go1.27.1/src/cmd/vendor/golang.org/x/telemetry/internal/telemetry/dir.go.
