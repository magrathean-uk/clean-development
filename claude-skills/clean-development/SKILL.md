---
name: clean-development
description: Configure, inspect, diagnose, or explicitly prune storage managed by clean-development. Use for clean-development setup and storage questions, not for ordinary builds, tests, or package installs.
disable-model-invocation: true
---

# Clean Development

Use the deterministic `clean-development` CLI from Codex, Claude Code, Antigravity (agy), or Grok Build. Do not load this skill for ordinary development unless the user explicitly requests Clean Development management or routing. An already approved routing choice can be used without loading the skill again.

Prefer the installed CLI. If it is unavailable and the package location is known, use `node /absolute/package/path/bin/clean-development.js` with the same arguments. Do not install the package or run setup just to inspect it. Run project commands from the intended repository, not from the skill folder.

## Choose the requested workflow

- **Inspect or diagnose:** run `clean-development status --json` and `clean-development doctor --json` directly. Add `--sizes` to status when disk usage is requested. Report an unhealthy doctor's JSON even though its exit code is 1. Do not ask for a routing choice or make changes for a read-only request.
- **Set up or change storage:** preview `setup --dry-run` with the exact requested `--root` and `--agents` options, show the destinations and agent selection, then apply those same options when authorized. `--agents` replaces the native-integration selection; do not silently enable all hosts or remove another host. Use `update` without `--agents` to retain an existing selection when refreshing the runtime.
- **Enable routing:** use the session workflow below.
- **Clean up:** preview `prune --json` with the user's requested age, for example `--older-than 60d`. Show eligible and retained entries, then use the same age with `--apply` only when deletion is authorized. An explicit request to delete after showing the list is sufficient; do not ask for the same approval again. Never replace prune with manual deletion.

## Session consent and execution

Before a new routing choice for a repository, run `clean-development session --dry-run --json`. Show detected tools, managed destinations, preserved overrides, conflicts, available choices, and the exact proposed `.clean-development.json`. Ask for **session only**, **save project settings**, or **skip** only if the user has not already selected one for this repository and task. Reuse an established choice; review again if the repository or destinations change.

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
