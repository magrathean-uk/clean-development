# Offline fixture lab

The fixture lab exercises baseline and routed storage behavior for Rust, Node.js, and Go. Run it from the repository with the required local tools installed:

```sh
node scripts/run-fixture-lab.mjs
```

To retain evidence in a chosen new directory, whose parent must already exist:

```sh
node scripts/run-fixture-lab.mjs --output /absolute/path/to/new-lab
```

`--output` refuses an existing directory. Without it, the runner creates a fresh temporary directory. The runner supports macOS and Linux, writes `report.json`, and exits unsuccessfully if a tool is missing or any case fails. It does not launch an agent and does not prove host integration acceptance.

Each lane has its own home, temporary directory, configuration locations, package-manager files, and cache paths. The parent shell environment and installed agent settings are not used by the fixture commands. The runner reuses installed toolchain executables and sets offline or local-toolchain controls, including Cargo offline mode, npm offline mode with lifecycle scripts disabled, `GOPROXY=off`, `GOSUMDB=off`, and `GOTOOLCHAIN=local`. This isolates process configuration; it is not a virtual machine, network sandbox, or filesystem sandbox.

| Fixture | Commands and checks |
| --- | --- |
| Rust | Tests a library and CLI workspace, runs the CLI, and checks that baseline output uses the project `target` while routed output is under the managed build root. |
| Node.js | Packs the local dependency, installs offline, runs tests and the app, and checks npm cache content, local `node_modules`, and matching baseline/routed tarball hashes. |
| Go | Runs tests, builds the CLI, runs the project binary, and checks build-cache and module-cache locations while keeping the final binary in the project `bin` directory. |

The fixture sources use the `.mjs.fixture` suffix so Node's test runner does not execute them before the local dependency is packed. The runner removes that suffix while materializing a project. The Go fixture uses only the standard library, so it exercises build-cache routing without claiming to populate a module download cache.

The report records tool paths and versions, exact argument arrays, working directories, isolated environment values, output, exits or signals, elapsed times, artifact inventories, and named checks. It retains both lanes for inspection. Keep the report and materialized projects when evidence is needed; remove the disposable output directory later using the normal filesystem tools.

## Interpreting results

Six passed cases and matching Node tarball hashes establish the runner's fixture assertions for that machine. A skipped or failed tool case is recorded in `report.json` and makes the overall result unsuccessful. The lab does not test a model, an agent's shell inheritance, native hook lifecycle, package installation, or account-level configuration.

For a separate host experiment, copy one materialized project and give the host a small task such as adding and testing a `subtract` function, changing the CLI to print `difference=2` for `7 - 5`, and running the project's normal tests and app command. Keep baseline and routed copies separate. Record the host's own command transcript and routing evidence; do not attribute it to this offline runner.

## Session-choice acceptance

Use a fresh project and fresh evidence directory for each mode. Begin with the read-only plan, then route a child command explicitly:

```sh
clean-development session --dry-run --json
clean-development run --session session-only -- cargo test --offline
clean-development run --session persist -- cargo test --offline
clean-development run --session skip -- cargo test --offline
```

The dry run should not create files. Session-only should create managed output without `.clean-development.json`. Persist should create exactly the JSON shown by the plan, while an existing project file remains unchanged. Skip should create no new Clean Development runtime or storage and should leave existing owned data alone. Compare each fresh project with its direct baseline so prior artifacts cannot make routing appear successful.

This acceptance exercise tests the child process launched by `run`; a standalone `session` command cannot rewrite the parent shell environment. A host experiment must separately record shell inheritance, command paths, and routing. Keep the host's sandbox boundary and configuration/authentication boundary in the evidence, and do not include local account details. This lab does not establish model, native hook, or ordinary-user acceptance.
