# Linux strict-mode evidence — 27 September 2026

## Revision and execution boundary

Base: `af12577c6596095fdf91f18e840e9433521ea3d2`, current main when inspected.
Read `AGENTS.md`, architecture and the safety model first; reviewed open PRs
#24–#43. Their normal routing, session, storage, process and integration changes
are not incorporated. This experiment adds a separate CLI path.

The provided archive's full reconstructed Git tree matched upstream
`998605cda006d588e9562cabe1eee6c78c2f3a59`. Direct Git networking was unavailable.
The local archive-baseline commit is synthetic bookkeeping, not upstream history;
publication uses the real main SHA as parent and verifies exact complete-tree
parity. See the draft PR for its published commit/tree. The live fixture records
SHA-256 fingerprints of its actual source files and the installed utility binaries.

Actual execution: Debian GNU/Linux 13.3, Linux `6.18.44`, x86-64, ordinary UID 1000.
This is rootless namespace execution, not a mock, host-root chmod test, CLI-loader
observation or claim of live agent-host acceptance.

| Component | Observed version |
| --- | --- |
| Node | v22.16.0 |
| npm | 10.9.2 |
| unshare / setpriv | util-linux 2.41 |
| Tini | 0.19.0 |
| gcc | Debian 14.2.0-19, GCC 14.2.0 |
| Go | go1.23.2 linux/amd64 |

Bubblewrap is not installed. No package was installed and no host kernel/security
policy was weakened. The backend uses the independently installed namespace,
mount, privilege and init utilities documented in [the contract](strict-mode.md).
An initial design probe attempting fresh procfs failed with `Mount too revealing`
before any workload. The committed policy always exposes **no procfs**; it never
falls back to host procfs. Actual mount and capability failures remain fatal.

## Commands and results

```sh
CLEAN_DEVELOPMENT_STRICT_TEST=1 \
  node --test test/strict.test.js test/strict-linux.test.js
# As a separate root-only refusal check, not a root sandbox acceptance:
node --test --test-name-pattern='root execution is refused' test/strict.test.js
node scripts/build-marketplace.mjs
npm run check
npm test
npm run test:package
```

| Check | Actual result |
| --- | --- |
| Focused policy + live suite as ordinary user | 40 tests: **39 passed, 1 root-only refusal skip, 0 failures** |
| Live namespace acceptance within that suite | **14 executed cases**, all passed; parent aggregation is not another case |
| Separate root-refusal check | **1 passed**; command refused without creating run storage |
| Bash and JavaScript syntax | Passed |
| Required generated Claude mirrors | Built, 43 bundle files; parity passed |
| `npm run check` | **Passed**: 37 JavaScript files, 14 synchronised version files, bundle and bug-report prompt |
| `npm test` as ordinary user | **413 total: 384 passed, 29 skipped, 0 failures** |
| Offline tarball extraction / strict C build | **Passed**: required helper included, compiled binary printed `packed-strict-ok` |
| `npm run test:package` | **Blocked / exit 1**: required genuine `v0.2.0` tag absent from the archive checkout |
| Scoped whitespace / relative-link checks | Passed |

The 29 ordinary-suite skips are 26 native-Windows tests, one unavailable real-Cargo
test, the separately opted-in strict acceptance entry and the root-only refusal
entry. They are not counted as passes. Native Windows/macOS strict execution is
explicitly unsupported. Other Linux distributions, kernels and Node versions
were not executed. No preceding-release tag was fabricated and no check was
weakened; genuine upgrade verification remains a draft blocker. Separately,
`npm pack --ignore-scripts --json` in a disposable offline npm home produced a
tarball containing the strict JavaScript and shell helper. Extracting that tarball
and invoking its CLI completed a real isolated C build. This packaging smoke does
not replace the blocked preceding-release upgrade gate.

## Real builds and final-output boundary

In a disposable source tree the command executes these operations inside the
actual namespace, with a fresh per-run HOME/cache/scratch:

```sh
gcc main.c -o "$CLEAN_DEVELOPMENT_STRICT_WORK/intermediate"
"$CLEAN_DEVELOPMENT_STRICT_WORK/intermediate"
gcc main.c -o "$1/c-release"
"$1/c-release"
go telemetry off
go build -o "$1/go-release" main.go
"$1/go-release"
```

`$1` is the explicitly declared empty artifact directory. The fixture pins Go's
local installed toolchain and disables module downloads through its explicit
policy. Actual stdout was:

```text
strict-c-ok
strict-c-ok
strict-go-ok
```

Exit: **0**. Managed C output and both final binaries were non-empty and executable;
the real Go compilation cache was populated below the private work directory.
The C binaries were 15,952 bytes; the Go binary was 2,128,941 bytes. Exact artifact
paths and SHA-256 hashes are in the retained JSON, not inferred from command exit.
Source names, file types, modes, bytes and synthetic Git metadata were unchanged.
There was no project-local `target`.

Go's first telemetry-control invocation still printed its existing sidecar
`/proc/self/exe` discovery warning on stderr. It is retained unfiltered in the
report; the successful build is not described as stderr-identical to an ordinary
host build. No procfs or host-network access was granted to avoid the warning.
Cargo/rustc are absent here, so absence of a local target does **not** constitute
real Rust build acceptance. The real compiler evidence is C and Go.

An explicit `gcc ... -o ./release` fails with read-only-filesystem diagnostics,
without source changes or a substituted destination. A second invocation using
the non-empty release directory is refused before a workload runs. There is no
implicit copying, moving, deleting or registration of the final files.

## Deliberate boundary attempts

The direct Python payload and its new-session (`setsid`) child execute the same
attacks. The 44 recorded denials include two closed-control-descriptor checks per
process; they are **not** 44 independent filesystem exploit classes.

| Attempt | Observed kernel result |
| --- | --- |
| Write/create/chmod/unlink source, change synthetic Git settings, overwrite system tool, write through a managed symlink back to source | `EROFS` (30) |
| Read/write synthetic credentials, write undeclared sibling, traverse a source symlink to hidden credentials, use `/etc`, `/proc/1/root` or `/sys` | `ENOENT` (2) |
| Rename/hardlink source into a writable grant | `EXDEV` (18) |
| Bind-remount source writable or chroot again | `EPERM` (1) |
| Connect to a live host-loopback listener | `ENETUNREACH` (101) |
| Reuse environment/readiness descriptors 3 and 4 | `EBADF` (9) |

Positive controls write into managed storage and compile into final-output grants.
The fixture also checks effective/permitted/inheritable capability masks are zero
and `PR_GET_NO_NEW_PRIVS` is 1. Independent host snapshots confirm that source,
credential and undeclared sentinel files retain their bytes and modes.

A separate test adds a **real seccomp denial of the unshare syscall to its own
subprocess**. It observes `unshare failed: Operation not permitted`, a nonzero exit,
and no workload artifact. This only tightens that disposable process's permissions;
it does not modify a global policy. Missing-utility rejection is additionally
covered by an explicitly mocked unit case, not mislabelled as a live host failure.

## Process evidence and limits

The original argv includes empty strings, Unicode, whitespace, shell metacharacters,
a newline, flag-shaped arguments and `--`. Python receives identical values and
cwd. Binary stdin/stdout (including NUL/non-UTF-8 bytes) round-trip exactly, with
stderr independently checked and exit 37 preserved. An executable named `odd=tool`
proves that command words are not accidentally consumed as environment assignments.
Environment values use a separate closed-before-exec descriptor, not argv.

INT, TERM, HUP, QUIT, USR1 and USR2 reach installed workload handlers, preserving
their selected exits 37–42. An uncaught child TERM produces status 143. Killing the
outer Node wrapper with KILL closes the namespace while a detached, stdio-independent
nested writer is running; its retained heartbeat stops across the bounded 200 ms
post-exit observation. This is the recorded lifecycle evidence, not a proof of
every signal timing or resource-exhaustion interleaving. The contract separately
states pre-handoff cancellation and non-interactive/job-control limitations.

All source, configuration, credentials, storage and output fixtures are newly
created disposable trees. No contributor's real agent settings or build storage
were read as test inputs or modified. The fixtures and evidence are retained; no
automatic installation, cleanup, uninstall or prune path was added.
