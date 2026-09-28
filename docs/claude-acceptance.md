# Claude Code: isolated child-process acceptance

This fixture separates a source-contract test from acceptance by an actual Claude Code host. A successful plugin load, a hook JSON match, or manually sourcing `CLAUDE_ENV_FILE` is **not** live acceptance. No fixture command can automatically certify a host pass.

## Revision and observed boundary

The production source under test is `af12577c6596095fdf91f18e840e9433521ea3d2` (main), tree `998605cda006d588e9562cabe1eee6c78c2f3a59`. The supplied archive's complete Git tree matched this revision. `AGENTS.md`, [agent integrations](agent-integrations.md), architecture and the safety model were read before testing. Open PRs #24–33 were inspected; #33 owns the integration writer and shared integration guide. This change intentionally leaves `src/integrations.js`, `hooks/session-start`, and `integrations/claude/` unchanged.

The automated runner is Linux x64, kernel `6.18.44`, Node `v22.16.0`, npm `10.9.2`. **Claude Code version: unavailable (`claude --version`: ENOENT).** Cargo and rustc are also absent. No Claude session, billed model invocation, genuine Cargo build, native macOS/Windows execution, resume, fork or subagent was run. Fork capability is unknown, not reported as unsupported.

| Case | Source-contract evidence | Live Claude evidence |
| --- | --- | --- |
| Ordinary startup before setup | Ownerless packaged hook is inert; actual shell/tool children use a local target | Blocked: host unavailable |
| Explicit setup and ordinary restart | Real CLI setup is idempotent; child PATH exposes stable shims, default mode is skip | Blocked |
| Session-only | Real CLI and shell dispatch; fake Cargo child writes managed artifact, no project-local target | Blocked |
| Skip with inherited routing | Shell and tool children lose recorded npm/Cargo routing; independent uv override survives | Blocked |
| Startup in disabled project | Owned startup hook cleans both child environments | Blocked |
| Cwd change to enabled project | Cargo shim chooses a distinct managed target from actual child cwd | Blocked |
| Cwd change to disabled project | **Failed invariant:** ordinary shell keeps inherited npm cache; Cargo child cleans it | Blocked; not a demonstrated live-host failure |
| Resume / fork | Matching hook commands exercised with synthetic events in routed and skip modes only | Blocked; actual lifecycle untested |
| Subagent | Not simulated | Blocked; installed-host support unknown |
| Uninstall | Real CLI preserves unrelated settings and managed artifact; fresh child resolves native tool wrapper | Blocked |

Automated results: 14 focused tests passed; 88 targeted CLI/integration/session tests passed; `npm run check` passed; `npm test` reported 404 tests, 377 passed, 27 skipped, zero failures. The skips are 26 native-Windows tests and one unavailable real-Cargo test. Three automatically discovered support files exit harmlessly without launching a host; their discovery passes are not additional acceptance cases. The cwd detector test passes because it correctly rejects the known failure, not because the disabled transition works.

## Reproduced cwd gap

```sh
node test/claude-acceptance/run.mjs reproduce-cwd
# Exit 1: failed source-contract invariant; JSON includes retained disposable lab.
```

The lab creates ordinary Cargo and Node manifests, performs explicit setup, and obtains a session-only parent through the real CLI. It executes the registered startup command and the shipped ownerless cwd hook, then starts a real shell child in the disabled project. The shell child inherits `npm_config_cache=<lab>/managed/caches/node/npm`. The Cargo shim removes that value in its own child and that child writes `<disabled-project>/target/debug/claude_acceptance_fixture`. Checking only the final Cargo environment or artifact would miss the stale shell cache.

Native setup installs an owner-bearing `SessionStart` entry but no `CwdChanged` entry. The packaged cwd command supplies no owner and exits without rewriting the session environment. This is a deterministic source-contract counterexample, not evidence that a particular Claude version dispatches or inherits events identically. The fixture's Cargo backend deliberately writes a nonce artifact rather than pretending to compile Rust.

An owner-authorised cwd registration is a follow-up for the integration writer, after live verification of the host's event contract. Do not make the generic hook infer consent or guess an owner to hide the gap. No writer or routing fix is included here.

## Repeat the automated checks

```sh
node --test test/claude-acceptance.test.js
node --test test/claude-acceptance.test.js test/cli.test.js test/integrations-review.test.js test/session.test.js
npm run check
npm test
node test/claude-acceptance/run.mjs preflight
# Exit 2 with blocked cases when Claude, Cargo or rustc is unavailable.
```

`preflight` creates its own disposable lab and records the exact checkout commit/tree, dirty flag, product-file SHA-256 values, machine, version invocations/results, and installed Claude help when available. A dirty checkout must not be reported as the clean commit alone. Every launch also records its exact argv, cwd, host version, timestamps and process result.

## Actual-host protocol

Use a disposable POSIX account or VM with Node, Claude Code and an already installed Rust toolchain. The fixture does not install tools, import credentials, copy an existing agent profile, or disable permission prompts. It requests disabled host auto-updates and updates to keep the recorded version stable. Its environment is constructed from an allowlist with fresh HOME, CLAUDE_CONFIG_DIR, XDG directories, Cargo/Rustup homes, temporary directories, and managed storage. `HOME` isolation is not an OS sandbox: inspect machine-wide managed policy and filesystem access first. Stop and mark the case blocked if the host cannot be isolated. Native Windows requires a separate protocol.

Prepare a fresh lab per independent case. Reuse one only where actual session continuity is the subject of the test. A project previously built in pass-through mode legitimately has a local target and must not be reused as a fresh no-local-target test.

```sh
node test/claude-acceptance/run.mjs prepare \
  --claude /absolute/path/to/claude \
  --cargo /absolute/path/to/toolchain/bin/cargo \
  --rustc /absolute/path/to/toolchain/bin/rustc
# Copy the returned root into LAB. All remaining commands run from this checkout.
LAB='/exact/root/printed/by/prepare'
node test/claude-acceptance/run.mjs launch "$LAB" native normal
```

Prefer concrete toolchain binaries: a rustup proxy with the deliberately empty RUSTUP_HOME may correctly fail preflight. Provision a toolchain in the disposable account, not by pointing the fixture at a contributor's real Cargo/Rustup home. The launcher forwards an explicitly supplied `ANTHROPIC_API_KEY` only into a requested live process, never into `lab.json` or the capture files. Otherwise authenticate in the disposable Claude profile. Preflight and automated tests never forward it. Host-created authentication/session files can contain secrets; do not publish the lab wholesale.

In this isolated Claude session, register this checkout with `/plugin marketplace add /absolute/path/to/checkout`, install `clean-development@clean-development-dev`, then exit and restart through the launcher. Verify the selected local revision and enabled plugin in that profile. Do **not** use `--plugin-dir` at the repository root: that bypasses the marketplace's explicit-only Claude skill selection. Installation is a prerequisite, not a routing pass. If this host's plugin commands differ or refuse installation, record its exact version and error as blocked rather than changing real settings or weakening policy.

For each case, ask Claude to execute the exact `observerCommand` printed by prepare, replacing `CASE_NAME` with the name below. It must be an actual Bash tool invocation from the intended session. Do not source a fixture env file, set routing variables, invoke the observer outside Claude, or substitute a loader test. Approve only the disposable fixture command using ordinary permissions. Capture the host's session ID, tool-call/event identifier, and the matching observation nonce.

| Step | Launch / operation | Child verification after exiting the host |
| --- | --- | --- |
| Before setup | `launch "$LAB" native normal`; observe `before-setup` | `verify "$LAB" before-setup pass-through` |
| Explicit setup | Exit host; `setup "$LAB"`; restart `launch "$LAB" native normal`; observe `after-setup` | `verify "$LAB" after-setup pass-through` |
| Session-only (fresh lab) | `setup "$LAB"`; `launch "$LAB" session-only normal`; observe `session-only` | `verify "$LAB" session-only routed` |
| Skip | In a fresh lab: `setup "$LAB"`; `launch "$LAB" skip normal`; observe `skip` | `verify "$LAB" skip pass-through` |
| Disabled startup | `setup "$LAB"`; `launch "$LAB" session-only disabled`; observe `disabled` | `verify "$LAB" disabled pass-through disabled` |
| Changed cwd | In a routed session, ask for one Bash call that only changes cwd to the lab's `project other é`, then a separate observer call named `cwd-enabled`; repeat into `project disabled é` with `cwd-change` | `verify "$LAB" cwd-enabled routed other`; `verify "$LAB" cwd-change pass-through disabled` |
| Resume | Exit a routed session, retain its real session UUID; `launch "$LAB" session-only normal --resume UUID`; observe `resume` | `verify "$LAB" resume routed` |
| Fork, when supported | `launch "$LAB" session-only normal --resume UUID --fork-session`; observe `fork` | `verify "$LAB" fork routed`; record new session ID and unchanged parent |
| Subagent, when supported | Ask the actual host to delegate only the observer command named `subagent`; do not execute it in the parent as a substitute | `verify "$LAB" subagent routed`; correlate the actual subagent tool trace/ID |
| Uninstall | Exit all host sessions; save current settings and managed artifact hashes; `uninstall "$LAB"`; `launch "$LAB" native normal`; observe `uninstall` | `verify "$LAB" uninstall pass-through`; check unrelated settings and old managed artifact hashes |

Each operation in the table is prefixed with `node test/claude-acceptance/run.mjs`. Project paths are in `lab.json`; the example names contain spaces and Unicode deliberately. A changed-cwd test must use one ongoing Claude session, not a new launch with a different cwd or a compound `cd && observer` command that avoids the event boundary. Confirm actual host cwd behaviour from its trace. Record an unsupported event as unsupported for that exact version, not a successful transition.

Repeat resume and fork in explicit skip mode, and in a disabled project, with unique case names and the corresponding pass-through verification. To test inherited skip cleanup live, in the routed host request the product's explicit `run --session skip -- <observer command>` as a separate case and record that invocation; a fresh skip launch alone does not exercise inherited cleanup. If the host lacks fork/subagents, retain its help/capability evidence and mark unsupported; if no attempt was made, mark not-run.

Uninstall removes product-owned configuration, not the environment already inherited by running shells. Observe that boundary separately rather than expecting uninstall to rewrite another process. Preserve pre-setup user-hook and plugin settings snapshots; Claude may add its own settings during a session, so compare ownership scopes as well as bytes. The automated uninstall test uses an exact unchanged unrelated-settings control.

## Evidence and classification

The observer records allowlisted shell and tool environments, actual cwd/argv, resolved Cargo command, correlated random nonce, child completion status and artifact location. In live mode its wrapper delegates to the explicitly selected real Cargo binary with that environment; it does not manufacture an artifact. Builds are dependency-free and offline. An absent/nonzero tool completion, mismatched nonce/backend, missing artifact, source mutation, incorrect routing or unexpected local target fails verification. Capture files use exclusive creation; retries require a new case name or lab, not overwriting evidence.

`verify` returns child assertions only: fixture-only or live-candidate, with live acceptance still unverified. A reviewer must correlate them with the actual host session, lifecycle event, tool invocation and nonce. Record each case as passed, failed, blocked, unsupported or not-run, including exact source revision, Claude version, machine, command, evidence paths and any permission/authentication limits. Never relabel a fixture-only result, missing observation, replay, or a parent-only tool call as a host/subagent pass. This protocol does not certify billed-token neutrality.

After all lab processes have exited, retain only reviewed/redacted evidence and remove the disposable tree explicitly:

```sh
node test/claude-acceptance/run.mjs cleanup "$LAB"
```

Cleanup validates the lab's canonical location and fixed config/storage paths, then removes that lab only. It is not process containment; retain the tree when child lifetime is uncertain. It never invokes prune on contributor storage.

## Host contract references

Consult the installed version's help and the official [hooks reference](https://code.claude.com/docs/en/hooks), [CLI reference](https://code.claude.com/docs/en/cli-reference), [settings reference](https://code.claude.com/docs/en/settings), [environment variables](https://code.claude.com/docs/en/env-vars), and [local marketplace procedure](https://code.claude.com/docs/en/plugin-marketplaces). These document environment-file persistence, cwd events, resume/fork options and configuration scope. They guide the protocol; documentation availability does not establish that this runner has those features or that a specific host passed.
