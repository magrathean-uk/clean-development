# Bounded untrusted-input fuzzing

This is a deterministic, structure-aware mutation campaign against the real CLI,
not a coverage-guided fuzzer or a security certification. Every case receives a
new disposable home, project, configuration, runtime/state and managed-storage
root. No contributor credentials, agent settings or build storage are copied.

## Repeat the campaign

From a checkout with Node 20.12 or newer:

```sh
node scripts/fuzz-boundaries.mjs --seed 0x434c454e --cases 512 \
  --timeout-ms 2500 --budget-ms 180000 --reduce 32 \
  --report /tmp/clean-development-fuzz-434c454e.json

node --test test/fuzz-boundaries.test.js test/metadata-read.test.js test/bounded-leases.test.js
npm run check
npm test
```

The report must be a **new file** in an existing directory. Repeat with seeds
`0x5eed2026` and `0xc0ffee`, using a different report path each time. The retained
[seed manifest](../scripts/fuzz/seeds.json) records the measured campaign's
parameters. `--cases` counts generated inputs, in addition to the eight permanent
regression cases. There are no npm dependencies, downloads, compiler invocations
or model calls in the campaign.

A smaller default run uses 128 generated cases. Exit 0 means every requested case
finished without an observed violation or capability skip. Exit 1 means a
violation, incomplete campaign or skipped capability; exit 2 is a driver/setup
error. A missing POSIX FIFO facility is recorded as a skip, not a pass. Do not
interpret an incomplete report's zero failure count as a clean campaign.

Replay the retained reductions with the same command, replacing `--seed` and
`--cases` with one of:

```sh
--replay scripts/fuzz/repro-json-content.json
--replay scripts/fuzz/repro-config-fifo.json
--replay scripts/fuzz/repro-nonfinite.json
```

The full report also contains every concrete case descriptor, its seed/index,
stdout/stderr fingerprints and runtime/harness file hashes. A failing case is
retained under its reported `retained` path, with
`telemetry/replay.json` and `telemetry/events.jsonl`. Replaying creates a **new**
fixture; it never reuses an earlier damaged home. Successful cases and reduction
attempts are removed only after checking the canonical fixture root and its
original device/inode identity. Failure/infrastructure fixtures remain available
for inspection. This cleanup is harness-owned fixture removal, not product prune.

## Generated boundaries and contracts

Cases rotate through the following eight families. PRNG choices alter strings,
field mutations and malformed forms; some cases intentionally repeat. Counts are
executions, not a claim of unique inputs or branch coverage. Labels describe the
intended generation class, not whether a particular tool accepts the value.

| Family | Generated input / exercised command | Independent requirement |
| --- | --- | --- |
| CLI arguments | Unknown/duplicate flags, separators, integer boundaries, Unicode, metacharacters, command/agent names; read-only commands and help short-circuits | No mutation or child execution; only ordinary 0/1 exits |
| Environment | Root/subroot selections, session mode, JSON provenance, wrong shapes and case-preserving values | Planning remains read-only and process-free |
| Project configuration | Valid objects with wrong schema/types/paths, malformed bytes, raw NUL, directories, regular-file secret symlinks, FIFO and oversize files | No source writes; no input snippet disclosure or blocking read |
| Manifests | Node package-manager declarations and scripts, Cargo tables, Python build-backend metadata, wrong types/truncation/FIFO | Detection must not execute package scripts/backends or modify source |
| State files | Seed a paired workspace record/marker; mutate a required field, timestamp or pin, or replace with malformed data | `prune --apply` must retain the deliberately ineligible build and records |
| Ownership markers | Alter only one side of paired ownership evidence, or substitute malformed/special-file input | The unproven target and protected siblings must survive |
| Installation receipts | Run trusted fixture setup first, then mutate runtime/integration receipt fields, schema, path, arrays or file type | Uninstall planning is read-only, bounded and does not disclose bytes |
| Native configuration | Claude JSON and Codex/Grok TOML, including valid near-misses, unknown user content, numeric overflow, broken syntax and FIFO | Explicit setup may write only its declared paths; existing user fields must remain; no hook/config command executes |

HOME, XDG locations, product homes, agent homes, temporary directories and PATH
are allowlisted fixture values. PATH contains only canary tools. Small ancestor
configuration/Cargo/Node manifest barriers keep the exercised ancestor discovery
inside the lab. Synthetic source, Git metadata, credentials, final deliverables
and unregistered files are protected by before/after snapshots. Inputs never
contain a real secret. NUL is generated in files, but escaped in environment
strings because operating-system argv/environment transport cannot carry it.

The read-only policy allows **no** filesystem mutation. For explicit setup,
allowed locations are the fixture `data`, `config`, `managed` trees and the exact
selected native configuration filenames/temporary siblings under the disposable
agent homes. Setup can legitimately publish runtime/configuration before failing
on a bad native file; that is not misclassified as an unexpected write. Existing
native JSON settings must remain a structural subset, including ordered array
entries with multiplicity. TOML's original nonempty lines must survive in order;
that is a retention check, **not a TOML scope/semantic parser**. Error exits may
not rewrite the selected native file.

Snapshots compare names, types, modes, link targets, lengths and SHA-256 bytes;
they include empty directories and never traverse a fixture symlink. They can
detect end-state changes but cannot alone detect a write followed by restoration.
For that reason a test-only ESM preload records selected Node filesystem mutation
APIs and rejects forbidden attempts before they reach disk. It also records and
rejects child-process APIs. It requires a loader-ready event, uses
`uncaughtExceptionMonitor` without suppressing the exception, and scans actual
stdout/stderr for a synthetic secret. A fixture observer is not shipped in the
runtime or agent hooks. Normal product commands are not recorded.

Negative controls deliberately attempt deletion, synchronous/stream/promise
writes, child execution, an uncaught exception, secret output and an endless
process. They must trigger the matching oracle. Trusted setup controls must really
write their allowed runtime/configuration files, so a guard that blocks everything
cannot produce a passing campaign. The permanent defect reproductions also run
against the CLI **without** the observer. Arbitrary generated cases are not run
without the guard.

## Bounds and reduction

The default child timeout is 2,500 ms, with SIGKILL on expiry; each capture is
limited to 128 KiB and each child receives a 128 MiB V8 old-space limit. Cases are
serial. Trusted setup and FIFO creation have their own same-sized subprocess
limits. The driver stops scheduling when its campaign budget cannot accommodate
another case; the budget is cooperative between operations, not a hard timeout
on the parent process's synchronous filesystem calls.

There are hard input limits of 2,048 generated cases, 32 argv elements, 8,192
characters per argument and 65,536 characters per descriptor. Inventories are
bounded to 2,048 entries, 4 MiB per file and 32 MiB per case; capture/event/report
bounds fail visibly instead of claiming completeness. Events stop at 4,096;
reports are capped at 16 MiB. These are observation limits, **not an OS disk quota
or a total process-memory cap**. A stalled filesystem operation in the harness
itself can still require external termination.

Reduction removes argv elements and payload chunks while requiring the **same
failing property**, rather than accepting any nonzero exit. It is bounded by
attempt count and remaining campaign budget. The recorded reductions are local
results of that strategy, not proofs of globally minimal input. FIFO cases have
no payload; their redundant command flags can still be reduced.

## Confirmed defects and focused fixes

**Metadata stream hang.** On the original runtime, ordinary read-only `status`,
`session --dry-run` and `explain` calls could wait indefinitely on metadata replaced
by a FIFO with no writer. Explicit native setup could do the same on agent
configuration. The permanent cases cover project JSON, package JSON, Cargo TOML,
Codex TOML and Grok TOML; generated cases cover additional receipt/native reads.
No compiler or actual agent host is needed to reproduce these CLI read paths.

`src/io.js` now supplies `readTextMetadata`: reject known non-regular or oversized
files before open; use read-only/nonblocking open where available; validate the
opened descriptor; and read no more than 1 MiB plus one detection byte. The helper
closes descriptors on success and failure. Shared JSON readers, the two static
manifest readers, and native TOML/Claude environment-text reads use it. Tests
cover exact byte limits, short reads, growth, descriptor substitution and a real
POSIX regular-file-to-FIFO replacement at the open boundary in a bounded child.

This deliberately imposes a **1,048,576-byte metadata limit**. Oversized selected
configuration/receipts now error or remain untrusted according to their caller's
existing policy; they are not truncated or silently repaired. Static manifest
hints retain their pre-existing best-effort fallback on unreadable input. Supported
symlinks to regular configuration files remain readable; this helper does not
replace the stronger ownership/path checks of individual callers.

**JSON diagnostic disclosure.** Node 22's JSON parser could quote malformed file
contents in its exception message. `readJson` forwarded that message through the
CLI. The synthetic canary was observed in errors for project configuration,
Claude settings, runtime receipts and integration receipts. The reduced case is
just `status` plus a malformed project JSON file. Syntax failures now report the
path and `Invalid JSON`, with no quoted data or retained parser-error cause.
Filesystem error attribution remains available. This is not blanket redaction of
all CLI arguments, filenames or successfully requested configuration output.

**Non-finite-number corruption.** Structurally valid `{"x":1e999}` is parsed as an
infinite JavaScript number. Claude setup then serialised the unrelated value as
`null` while returning success. The native preservation oracle found this beyond
the initial 128-case run, and an uninstrumented CLI run reproduced the exact
before/after bytes. `readJson` now rejects non-finite numeric values with a
content-free error before callers can rewrite them. The iterative validation walk
also handles a tested 20,000-level array without a recursive reviver. Ordinary
finite-number rounding and arbitrary-precision JSON are **not** solved here.

Only three hand-edited production modules change: `src/io.js`,
`src/workspace.js` and `src/integrations.js`. Their three generated Claude copies
are kept byte-identical as required by the existing checker. Lock primitives,
pruning, runtime ownership/schema rules, routing, session consent, dependencies,
legal files and CI workflows are unchanged. No migration or automatic deletion
is introduced; rollback is a code revert.

## Recorded run and limitations

The companion [evidence summary](fuzzing-evidence.json) records the exact base,
platform, seeds, counts, reductions and full-report hashes. Full reports are
created by the commands above and were supplied with this change's validation
artifacts. The branch is based on main
`af12577c6596095fdf91f18e840e9433521ea3d2`; the supplied archive's complete Git tree
was verified as `998605cda006d588e9562cabe1eee6c78c2f3a59`. Local archive-import Git
history is synthetic; publication is parented to the real upstream main commit.

Read AGENTS, architecture and the safety model first and inspected open PRs
#24–#43. This does not incorporate their fixes. In particular, #34's lock work,
#35's workspace-identity work and #33's TOML block-removal work share filenames
but not the changed algorithms here.

The initial CJS preload caused Node to read malformed cwd package metadata before
the observer loaded. Those apparent crashes were harness interference, not product
findings; the final ESM file-URL preload and its negative control avoid that path.
An intermediate generator also selected an untransportable NUL environment value;
that was an explicit harness error, never a product failure or pass. The final
generator excludes it and tests that transport constraint. An existing lease test
mocked all `readSync` calls; it was narrowed to forbid opening the oversized lease
itself, allowing legitimate bounded workspace reads without weakening retention.

This is Linux/Node CLI evidence. Native Windows/macOS, real agent lifecycle hooks,
real compilers, package-install/upgrade compatibility, hostile filesystems,
mounts/devices, concurrent lifecycle/lock races and comprehensive operation
sequences are outside this campaign. Receipt fuzzing uses uninstall **planning**;
prune fuzzing uses intentionally ineligible paired evidence. The known parallel
PR race scenarios are not certified by a clean input corpus. Python manifests are
tested as detection inputs; their backend language is not interpreted.

The preload is a safety guard and observation aid, **not OS containment**. It
cannot prove coverage of native addons, escaped descendants, every filesystem
API, network exfiltration or transient changes outside its intercepted calls.
The secret oracle checks one synthetic stdout/stderr canary, not all possible
encodings or destinations. SHA-256 snapshots do not prove durable fsync behaviour.
No input coverage metric, token-neutrality result or universal security guarantee
is claimed. Use a disposable machine/container, not a privileged contributor
session, for extended campaigns.
