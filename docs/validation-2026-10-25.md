# Source validation - 25 October 2026

> Historical snapshot. The [current validation record](validation-2026-10-25-current.md) supersedes this record's test totals, runtime fingerprint and outstanding Node 20 status. Intermediate observations and log identities below are retained, not current-release claims.

Clean Development **0.6.1**, branch `feat/clean-development-safety`, based on `d5edf8097068eb0b837f0bfd6f5e2d5755516d01`. Implementation and review artefacts remain uncommitted and unpushed. This record describes isolated source tests, **not deployment or native-host acceptance**.

## Final results

| Interpreter | Node tests | Shell assertions | Source/release checks |
|---|---|---|---|
| Node 24.21.0 | 96 passed; 0 failed, skipped or cancelled | 52 passed; 0 failed | `npm run check` passed |
| Node 26.10.0 | 96 passed; 0 failed, skipped or cancelled | 52 passed; 0 failed | `npm run check` passed |

One of the 96 Node cases wraps **91 offline profile-test executions** using fabricated HOME, CLIs, login records and mocked VPS responses. Those executions are nested coverage, not 91 additional independent Node cases or production validations. The wrapper deliberately supplies a symlinked TMPDIR. Shell coverage includes stock Bash 3.2.57 and zsh 5.9.

These final runs include the non-expiring publication-hold regression: failed copying remains protected after parent end and a simulated year of elapsed time; ordinary lease release is refused; explicitly recovery-confirmed release permits subsequent cleanup. They also include the continuation fixes below and supersede the earlier 92-case results for current source.

## Continuation fixes and intermediate failures

- A rerun using macOS's `/var/...` TMPDIR alias failed the profile wrapper: manager paths were canonical `/private/var/...`, while fixture expectations retained the alias. `WorkTests.setUp` now canonicalises the fabricated base, and the wrapper always exercises an explicit symlinked temporary parent. No production profile, login or manager path was changed.
- New failure-injection tests reproduced activation overwriting a permission-only user change or replacing a new leaf link whose bytes matched the backup. Backup and activation now revalidate real-directory parents and regular-file targets; activation compares both bytes and permissions. Write intent is recorded only after validation. An additional reproduced reinstall case verifies that rollback cannot mistake a pre-existing user permission change matching planned output for its own write. Four added tests cover these boundaries, including link replacement before backup.
- An intermediate concurrent Node 24/26 run had one Node 24 positive-control failure: `repo-local declared build dirs` retained the ignored build directory instead of removing it. The isolated case and the subsequent complete serial Node 24 run passed; the precise cause was not established. This records a load-sensitive validation failure, not proof of deletion or a fixed runtime defect. Runtime budgets were not relaxed, and no retry was added to mask the assertion. The failed full log remains at `cd-continuation-final-node24.XCfwEP/tests.log` under the scratch prefix below.

Additional checks passed:

- `git diff --check`.
- Syntax checks for the adjacent reprovision, Claude-tooling installer and OpenCode client launcher scripts; in-memory Python compilation of the hook merger, both Codex helpers and profile provisioner, without bytecode writes.
- Redacted Gitleaks scans of `clean-development/`, `bin/`, `reports/`, `research_notes/` and the tracked diff; no findings. These are focused scans, not an assertion about every historical repository file.
- Continuation checks repeated `git diff --check`, the source/release checks and redacted Gitleaks scans of `clean-development/` and the tracked diff; no findings. The modified Python fixture compiled in memory without bytecode writes.
- The original `~/dev/source/bolyki-dev` checkout remains clean on `main`; no commit, push, live installation, hook merge, service/account change or real mount operation was performed.

## Runtime fingerprint

Computed using `treeDigest("runtime")` from `runtime/lib/release.mjs`:

```text
algorithm: sha256(sorted-relative-name,NUL,decimal-permissions,NUL,bytes)
runtime:   3bc7bbc53366fbce584765050ea270d049f631c176c317eec57503c4b2702739
```

This covers runtime names, file permissions and bytes only, not the entire implementation, installer or monorepo. It supersedes the pre-publication-hold runtime fingerprint.

The continuation did not alter runtime bytes. The separately changed `installer.mjs` file has SHA-256 `90e261e9fe91318fbbe7ba826d1e1ecc69627d4139e086d7540d2d2c58edf6d3`.

## Log identity and reproduction

The final raw logs remain in session-local scratch; their paths are locators, not guaranteed permanent retention. This record preserves the minimum result summary and fingerprints; the regression tests remain in source.

Scratch prefix: `/private/var/folders/h2/yg809k5n6j76t8bjyrls2g680000gn/T/opencode/`.

| Run directory | File | SHA-256 |
|---|---|---|
| `cd-continuation-serial-node24.SL9poy` | `tests.log` | `d05a37c601c2d9f3b37a49fc585ca00f7a986538467d421082c42300e9fca21d` |
| `cd-continuation-serial-node24.SL9poy` | `check.log` | `b711ed861cba0c392311e6fb115221d7b7fde9e23ae59cac2cdf7a3140a83788` |
| `cd-continuation-final-node26.uW2tiG` | `tests.log` | `db5ff160d1f47ad44a5d2dcbecfb26c5e193ecfd4cb14d22315b5d6b2cad3941` |
| `cd-continuation-final-node26.uW2tiG` | `check.log` | `b297abc4b36ef29359344bdda6fdba78368dded7fe1d2ff720af5134982621a4` |

Earlier 92-case evidence is retained for provenance, not current-source acceptance:

| Run directory | File | SHA-256 |
|---|---|---|
| `cd-final-proof-node24.OT48jd` | `tests.log` | `7f3505186f9b890af4f8b412d3bf52eae9e0e232c7b3f7138c40b40c02fff5b8` |
| `cd-final-proof-node24.OT48jd` | `check.log` | `b711ed861cba0c392311e6fb115221d7b7fde9e23ae59cac2cdf7a3140a83788` |
| `cd-final-proof-node26.8pvspi` | `tests.log` | `cfa731e290fd7d2c79e2a51dcf64f7ae97f63faf301a883e266aa6232159d161` |
| `cd-final-proof-node26.8pvspi` | `check.log` | `b297abc4b36ef29359344bdda6fdba78368dded7fe1d2ff720af5134982621a4` |

From `clean-development/`, select each available Node version in a separate shell, then run one full version suite at a time:

```sh
source ~/dev/machine/env.zsh
export PATH="$HOME/dev/machine/toolchains/node/v24.21.0/bin:$PATH" # repeat with v26.10.0
node --version
proof=$(clean-development run --session session-only -- mktemp -d "$TMPDIR/cd-proof.XXXXXX")
CLEAN_DEV_TEST_DIR="$proof/fixtures" clean-development run --session session-only -- npm test
clean-development run --session session-only -- npm run check
```

Use a fresh absolute fixture root each time; shell tests deliberately refuse reuse. The package uses `node --test test/*.test.mjs`, not the directory argument rejected by Node 24. The `run` command is a compatibility shim, not a lease or workload supervisor.

## Not accepted by these tests

Node 20 was unavailable and is untested. Actual Claude/Codex dispatch, five-seat native-host operation, real removable/read-only/reconnected storage and deployment/rollback canaries remain unperformed. OpenCode remains environment-only; the source client-launch fixture does not validate a reused server or the other installed launcher. Full-ID routing, hostile path-swap protection, general workload budgets and historical restore-kit regeneration remain outside this patch.

See [release scope and rollout gates](safety-release.md) before any separately approved deployment.
