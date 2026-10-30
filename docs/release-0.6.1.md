# Release validation - 30 October 2026

Version **0.6.1** is the first published source release of the machine-scoped
0.6 rewrite. The previous public release is v0.5.0. The 0.6.0 changelog entry
records the rewrite's development milestone; no v0.6.0 release was published.

This replaces the former multi-host/npm package. Current support covers storage
routing and lifecycle hooks for G's Mac: Claude Code, Codex and numbered Claude
profiles. OpenCode remains environment-only. The former Windows, SwiftPM and
other host adapters are outside this version's scope. There is no npm publish
step; GitHub distributes the source archive and its SHA-256 checksum.

## Fresh local checks

| Source layout | Runtime | Node tests | Shell assertions | Source/release checks |
|---|---|---|---|---|
| Monorepo, including adjacent tools | Node 26.10.0 | 97 passed, 0 skipped | 52 passed | Passed |
| Standalone copy | Node 26.10.0 | 91 passed, 6 skipped | 52 passed | Passed |
| Standalone copy | Node 24.21.0 | 91 passed, 6 skipped | 52 passed | Passed |

Every run used a fresh, explicit fixture directory with fabricated homes and
volumes. Standalone skips cover the numbered Claude profile suite, three
monorepo Codex configuration/trust helpers, reprovision rollback and the
monorepo OpenCode launcher. Those files are not part of this distribution.
The component's own installer, hooks, trust editor and safety tests still run.
Adjacent installer preview checks run only when that installer is available;
Clean Development's preview and unknown-flag checks always run.

The pinned development runtime remains Node 26.12.1. The earlier
[validation matrix](validation-2026-10-25-current.md) records separate runs on
26.12.1, 24.22.1 and the minimum supported 20.12.0; the table above reports the
versions actually installed for this fresh local check. The standalone GitHub
Actions workflow runs macOS checks on exact Node 20.12.0 and Node 24/26.

`git diff --check`, release identity checks and a redacted Gitleaks directory scan
passed. CI actions retain the reviewed SHA pins from already-merged Dependabot
PR [#63](https://github.com/magrathean-uk/clean-development/pull/63). The original
multi-host workflows and npm publication are superseded by source-only macOS CI.
The MIT licence is included in the distribution.

## Deployment boundary

Publishing this release does not install the runtime or alter active hooks,
trust preferences, accounts, mounts or services. Source tests do not establish
full native-host, removable-media or canary rollback acceptance. Those remaining
gates and recovery requirements are recorded in [safety-release.md](safety-release.md).
Live deployment remains a separate operation.
