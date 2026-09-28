# Pi 0.87.1 acceptance protocol

## Status and evidence boundary

**Live Pi acceptance is blocked, not passed.** On 27 September 2026 the available
Linux x64 runner had Node v22.16.0 and npm 10.9.2, but no installed Pi executable
or package. A registry probe for the exact
`@earendil-works/pi-coding-agent@0.87.1` package failed with
`getaddrinfo EAI_AGAIN registry.npmjs.org`; GitHub cloning also failed DNS
resolution. No Pi process, Pi Bash tool call or Pi-produced artifact was observed.
The version below is a **protocol target**, not an installed version observed on
this runner. Keep the Pi row in [agent integrations](agent-integrations.md)
unverified until a complete host run supplies its own evidence.

This change starts from `main` at
`af12577c6596095fdf91f18e840e9433521ea3d2`, whose complete tree is
`998605cda006d588e9562cabe1eee6c78c2f3a59`. The supplied archive reconstructed that
exact tree. Local execution used an archive-backed Git repository with a
synthetic baseline commit, not fetched upstream history. Source fingerprints
and Git worktree status are recorded separately so an uncommitted fixture cannot
masquerade as a clean tested commit. The PR commit is parented to the actual
upstream base.

`AGENTS.md`, the integration guide, architecture and safety model were read.
Open PRs #24–#33 were checked before editing; none declared Pi extension ownership.
This work adds only this document and the Pi fixture/tests. It does not change
`.pi/extensions/clean-development.ts`, general routing, other integrations,
package dependencies, contributor settings or CI. There is no speculative
production fix based on an unrun host.

## Run on an isolated Linux host

Requirements: Linux with `/proc`, `/bin/bash`, Git, Node/npm supported by the named
Pi release, and a reviewed installation of the exact npm package. This protocol
uses the npm-installed Node CLI, not the standalone Bun binary. It does not
install Pi automatically or search a contributor's global agent configuration.
An existing separately installed package can be supplied directly to the final
command below. To install one in a disposable prefix first:

```sh
HOST="$(mktemp -d)"
NODE_DIR="$(dirname "$(command -v node)")"
mkdir -p "$HOST/home" "$HOST/npm-cache" "$HOST/pi"
: > "$HOST/user.npmrc"
: > "$HOST/global.npmrc"
env -i HOME="$HOST/home" PATH="$NODE_DIR:/usr/bin:/bin" \
  npm_config_userconfig="$HOST/user.npmrc" \
  npm_config_globalconfig="$HOST/global.npmrc" \
  npm_config_cache="$HOST/npm-cache" npm_config_audit=false \
  npm_config_fund=false npm_config_update_notifier=false \
  npm install --prefix "$HOST/pi" --ignore-scripts --save-exact \
  @earendil-works/pi-coding-agent@0.87.1

# Run from this repository; the report destination must not already exist.
node test/pi-acceptance/acceptance.mjs --live \
  --pi-package "$HOST/pi/node_modules/@earendil-works/pi-coding-agent" \
  --report "$HOST/pi-acceptance.json"
```

Installation requires network access. Installation/startup/dependency failures
are blockers, not permission to use another version or count a loader pass.
Retain the resulting installation lockfile when distributing host evidence.
The fixture checks the installed package name/version, its contained CLI path,
CLI SHA-256, and the actual `--version` output before host testing. A manually
relabelled or modified package is not valid acceptance evidence.

The driver creates a separate fresh temporary HOME, application data, managed
storage, npm configuration/cache, Pi agent directory, source-package copy and
project. Its child environment is an allowlist: no inherited API credentials,
`NODE_OPTIONS`, shell startup injection, agent settings or cache-routing state.
Only trusted Node/npm executables are linked into its disposable tools directory.
It seeds unrelated Claude settings and Pi package settings and checks their bytes.
It uses real npm packages packed locally without dependencies or install scripts;
cache operations are offline. No contributor build storage is touched.

Exit **0** requires every live case and its evidence checks to pass. Exit **2**
means a prerequisite/host blocker; exit **1** means a failed invariant, host-run
failure or invalid invocation. Cases not reached remain `blocked`, never `passed`.
The report includes the observed version or `null`, machine/kernel/Node, source
commit/tree/worktree status, source fingerprints, invocation, actual spawned
command, process evidence, artifact hash/location, and per-case result. Portable
JSON replaces known source, Pi-package and fixture path prefixes with `$SOURCE`,
`$PI_PACKAGE` and `$FIXTURE`; the local fixture locator is printed to stderr.

## What the live driver must prove

Pi runs as a real long-lived CLI subprocess in RPC mode. A fixture-only HTTP
provider bound to `127.0.0.1` returns one deterministic Bash tool call per case,
then a final response. There are no paid model requests or credentials. The
normal Pi tool executor must consume that response and run the registered Bash
tool. The driver does **not** substitute RPC's separate user `bash` command,
a mocked ExtensionAPI, an imported `createBashTool`, or a package-loader test.
It waits for `agent_settled`, checks tool start/end events and rejects unexpected
provider requests or errors.

| Case | Required live evidence | Recorded here |
| --- | --- | --- |
| Discovery before setup | Discover the copied package through isolated Pi `settings.json`; run real npm; mode is skip; no application data/managed root appears; no runtime path is exposed | Blocked |
| Native default after setup | Explicit `setup --agents pi`; validate the owned receipt/inventory; the same Pi process exposes only the owned stable bin; ordinary npm still uses the native cache | Blocked |
| Modified owned launcher | Modify only a disposable installed npm launcher; the same host rejects it with the specific ownership error before spawning Bash; restore the exact bytes | Blocked |
| Explicit session-only | Native Bash launches `clean-development run --session session-only -- /bin/bash -c ...`; actual npm payload bytes appear only in the managed cache | Blocked |
| Nested explicit skip | A routed shell starts a nested explicit skip; native npm cache and native PATH return without stale managed routing | Blocked |
| Inherited session-only | Start a second real Pi through explicit `clean-development run --session session-only`; its own native Bash tool and npm lifecycle child preserve routing | Blocked |
| Uninstall stops exposure | Uninstall while the first Pi stays running; subsequent Bash uses native tools/cache and cannot recreate owned launchers; retain unrelated bin content, settings and existing managed artifacts | Blocked |

Each successful shell case requires **all** of the following evidence:

- A fixture-only Node preload observes the original `child_process.spawn` call
  without altering its arguments/options. The actual host Bash argv must be
  exactly `['-c', requestedCommand]`, with the expected cwd. This observer is
  passed explicitly to the disposable Pi process; it is not product telemetry
  or a persistent `NODE_OPTIONS` change.
- A real direct Node child and a real `npm run` lifecycle child independently
  capture `/proc/<parent>/cmdline`, cwd, command resolution and selected routing
  variables. Missing process evidence cannot pass. Pi's own `agent-dir/bin`
  prefix is accounted for explicitly; arbitrary extra PATH entries are rejected.
- The SHA-256 of a uniquely packed tarball must match a content file in the
  expected npm `_cacache/content-v2` and must be absent from the other cache.
  An environment value, directory existence, an empty cache, or a printed path
  alone is insufficient. Source/package/project/config fingerprints must remain
  unchanged, including detection of unexpected empty project directories.

Skip has a deliberate nested distinction: the outer native Pi shell may expose
the stable management CLI after setup, but a skipped npm shim removes that
owned bin before launching native npm. Its lifecycle child therefore has native
PATH, not continued runtime exposure. Routed npm lifecycle children retain the
managed bin and cache. The ordinary CLI control test exercises this distinction.

The fixtures impose command/RPC/provider deadlines, bounded captured output and
bounded file scans. Host shutdown closes stdin, then escalates within the
fixture's process group. Unconfirmed cleanup fails the run and retains its
fixture. Live runs retain their disposable directories for inspection rather
than recursively deleting an operator-supplied path. Review the stderr locator
and stop any surviving fixture processes before manually removing that one
created directory. This is not OS-level containment of arbitrary malicious
extensions or detached descendants.

## Repository checks and remaining work

```sh
node --check test/pi-acceptance/acceptance.mjs
node --test test/pi-acceptance.test.js
npm run check
npm test
```

The ten dependency-free fixture-control tests passed locally. They validate
isolation, snapshot/quoting/redaction behaviour, missing/wrong-host blockers,
loopback protocol validation, RPC failure/shutdown handling, deadlines and real
CLI-only npm artifacts through setup, routing, nested skip and uninstall.
They also reject missing child evidence and a wrong routing expectation.
**None is a Pi host acceptance pass.** Ordinary `npm test` never downloads Pi,
uses credentials, or silently substitutes a fake Pi host. The opt-in driver is
inert when the test runner discovers it.

`npm run check` passed. The complete local suite passed with 371 passes, 27
skips and zero failures (398 total). The skips are the existing 26 native-Windows
cases and one real-Cargo case because Cargo is absent. Native macOS/Windows,
standalone Pi binaries, registry installation of Clean Development, other Pi
versions, interactive `!` user Bash, resume/project switching, Cargo/uv/other
adapter builds, and production model providers are **not** certified by this
protocol. It also makes no billed-token-neutrality claim.

The unresolved delivery item is a complete run on the exact real Pi package,
with the JSON evidence attached and every host case evaluated. Until then this
is an executable, locally validated **protocol**, not a promoted native route.

## Version-pinned primary references

The protocol follows Pi 0.87.1's interfaces rather than assuming current main:
[CLI](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/cli.md),
[RPC](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/rpc.md),
[configuration](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/configuration.md),
[compatible providers](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/models.md),
[Bash executor](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/tools/bash.ts),
[shell environment](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/utils/shell.ts),
and [agent bin location](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/config.ts).
