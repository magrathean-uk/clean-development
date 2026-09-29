<h1 align="center">clean-development</h1>

<p align="center">Routes new development caches and build output to a managed root, for developers and coding agents.</p>

<p align="center">
  <a href="docs/index.md">Documentation</a>
</p>

## Overview

`clean-development` routes new development caches and supported build output to a managed root. It is a local Node.js CLI for developers and coding agents. Routing is explicit and preserves existing environment values unless force mode is selected.

The current source version is `0.2.1` and requires Node.js `20.12` or newer. The repository is MIT licensed. It has not been published to npm or listed in the official Codex or Claude directories; use this source checkout until a public release is available.

Directory review is separate from public availability. The Claude directory submission passed its automated security scan and is in manual policy review because the bundle contains executable files. The [Codex community submission](https://github.com/openai/community-plugins/pull/21) is open but not live. The global OpenAI directory listing is a draft and has not been submitted because its MCP form blocks the submission.

## Preview a command without running it

From a source checkout, inspect the environment a wrapped command would receive:

```sh
node bin/clean-development.js explain -- npm test
node bin/clean-development.js explain --json -- cargo check
node bin/clean-development.js explain --session skip --json -- npm test
```

After installation, use `clean-development explain` with the same arguments.
This read-only prediction reports the selected executable, project, configuration
sources, managed environment values and preserved overrides. It creates no
runtime, storage directories or receipts and executes no tools or project code.
Cargo identities are provisional until command-time discovery; native flags,
configuration and scripts can choose other paths. It does not prove that an agent
host or the current parent shell is routed. See [command explanations](docs/explain.md).

## Check an installed adapter

```sh
node bin/clean-development.js probe --tool npm --json
node bin/clean-development.js probe --tool npm --execute --json
```

The first command only plans. The second explicitly queries the installed tool
with a temporary project, tool home and cache. Supported probes are npm, Go and uv.
An observed match verifies the adapter in that disposable fixture, **not** the
configured volume, a repository build or an agent session. Overrides and disabled
routing are reported without probing user-owned paths. No repository scripts run.
See [probe scope, limits and cleanup](docs/probe.md).

## Inspect stored builds

```sh
node bin/clean-development.js status --workspaces --sizes
node bin/clean-development.js status --build-budget 20GiB --json
```

The workspace view shows valid registered records, last use, pins, active or uncertain
leases and retention eligibility. Sizes are bounded metadata scans; incomplete or
missing measurements are explicitly unknown, not zero. The build budget is
advisory, covers registered logical bytes only, and never changes retention or
triggers cleanup. Shared caches are not arbitrarily attributed to projects.
See [workspace status and size limits](docs/status.md) and
[read-only inspection guarantees](docs/inspection.md).

## What it manages

When a routed session is active, the CLI provides adapters for:

| Tool | Managed value |
| --- | --- |
| Cargo | Per-workspace `CARGO_TARGET_DIR` |
| Go | `GOCACHE` and `GOMODCACHE` |
| npm and npx | npm cache |
| pnpm | npm cache and pnpm store |
| Yarn | Yarn cache |
| Bun | Bun install cache |
| uv | uv cache |
| pip and pip3 | pip cache |
| dotnet | NuGet packages |
| Composer | Composer cache |
| ccache and sccache | Native compiler cache |

On macOS, `setup` also asks whether to manage Xcode DerivedData and simulator leftovers (default no); see [Xcode management](docs/xcode.md). It does not move `node_modules`, virtual environments, final Go binaries, release archives, Xcode archives, Rust toolchains, credentials, or arbitrary framework output. `CARGO_HOME` is not relocated because it can contain configuration, credentials, installed binaries, and caches together.

The default managed layout is one root with `caches/`, `builds/`, and `scratch/` children. Routed Cargo build workspaces receive ownership records and active-build leases. Scratch storage is reserved; automatic scratch registration and cleanup are not implemented. Pruning is limited to registered direct children of the managed build root and is a dry run unless `--apply` is supplied.

## Install and develop from this checkout

The source checkout uses the standard npm scripts:

```sh
npm run check
npm test
npm run test:package
```

The package has no runtime or development dependency declaration, so a clean checkout does not need `npm install` for these scripts. `package.json` declares Node.js `>=20.12`. `npm run check` validates repository-facing files, `npm test` runs the Node test suite, and `npm run test:package` packs and installs temporary tarballs, including the preceding-release tag named in `scripts/verify-package.mjs`. Run it only with that tag available. A quick check should not use `npm pack --dry-run`: the package's `prepack` hook runs the check and test suite. The fixture lab is a separate offline integration exercise described in [`test/lab/README.md`](test/lab/README.md).

For required real-tool coverage and a source-fingerprinted JSON record:

```sh
node scripts/smoke-real-tools.mjs --require cargo,go,npm --json
```

Missing required tools fail the run rather than silently reducing coverage. The
harness uses predefined offline fixtures, not live agent sessions; see
[verification evidence](docs/verification-evidence.md) for the schema and limits.

The CLI can be run directly without installing a global command:

```sh
node ./bin/clean-development.js --help
node ./bin/clean-development.js status --json
```

For an installed package, the executable is `clean-development`. Setup is explicit and does not run as an npm install side effect. Review a proposed session first when deciding whether to use routing in another repository:

```sh
clean-development session --dry-run --json
```

## Configuration and storage

`setup` resolves a root and selected agent integrations. It creates the managed directories, durable runtime, and user configuration only when run without `--dry-run`:

```sh
clean-development setup --dry-run --root /path/to/artifacts --agents claude,codex
clean-development setup --root /path/to/artifacts --agents claude,codex
```

The project configuration file is `.clean-development.json`. `init` writes a project file, while `prepare` creates or checks the effective cache, build, and scratch directories:

```sh
clean-development init --root /path/to/artifacts
clean-development prepare --dry-run --json
clean-development prepare
```

Paths must be absolute. The parent of an external destination must already exist, so an unavailable mount fails instead of being silently created elsewhere. Resolution precedence is command-line option, environment variable, project configuration, user configuration, then platform default. Supported environment overrides include `CLEAN_DEVELOPMENT_ROOT`, `CLEAN_DEVELOPMENT_CACHE_ROOT`, `CLEAN_DEVELOPMENT_BUILD_ROOT`, and `CLEAN_DEVELOPMENT_SCRATCH_ROOT`.

## Session modes and routing

The session command can inspect or apply one of three modes:

```sh
clean-development session --dry-run --json
clean-development session --session session-only --json
clean-development session --session persist --json
clean-development session --session skip --json
```

The standalone `session` command applies or prepares its choice for that invocation and then exits. It cannot change the environment of its parent shell. Use `run` or `agent` to route a child command. `session-only` routes that child without creating project settings. `persist` may create the reviewed `.clean-development.json`. `skip` leaves ordinary tool storage unchanged. When no explicit mode is supplied, selection first considers inherited `CLEAN_DEVELOPMENT_SESSION_MODE`; noninteractive `agent` and `run` invocations otherwise default to `session-only`, while direct native integrations default to `skip` until an explicit choice is made.

Route a child command with the public wrapper:

```sh
clean-development run --session session-only -- npm test
clean-development run --session skip -- cargo test --offline
```

Cargo should run through the wrapper or Cargo shim because its per-workspace output needs ownership and lease tracking. Shared cache adapters can also be inspected with:

```sh
clean-development env --tool npm --format sh
clean-development env --format json
```

Explicit environment variables win by default. `CLEAN_DEVELOPMENT_FORCE=1` is required to override them. The runtime does not inject prompts, bootstrap text, telemetry, or model calls.

## CLI reference

The executable exposes these commands:

```text
setup [--root PATH] [--agents LIST] [--xcode | --no-xcode] [--dry-run] [--json]
update [--root PATH] [--agents LIST] [--xcode | --no-xcode] [--dry-run] [--json]
prepare [--dry-run] [--json]
session [--session session-only|persist|skip] [--dry-run] [--json]
init [--root PATH] [--force]
agent AGENT [--session session-only|persist|skip] [-- ARGS...]
run [--session session-only|persist|skip] -- COMMAND [ARGS...]
explain [--session session-only|skip] [--json] -- COMMAND [ARGS...]
env [--tool TOOL] [--format json|sh|fish|powershell]
status [--workspaces] [--sizes] [--build-budget SIZE] [--json]
  [--max-scan-entries COUNT] [--max-scan-ms MS]
doctor [--json]
probe --tool npm|go|uv [--execute] [--timeout-ms MS] [--json]
prune [--older-than DAYS] [--apply] [--json]
xcode [status|prune] [--older-than DAYS] [--apply] [--sizes] [--json]
pin WORKSPACE_ID
unpin WORKSPACE_ID
uninstall [--dry-run] [--json]
```

Use `clean-development COMMAND --help` to display CLI usage. Child command options belong after `--`.

`status` reports configured paths and workspace records. `doctor` checks managed directories and owned runtime files without repairing them. `update` refreshes the durable runtime and configured integrations. `uninstall` removes owned integrations and launchers while retaining configuration and managed data. Use `prune --json` first; add `--apply` only when the listed registered workspaces are intended for removal. `xcode status` and `xcode prune` (macOS, opt-in) follow the same dry-run-first rule.

## Safety boundaries

The router is not a filesystem sandbox. A tool can still write an absolute path outside the managed root. Managed paths must be real directories and are checked against the configured root. Existing explicit environment values are preserved. Unregistered paths are outside automatic prune ownership. The CLI refuses a managed root inside the detected project for routed sessions.

The test suite covers configuration precedence, routing, ownership, leases, pruning, integration edits, and safety regressions. The fixture lab provides separate baseline and routed projects for Rust, Node, and Go. Neither source tests nor package metadata establish ordinary-user acceptance for every listed host integration.

## Documentation

The detailed documents in `docs/` cover [architecture](docs/architecture.md), [configuration](docs/configuration.md), [agent integrations](docs/agent-integrations.md), [safety](docs/safety-model.md), and [verification](docs/verification.md). Read the verification document before treating an integration manifest or launcher as host acceptance evidence.

Contributions and security reports are covered by [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md). Project guidance on licensing is in [`docs/licensing.md`](docs/licensing.md). The project also includes [`SUPPORT.md`](SUPPORT.md), [`GOVERNANCE.md`](GOVERNANCE.md), and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Its privacy notice and software terms are at [`PRIVACY.md`](PRIVACY.md) and [`TERMS.md`](TERMS.md).

## Licence

clean-development is open source under the MIT licence. See [LICENSE](LICENSE). Contributions: see [CONTRIBUTING](CONTRIBUTING.md).

<sub>© 2026 MAGRATHEAN UK LTD and contributors · [Legal](https://github.com/magrathean-uk/.github/blob/main/LEGAL.md)</sub>
