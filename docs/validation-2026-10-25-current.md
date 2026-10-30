# Current branch validation - 25 October 2026

> Source-validation snapshot before the subsequent, separately authorised merge/push to `main`. That authorisation does not approve live installation or change the outstanding host/storage acceptance gates below. A project-only version audit confirmed no third-party npm or AI model dependency; `.node-version` now pins the already validated development runtime, Node 26.12.1. Minimum Node 20.12.0 and schema v1 remain compatibility support, not preferred versions.

Scope: unreleased **0.6.1**, isolated branch `feat/clean-development-safety`, based on `d5edf8097068eb0b837f0bfd6f5e2d5755516d01`. This record accompanies the feature-branch work; it is **not approval or evidence of a live installation**. The user requested that development remain separate and not interfere with current work. No merge, push, shared runtime/environment/hook replacement, account change, service restart or real mount operation was performed.

## Source matrix

| Runtime | Role | Node tests | Shell assertions | Source/release checks |
|---|---|---|---|---|
| **26.12.1** | Current Node; development target | 97 passed | 52 passed | Passed |
| **24.22.1** | Current LTS compatibility | 97 passed | 52 passed | Passed |
| **20.12.0** | Exact minimum-supported compatibility only | 97 passed | 52 passed | Passed |

All three runs had zero failed, skipped or cancelled Node tests. They ran sequentially using `npm test` and `npm run check`, fresh explicit fixture roots, and isolated runtimes in session scratch. The existing shared Node/current link was not changed. One Node case wraps 91 offline profile-test executions; those are nested coverage, not 91 additional independent cases. Profile tests use fabricated HOME, fake CLIs/login records and mocked VPS responses, including an explicit TMPDIR symlink.

Official `nodejs.org/dist/index.json` identified Current 26.12.1 and LTS 24.22.1. Each Darwin ARM64 archive was checked against its release's official HTTPS `SHASUMS256.txt` before extraction:

| Archive | SHA-256 |
|---|---|
| `node-v26.12.1-darwin-arm64.tar.gz` | `1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8` |
| `node-v24.22.1-darwin-arm64.tar.gz` | `89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7` |
| `node-v20.12.0-darwin-arm64.tar.gz` | `422a74b7ede14b697a8c2ca887ea161fe79898a35f163fdfb98435c5ab25027b` |

These are checksum checks over HTTPS, not an independently verified release-signature chain. Node 20 is not the development/default runtime and is not recommended as a new installation.

## Intermittent cleanup assertion and bounded deferral

The earlier concurrent Node 24/26 run retained an ignored build directory instead of deleting it; its original precise cause cannot be reconstructed because the CLI output was discarded. The preserved fixture remains idle, ignored and selectable in a subsequent read-only check. A bounded Git timeout is a reachable explanation, not proof of that historical call's result.

A forced FIFO stall now reproduces a concrete defect in the same path: Git times out safely, but the old implementation silently stamped the weekly repo pass complete. It postponed retries for seven days despite incomplete verification. The fix propagates repo/path/reason diagnostics, marks the hook outcome deferred and leaves the sweep due. A deterministic regression verifies that both CLI and native-hook entry points retain the output, report `ETIMEDOUT`, and that the next ordinary Stop retries successfully once the fixture's Git configuration is repaired.

The Git timeout remains **200 ms**; no production bound was relaxed and no blind test retry was added. The older CLI positive control now captures its result and accepts retention only when that exact path has an explicit Git timeout, a deferred result and no completion stamp. Silent retention or a wrong-path error still fails. All three final matrix runs took the normal deletion path; the dedicated FIFO test separately exercises timeout and recovery.

Earlier installer fixes remain covered: validate target parents/type at backup and activation; compare bytes and permissions; record write intent only after conflict checks. Rollback cannot claim a refused pre-activation user edit as its own output. Post-activation edits remain recovery conflicts.

## Limited native checks - not full host acceptance

Native executables ran in fabricated homes with private configuration/state, no credentials and **no model/user turn**. The existing Claude/Codex processes and their settings were not changed.

| Probe | Observation | What it does not establish |
|---|---|---|
| Codex hook discovery/trust | The actual app-server recognised all three computed hashes as trusted and enabled. | Lifecycle dispatch, sandbox writes, installed-user configuration, or model turns. |
| Claude SDK initialisation then input EOF | Actual SessionStart and SessionEnd hooks completed successfully under 0.6.1; child exited 0 without a timeout. | Stop, resume, sandbox writes, five-seat native authentication or live deployment. |
| Codex no-turn start/archive/resume exploration | Archive dispatched SessionEnd; cleanup safely reported `unknown session`. The host refused resuming the still-archived thread. | This was not a valid full lifecycle acceptance sequence and is not evidence of a Clean Development defect. No model turn, registered start or successful resume is claimed. |

The executables reported Claude Code 2.1.310 and Codex CLI 0.163.0-alpha.10.2 during this validation period. Native probes are deliberately separate from `npm test`; ordinary source tests never launch actual hosts.

## Fingerprints and retained log locators

Runtime digest algorithm: `sha256(sorted-relative-name,NUL,decimal-permissions,NUL,bytes)`.

```text
runtime:       cb74e292d14c12c5129725aba65286d13361b0e951983448903072ceb77d5161
installer.mjs: 90e261e9fe91318fbbe7ba826d1e1ecc69627d4139e086d7540d2d2c58edf6d3
```

The runtime fingerprint supersedes the earlier 96-case record after the Git-deferral change. It covers the runtime tree only; the installer hash covers that single file, not the whole monorepo.

Scratch prefix: `/private/var/folders/h2/yg809k5n6j76t8bjyrls2g680000gn/T/opencode/`. Raw logs are session-local locators, not promised permanent storage. This record preserves the minimum results and fingerprints.

Final matrix directory: `cd-final-matrix.Jmv0Pv`.

| Log | SHA-256 |
|---|---|
| `node-26.12.1-tests.log` | `69b37291c2f08d5c9caef7a11c03b289a8e838b4560ebd3bf286b58cc4a3cfda` |
| `node-24.22.1-tests.log` | `912975f043ced42e2b5c40e94f8181f0929ed6d0c6c4d13dda02598c294f2207` |
| `node-20.12.0-tests.log` | `9e481c82349c7b3b0beeafc04a907d829c6811b64f4c830d48eac8ddfecbfe77` |
| Each `node-VERSION-check.log` | `b711ed861cba0c392311e6fb115221d7b7fde9e23ae59cac2cdf7a3140a83788` |

Native probe locators: `cd-native-trust.rk6Zoz/{stdout,stderr}.log`, `cd-native-claude.nBBmqS/result.json` and `cd-native-codex.Lmqz6x/{result.json,stdout.log,stderr.log}`. Generated protocol schemas and all host-created state stayed in those private scratch workspaces, not in the repository.

## Review and remaining gates

Source/release checks, adjacent shell/Python syntax checks, `git diff --check` and focused redacted Gitleaks scans passed. No live helper was run to rebuild configuration, refresh real hook trust, reprovision seats or clean caches. The implementation retains the scope/limitations in [safety-release.md](safety-release.md); this is not a new claim of workload supervision, strict quotas or hostile-filesystem protection.

The original checkout stays on `main`; feature-branch commits do not authorise a merge or deployment. Several live Claude/Codex processes were present, and the 4TB volume was absent. Under the user's latest non-interference instruction, the following remain deferred:

1. Full native start/resume/Stop/end, actual sandbox writes and late-generation event semantics, including all five native seats.
2. Real removable/read-only/reconnected media acceptance with disposable media and ordinary workflows stopped. The existing SD was not borrowed as a test target.
3. Reversible canary installation/rollback and wider rollout after quiescing conflicting old/new cleanup writers. Isolated fabricated-HOME deployment/failure/rollback fixtures already pass; they are not live rollback acceptance.

Do not terminate current sessions, alter their accounts or silently install the release to close these gates. Resume live acceptance only at an agreed safe pause point.
