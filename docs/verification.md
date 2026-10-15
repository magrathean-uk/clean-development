# Verification status

This ledger separates recorded checks from current acceptance. The current source version is `0.5.0`. Final artifact hashes, source-to-package audit reports and publication status belong to the [matching GitHub release](https://github.com/magrathean-uk/clean-development/releases/tag/v0.5.0). The observations below are dated repository records. They do not establish acceptance for a later source revision, package, or host version.

## Recorded evidence

| Snapshot | Recorded result | Limit |
| --- | --- | --- |
| 19 September 2026, v0.2.0 candidate | 148 tests: 147 passed, one native-Windows test skipped; package lifecycle and upgrade checks; Cargo, Go, npm, and uv smoke; six baseline/routed fixture cases | Historical candidate evidence; does not certify later source changes |
| 19 September, macOS arm64 benchmark | 100 paired samples, 57.96 ms added median and 67.28 ms added p95 | One machine and Node version; no general speedup or supported-platform performance claim |
| 19 September, Debian 13 ARM64 | Source and installed-package checks on Node 20.12.2 and 20.19.2 | Go and uv were unavailable in that environment |
| 26 September, 0.2.1 local rollout | `npm run check`; 159 test successes with one platform-specific skip; 58-file installed-package gate covering exports, session choices, setup/status/uninstall, and upgrade from `v0.2.0` | Local source and isolated-package evidence; not npm publication, release-tag, or public-directory acceptance |
| 26 September source review | 159 tests: 158 passed, one native-Windows test skipped; syntax/version, package, smoke, and offline fixture checks recorded | Isolated source/process checks, not new live-host acceptance |
| Later 26 September skill review | Repository record reports 159 passing tests plus one platform skip and a 58-file package; earlier review reports a 57-file package | Separate checkpoints; do not combine counts or attribute them to an unrecorded revision |
| 15 October 2026, v0.4.3 merged source | Tested source `2c1b455e495da30c19f7a1dcd90afd9305e92d45` merged as `52d1bfad9a0a103edf6acc42a7d060ab02ad63fb`; full suite 1,284 passed, 48 skipped, zero failed/cancelled/TODOs; genuine `v0.2.0` package upgrade passed with 125 files; 15 GitHub checks passed, one Dependabot automerge skip | Verified v0.4.3 source only; no npm release/tag; workflow results apply to the named tested head and configured platform/Node jobs, not v0.5.0 |

The self-contained Claude directory bundle at `d0bd0a488dd1ed6d705423b43b8725ee36552fe5` also passed live Claude Code 2.1.283 / Sonnet 5 checks for ordinary non-invocation, explicit read-only diagnosis, and approved session-only child routing. That source checkpoint passed the 62-file package gate. This is direct local bundle evidence, not directory-installed acceptance; see the [marketplace submission record](https://github.com/magrathean-uk/clean-development/blob/d0bd0a488dd1ed6d705423b43b8725ee36552fe5/docs/marketplace-submission.md).

The historical release artifact digests remain in `.release/v0.2.0-package.sha256` and `.release/v0.2.0-source-manifest.sha256`. They describe that artifact, not the current working tree. See [the source review](https://github.com/magrathean-uk/clean-development/blob/main/docs/review-2026-09-26.md), [the earlier audit](https://github.com/magrathean-uk/clean-development/blob/main/docs/audit-2026-09-18.md), and [benchmark history](https://github.com/magrathean-uk/clean-development/blob/main/docs/benchmarks/m3-pro-2026-09-18.md).

## 30 September native lab record

These native runs tested the pre-bump `0.3.1` source overlay below. The later
`0.4.0` version bump and release checks do not change that snapshot's identity.

The final native snapshot is a 287-file dirty source overlay on commit
`4442d855feebe6e248ac6f21f4f6a5700db294eb`, rather than that commit alone. Its
source SHA-256 is `0460e59f17ae47ac23e4aa7f90ffeeffdc1980e28ebdbb52a359d1e47256a16b`
and its transferred archive SHA-256 is
`45ee2edc17821429ef7d3b4cc7b92ae435753a288c57a425c5e6ae5434de6fa4`.
The source digest sorts slash-separated relative paths, then hashes each path,
NUL, file bytes, and NUL; `.git` is excluded. The native runs verify source
identity before and after testing. Later ledger edits are outside that snapshot.
Both package gates use the genuine `v0.2.0` commit
`0541c6bf7e0ee1b9939a9c6518b24e1f767f686c` from retained Git history.

| Host and tools | Completed checks | Boundary |
| --- | --- | --- |
| Ubuntu 26.04.1 LTS ARM64, Linux 7.0.0-34-generic; Node 20.12.0, npm 10.5.0, Go 1.27.1, Git 2.53.0 | Source check; full suite: 1,101 passed, zero failed, 70 skipped, three TODOs (1,174 total); genuine installed-package upgrade passed, 115 packaged files | Local ARM64 / exact Node minimum only; native Windows/Xcode, unavailable tools and live-agent workflows retain their own boundaries; TODOs remain known failures |
| Windows 11 Pro ARM64, build 26200; PowerShell 5.1.26100.7920; Node 20.12.0, npm 10.5.0, Go 1.27.1, Git 2.56.0.windows.1 | Source check; 27-file contract gate: 451 passed, zero failed, 14 skipped; Windows runtime subset: three passed, 13 filtered; PATH-casing subset: one passed, 36 filtered; genuine installed-package upgrade passed | Local native ARM64 / exact Node minimum only; not the full legacy Windows suite, GitHub CI execution, other Node majors/architectures, or real artifact-build equivalence |

The final Ubuntu full-suite skips are 38 native-Windows cases, 27 macOS/Xcode
cases, one unavailable-Cargo check, two unavailable-uv checks, one blocked real
OpenCode check, and one real SwiftPM check that was not enabled. Its three TODOs
are the existing fault-lab assertions described below, not successful invariants.

Windows ran the selected files with `--test-concurrency=1` on a two-CPU guest;
parallel resource-related timeouts were cleared without increasing test limits.
The final run had no timeouts and all 12 required commands passed. Its 14 contract
skips are 11 POSIX-only cases, two unavailable-uv checks, and one native
case-distinct-path check on a filesystem that aliases those spellings. The named
subsets' filtered cases are not selected native contracts. Real npm/Go cache
queries and disposable fake Cargo shims establish invocation/routing behavior;
Windows artifact smoke and verification-timeout descendant cleanup remain open.
Failed checkpoints and original native logs remain in private lab evidence.

An earlier snapshot from the same lab, source SHA-256
`cb7cc14de41a6d4ccea3e616fecd6a40d59dbe5e61e8823ba9691f64843c3874`, passed
offline Linux Go/npm artifact smoke and all 15 performed baseline/routed artifact
checks. Cargo and uv were unavailable; two Rust fixture lanes were skipped, so
the six-lane fixture aggregate correctly exited 1. Its standalone fault lab also
exited 1 with no infrastructure errors and the three known violations:
`missing-during-marker/storage-identity`, `replaced-managed-root/storage-identity`,
and `publication-cleanup-error/original-error`. These were unresolved findings
at that checkpoint, not safety passes; see [the fault cases](../test/fault-lab/FINDINGS.md)
and the 14 October resolution below.

## 0.4.0 source preparation

The 30 September `0.4.0` preparation was checked on macOS 26.7.1 (25G241),
ARM64, Node 26.10.0 and npm 12.1.0. The dirty source overlay used parent commit
`4442d855feebe6e248ac6f21f4f6a5700db294eb`. Its 57-file runtime SHA-256 stayed
`e55fe53b52526ed08028248739f53f44b78dcdaae6c805434da477d0d0c03220` before and
after testing, using the same path-NUL/file-bytes-NUL framing over `bin/`, `src/`,
`scripts/`, `package.json` and `package-lock.json`; documentation and tests are
outside that fingerprint.

The isolated Xcode lifecycle suite passed all 29 tests, including five cases
where malformed device metadata must retain the owned simulator and retryable
receipt. Executable/release-audit fixtures passed all 55 selected tests.
`npm ci --ignore-scripts`, source/version/bundle checks, the full suite, and the
genuine preceding-release package gate passed. The full suite recorded 1,179
tests: 1,128 passed, zero failed, 48 skipped and the same three known fault TODOs.
The package gate verified 115 files. Later outcome-ledger edits are documentation
changes; exact committed-source and final archive hashes belong to the separate
[release audit](release-audit.md), outside the hashed package.

This check covers the newly versioned source and malformed-simulator cleanup
correction. It does not extend the earlier native VM record to `0.4.0`, establish
real Xcode/SwiftPM or live-agent acceptance, or repair the three fault invariants.
The configured CI matrices and npm publication remain separate observations.

The initial `0.4.0` source push at
`cf83f48a4230090f6c3ec1ec291bd65184d1ec6a` exposed additional fixture assumptions
on hosted runners: short Windows `TEMP` paths, inherited `Path` spelling, and
extensionless fake Xcode executables whose ESM syntax was unsupported by Node
20.12.0. The follow-up canonicalizes owned temporary fixture paths, replaces
native PATH aliases through the environment helper, and uses CommonJS for the
fake executables. The synthetic package fixture uses JavaScript copy traversal
to avoid Node 22's native Windows directory-copy handling of Unicode names;
the adversarial source and cwd names remain in the test. Ownership and deletion
assertions remain intact. The Xcode
failure was reproduced locally with the official macOS ARM64 Node 20.12.0
archive, checked against its published SHA-256; the corrected lifecycle suite
passed all 29 cases on that exact runtime. The initial hosted failures and any
later workflow result are separate checks from the earlier ARM64 VM snapshot.

## 0.4.3 merged source verification

The source tested at `2c1b455e495da30c19f7a1dcd90afd9305e92d45` was merged as
`52d1bfad9a0a103edf6acc42a7d060ab02ad63fb`. The final local full suite recorded
1,284 passed, 48 expected skips, zero failed/cancelled/TODOs. The source check
passed its version-file, generated Claude bundle and bug-report consistency
checks. Package installation and the genuine `v0.2.0` upgrade passed with 125
files. Fifteen GitHub checks passed, including the macOS/Linux Node 20.12, 20,
22 and 24 matrix, native Windows Node 20.12, 22 and 24 checks, and real SwiftPM;
one Dependabot automerge check was skipped.

Claude Code 2.1.300 with Haiku 5.5 completed one isolated print-mode session on
the tested source. It ran one exact Bash observer command and built a dependency-
free Rust fixture using real Cargo 1.98.1 with `--offline --locked`. The eight
routing, artifact, nonce, isolation, credential-absence and unrelated-hook
checks passed; source was unchanged and the credential scan completed. The
passing call cost $0.00059402; including two earlier fixture-diagnostic calls,
reported spend was $0.001735435 across three calls. This is one isolated
print-mode session: resume, fork, subagents and billed-token neutrality remain
unverified. Codex was checked only for launcher version `0.162.0-alpha.17.2`;
the prior authenticated Codex workflow was not repeated at this boundary.

This evidence describes v0.4.3 and does not certify the current v0.5.0 source
candidate, its package, or publication.

## Recorded host observations

| Host | Observation in repository records | Still outside that evidence |
| --- | --- | --- |
| Codex CLI 0.154.0; v0.4.3 launcher check at 0.162.0-alpha.17.2 | Earlier managed Cargo and uv routing in isolated model workflows, with clean fixture checkouts; v0.4.3 checked launcher version only | The authenticated workflow was not repeated at 0.162.0-alpha.17.2; Codex App, restart/resume, subagents, and billed-token neutrality |
| Grok Build 1.0.34 | Marketplace/parser checks and model-shell routing after the owned command prefix restores the managed path | Broader lifecycle coverage and newer versions |
| Antigravity 1.2.7 | Short routed model workflow | Long print-mode commands encountered cancellation; later authentication-limited runs were not counted as model acceptance |
| Claude Code 2.1.283 / Sonnet 5 | Ordinary development, read-only diagnosis, and explicit session-only child-command routing | Full native-hook, resume/fork/subagent, and cwd-change acceptance; billed-token neutrality |
| Claude Code 2.1.300 / Haiku 5.5 | One isolated v0.4.3 print-mode session; exact Bash observer and real Cargo 1.98.1 `--offline --locked` build passed eight routing, artifact, nonce, isolation, credential-absence and unrelated-hook checks | Resume, fork, subagents, broader native-hook/lifecycle acceptance, and billed-token neutrality |
| Gemini 0.54.4 and Copilot CLI 1.0.80 | Launcher version/argument smoke | Model workflows and native routing |
| Codex 0.155.1, Grok 1.0.41, and AGY 1.2.10 | Loader, package, or discovery observations in the skill review | Live model routing for those exact versions |

The [skill compatibility record](https://github.com/magrathean-uk/clean-development/blob/main/docs/skill-compatibility.md) keeps the tested Claude revisions and the distinction between request capture and inference. Neither metadata discovery nor a successful fixture proves that an ordinary host session used the managed shell.

## Reproduce the relevant checks

Use Node 20.12 or newer. The core repository checks are:

```sh
npm run check
npm test
```

Additional checks have different prerequisites and side effects:

| Command | Purpose and prerequisites |
| --- | --- |
| `npm run test:package` | Builds and installs temporary packages, tests exports and lifecycle, and needs the preceding-release tag named in `scripts/verify-package.mjs` for upgrade coverage |
| `npm run smoke:tools` | Offline smoke for locally available tools; review missing-tool results |
| `node scripts/run-fixture-lab.mjs` | Rust, Node, and Go baseline/routed artifacts; retains evidence in a new disposable directory |
| `npm run benchmark:overhead` | Paired shim dispatch measurements; record platform and sample count |
| `npm audit --omit=dev --audit-level=low` | Registry advisory check; a clean result is not a security audit |

See [contributing](https://github.com/magrathean-uk/clean-development/blob/main/CONTRIBUTING.md), [the fixture lab](https://github.com/magrathean-uk/clean-development/blob/main/test/lab/README.md), and [releasing](https://github.com/magrathean-uk/clean-development/blob/main/RELEASING.md). External plugin validators are optional, separately installed tooling; they are not npm scripts in this repository.

## Installed-launcher package regression

The package gate requires `bin/clean-development-shim.js` in the tarball. After both an upgrade and a fresh setup, it executes the managed CLI's `--version` and the managed Cargo shim against a disposable fake tool. The shim must actually reach that tool with session-only routing and the expected managed root; a successful setup receipt or an existing launcher file is not sufficient.

Run the verifier regression independently with:

```sh
node --test test/package-verification.test.js
```

Its disposable repository creates a **synthetic** `v0.2.0` tag solely to exercise the verifier offline. It covers a complete package, a nested `.npmignore` that excludes the shim, and an included shim that exits unsuccessfully. This is verification-harness evidence, not compatibility evidence for the genuine `v0.2.0` release. The fixture does not create or replace tags in the working checkout. The verifier resolves each command from its child cwd/environment and uses the batch adapter for native Windows `.cmd` launchers; ordinary executables retain direct argv dispatch. Native Windows execution is configured as a separate gate, and results must be recorded from that host.

`npm run test:package` still requires the genuine preceding-release tag. A source ZIP without Git history cannot complete that check: record the missing tag as a limitation, fetch the real tag, and rerun before claiming release-upgrade coverage. Neither the synthetic regression nor an installed-package check establishes npm publication or live-agent acceptance.

## 14 October diagnostics, storage and verification implementation

This is an unreleased dirty overlay on
`207389e87f267b4f3e2a1ad17122462b19802508`, still version `0.4.0`.
Checks ran on macOS 26.7.1 (25G241), ARM64, Node 26.10.0 and npm 12.2.0.
The 62-file product/harness fingerprint is
`041d15f05322e87e0db84823a361819f6ed7bb6a5756fa4c2bcb3f88c682b1d2`;
its scope is sorted paths/content digests in `bin/`, `src/`, `scripts/` and
`package.json`, excluding documentation, tests and the release tarball.

| Check | Recorded result | Boundary |
| --- | --- | --- |
| Source and full suite | Source/version/bundle check passed; 1,211 passed, 48 skipped, zero failed/TODOs; coverage gate passed with the same counts | Both full runs use `--test-concurrency=4`. Default parallel execution exceeded two 2.5-second fuzz bounds; isolated fuzz recheck and unchanged bounded assertions pass. Platform/opt-in skips remain visible. |
| Fault replay | 12 scenarios, 95 required checks, no violations or infrastructure errors | Original three failures were replayed before correction; no remaining fault TODOs. Physical directory replacement and selected synthetic ENOSPC, not a real disk-full or unmount test. |
| Real SwiftPM | Seven tests passed with Apple Swift 6.4 (swiftlang-6.4.0.34.1) | Actual binary/test/archive bytes, cold/warm reuse and explicit native overrides; complete unchanged selected disposable-home cache metadata for enabled build/test. No Xcode or downloaded-dependency acceptance. |
| Host verification | 34 focused tests and independent reproduction rechecks passed | Real subprocesses with synthetic lifecycle events; full disposable HOME leak detection, source/fixture digests and background-child uncertainty. No model-host lifecycle acceptance. |
| Real tools and offline fixtures | Cargo 1.99.0, Go 1.27.2, npm 12.2.0 and uv 0.13.0 smoke passed; all six Rust/Node/Go cases passed | Offline tiny fixture artifacts, separate from agent integration and installer/updater behavior. |
| Boundary fuzzing | 136/136 cases passed, complete, no skips | Recorded seed 20261014 and bounded observations; not an exhaustive input or filesystem proof. |
| Package lifecycle | Genuine `v0.2.0` upgrade and fresh consumer gate passed; 124 packaged files | Disposable native HOME/cache/config/temp and exact installed child routing; no publication or shared-runtime activation. |
| Older installed Node | 62 focused tests passed on Node 24.21.0 | Changed diagnostics/storage/inspection/harness paths; no new native Windows or Node 20 minimum run. |
| Paired overhead harness | All timing/artifact assertions passed: 100 short pairs, two cold/cache-hit pairs, eight warm and eight concurrent pairs | One loaded machine, Go only, no controlled host load; not a performance improvement or general overhead claim. |

The exact fault product hash and report digests are in
[resolution evidence](../test/fault-lab/resolution-evidence.json); historical
baseline evidence is retained. New read-only health, explicit scratch allocation,
physical-root admission and cleanup-status behavior are documented in
[diagnostics](diagnostics.md), [scratch](scratch.md) and
[architecture](architecture.md). [Host installer observation](host-installation-footprints.md)
and [Codex lifecycle verification](codex-acceptance.md) retain their separate
credential/profile and live-event requirements. Metadata-only installed-host
preflight observed Codex 0.162.0-alpha.17.2 and Claude 2.1.299; it proves version/help only.

The machine inspection/audit scripts were synchronized with retained backups.
The shared installed Clean Development runtime and active Claude configuration
were preserved. Source doctor correctly reports the existing absent Codex native
block and the old installed runtime inventory. Those observations are not a
successful activation of this overlay. Antigravity/Gemini/AWS owning lifecycle
checks and actual authenticated model-host lifecycle acceptance remain pending.

## Remaining acceptance

- Broader native Windows architectures and Node versions, the full legacy fixture suite, live-agent lifecycle acceptance, and real concurrent managed builds.
- Codex App shell snapshots, restart behavior, and sandbox writable roots.
- Complete native-hook and lifecycle acceptance for Claude, Grok, OpenCode, and Pi.
- Real host workflows for launcher-only or metadata-only integrations.
- External-volume loss, disk-full interruption, and hostile filesystem races.
- Supported-Node performance measurements, cold/warm cache reuse, and system-load variance.
- Public-registry installation and publication evidence when a release is actually available.
- Comparable model-facing request captures and billing evidence before claiming billed-token neutrality.

Record each new result against its source revision or package hash, exact host version, environment, command, and outcome. Keep private account details and raw local paths outside public documentation.
