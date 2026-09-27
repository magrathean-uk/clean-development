# Shared-cache and checkout-build correctness lab

This is a content-correctness lab, not a speed benchmark or a cache-safety proof.
Read the [architecture](architecture.md), [safety model](safety-model.md),
[command/storage boundaries](command-storage-boundaries.md) and [Cargo workspace discovery](cargo-workspaces.md).

## Run

Use a POSIX host with Node 20.12+, Git, and the real tools to be tested. Go and uv
also require Python 3 for deterministic local package archives. Cargo requires an
already-installed Rust toolchain. No tool installation, dependency download,
credential copy, npm publication, setup of real agent settings, or prune is done.

```sh
node --test test/cache-correctness.test.js
node test/cache-correctness/run.mjs --run --tools=go,npm,uv,cargo
npm run check
npm test
```

The ordinary test suite explicitly skips missing tools and native Windows; it
never replaces a missing compiler with a fake. The explicit `--run` command
retains each new temporary lab and prints its location plus a JSON report. It
exits 1 for failures, 2 for unavailable tools, and 0 only when every requested
lane passed. Successful test-mode labs remove only their own token/device/inode-
verified disposable tree; failed labs remain for diagnosis. Explicit execution
always retains the fixture. Do not point these tests at existing storage.

Each report records actual versions, platform, product source fingerprints,
command argv/cwd, exit/signal, output hashes, log locations, expected program
content, and assertions. Temporary paths are redacted in `report.json`; raw
stdout/stderr logs remain inside the newly allocated lab. Those logs contain
only fixture commands/data, not inherited credentials. Inspect them before sharing.

## Contract and independent oracle

A real Git fixture creates independent repositories A and B plus two detached
worktrees W1 and W2 of A's initial commit. All four directories have the same
basename and use the same package/module names. The test checks the Git common
directory and commit, but expects separate canonical checkout output roots.
Fixture source is deliberately different in each checkout after creation.

Every actual program must print the independently supplied exact value:

```text
<checkout>|<source-revision>|<flag-selection>|<dependency-content>
```

Exit zero, cache timing, an existing binary, or a compiler-reported pathname is
not sufficient. The harness executes binaries/packages and compares their bytes
on stdout. Go also embeds the expected dependency and compiler flags in binary
metadata. Cargo's real compiler-artifact JSON must identify the expected binary
and dependency version. Direct-tool controls run the same source and arguments
with separate disposable caches/targets, and must satisfy the same oracle.

Snapshots include source bytes, names, file types, modes, empty directories,
symlink targets, untracked files and Git metadata. Only explicit fixture edits
between phases are permitted. There is no broad `target`/`node_modules`/`.venv`
exclusion that could hide accidental writes. Detection is before/after, not a
kernel write audit: a transient write that is undone before the next snapshot
is outside this evidence.

## Matrix

| Scenario | Go | Cargo | npm | uv |
| --- | --- | --- | --- | --- |
| A/B and two real linked worktrees | Yes | Yes | Yes | Yes |
| Concurrent cold execution, exact outputs | Yes | Yes; build-script barrier | Yes | Yes |
| Warm execution and separate-cache direct controls | Yes | Yes | Yes | Yes |
| Changed source, without cleaning cache | Yes | Yes | Yes | Yes |
| Changed compiler flags, then restored flags | Build tags and `-gcflags` | `RUSTFLAGS --cfg` and optimisation | Not a compiler test | Not a compiler test |
| Changed arguments and dependency versions | Yes | Yes | Yes | Yes |
| Real interrupted build and verified restart | Real compiler archive | Real compiled build script / `OUT_DIR` | Not covered | Not covered |
| One routed parent changes cwd across checkouts | Yes | Yes, nested workspace members | Yes | Yes |
| Unplanned persistent source-tree changes | Full snapshots | Full snapshots | Full snapshots | Full snapshots |

Go uses a local file-protocol module proxy with two valid, immutable versions,
`go.sum` hashes and read-only module resolution. npm uses actual `npm pack`
tarballs followed by `npm exec --offline --package=<archive>`. The test compares
the tarball bytes with their SHA-512-addressed npm cache content. uv installs
valid locally generated wheels, executes code from each version using real
`uv run`, and checks cached Python source bytes. These do not test external
registries or supply-chain authenticity.

All four Go executions must observe the same configured `GOCACHE` and
`GOMODCACHE`. npm/uv must observe their expected shared cache. Cache-only tools
must not claim workspace build ownership. Go binaries are explicitly requested
outside source with `-o`; Clean Development does **not** relocate default Go
final deliverables. npm uses its cache-backed exec environment; uv uses
`--no-project`. Normal project-local dependency installation is not promised to
move merely because a cache variable is routed.

Cargo target paths are independently derived from each canonical checkout path,
not by asking the production workspace function for the expected answer. Four
roots, real binary locations, ownership markers and matching outside-root
receipts are checked. Ordinary Cargo intermediates and this lab's disposable
binaries live there. Do not use a prunable Cargo target as the only copy of a
valuable final release artifact. This lab adds no migration/adoption/deletion.

### Interruption boundary

The Go `-toolexec` helper delegates to the actual compiler and propagates its
failure. It pauses only after that compiler produced a non-empty package
archive and before Go observes completion. The Cargo fixture first compiles and
runs a genuine Rust build script, which writes an `OUT_DIR` intermediate and
signals its barrier. Ready files establish ordering; sleep duration is not the
correctness oracle. Waiting is bounded.

The lab sends SIGKILL to its own spawned process group, requires a non-successful
result, verifies that the last complete binary was not replaced, then rebuilds
changed source without clearing the cache. It executes the rebuilt binary and
all untouched peer binaries against their expected content. This tests process
interruption, not power loss, fsync durability, a full disk, all signal paths,
or processes that deliberately escape their process group. npm/uv interrupted
installation and concurrent cache deletion are explicit gaps, not passes.

## Responsibilities that remain upstream

* [Go build/test caching](https://pkg.go.dev/cmd/go#hdr-Build_and_test_caching)
  accounts for source, compiler and option changes, and documents concurrent
  use by Go commands. Clean Development selects paths, not cache keys or
  compiler invalidation. Go documents the cgo C-library invalidation exception;
  this fixture sets `CGO_ENABLED=0` and does not certify cgo.
* [Cargo build cache](https://doc.rust-lang.org/cargo/reference/build-cache.html)
  defines target/intermediate placement. Cargo/rustc own fingerprints,
  incremental compilation and rebuild decisions. Build scripts must declare
  relevant inputs using their [rerun instructions](https://doc.rust-lang.org/cargo/reference/build-scripts.html#change-detection).
  Clean Development supplies checkout-specific target roots and ownership/
  lease bookkeeping, not content-addressed Rust output sharing or an sccache
  service. These local path dependencies do not exercise registry/git caches.
* [npm cache](https://docs.npmjs.com/cli/v10/commands/npm-cache/)
  checks content integrity on insertion/extraction and can refetch corrupt
  entries; it is not durable package storage. Clean Development neither hashes
  npm keys nor makes arbitrary installation trees safe for concurrent writes.
* [uv caching](https://docs.astral.sh/uv/concepts/cache/) documents append-only,
  concurrent cache use and target-environment locking. Its dependency cache
  keys and invalidation belong to uv; dynamic/local metadata may require
  explicitly configured cache keys. This fixture uses immutable wheels, not
  editable installs, sdist build isolation or dynamic version metadata.

The lab never edits a live upstream cache to force reuse. Reusing the same
mutable target manually through a user override, unsupported build scripts,
network filesystems, cross-compilation, multiple compiler versions, cache
pruning, symlink aliases and adversarial filesystem races need separate tests.
Explicit output/cache overrides remain the caller's responsibility. A clean
matrix does not establish universal absence of contamination or source writes.

## Evidence status

The initial local run used Linux x64, Node 22.16.0, Go 1.23.2, npm 10.9.2,
uv 0.10.0, Python 3.13.5 and Git 2.47.3. Go, npm and uv passed their actual
content and source-snapshot assertions. Cargo/rustc were unavailable locally;
its explicit invocation reported **blocked**, not passed. The existing PR CI
runs this test when a real Rust toolchain is available; a queued or unobserved
CI run is not evidence. The PR records the final executed revision and results.

No confirmed production routing defect was found in the executed local matrix,
so this change does not alter routing, ownership or upstream cache behaviour.
Harness detector controls deliberately reject stale content and source writes;
they are controls, not product vulnerabilities. Keep the PR draft for review.
