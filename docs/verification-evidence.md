# Required coverage and reproducible smoke evidence

The smoke harness runs small, predefined **offline** fixtures through the real CLI
and requires a non-empty managed compiler/package artifact, not merely a successful
exit. It is development tooling, not an automatic runtime probe or an authenticated
agent-host acceptance test.

```sh
# Run every available supported fixture; fail if none run or any fixture fails.
npm run smoke:tools

# Make missing coverage a failure, not an unnoticed skip.
node scripts/smoke-real-tools.mjs --require cargo,go,npm --json

# Save pure JSON explicitly. npm run itself prints lifecycle text, so use node.
node scripts/smoke-real-tools.mjs --require go,npm,uv --json > smoke-evidence.json
```

Supported required names are `cargo`, `go`, `npm`, and `uv`. Selection is strict:
unknown/duplicate tools, empty lists, repeated options, and unexpected arguments
fail with exit 2 **before fixture setup**. `--require` does not limit which available
fixtures run; every available supported tool is still checked. Missing optional
tools are reported as skipped. A present but failing optional tool still fails the
run. A required tool must **pass**, so another tool's success cannot replace it.
The CI matrix now requires Cargo, Go and npm on each Ubuntu/macOS job; uv runs when
available and requires an installed Python 3. CI explicitly provisions Go 1.27.1
with the immutable-SHA-pinned official setup-go action before invoking the harness;
that provisioning may download the toolchain. The harness itself never downloads
a missing tool. This distinction matters: the first required-coverage run exposed
that the macOS runner had no Go executable on PATH, despite earlier smoke success
for the subset of available tools.

## Scope and isolation

Fixtures use temporary projects, managed directories, tool homes, XDG homes and
npm user/global configuration. Ambient npm configuration environment values are
removed. Cargo has a disposable home for this dependency-free fixture; rustup still
uses the original installed toolchain location, with auto-install disabled. This
harness isolation is not a change to the product's `CARGO_HOME` routing policy.
Go proxy/checksum downloads, npm network access, Cargo dependency access and uv
Python/package downloads are disabled using their normal offline controls. These
are native tool controls, **not a network sandbox**; a substituted executable or
external tool configuration is not made trustworthy by this harness.

Each command has a 120-second timeout and a 2 MiB output limit; version queries use
10 seconds. Timeout/output failures become failed checks, not skips. On POSIX,
commands have a separate process group and the harness terminates that group after
a failed command, so killing the wrapper alone does not intentionally leave its
compiler child running. This is not an OS-wide process sandbox; descendants that
create another session can escape a group. Windows command-tree termination and
native Windows smoke acceptance are not established by this work.

Temporary fixture content is removed after the run; failure to clean it changes the
report to failure. JSON does not contain environment variables, executable paths,
project paths, regular-file contents, argv, raw child stdout/stderr, or stack traces.
Version strings are extracted with bounded tool-specific parsing. Default text mode
can display assertion messages for diagnosis; review logs before sharing. Early
argument, source-inventory or OS setup failures can terminate before a JSON report
is produced and still fail the process. Redirection is the caller's explicit file
write; the harness does not upload evidence or create persistent reports itself.

## JSON schema version 1

| Field | Meaning |
| --- | --- |
| `kind`, `schemaVersion`, `packageVersion` | `real-tool-smoke`, schema 1 and source package version. This is not an npm publication claim. |
| `source.gitCommit`, `source.gitDirty` | Actual local checkout HEAD and dirty state when Git can establish this exact root; otherwise null. A source archive inside a parent checkout does not borrow that parent's identity. In PR CI this may be a synthetic merge commit, not the PR head. |
| `source.fingerprint`, `fingerprintAlgorithm`, `fingerprintScope`, `fileCount` | SHA-256 over sorted relative filenames and their content hashes under `bin`, `src`, `scripts` and `package.json`. Does not scan arbitrary project files or `.env`. It is not the entire repository/tree, a signature, executable-mode verification or a release-tarball digest. |
| `sourceUnchanged` | Fingerprinted content and Git identity match the final recheck; a change or unavailable recheck fails the run. This is not an atomic filesystem snapshot. |
| `environment` | Platform, architecture, Node version and OS release; no hostname, username or full environment. |
| `startedAt`, `finishedAt`, `durationMs` | UTC ISO timestamps and monotonic elapsed duration. |
| `requiredTools`, `commandLimits` | Coverage policy and command work limits. |
| `results` | Per tool: `tool`, `required`, `status`, `reason`, `version`, `durationMs`; successful checks add fixture ID and prerequisite versions, failed checks add a bounded error code. |
| `passed`, `skipped`, `missingRequired` | Actual outcomes. `missingRequired` includes absent **and failed** required checks. |
| `ok`, `setupError`, `scope` | Overall result, setup/cleanup failure category and explicit acceptance boundary. |

A `passed` result requires both the fixture and version capture to pass. A
`skipped` result is `executable-unavailable`; a present tool with an unsuccessful
fixture is `failed`, not skipped. `ok` is true only when at least one check passes,
no available check fails, all required checks pass, and setup/cleanup succeeds.
Exit status is 0 for that result and 1 for check/coverage failures. CI logs retain
the complete JSON, including failed/skipped outcomes. Hash equality supports a
content comparison; it does not certify correctness, origin or security.

## Installed package boundary

`npm run test:package` retains its preceding-release tag requirement and upgrade
checks. Its session/lifecycle fixtures discard inherited routing overrides rather
than borrowing a contributor's managed storage settings. Its installed-package contract now explicitly checks the explain/status/
measurement source files, documentation and new public API exports. A source test
alone cannot prove that those files were packed and installed. No option was added
to silently skip the upgrade gate; source archives without that history must report
that gap and run any current-package-only checks separately.

Regression tests are in `test/verification-evidence.test.js` and
`test/harness.test.js`. Relevant primary contracts:
https://nodejs.org/api/child_process.html and
https://rust-lang.github.io/rustup/environment-variables.html.
