---
name: clean-development
description: Configure, inspect, diagnose, or explicitly prune storage managed by clean-development. Use for clean-development setup and storage questions, not for ordinary builds, tests, or package installs.
disable-model-invocation: true
---

# Clean Development

Use the deterministic `clean-development` CLI from Codex, Claude Code, Antigravity (agy), or Grok Build. Do not load this skill for ordinary development unless the user explicitly requests Clean Development management or routing. An already approved routing choice can be used without loading the skill again.

Prefer the installed CLI. If it is unavailable and the package location is known, use `node /absolute/package/path/bin/clean-development.js` with the same arguments. Do not install the package or run setup just to inspect it. Run project commands from the intended repository, not from the skill folder.

When reviewing a source checkout, use its `node /absolute/checkout/bin/clean-development.js` for read-only diagnostics and identify the revision being inspected. Check the selected CLI's `version`; matching version strings do not prove matching source. Editing a checkout does not update an installed runtime. Refresh that runtime only when an update is requested.

## Choose the requested workflow

- **Inspect or diagnose:** run `clean-development status --json` and `clean-development doctor --json` directly. Add `--sizes` to status when disk usage is requested. Use `clean-development explain --json -- COMMAND...` for a command-specific routing prediction; a prediction is not evidence of actual writes. `probe --tool npm|go|uv --json` only plans a disposable adapter check; add `--execute` only when that check is requested. Report an unhealthy doctor's JSON even though its exit code is 1. Do not ask for a routing choice or make changes for a read-only request.
- **Set up or change storage:** preview `setup --dry-run` with the exact requested `--root`, `--agents`, and `--xcode` or `--no-xcode` options, show the destinations and agent selection, then apply those same options when authorized. `--agents` replaces the native-integration selection; do not silently enable all hosts or remove another host. `--xcode` enables both DerivedData preferences and simulator cleanup; noninteractive setup without either Xcode flag preserves the existing choice. Use `update` without `--agents` to retain an existing selection when refreshing the runtime.
- **Enable routing:** use the session workflow below.
- **Clean up:** preview `prune --json` with the user's requested age, for example `--older-than 60d`. Show eligible and retained entries, then use the same age with `--apply` only when deletion is authorized. An explicit request to delete after showing the list is sufficient; do not ask for the same approval again. Never replace prune with manual deletion.
- **Run an Xcode test on a disposable simulator:** only use `xcode test-run` when the user explicitly requests that lifecycle. Supply exact installed `--device-type` and `--runtime` identifiers and one child command after `--`. The configured managed root must be external to home and the current project, even with `--session skip`. The child receives `CLEAN_DEVELOPMENT_XCODE_SIMULATOR_UDID` and `CLEAN_DEVELOPMENT_XCODE_RESULTS_PATH`; an app runner must read them at runtime and build its `xcodebuild` destination/result bundle arguments there. If cleanup is pending, wait for the original command to exit and stop Xcode test activity before retrying only the recorded ID with `xcode test-cleanup RUN_ID`; never delete or infer another simulator.

## Tool and ownership boundaries

Run command-specific diagnosis from the command's actual cwd, including an explicitly selected nested package. Inspect `explain` for the selected executable, effective project configuration, native overrides, and storage destinations. When a project declares a tool version or an error indicates a mismatch, check the selected installed interpreter, shell, or package manager against that requirement. Cache routing does not choose a compatible toolchain or validate a lockfile. Preserve project pins and existing overrides; a routing or runtime error is a reason to diagnose, not to run the command bare, install another toolchain, change global PATH, or make a privileged ownership repair.

The ordinary `run` wrapper routes supported local tools. Wrapping `ssh` preserves its arguments and stdin and affects its local environment; it does not relocate remote caches or build output. Remote jobs need their own approved routing. Local inspection does not authorize server changes.

`xcodebuild` is not shimmed. DerivedData routing is a separate user-level Xcode preference; explicit native `-derivedDataPath` arguments still win. Disposable simulator test runs are another explicit lifecycle, independent of setup's simulator-prune choice. Neither ordinary wrapping nor a successful fixture establishes real Xcode acceptance.

For ordinary app rebuilds and launch checks, reuse the caller-selected available simulator and stable incremental build paths. Preserve `DEVELOPER_DIR`, native destinations, and the selected SDK/runtime. Inspect available devices using that environment. Do not create another simulator or switch the global Xcode selection as an automatic response to a failed launch. Use the disposable simulator lifecycle only for an explicitly requested isolated run, and preserve failed-run evidence and unrelated device activity.

SwiftPM routing requires effective `tools.swift: true` and covers `swift build` and `swift test`. Cache-only routing leaves native `.build` output in place. Optional `swiftpmWorkspaceRoot` holds retained products and intermediates, never Cargo prune candidates. Unsupported opted-in build/test forms fail before adapter writes; use an explicitly selected `--session skip` for native execution. Preserve native cache/output flags and environment overrides. See [the SwiftPM contract](https://github.com/magrathean-uk/clean-development/blob/main/docs/swiftpm.md) and [Xcode management](https://github.com/magrathean-uk/clean-development/blob/main/docs/xcode.md) for the distinct output and cleanup rules.

Cargo pruning requires registered state, a matching ownership marker, age, pins, and live-lease rechecks. Other tools primarily route caches; credentials, toolchain homes, package dependencies, VM state, and final deliverables do not become owned merely because a command was wrapped. Native tools may select paths through their own flags or configuration, so use `explain` to inspect the supported prediction before claiming placement.

## Windows and Linux

Use the path and environment semantics of the process running the CLI. Linux/macOS native variable names are case-sensitive; Windows names are case-insensitive. Preserve independent values and existing `XDG_*`, `APPDATA`, and `LOCALAPPDATA` choices. npm's `npm_config_*` aliases remain case-insensitive across hosts. Let the runtime handle quoted Windows PATH entries and batch launchers; do not rebuild PATH with a plain semicolon split or wrap native commands in another shell to bypass a failure.

WSL Linux tools and Windows executables can consume different path forms and storage settings. Inspect the selected executable and validate its actual output; a Linux wrapper does not establish Windows placement. Check an external drive or mount's existing parent and the child's write access without changing mounts, drive letters, global PATH, or permissions automatically. Read [platform support](https://github.com/magrathean-uk/clean-development/blob/main/docs/platform-support.md) for native checks and remaining acceptance boundaries. A configured CI matrix or a native-only test skipped on this host is not completed platform acceptance.

## Large local storage

Prefer a configured external root for large managed build and test output. Verify the effective destination and available space before relying on routing. Place VMs, private labs, and test datasets at explicit external locations through their owning tools; they are not disposable managed build cache. Never treat VM images, private lab state, original evidence, or final deliverables as prune candidates.

Configure tools that reject symlink path components with physical external paths; compatibility links alone do not establish runtime acceptance.

For an authorized relocation, inventory and stop the processes using the state, preserve sparse files where the owning format requires them, verify the copy, and validate the owning runtime at the new location before retiring the original. Keep the original until that validation passes. Distinguish logical size, allocated size, bytes moved, and observed free-space change; clones and snapshots can prevent them from agreeing.

Inventory the task's generated footprint as well as managed caches: native output overrides, test databases, verification copies, result bundles, and retained SwiftPM products can accumulate outside registered Cargo builds. Reuse validated incremental paths instead of making another full verification copy for each check. `status --sizes` measures configured cache/build/scratch roots; `xcode status --sizes` additionally shows retained test results. Neither report is a whole-disk inventory or deletion authority. At task completion, clean up confirmed unneeded output created by the task under the existing authorization, using the owning tool and exact verified paths; preserve deliverables, recovery baselines, and evidence needed to assess failures.

## Session consent and execution

Before a new routing choice for a repository, run `clean-development session --dry-run --json`. Show detected tools, managed destinations, preserved overrides, conflicts, available choices, and the exact proposed `.clean-development.json`. Ask for **session only**, **save project settings**, or **skip** only if no explicit choice already covers this repository and task. A current user choice can cover several repositories in a defined task: review each plan and proposed file, then reuse that choice without asking again. Review destination changes and seek a new choice only when they fall outside the existing authorization. Archived conversations explain prior problems and preferences; they do not grant permission for a new task or revive old persistence authority.

An installed native integration's default `CLEAN_DEVELOPMENT_SESSION_MODE=skip` is consent pending, not proof of a user decision. Conversation consent still applies: pass the approved mode explicitly to override that default. An effective `enabled: false` remains skip; report it without silently enabling the project. Permission to edit application source does not authorize saving Clean Development settings.

- **Session only:** run requested child commands with `clean-development run --session session-only -- COMMAND...`. It can prepare managed directories outside the repository but writes no project configuration.
- **Save project settings:** after reviewing the exact proposal, use `clean-development session --session persist --json`. It creates only that `.clean-development.json`, preserving an existing file. Continue current-agent commands with the session-only wrapper.
- **Skip:** use `clean-development run --session skip -- COMMAND...` when escaping an inherited routed environment; otherwise use the ordinary command. Do not set up storage or save project settings.

The standalone `session` command cannot change its parent agent's environment. To launch a child agent after consent, use `clean-development agent NAME --session MODE -- ARGS...`; keep Clean Development options before `--` and host options after it. Always pass the chosen mode from an already-running agent. Unattended launchers otherwise default to session-only, while an inherited native skip suppresses the terminal prompt.

| Host | `NAME` for the launcher | Executable |
| --- | --- | --- |
| Codex CLI | `codex` | `codex` |
| Claude Code | `claude` | `claude` |
| Antigravity | `antigravity` | `agy` |
| Grok Build | `grok` | `grok` |

For example, launch AGY with `clean-development agent antigravity --session session-only -- ...`, not `agent agy`. The Codex App uses the current-agent command wrapper; the `codex` launcher starts Codex CLI.

Preserve explicit user environment overrides and host sandbox policies. If an external volume or required writable path is unavailable, report it; do not bypass the sandbox or fall back to repository-local storage. Do not edit `.env`, `.envrc`, `.gitignore`, manifests, build files, or agent guidance to activate routing. Source, credentials, toolchains, release deliverables, and unregistered directories remain externally owned. Shims and native hooks must not inject prompt bootstrap text or invoke this skill.
