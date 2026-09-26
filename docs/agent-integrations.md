# Agent integrations

Clean Development follows Superpowers' 13-family, 14-surface repository shape but not its prompt-bootstrap strategy. Coverage in this document means that a distribution or launch route is present. It does not mean that every host has passed end-to-end acceptance.

## Support levels

- **Native pass-through integration:** the host has a documented environment mechanism implemented here. It exposes the stable CLI/shims and initializes an unset session mode to `skip`; installation alone does not route storage. Every such route is still experimental until the named host/version passes the acceptance fixture.
- **Zero-context launcher:** `clean-development agent NAME` offers a terminal session choice and starts the CLI with the selected environment. Routed choices add cache variables and the shim path; `skip` bypasses routing. The choice adds no prompt text, MCP tools, or model calls. A shipped launcher is not a claim that the host executable has been smoke-tested.
- **Package metadata:** a manifest is present for that host or a documented compatibility format. Discovery alone does not prove installation, activation, or shell inheritance.

| Family / surface | Native pass-through integration | Zero-context launcher | Package metadata | Evidence boundary |
|---|---|---|---|---|
| Claude Code | Shipped: `SessionStart`; plugin also uses `CwdChanged` | `clean-development-claude` | Claude plugin | Management skill and explicitly wrapped child commands passed with 2.1.283 / Sonnet 5; full native-hook/lifecycle acceptance pending |
| Antigravity | None | `clean-development-antigravity` | Portable layout validates; launcher recommended | Routing and short model workflow passed with `agy` 1.2.7; long print-mode commands hit an upstream cancellation bug; explicit-only skill discovery unverified |
| Codex App | Shipped: `allow_login_shell = false` and `shell_environment_policy` | Not applicable to the GUI | Codex plugin and repo marketplace | Restart, sandbox, and shell snapshot acceptance pending |
| Codex CLI | Shipped: non-login-shell environment policy | `clean-development-codex` | Codex plugin and repo marketplace | Terra-high model workflow passed with 0.154.0, managed Cargo output, and no local `target` |
| Cursor | None | `clean-development-cursor` | Cursor manifest | Launcher/package route only; acceptance pending |
| Devin CLI | None | `clean-development-devin` | Devin manifest | Launcher/package route only; acceptance pending |
| Factory Droid | None | `clean-development-droid` | Claude-compatible | Launcher/package route only; acceptance pending |
| Gemini CLI | None | `clean-development-gemini` | Gemini extension without context or hooks | Launcher smoke passed with 0.54.4; model workflow pending |
| GitHub Copilot CLI | None | `clean-development-copilot` | Claude-compatible | Launcher smoke passed with 1.0.80; model workflow pending |
| Grok Build CLI | Shipped: `toolset.bash.cmd_prefix` | `clean-development-grok` | Claude-compatible plugin and Grok marketplace | Parser, marketplace, argv, and actual model-shell routing passed with 1.0.34 |
| Kimi Code | None | `clean-development-kimi` | Kimi manifest | Launcher/package route only; acceptance pending |
| OpenCode | Shipped: `shell.env` | `clean-development-opencode` | npm/OpenCode plugin | Host-version-dependent; real-host acceptance pending |
| Pi | Shipped: Bash `spawnHook` | `clean-development-pi` | npm/Pi extension | Source fixture only; package acceptance pending |
| Hermes Agent | None | `clean-development-hermes` | Hermes manifest | Launcher/package route only; acceptance pending |

## Session launch choices

```sh
clean-development session --dry-run --json
clean-development agent codex --session session-only -- exec "Run the tests"
clean-development agent grok --session persist
clean-development run --session skip -- agy --help
```

With no explicit or inherited choice, `agent`, `run`, and the stable `clean-development-AGENT` launchers prompt in an interactive terminal. The three choices are `session-only` (the Enter default), `persist`, and `skip`. Noninteractive use defaults to `session-only`; pass `--session` to `agent` or `run` to make the choice explicit. Arguments after `--` belong to the launched agent. Children inherit the mode, with `persist` reduced to `session-only` so nested launches cannot save another project's settings without a new explicit choice.

The plan detects nearby manifests without running the project, shows the managed storage destinations, and previews any new `.clean-development.json`. Routed choices prepare managed bases and apply static shared-cache values; Cargo targets remain dynamic through the shim. `persist` creates only the reviewed project file and retains an existing file. It does not change native agent configuration. `skip` starts the underlying executable without creating a runtime or applying shims. Existing native integrations remain installed, and their routing paths honor the inherited skip choice.

This is a local launcher interaction. Directly opening an agent with an already installed native integration does not display this terminal prompt. Native hooks and shims stay silent and noninteractive, expose the stable command path, and default `CLEAN_DEVELOPMENT_SESSION_MODE` to `skip`, so supported tools pass through without managed storage routing. A launcher prompts only when no mode is inherited. An already-running native agent inherits `skip` and must use an explicit `clean-development run --session session-only|persist -- COMMAND` or `clean-development agent NAME --session ...` after the user approves the read-only plan.

Codex's own sandbox permissions remain separate. The recorded Rust acceptance used `workspace-write` with both the application data/state directory and managed artifact root writable. The session choice does not add sandbox permissions or weaken the agent's policy; configure the allowed paths explicitly for the test account or host session. Routed Codex launches retain the non-login-shell override so shell startup cannot replace the shim path. Skipped launches preserve the original agent argv.

## Setup behavior

```sh
clean-development setup --agents claude,codex,grok
```

Installing or enabling plugin metadata alone does not activate routing. Claude, OpenCode, and Pi lifecycle code first checks for the runtime receipt created by explicit setup and otherwise returns without creating files or changing `PATH`. With a receipt, it may expose the stable path but still sets or preserves `skip` until an explicit session choice.

- Claude: merges one owned SessionStart hook into `~/.claude/settings.json`, preserving unrelated hooks. Its command carries the receipt owner; `CLAUDE_ENV_FILE` is changed only when that owner matches exactly one recorded native hook. The generic packaged hook is inert without an owner argument.
- Codex: adds a marked block with `allow_login_shell = false`, a stable PATH, and a `skip` session default only when it can preserve existing shell configuration. The launcher overrides that default with the reviewed selection. A compatible user-owned `allow_login_shell = false` is retained; other explicit values and incompatible policies are preserved and reported as launcher fallbacks.
- Grok: adds an owned `toolset.bash.cmd_prefix` to `~/.grok/config.toml`. The prefix sources an owned runtime helper after Grok restores its login-shell environment, so the stable shim directory wins without adding model instructions. The helper defaults to pass-through `skip` and preserves an inherited explicit choice. An existing user `cmd_prefix` is preserved and reported as a launcher fallback.
- Every selected CLI family receives a stable `clean-development-AGENT` launcher in the application-data `bin` directory. The `codex` launcher is for Codex CLI, not the Codex App GUI.

Codex requires a complete PATH value in its TOML environment policy. It normally executes model commands in a login shell, whose startup files can reorder that PATH after the policy is applied. Clean Development therefore sets `allow_login_shell = false` in fresh native integration and passes the same override through `clean-development-codex`, together with the explicitly selected session mode. Setup removes duplicate shim entries, the current project and its descendants, active virtual/Conda environments, temporary directories, and `node_modules/.bin` paths before persisting PATH. When setup is itself running under npm/npx, it does not write a native Codex block because the package runner's PATH is transient and can be project-controlled; it returns the stable launcher route instead. Run a global installation from a fresh shell when the native Codex path is wanted.

Claude environment-file blocks use owner-specific whole-line markers tied to the installed integration receipt. A missing owner, mismatched owner, duplicated marker, malformed block, or modified block fails closed instead of replacing nearby shell text. When a routed Claude session enters a project with `enabled: false`, the hook replaces its exact owned block with an integrity-tagged pass-through block that removes only the values recorded as session injections.

OpenCode merges `shell.env` output over its parent environment, so an omitted key cannot unset a value inherited by the OpenCode process. The `clean-development-opencode` launcher therefore keeps shared-cache variables out of that parent and lets command shims add them per supported tool. The plugin can then enter an `enabled: false` project by returning `skip`, a native PATH, and neutral internal flags. An OpenCode process started by an older or external fully routed environment fails closed if a disabled project would require unsetting inherited cache variables; relaunch it through `clean-development agent opencode` or with `--session skip`.

Grok 1.0.34 replaces the launcher's PATH with a captured login-shell PATH before executing model commands. Clean Development's owned command prefix sources its environment helper inside that final shell. A live Rust workflow then resolved the managed Cargo shim, wrote to the managed target, and left no project-local `target`. The prefix is execution configuration and does not change the command shown to the model.

Running setup again is idempotent. Uninstall removes only marked or recognizably owned entries, and retains storage/configuration.

When `--agents` is supplied explicitly, it is a selection: previously owned native integrations for agents omitted from the list are removed safely, while unrelated configuration remains. The shared runtime launchers remain available for later selection.

Setup updates and uninstall must resolve the same agent configuration locations used by the original setup. If `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `GROK_HOME` changes, the receipt is rejected before any agent file is edited. Rerun the command with the original values; this binding prevents a modified receipt from redirecting removal to an arbitrary file.

## Skills and token use

The management skill is narrowly scoped to setup, status, diagnosis, explicit routing, and pruning. Codex uses `skills/clean-development` with an `agents/openai.yaml` policy that disables implicit invocation. The Claude marketplace explicitly replaces root skill discovery with `claude-skills/`, whose copy uses `disable-model-invocation: true`, so Claude does not place its description in normal model context. The Grok marketplace points at the dedicated `.grok-plugin/` package, which intentionally contains no skills directory; management stays CLI-only there. Grok can separately opt into the Claude variant as a user skill. AGY uses the launcher or an explicitly requested read of the skill; its native explicit-only discovery is not verified. See [the four-host skill guide](skill-compatibility.md) for exact routes and current loader checks. The skill is not needed for routing and is never invoked by a shim.

The Codex plugin manifest must include a `defaultPrompt` field for the host schema. Its only entry is explicitly worded as an opt-in UX suggestion (`Use Clean Development only when explicitly requested.`); it is not a startup hook, session bootstrap, or normal routing context.

The npm CLI path uses no skill at all. For the advertised token-neutral plugin routes, install Claude and Grok through their included marketplace manifests. Do not point `claude --plugin-dir` or `grok --plugin-dir` at the repository or npm package root: direct-root loading bypasses the marketplace's selected skill/plugin root and may discover the root Codex management skill. Other plugin hosts may catalogue bundle metadata according to their own rules; if even catalogue metadata is unacceptable, use only the npm CLI and launcher.

### Codex desktop access errors

If the Codex desktop plugin browser reports `access_programs` is not enabled for the organization, the failure is in the signed-in workspace's plugin entitlement, not in this package. OpenAI documents plugin availability as a workspace control for desktop surfaces, while Codex CLI has its own local marketplace browser. There is no package-side switch that can bypass the organization gate.

Use the npm/launcher route while that entitlement is unavailable. From this checkout:

```sh
node ./bin/clean-development.js setup --root /absolute/path/to/managed-artifacts --agents codex
```

After the package is published, the equivalent is `npx clean-development setup --root /absolute/path/to/managed-artifacts --agents codex`.

For a checkout, the Codex CLI route is independent of the desktop browser:

```sh
codex plugin marketplace add /absolute/path/to/clean-development
codex plugin add clean-development@clean-development-dev
```

The second route installs the local plugin without adding prompt text or making model calls. A workspace owner/admin must enable plugin access if the desktop marketplace is required.

## Acceptance status

The table combines earlier host observations with the final v0.2.0 consent-flow checks. Fresh isolated Codex and Grok acceptance is tracked in [verification](verification.md); earlier green workflows alone are not evidence for the new flow. Real-host acceptance remains required before promoting any still-unverified native route, while model-request capture remains a separate token-neutrality certification task. See [ROADMAP.md](../ROADMAP.md). Until a named host/version passes its stated boundary, describe its routes as shipped but unverified.
