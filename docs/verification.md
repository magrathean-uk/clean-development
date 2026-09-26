# Verification status

Updated for the source review on 26 September 2026. The v0.2.0 release and host observations below are historical evidence from 19 September 2026.

## Unreleased review fixes — 26 September 2026

The [code, design, and general inspection](review-2026-09-26.md) covered the CLI, session/configuration API, runtime, adapters, storage, integrations, packaging, and documentation. The final source checks ran on macOS 27.2.0 arm64 with Node 26.9.0:

- `npm run check` passed: 21 JavaScript files and 14 synchronized version files.
- `npm test` passed: 159 tests, 158 passed, zero failed, and one native-Windows execution test skipped. New regressions cover diagnostics, CLI help and validation, exclusive initialization, disabled/skip API behaviour, conservative corrupt-state handling, environment casing, and Claude fork activation.
- `npm run test:package` passed with 57 packaged files, including install/export checks, all three session choices, fresh setup/status/uninstall, and upgrade from v0.1.0.
- `npm run smoke:tools` passed Cargo, Go, npm, and uv. The offline fixture lab passed all six baseline/routed Rust, Node, and Go cases.
- `npm audit --omit=dev --audit-level=low` found zero vulnerabilities. `git diff --check` passed.
- An independent review of the combined fixes found no remaining blocker in the changed paths.

These are source and isolated-process results. No new real-agent acceptance, native Windows run, or performance benchmark is claimed. The immutable v0.2.0 package hashes below remain tied to that earlier release; these changes are unreleased.

The later [skill compatibility checks](skill-compatibility.md) include a real Claude Code 2.1.283 marketplace installation, launcher version check, and ordinary/explicit skill request capture against a localhost fixture. Claude correctly excludes the manual skill from an ordinary request and loads the Claude variant on explicit slash invocation. These host checks do not use a real model; authentication was unavailable. Claude model behaviour and native lifecycle acceptance remain open.

## v0.2.0 acceptance

The release candidate passed the session, package, host, and review gates on 19 September 2026:

- `npm run check` validated 21 JavaScript files, 14 synchronized version files, and the bug-report version prompt.
- The automated suite ran 148 tests: 147 passed, zero failed, and the native-Windows execution test was skipped on macOS/Linux. It covers read-only planning, every session choice, exact project-file persistence, disabled-project transitions, owner-bound Claude environment files, OpenCode's additive host merge, runtime ownership, lock-release races, and package lifecycle behavior.
- Coverage on macOS arm64/Node 26.8.2 was 87.89% lines, 79.26% branches, and 91.88% functions. The final 100-pair no-op benchmark measured 57.96 ms added median and 67.28 ms added p95, below the provisional 75 ms p95 gate.
- Real-tool smoke passed Cargo, Go, npm, and uv. The independent fixture lab passed 6/6 baseline/routed Rust, Node, and Go cases. `npm audit --omit=dev --audit-level=low` reported zero vulnerabilities.
- The installed-tarball gate checks both exports, dry-run, fresh skip with no writes, session-only, persist, retained project settings after skip, fresh v0.2.0 setup/status/uninstall, and upgrade from the tagged v0.1.0 runtime. The package contains 56 files. The release tarball SHA-256 is stored in `.release/v0.2.0-package.sha256`; its unpacked source-file manifest is `.release/v0.2.0-source-manifest.sha256` because embedding a tarball hash inside a packaged document would change that hash.
- macOS 26.6.2 arm64 with Node 24.20.0 passed check, the 147/0/1 suite, installed-package gate, all four real-tool smokes, the 6/6 fixture lab, and the dependency audit. Evidence is retained in `/Users/admin/clean-development-v020-acceptance-20260919-r6/evidence/` in the `clean-development-macos26` VM.
- Debian GNU/Linux 13 ARM64 passed check, the 147/0/1 suite, and the installed-package gate on exact Node 20.12.2 and 20.19.2. Cargo/npm smoke and four applicable fixture cases also passed; Go and uv were unavailable in that VM, so the complete four-tool smoke result comes from macOS. Evidence is retained in `~/clean-development-v020-acceptance-20260919-r6/evidence/` in the `debian13-arm64` Lima VM.
- A fresh, isolated `CODEX_HOME` on the separate macOS `test` account contained only its copied login and the setup-owned v0.2.0 configuration at launch. Codex CLI 0.154.0 with `gpt-5.6-terra` at high reasoning inherited `session-only`, resolved the managed uv shim and cache, completed all 914 Auditex tests offline, left the checkout clean, and created neither `.venv` nor `.pytest_cache`. Evidence for the corrected candidate is retained in `/Users/Shared/clean-development-v020-model-20260919-r6/evidence/`; the active Codex desktop session was not used or closed.
- Grok Build 1.0.34 repeated the same corrected-candidate acceptance in `clean-development-macos26`: all 914 Auditex tests passed offline through the managed uv shim/cache, the checkout remained clean, and no local virtual environment or pytest cache appeared. Evidence is retained in `/Users/admin/clean-development-v020-model-20260919-r6/evidence/`. AGY 1.2.7 remained installed and its launcher/version smoke passed, but the SSH test process did not inherit the GUI account's authentication, so it is not counted as a current model-backed acceptance.
- Independent final review found no remaining release blockers after fixes for disabled-project environment cleanup, Claude owner binding, OpenCode additive environment behavior, and complete installed-package lifecycle coverage.
- The first hosted matrix run exposed the transient setup-lock release race on macOS/Node 22. The corrected lock wait path and its deterministic async/sync regression tests passed the repeated local stress run and the replacement hosted matrix recorded for the final commit.

The fixture runner proves artifact placement independently. Model-backed acceptance is recorded separately below because a green fixture does not prove that a host model used the routed shell.

## Earlier local evidence

- Before the session feature, the automated Node suite passed 122 tests with one native-Windows execution test skipped on non-Windows hosts. Coverage included config precedence, workspace identity, explicit overrides, all 14 declared adapter destinations, modern Yarn cache modes, dormant pre-setup plugins, durable runtime setup/update, bounded executable probing, Windows batch argv construction, Codex non-login-shell argument routing, PATH persistence safety, state/runtime symlink containment, stale-lock timeouts, receipt validation and path binding, hashed native TOML ownership, Grok command-prefix ownership and conflicts, syntax-aware and byte-preserving TOML edits, concurrent setup/builds/preparation, nested Cargo target ownership and leases, prune containment, top-level run routing, real executable resolution, arguments, and exit status.
- A generated baseline/routed fixture lab passed all 21 checks across six small Rust, Node.js, and Go projects. Routed Rust produced no local `target`, npm used the managed content cache while retaining project-local `node_modules`, and Go used the managed build and module caches.
- Real no-network tool smoke fixtures:
  - Cargo 1.98.1: `cargo check` wrote no project-local `target` and used the managed checkout target.
  - Go 1.27.1: `go test ./...` used the managed build cache.
  - npm 11.19.1: a package script ran and `npm config get cache` resolved to the managed cache.
  - uv 0.12.12: `uv cache dir` resolved to the managed cache.
- `npm pack` file-list inspection, install into an empty prefix, packaged executable version check, and import checks for both package exports.
- Generated Codex TOML parsed successfully with Codex CLI 0.154.0 (`config.load=ok`). Generated Grok command-prefix TOML parsed with Grok 1.0.34 and then passed a model-backed workflow.
- The repo-local Codex marketplace passed an isolated Codex CLI 0.154.0 add/install/list flow with the current `source: local` / `path: ./` marketplace schema. This does not prove desktop plugin-browser entitlement or model-backed workflow acceptance.
- The packed Grok marketplace route passed an isolated Grok 1.0.34 add/install/list/details flow; its installed plugin reported zero skill, command, and agent directories.
- Version/argv/exit launcher smoke passed against installed Antigravity (`agy` 1.2.7), Codex 0.154.0, Gemini 0.54.4, Copilot 1.0.80, and Grok 1.0.34. OpenCode exited 137 both directly and through the launcher, so it is not counted as accepted.
- A model-backed Rust workflow passed through the Antigravity launcher with managed Cargo output. AGY 1.2.7 automatically backgrounds commands after its 10-second synchronous window and print-mode shutdown cancels those jobs despite `--print-timeout 1800s`; long-command completion is therefore an upstream lifecycle gap. Codex CLI 0.154.0 initially replaced the managed PATH through its default macOS login shell and created a local `target`. The non-login-shell launcher fix was then verified with Terra high: model commands resolved the managed Cargo shim, metadata pointed to the managed build root, two offline tests passed, and no local `target` remained. Both the application data/state root and managed artifact root were writable sandbox additions.
- A fresh `magrathean-uk/auditex` checkout at `246c819923e115f521535cc1b7f47739bf317c67` passed a second Terra-high Codex launcher workflow: the model resolved the managed uv shim and cache, `compileall` passed, all 914 pytest tests passed, and `git status --short` remained empty.
- The earlier Codex runs used macOS account `test` and disposable Clean Development paths, but their raw transcripts also show account-level skills loading and a Cloudflare MCP authentication attempt. The v0.2.0 rerun above replaced that evidence with a fresh `CODEX_HOME`, a copied login, setup-owned configuration, and no copied skills or plugins. It proves the recorded routing result, not host-level billed-token neutrality.
- Grok 1.0.34 initially restored native Cargo after its captured login PATH, defeating native-policy and ordinary-launcher variants. The owned `toolset.bash.cmd_prefix` now sources the runtime helper inside the final model shell. A live Rust workflow resolved the managed Cargo shim, completed offline tests in the managed target, and left no local `target`.
- An isolated Debian 13 ARM64 Lima VM passed the suite, syntax checks, offline package/install/export/setup/status/uninstall lifecycle, and post-uninstall assertions on Node 20.12.2 and Node 20.19.2.
- Plugin Creator validation of `.codex-plugin/plugin.json` and Skill Creator validation of the explicit-only management skill.
- No npm runtime dependencies and `npm audit` reported zero vulnerabilities for the lockfile.

Run the core automated repository checks with:

```sh
npm run check
npm test
npm run smoke:tools
npm run test:package
node scripts/run-fixture-lab.mjs
npm run benchmark:overhead
```

The plugin/skill validators and dependency audit are separate checks:

```sh
python3 /path/to/plugin-creator/scripts/validate_plugin.py .
python3 /path/to/skill-creator/scripts/quick_validate.py skills/clean-development
npm audit --omit=dev --audit-level=low
```

The named agent parser and launcher observations above are host-specific manual smoke checks, not part of the npm scripts.

## Not yet proven

- A real process acceptance run for every advertised agent surface.
- Codex App restart/shell snapshot behavior and sandbox writable-root interaction.
- Claude subagents, resume, fork, and CwdChanged behavior outside isolated hook fixtures.
- Grok resume, subagent, and future-version acceptance beyond the verified 1.0.34 single-turn workflow.
- OpenCode variants that currently do not apply `shell.env` to their development Bash tool.
- Pi package installation against a released npm tarball.
- Cursor, Devin, Droid, Kimi, OpenCode, Pi, and Hermes launcher/package smoke runs. Claude's loader and skip-mode version smoke passed on 26 September; routed model execution remains unverified.
- Native Windows behavior, concurrent real worktrees, external-volume loss, symlink races, and disk-full conditions.
- Host-level model request captures needed to certify billed-token neutrality.

These gaps limit the corresponding native-support claims and remain follow-up work after the CLI-focused v0.2.0 release. The launcher and package files exist for the full Superpowers-sized matrix; native behavior is advertised separately.
