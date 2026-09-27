# Differential real-tool conformance lab

This lab compares a native invocation with the same command passed through
`clean-development run --session session-only --`. It is an executable contract
check, not a benchmark or a claim that every command supported by a tool is
transparent. It imports no product routing or workspace logic as its oracle.

## Run

Use a checkout with Node 20.12+ and independently installed Cargo/rustc, Go, npm,
uv and Python 3 on PATH. This version of the lab supports POSIX (Linux/macOS),
not native Windows. It never installs a toolchain or downloads dependencies.

```sh
node --test test/conformance-lab.test.js
node scripts/conformance-lab.mjs --seed 24301 --count 8 --output /tmp/conformance-24301.json
node scripts/conformance-lab.mjs --seed 3735928559 --count 8 --output /tmp/conformance-deadbeef.json
```

The output path must be new and its parent must exist. CLI runs retain their
new private temporary roots, raw captures and `report.json`, including failed
runs. Successful Node test fixtures are removed; failed fixtures are retained
and their locations printed. No contributor source, settings or storage are
used as test projects. Remove only the reported disposable roots after review.

Exit codes are **0** (all requested tools passed), **1** (difference or fixture
error), and **2** (at least one required tool unavailable). Unavailable tools
are explicit skips in the default Node suite, never passes. An all-tool
acceptance requires evidence for all four tools; a green suite with skips is
insufficient. For a deliberately narrower local run, use `--tools go,npm,uv`.

## What actually executes

Each tool gets a fresh HOME, XDG/config/data/cache roots, temporary directory,
Cargo home, GOPATH, npm configuration files and managed root. The environment
is an allowlist: ambient credentials, Node hooks, tool options and cache
overrides are not copied. The installed Rust toolchain location is the sole
retained Rustup setting. Offline/no-download settings prevent dependency and
managed-Python installation. This is configuration isolation, not a filesystem
sandbox against malicious installed tools.

Both lanes use the same physical project and the same argument array, stdin,
user environment and explicit final destination. The direct lane uses the
independently resolved real executable; the routed lane invokes the real CLI,
which installs its runtime only inside the disposable data root. Nested tools
resolve through the inherited PATH, thereby exercising the installed shims.

| Tool | Real execution and child observation | Artifact proof |
| --- | --- | --- |
| Cargo | `cargo run --offline --locked --quiet -- ...` compiles a dependency-free Rust binary, which `exec`s the probe without a shell. Nested Cargo runs `metadata`. | `cargo build` produces an executable in native `target` versus a marker-verified managed target. Compare executable SHA-256. |
| Go | `go run -trimpath . ...` compiles a dependency-free Go program that `exec`s the probe. Nested Go runs `env`. | `go build -trimpath -ldflags=-buildid= -o ...` creates the same explicit binary; require populated real Go build cache and equal binary SHA-256. |
| npm | `npm --silent run probe -- ...` executes an actual package lifecycle script. Nested npm runs `config get cache`. | `npm pack` creates the same tarball at an explicit destination; `npm cache add` must store those exact tarball bytes in each native content-addressed cache. |
| uv | `uv --quiet run --no-project --no-python-downloads -- node ...` executes the probe. Nested uv runs `cache dir`. | Real `uv pip install --target ...` installs a deterministic local wheel; require exact installed module bytes and those bytes in the real uv wheel cache. |

The probe is a child program, not a fake replacement for any of the four tools.
It writes a private observation and a binary artifact, emits argv/cwd/user
values plus raw stdin to stdout, and emits a distinct prefix plus raw stdin to
stderr. Streams are captured separately as Base64; invalid UTF-8 and NUL bytes
are not decoded for comparison. The stdin payload includes 257 seeded random
bytes. Expected argv, cwd, user values and artifact contents are also asserted
independently, so two identically broken lanes do not pass merely by agreeing.

The fixed vector includes empty arguments, whitespace, quotes, Unicode and
literal shell metacharacters. A fixed unsigned-32-bit LCG produces additional
vectors from documented constants in the driver; count is bounded to 1–32.
Three nonzero child exits, a native invalid option, nested commands, explicit
cache overrides and SIGINT/SIGTERM run for every available tool. npm and uv
also exercise leading split and equals-form native cache options.

The `native-cwd` case starts in a separate empty caller directory and supplies
Cargo `--manifest-path`, Go `-C`, npm `--prefix` or uv `--directory`. Cargo's
program retains the caller cwd; the other fixture commands execute their
probe in the selected project. Manifests, source bytes/modes and absence of a
persisted `.clean-development.json` are checked across the run.

## Permitted differences, not blanket normalisation

| Surface | Exact permitted difference |
| --- | --- |
| Invocation | Routed entry is Node plus this CLI and the explicit session choice. Native tool arguments/effects remain the same. |
| PATH and session | Exactly one owned stable `data/bin` entry and `session-only`; removing that entry must reproduce the direct child's complete PATH sequence. Native tool-added PATH entries remain in order. |
| Cargo storage | `target_directory` (and identical `build_directory` when present) points at the registered managed Cargo target instead of project `target`. Validate its marker owner, canonical workspace and ownership ID. |
| Go storage | Only GOCACHE and GOMODCACHE change to their configured managed paths unless explicitly overridden. |
| npm/uv storage | Only npm_config_cache / UV_CACHE_DIR change to their configured managed paths unless explicitly overridden. |
| Native cache-query output | Validate each exact destination first, then replace only its literal JSON string (Cargo/Go) or exact single output line (npm/uv) for comparison. All other output remains compared. |
| Signal termination | Native signal termination may become the documented numeric `128 + signal number` from the wrapper. Any other code/signal difference fails. |
| Private bookkeeping | The routed lane creates runtime, ownership and lease metadata in its disposable data/managed roots. Those are not native tool artifacts. |

Ordinary command stdout/stderr and final artifact bytes have **no** path,
whitespace, line-ending or timestamp scrubber. Quiet tool options suppress
native progress/timing diagnostics identically in both lanes; nonquiet output
is not certified by this matrix. Go's identical deterministic build flags
remove its build-ID variability rather than ignoring unequal executables.

Opaque cache indexes, locks, timestamps, compiler internals and whole-directory
cache byte equality are outside the artifact oracle. The lab instead requires
useful real cache payloads in the exact permitted locations and equality of
selected final artifacts. It checks the selected user/cache variables and full
PATH, not every environment variable a tool may add. Source checks cover the
fixture's declared source files and project-config noncreation, not arbitrary
write containment. These limits must not be described as full filesystem or
environment equivalence.

## Signals and bounded cleanup

A readiness marker is emitted only after the child has consumed stdin and
written its observations. SIGINT and SIGTERM are then sent to the isolated
**foreground process group**, modelling terminal signals. The lab records
this target and compares the entry process's actual exit/signal plus output.
It does not silently treat a timeout or infrastructure failure as conformance.

An initial local control sent SIGINT only to npm's entry PID. Native npm did
not terminate its shell/probe in that mode; that attempt was stopped and is not
a product regression or a signal pass. Entry-PID-to-descendant forwarding is
not certified here. See [foreground lifecycle](process-lifecycle.md) for the
product's direct-child contract and its separate tests.

Each invocation has a 120-second deadline and a 2-MiB output cap. Nested
queries have 10 seconds/1 MiB. After an entry process exits, a remaining owned
process group holding pipes is killed after 100 ms; its cleanup is not counted
as the observed entry's termination. This is fixture leak prevention, not a
claim of product process containment. The cache inventory is bounded to 20,000
entries. These are process/observation bounds, not disk quotas.

## Failures and minimisation

A difference fails the standalone lab and is retained with exact commands,
cwd, seed, observations, Base64 streams, termination and artifacts. Random argv
failures trigger at most 40 reducer replays: delete argument chunks, then
Unicode codepoints, retaining the same difference-category signature. This is
a bounded reduction, **not proof of a global minimum or unchanged root cause**.
Inspect/replay it before labelling a production regression. The Node suite
uses the same oracle but disables automatic minimisation to bound CI time.

Controls reject same-length byte corruption, changed stderr/status/signals,
missing executables and deadlines, and test seed/reducer behaviour. Product
fixes require a separately confirmed failing case; do not weaken this oracle
to accommodate an unexplained difference or duplicate another open PR's fix.

## Evidence and revision boundary

Base at the start of this work: `af12577c6596095fdf91f18e840e9433521ea3d2`.
Read `AGENTS.md`, architecture, safety and process contracts; inspected open
PRs #24–#43 before editing. This change adds only the lab, probe, its dedicated
tests and this document. No production module, installed integration, package
dependency, workflow or generated bundle is changed.

The container's supplied source archive was verified against the complete
upstream tree `998605cda006d588e9562cabe1eee6c78c2f3a59`. Its local initial
commit is archive bookkeeping, not upstream history. Published commits are
parented to actual main. Reports distinguish `sourceHead`, the staged
`indexTree`, worktree status and SHA-256 fingerprints of the executed source
and harness. Do not interpret an index tree as an unstaged working-tree hash.

Local pilot evidence: Linux x64, Node 22.16.0, Go 1.23.2, npm 10.9.2,
uv 0.10.0 and Python 3.13.5. Cargo/rustc are unavailable locally and outbound
package/Git DNS failed. Cargo is therefore explicitly blocked here. The
repository's ordinary PR test matrix runs these tests on installed real tools;
only inspected job logs may establish additional Cargo/platform coverage.
Final check results and exact CI revisions belong in the draft PR evidence.

Relevant upstream contracts:
[Cargo run](https://doc.rust-lang.org/cargo/commands/cargo-run.html),
[Go command](https://pkg.go.dev/cmd/go),
[npm run-script](https://docs.npmjs.com/cli/v10/commands/npm-run-script),
and [uv CLI](https://docs.astral.sh/uv/reference/cli/).
