# Release validation for 0.6.1

Version **0.6.1** is the first published source release of the storage-routing
0.6 rewrite. The previous public release is v0.5.0. The 0.6.0 changelog entry
records the rewrite's development milestone; no v0.6.0 release was published.

This replaces the former multi-host/npm package. At the time of release, support
covered storage routing and lifecycle hooks for macOS with Claude Code and Codex.
OpenCode remains environment-only. The former Windows, SwiftPM and
other host adapters are outside this version's scope. There is no npm publish
step; GitHub distributes the source archive and its SHA-256 checksum.

## Fresh local checks

| Source layout | Runtime | Node tests | Shell assertions | Source/release checks |
|---|---|---|---|---|
| Source copy | Node 26.10.0 | 91 passed, 6 skipped | 52 passed | Passed |
| Source copy | Node 24.21.0 | 91 passed, 6 skipped | 52 passed | Passed |

Every run used a fresh, explicit fixture directory with fabricated homes and
volumes. Six optional integration checks were skipped because they require
adjacent tools or authenticated host configuration. The component's installer,
hooks, trust editor and safety tests still ran.

The table above reports the versions used for the fresh source checks. The GitHub Actions workflow runs
macOS checks on exact Node 20.12.0 and Node 24/26. Required
Linux checks exercise source syntax and isolated Node fixtures on Node 20/22/24;
the macOS-specific shell assertions run only on macOS. CodeQL remains enabled.
These compatibility checks do not add Linux or Windows deployment support.

`git diff --check`, release identity checks and a redacted Gitleaks directory scan
passed. CI actions retain the reviewed SHA pins from already-merged Dependabot
PR [#63](https://github.com/magrathean-uk/clean-development/pull/63). The original
multi-host packaging workflows and npm publication are superseded by source
validation, with existing required checks preserved.
The MIT licence is included in the distribution.

## Deployment boundary

Publishing this release does not install the runtime or alter active hooks,
trust preferences, accounts, mounts or services. Source tests do not establish
full native-host, removable-media or canary rollback acceptance. Those remaining
gates and recovery requirements are recorded in [safety-release.md](safety-release.md).
Live deployment remains a separate operation.
