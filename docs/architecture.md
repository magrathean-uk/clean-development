# Architecture

## Design rule

The session planner reviews the launch environment and any proposed project file. The runtime owns command-time storage routing. Agent integrations make that runtime available to child commands.

```text
session / agent / run
        |
read-only manifest and storage plan
        |
session-only / persist / skip
        |
shared-cache environment + managed shim PATH
                    |
        tool shim resolves current cwd
                    |
      explicit user override still wins
                    |
        real tool, unchanged argv/stdin/out
                    |
       shared cache or checkout build root
```

There is no MCP server. Routing does not need model judgment, a network service, or a new tool schema.

## Runtime components

- `src/config.js` resolves user, project, environment, and command configuration.
- `src/workspace.js` identifies the effective tool workspace and derives a readable stable ID from its canonical path.
- `src/session.js` builds a read-only session plan, applies the selected environment, and writes only explicitly selected project configuration.
- `src/adapters.js` maps a supported tool to documented environment variables.
- `src/runtime.js` materializes versioned shims, resolves the real executable outside the shim directory, and preserves child process semantics.
- `src/state.js` records owned workspace build roots and active process leases.
- `src/integrations.js` adds narrowly owned Claude, Codex, and Grok native pass-through entries plus launcher receipts.
- `src/cli.js` exposes setup/update, launch, inspection, pinning, pruning, and uninstall commands.

## Session planning and application

The planner limits discovery to ancestor directories and selected local manifest metadata, stopping at the nearest supported project manifest or Git boundary. It reports detected tools, package-manager conflicts, configured storage roots, static environment values, preserved overrides, and the exact optional `.clean-development.json`. It runs no project code, dependency installation, model call, recursive source scan, or toolchain discovery.

`session --dry-run` stops after planning. Interactive `session`, `agent`, and `run` calls prompt for `session-only`, `persist`, or `skip` unless an explicit or inherited choice exists. Noninteractive calls default to `session-only`. Applying a routed choice prepares managed base directories; `agent` and `run` then materialize the runtime and launch the child. The standalone `session` command returns its result without changing the parent shell or starting a child. OpenCode launchers defer static cache values because the host's additive shell hook cannot remove inherited variables; its supported command shims apply the selected cache routes instead.

Before any routed choice, the planner rejects managed roots equal to or contained by the detected project. This keeps the noninteractive default from creating artifact directories inside source. An already-running agent cannot acquire a new parent environment from the standalone command; it must use routed child commands or relaunch.

`persist` additionally creates the reviewed project configuration and checks that the resulting bytes match the proposal. Existing files are retained and checked for changes after review. Children inherit `session-only` rather than persistence authority. `skip` takes the original executable route before runtime creation; it removes the shim path and unchanged session-injected environment values while preserving independent user values. Preinstalled native hooks keep their durable command path but default the session to `skip`, making their shims pass through until an explicit choice is inherited. Automatic hooks and tool shims stay noninteractive.

## Static caches and dynamic Cargo

The session overlay sets shared-cache values for detected, enabled tools once in the child environment. It leaves supported shims available for subsequent commands and preserves explicit tool variables according to configuration precedence.

A session can change directories and build several repositories. A static session variable such as `CARGO_TARGET_DIR` would send all of them into one target. A shim sees the actual command cwd and flags at execution time, then chooses the correct Cargo workspace or nearest manifest root.

For nontrivial Cargo layouts, command dispatch asks the selected real Cargo executable for `locate-project --workspace` before acquiring workspace locks or creating ownership records. Static previews remain estimates; see [Cargo workspace discovery](cargo-workspaces.md).

The shim resolves the real executable from `PATH` while skipping its own directory. It spawns direct executables without a shell, leaves the shim directory in the child `PATH` for nested supported commands, inherits stdio, forwards termination signals, and returns the child's status. On Windows, `.cmd` and `.bat` tools instead use an explicit `ComSpec` wrapper that escapes metacharacters, rejects multiline or NUL input, and passes the constructed command line verbatim.

## Runtime installation

`setup` copies the current package's `bin/`, `src/`, and `package.json` into a versioned application-data directory. Stable launchers refer to that copy. Runtime and launcher receipts contain exact paths and SHA-256 digests, so setup refuses to overwrite an unowned or locally modified file and uninstall removes only unchanged files it recorded. This avoids persistent hooks pointing into a global npm version that may be replaced or an ephemeral `npx` directory that may disappear.

Setup and uninstall share an application-data lock. Runtime synchronization has its own lock, and each owned Cargo workspace has a lock shared by first-build creation, pinning, and prune. Lock, state, runtime, and launcher directories must be real directories at their canonical paths; collection symlinks fail closed. Integration receipts are schema-checked and bound to the agent config paths resolved from the current setup environment before they can authorize an edit. Claude session-environment edits also require the owner embedded in the installed hook to match exactly one receipt entry. Concurrent setup calls converge on one integration receipt, overlapping Cargo processes receive separate leases, and setup cannot interleave its external config edits with uninstall.

Receipts for superseded runtime versions are archived. Uninstall checks every archived inventory and removes only exact, unchanged owned files. An explicit uninstall also leaves a tombstone so a stale automatic Claude/OpenCode/Pi activation cannot silently reinstall the runtime; a later explicit setup re-enables it. See [runtime installation verification](runtime-installation.md) for publication checkpoints, canonical-path ownership, and the partial states retained after interruption.

There is no `postinstall` script. Merely installing or inspecting the npm package makes no configuration changes. Automatic Claude/OpenCode/Pi entry points require an already installed runtime receipt, so plugin discovery before explicit setup is an inert no-op. A receipt permits exposure of the stable shims; native entry points still default to pass-through `skip` until a routed mode is explicit.

## Ownership and pruning

State lives outside the disposable root. Before Cargo output is routed, the runtime atomically creates a direct child containing a random ownership ID. The same ID, source path, workspace ID, exact build root, managed path, last-used time, and pin state are recorded outside the disposable root. A running shim transfers its PID lease to the real child process, so killing the wrapper cannot make a live build look idle. Cache-only tools do not create build records.

Prune requires all of the following:

1. The record is old enough.
2. The workspace is not pinned.
3. No live lease uses the workspace ID.
4. The recorded build root is the build root currently selected by configuration.
5. The candidate is exactly one real directory below that root, without a symlink boundary.
6. Its on-disk marker matches the random ownership ID and workspace identity in state.
7. The same checks still pass immediately before deletion.
8. The user supplied `--apply`; otherwise the command only reports the plan.

Cache and scratch eviction are not implemented in `0.2.0`. Package-manager caches can have their own concurrency and integrity rules and should use native prune commands when an adapter is added.

## Failure behavior

- An existing explicit tool environment variable is preserved.
- An existing Codex login-shell choice or incompatible `shell_environment_policy` is not overwritten; setup reports a Codex launcher fallback. Fresh native integration owns `allow_login_shell = false` and a `skip` mode so macOS login startup cannot reorder the stable PATH or authorize routing. The routed launcher overrides the mode after consent.
- Codex PATH persistence removes entries inside the setup cwd, active Python/Conda environments, package-runner bins, and temporary directories; npm/npx setup falls back to a launcher rather than snapshotting its ambient PATH.
- Grok setup owns only its marked `toolset.bash.cmd_prefix`. The prefix sources the owned runtime environment helper after Grok applies its captured login-shell PATH. The helper defaults to `skip`, so PATH precedence alone does not authorize routing. Existing user prefixes and unsupported TOML forms are preserved with a visible launcher fallback.
- A missing external cache or build base produces a direct error. `setup`, `prepare`, and session preparation require its direct parent to exist; ordinary tool runs never recreate a missing base or select another drive.
- If the real tool cannot be found outside the shim directory, the shim fails with a direct error instead of recursively invoking itself.
- Unregistered directories are never inferred to be owned from names such as `target`, `build`, or `.cache`.
- Uninstall requires receipts at the currently resolved application-data location and the same Claude, Codex, and Grok config-home choices used by setup. A changed data-home/XDG or relevant agent config location is reported before any edit rather than followed or treated as an empty successful uninstall.

## Boundaries

This is not complete filesystem isolation. Tools that ignore the routed variable, scripts with absolute output paths, native applications, remote jobs, and unsupported build systems can write elsewhere. A future strict mode would require an actual sandbox, container, or VM with separately designed mount and artifact-export rules.
