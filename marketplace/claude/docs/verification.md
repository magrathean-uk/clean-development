# Verification status

This ledger separates recorded checks from current acceptance. The source version is `0.2.1`, but it is not an npm publication or release tag. The observations below are dated repository records. They do not establish acceptance for a later source revision, package, or host version.

## Recorded evidence

| Snapshot | Recorded result | Limit |
| --- | --- | --- |
| 19 September 2026, v0.2.0 candidate | 148 tests: 147 passed, one native-Windows test skipped; package lifecycle and upgrade checks; Cargo, Go, npm, and uv smoke; six baseline/routed fixture cases | Historical candidate evidence; does not certify later source changes |
| 19 September, macOS arm64 benchmark | 100 paired samples, 57.96 ms added median and 67.28 ms added p95 | One machine and Node version; no general speedup or supported-platform performance claim |
| 19 September, Debian 13 ARM64 | Source and installed-package checks on Node 20.12.2 and 20.19.2 | Go and uv were unavailable in that environment |
| 26 September, 0.2.1 local rollout | `npm run check`; 159 test successes with one platform-specific skip; 58-file installed-package gate covering exports, session choices, setup/status/uninstall, and upgrade from `v0.2.0` | Local source and isolated-package evidence; not npm publication, release-tag, or public-directory acceptance |
| 26 September source review | 159 tests: 158 passed, one native-Windows test skipped; syntax/version, package, smoke, and offline fixture checks recorded | Isolated source/process checks, not new live-host acceptance |
| Later 26 September skill review | Repository record reports 159 passing tests plus one platform skip and a 58-file package; earlier review reports a 57-file package | Separate checkpoints; do not combine counts or attribute them to an unrecorded revision |

The self-contained Claude directory bundle at `d0bd0a488dd1ed6d705423b43b8725ee36552fe5` also passed live Claude Code 2.1.283 / Sonnet 5 checks for ordinary non-invocation, explicit read-only diagnosis, and approved session-only child routing. That source checkpoint passed the 62-file package gate. This is direct local bundle evidence, not directory-installed acceptance; see the [marketplace submission record](https://github.com/magrathean-uk/clean-development/blob/d0bd0a488dd1ed6d705423b43b8725ee36552fe5/docs/marketplace-submission.md).

The historical release artifact digests remain in `.release/v0.2.0-package.sha256` and `.release/v0.2.0-source-manifest.sha256`. They describe that artifact, not the current working tree. See [the source review](https://github.com/magrathean-uk/clean-development/blob/main/docs/review-2026-09-26.md), [the earlier audit](https://github.com/magrathean-uk/clean-development/blob/main/docs/audit-2026-09-18.md), and [benchmark history](https://github.com/magrathean-uk/clean-development/blob/main/docs/benchmarks/m3-pro-2026-09-18.md).

## Recorded host observations

| Host | Observation in repository records | Still outside that evidence |
| --- | --- | --- |
| Codex CLI 0.154.0 | Managed Cargo and uv routing in isolated model workflows, with clean fixture checkouts | Codex App, restart/resume, subagents, newer host versions, and billed-token neutrality |
| Grok Build 1.0.34 | Marketplace/parser checks and model-shell routing after the owned command prefix restores the managed path | Broader lifecycle coverage and newer versions |
| Antigravity 1.2.7 | Short routed model workflow | Long print-mode commands encountered cancellation; later authentication-limited runs were not counted as model acceptance |
| Claude Code 2.1.283 / Sonnet 5 | Ordinary development, read-only diagnosis, and explicit session-only child-command routing | Full native-hook, resume/fork/subagent, and cwd-change acceptance; billed-token neutrality |
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

Its disposable repository creates a **synthetic** `v0.2.0` tag solely to exercise the verifier offline. It covers a complete package, a nested `.npmignore` that excludes the shim, and an included shim that exits unsuccessfully. This is verification-harness evidence, not compatibility evidence for the genuine `v0.2.0` release. The fixture does not create or replace tags in the working checkout. Its direct npm/shell execution is POSIX-only; a skipped native-Windows run is not a pass.

`npm run test:package` still requires the genuine preceding-release tag. A source ZIP without Git history cannot complete that check: record the missing tag as a limitation, fetch the real tag, and rerun before claiming release-upgrade coverage. Neither the synthetic regression nor an installed-package check establishes npm publication or live-agent acceptance.

## Remaining acceptance

- Native Windows execution and real concurrent worktrees.
- Codex App shell snapshots, restart behavior, and sandbox writable roots.
- Complete native-hook and lifecycle acceptance for Claude, Grok, OpenCode, and Pi.
- Real host workflows for launcher-only or metadata-only integrations.
- External-volume loss, disk-full interruption, and hostile filesystem races.
- Supported-Node performance measurements, cold/warm cache reuse, and system-load variance.
- Public-registry installation and publication evidence when a release is actually available.
- Comparable model-facing request captures and billing evidence before claiming billed-token neutrality.

Record each new result against its source revision or package hash, exact host version, environment, command, and outcome. Keep private account details and raw local paths outside public documentation.
