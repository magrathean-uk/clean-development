# Codex child and lifecycle verification

The tests in `test/codex-acceptance.test.js` exercise real subprocesses, source CLI
setup, native policy configuration, explicit launch modes, shims, artifact writes,
argv/cwd and child exit status in disposable homes. Their Codex host is deliberately
synthetic. Startup, resume, fork, subagent and cwd events remain labelled
`fixture-only` and `synthetic-*`; they never start an installed Codex or a model.

The fixture transports source-generated native config and launcher overrides to
actual child shells. It covers native pass-through before setup, inherited native
skip after setup, session-only, explicit skip from a routed parent, disabled
projects, changed cwd, login/non-login shells, and synthetic delegated subprocesses.
The controlled fake npm writes a nonce artifact. Failed child status, incomplete
footprint, wrong backend/nonce, missing output and absent host linkage fail the
evidence verifier. Synthetic resume/fork do not establish actual session continuity.

```sh
clean-development run --session session-only -- \
  node --test test/codex-acceptance.test.js test/host-boundaries.test.js
```

## Installed-host preflight

Use [host boundary verification](host-installation-footprints.md) to run only
`--version` and `--help` against a selected installed executable in disposable
native homes. Record its exact version, source fingerprint and observation
completeness. Preflight inspects neither credentials nor authentication and performs
no model call. Help capability flags describe observed text; they do not attest a
working resume/fork/subagent contract.

An isolated metadata check on 14 October 2026 observed Codex
`0.162.0-alpha.17.2` and Claude `2.1.299`, with complete unchanged selected-root
footprints. The corresponding reports retain their exact dirty source fingerprint
and command boundary. That observation establishes version/help only. No actual
Codex lifecycle, Claude restart or model-driven tool call was run for it.

## Explicit real-child preparation

`test/codex-acceptance/run.mjs` has preparation, setup and verification phases;
it has no host-launch phase. Ordinary `npm test` cannot start a paid host call.
For actual-host acceptance, use a disposable account/VM or a fresh profile whose
credential/session lifecycle is isolated. The harness copies no existing profile
or credential. Authenticate that profile through its owning host explicitly.

Select the installed npm executable belonging to the intended Node toolchain:

```sh
clean-development run --session session-only -- \
  node test/codex-acceptance/run.mjs prepare \
  --scratch-root "$CLEAN_DEVELOPMENT_SCRATCH_ROOT" \
  --npm /absolute/installed/node/bin/npm
```

Copy the returned exact lab root to `LAB`. Preparation returns a shell environment
file and a predefined observer command. It creates only the disposable profile,
tiny dependency-free projects, output/evidence directories and environment file.
Its configuration, source revision/fingerprint and fixture digests are recorded.
The loader rejects changed native homes, unknown environment fields and path aliases.

```sh
clean-development run --session session-only -- \
  node test/codex-acceptance/run.mjs setup --lab "$LAB"
```

Setup installs source-owned routing only into that lab's Codex configuration. It
preserves the lab's unrelated setting. Existing contributor settings and running
sessions are never changed.

In a separate fresh shell, start from an empty environment and source the returned
lab environment file. Use an explicitly selected native/skip/session-only launcher
for the isolated Codex profile. Consult that exact installed CLI's help for its
cwd, resume and fork forms. After a real host tool call executes the printed
observer command with a unique `CASE_NAME`, exit the isolated host and inspect the
evidence. Do not invoke the observer directly and relabel that as host acceptance.

The live observer runs predefined real npm commands: offline, script-disabled
packing into declared outputs, then offline cache insertion through the inherited
executable route. It verifies actual npm-selected cache metadata, a nonempty
package artifact, child status and matching nonce. It supports both npm's array
and keyed `pack --json` report formats. It neither fabricates the package/cache
artifact nor downloads a dependency. A direct real-tool fixture remains separately
labelled from an actual host execution.

## Lifecycle evidence

Exercise each case in a fresh isolated profile, except when actual continuity is
the subject. Record the real session, tool-call and lifecycle identifiers alongside
the observer nonce and exact host version.

| Case | Required actual host operation |
| --- | --- |
| Startup | New session; execute the predefined child tool call |
| Native skip | Fresh startup after setup; prove native pass-through |
| Session-only / skip | Explicit mode; actual npm artifact and selected cache |
| Disabled | Start in disabled project; preserve its configuration |
| Cwd change | Change cwd in the ongoing host, then a separate observer tool call |
| Resume | Resume the recorded session; correlate its original session identity |
| Fork | Fork the recorded parent; distinct child and retained parent identity |
| Subagent | Actual delegation; subagent identity and its own tool-call trace |
| Login shell | Observe actual host shell policy and child route; fixture login flags alone do not prove it |

Repeat resume/fork/delegation in explicit skip and disabled modes. Mark unsupported
events unsupported for that exact version, and unattempted operations not-run.
Do not substitute a new process or parent tool call for actual host continuity or
subagent execution.

```sh
clean-development run --session session-only -- \
  node test/codex-acceptance/run.mjs verify --lab "$LAB" \
  --case CASE_NAME --disposition routed --project normal \
  --event startup --host-version EXACT_VERSION \
  --session-id ACTUAL_SESSION_ID --tool-call-id ACTUAL_TOOL_CALL_ID \
  --nonce OBSERVED_NONCE
```

Use `--disposition native` for pass-through; supply `--parent-session-id` for
resume/fork and `--subagent-id` for delegation. These identifiers are caller-supplied
correlation data, not independently attested host traces. A successful verification
is therefore `live-candidate` with `liveAcceptance: unverified`; a reviewer must
correlate it with the actual host operation. Prepared source drift refuses live
verification. Authentication, host permission limits and absent event evidence
remain explicit acceptance limits.

Both external fixture controllers and live observers measure the full disposable
native home. The live observer uses a separate metadata-only Node process with
its own unused disposable HOME; its explicitly validated target is the lab's
native home. This preserves the scanner's real-home rejection. It also records
the named `.npm`, `.cache` and `Library/Caches` cache rows, managed storage and
outputs. Routed evidence requires a complete unchanged full-home observation;
an additional home entry outside the cache subdirectories fails it. Live source
verification compares product fingerprints and the complete fixture digest map.
Reports record aggregate metadata and completeness, not credentials, arbitrary
commands or file contents. Preserve the lab/evidence while verification or child
lifetime is uncertain; this protocol performs no automatic cleanup.
