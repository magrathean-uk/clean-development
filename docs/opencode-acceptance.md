# OpenCode additive environment acceptance

## Status recorded on 27 September 2026

**Real-host acceptance is BLOCKED, not passed.** No OpenCode executable is installed in the execution container. Registry and GitHub downloads failed; the explicit host probe exits nonzero with `ENOENT`. Its evidence records `hostVersion: null`, `hostBinarySha256: null`, `status: "blocked"` and no executed host cases. Do not interpret the skipped opt-in test as acceptance, or the source driver as OpenCode.

The source-contract regression is fixed and passes on Linux x64 with Node **v22.16.0**, npm **10.9.2**. A separate read-only Go observation used **go1.23.2 linux/amd64**. All project, home, configuration, runtime and cache paths were disposable. Neither contributor settings nor existing build storage were used.

Source base: `af12577c6596095fdf91f18e840e9433521ea3d2`; complete upstream tree: `998605cda006d588e9562cabe1eee6c78c2f3a59`. Direct Git networking was unavailable. The uploaded source archive's commit comment and reconstructed Git tree both matched upstream before editing. The local snapshot commit `aeeb2b8099323ca552f37694cb624aad4ad53eea` in the blocked probe is only the local archive import, **not** a different upstream revision; `sourceDirty: true` records the candidate changes. The published PR records the final tested tree and real upstream parent.

Candidate plugin SHA-256: `6ade84fed0c99a857064de67499f5d6186b5578c1497216cfea31a18518ba4ad`.

`AGENTS.md`, the architecture, safety model and OpenCode integration section were read. Open PRs #24–#33 were inspected before editing. #29 changes general cache-provenance retention, a related but distinct layer; this change does not incorporate or modify it. #33 owns general integration settings/documentation. Only the OpenCode plugin, the new [fixture](../test/opencode-acceptance.test.js), and this document change.

## Reproduced defect

On POSIX, environment names are case-sensitive. The plugin's removal guard instead compared every name case-insensitively. A parent containing both an unchanged recorded `GOCACHE` injection and an independent `gocache` value was incorrectly allowed into a disabled project:

```text
Parent:
  CLEAN_DEVELOPMENT_SESSION_MODE=session-only
  CLEAN_DEVELOPMENT_SESSION_ENV={"GOCACHE":"<LAB>/old-cache"}
  GOCACHE=<LAB>/old-cache
  gocache=<LAB>/user-cache
Project:
  {"schemaVersion":1,"enabled":false}
```

The general session cleanup correctly removed `GOCACHE` and retained `gocache`. The plugin then mistook the retained spelling for the removed spelling and returned `skip`, with provenance cleared. An additive `{ ...parent, ...output.env }` merge restored the omitted parent `GOCACHE`.

Before the fix, the actual plugin plus a Node source driver and a **real Go subprocess** produced:

```json
{"accepted":true,"mode":"skip","marker":"","GOCACHE":"<LAB>/old-cache","gocache":"<LAB>/user-cache","actualGoCache":"<LAB>/old-cache","childError":""}
```

`actualGoCache` came from `go env GOCACHE`; this did not run a build or invoke OpenCode. After the fix the plugin throws before the child is started:

```text
OpenCode cannot safely unset inherited Clean Development routing (GOCACHE).
Relaunch OpenCode through clean-development agent opencode, or use --session skip.
```

Four test-first regressions cover disabled-project and explicit-skip entry, each with `npm_config_cache`/`NPM_CONFIG_CACHE` and `GOCACHE`/`gocache`. All four failed on the unchanged plugin and pass after the fix. Controls retain an independent same-spelling user replacement and reject an unchanged injection even without another spelling.

The production change only makes the removal guard match POSIX key identity; Windows retains case-insensitive comparison. It does not unset variables in the host, overwrite an independent cache with an empty string, infer ownership from a path, or change general routing. Uncertain removal remains an exception rather than a falsely successful disabled launch.

## Executed versus pending matrix

| Case | Executed source-contract result | Real OpenCode result |
| --- | --- | --- |
| Startup before setup | Skip, original PATH, native tool artifact; no managed runtime/root created | NOT RUN |
| Ordinary startup after explicit setup | Skip with stable shim PATH, native tool artifact | NOT RUN |
| Explicit `agent opencode --session session-only` | Launcher defers parent cache/provenance; supported child writes managed cache | NOT RUN |
| Same process A → B → disabled → A | Correct per-project destinations; disabled receives native PATH, skip and neutral internal flags | NOT RUN |
| Independent inherited cache | Preserved in enabled and disabled projects | NOT RUN |
| Recorded old cache beside another spelling | Rejected before any shell/tool artifact, in disabled and skip modes | NOT RUN |
| Uninstall | Native artifact afterwards; uninstall receipt unchanged and shim not recreated | NOT RUN |

The source tests launch the real Clean Development CLI/plugin and real Node/shell processes, but deliberately use an artifact-producing **fake npm** and a **fake OpenCode driver**. They establish plugin/launcher contracts and artifact placement, not host loading or actual npm behaviour. Before/after hashes protect all fixture manifests and pre-existing project configuration. Project-local `target` absence is a no-write check, not Cargo-build acceptance.

## Run the fixture

The normal suite is offline, has no downloads or model calls, and explicitly skips the live case without a supplied host:

```sh
node --test test/opencode-acceptance.test.js test/session.test.js
npm run check
npm test
```

For live acceptance, use an independently installed OpenCode binary on a disposable POSIX test machine. Supply an **absolute executable path** and an **absent absolute evidence file**, with its parent directory already present:

```sh
OPENCODE_ACCEPTANCE_BINARY=/absolute/path/to/opencode \
OPENCODE_ACCEPTANCE_EVIDENCE=/absolute/evidence/opencode-result.json \
node --test --test-name-pattern='OpenCode REAL HOST' test/opencode-acceptance.test.js
```

An explicitly supplied missing/broken binary fails; it never turns into a skip or a source-driver fallback. The host must report an exact `--version`; the fixture hashes the executable and requires `/global/health` to report the same version. It requires the running host's `/doc` to expose `/pty` before sending commands.

The opt-in protocol starts real `opencode serve` processes bound to `127.0.0.1` on an ephemeral port with a random HTTP password. It uses allowlisted environments, isolated HOME/XDG/agent configuration, disabled sharing/autoupdate/default plugins/models fetch, and no provider credentials. A local instrumentation plugin delegates to the actual Clean Development hook and records only selected routing fields. The test uses authenticated HTTP PTY creation, not a model prompt; it checks both actual child artifact files and hook execution. A hook exception that is ignored by the host fails the test. A real host lacking the necessary endpoint/plugin support also fails, rather than being labelled compatible.

The live sequence includes startup before setup, setup within that running host, routed A/B/disabled/A requests, independent overrides, deliberately seeded legacy/external inherited routes, uninstall while running, and an ordinary restart after uninstall. The seeded legacy cases require HTTP rejection, a matching hook error, absent child artifacts and no old-cache directory. They do not simulate a host transition by merely calling the plugin in Node.

Host output is bounded to its last 64 KiB, HTTP responses to 2 MiB while reading, requests to 15 seconds and startup to 30 seconds. Spawned host groups receive bounded termination on completion/failure; fixture trees are retained for inspection by the live case. No model-tool workflow, TUI lifecycle, package installation, billing/token neutrality, macOS or Windows acceptance is claimed by a PTY pass.

## Redacted artifacts and checks

`<LAB>` is the canonical newly created disposable root; `<SOURCE>` is the checkout; `<OPENCODE>` is the supplied executable. These are path substitutions, not invented observations. The fixture's JSON contains only allowlisted environment fields, never the HTTP password or provider credentials. Review retained raw local files before sharing; only the exported redacted result is the intended shareable record.

Exact artifact layout for the live protocol:

```text
<LAB>/evidence/result.json
<LAB>/evidence/hook.jsonl
<LAB>/evidence/<host-name>-host.log
<LAB>/evidence/<case-name>-shell.json
<LAB>/evidence/<case-name>-tool.json
<LAB>/managed/caches/node/npm/<case-name>.sentinel
<LAB>/cache-b/node/npm/<case-name>.sentinel
<LAB>/home/native-npm/<case-name>.sentinel
<LAB>/user-cache/<case-name>.sentinel
```

Case names include `host-before-setup`, `host-after-setup`, `host-routed-a`, `host-switch-b`, `host-disabled`, `host-return-a`, `host-user-a`, `host-user-disabled`, `host-stale-false`, `host-stale-true`, `host-pre-uninstall`, `host-after-uninstall`, and `host-uninstalled-restart`. Rejected cases must not create either child JSON file or a sentinel. Host names/log prefixes are `ordinary`, `launcher`, `user-override`, `unsafe-false`, `unsafe-true`, `uninstall`, and `uninstalled-restart`.

The attached validation archive contains `availability.log`, `reproduction-before.json`, `reproduction-after.json`, `regression-before.log`, `focused-after.log`, `check.log`, `npm-test.log`, `real-host-blocked.log`, `real-host.json` and a revision/check manifest. The blocked host record contains no successful host health check, hook invocation or child artifact. Source-only artifact observations are labelled as such in `focused-after.log`.

| Check | Recorded result |
| --- | --- |
| New fixture on original plugin | 3 passed, 4 failed as expected, 1 live-host skip |
| Fixture plus session tests after fix | 26 passed, 0 failed, 1 live-host skip |
| `npm run check` | Passed, including existing bundle parity; no bundle edits needed |
| `npm test` | 367 passed, 0 failed, 28 skipped; 395 total |
| Explicit unavailable-host probe | Nonzero; blocked, host version null, no host cases |
| `git diff --check` | Passed |

The full-suite skips are the unavailable live OpenCode case, 26 native-Windows cases and one real-Cargo case because Cargo is unavailable. They are not passes. No release-upgrade or package-distribution acceptance is claimed.

## Upstream boundary and remaining limits

Source review used OpenCode **v1.18.32**, release target `f5ce4f881e477c7b75421cea2d20939f0ddd71fb`, published 21 September 2026. This is the reviewed source version, **not an executed host version**. Its [shell implementation](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/tool/shell.ts) merges `process.env` and `extra.env`; its [PTY hook bridge](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/plugin/pty-environment.ts) invokes `shell.env`; the [PTY handler](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/server/src/handlers/pty.ts) obtains that environment before creating the PTY. Reading those sources does not prove how an installed binary behaves.

A change of working directory inside a single already-launched shell is not another host hook event. Other plugins or user commands can replace environment values after this hook; this integration is not a sandbox. Unrecorded or lost provenance must not be guessed from cache paths. Native Windows key identity still requires native validation. Before promoting this OpenCode route from unverified, run the opt-in test on an accessible installed host and inspect its exact version, artifacts and rejection evidence; model-shell/TUI acceptance remains a separate boundary.
