# Security Review: clean-development

## Scope

Offline Standard repository security audit of clean-development at revision 207389e87f267b4f3e2a1ad17122462b19802508.

- Scan mode: repository
- Target kind: git_worktree
- Target ID: target_sha256_473c37fce9bebe760a1677cd3d94c3362eb02206845952a7668f16aac9a3c0a6
- Revision: 207389e87f267b4f3e2a1ad17122462b19802508
- Snapshot digest: codex-security-snapshot/v1:sha256:4f09994c3db2fc9b2327af469e01403c85c44b4a0f130567a5db2e3bb36673e5
- Inventory strategy: repository
- Included paths: .
- Excluded paths: none
- Artifacts reviewed: CLI/session and configuration resolution, Executable/process/routing adapters, Ownership, leases, prune, recovery and Xcode boundaries, Runtime and agent integration edits, Package scripts and marketplace builder

Limitations and exclusions:
- Partial coverage: 287 tracked files; core security paths and relevant tests/docs reviewed, but not every release script and generated bundle file was line-reviewed.
- Live agent-host policy, native tool behavior, filesystem race and consent semantics were not measured.

### Scan Summary

| Field | Value |
| --- | --- |
| Scan outcome | completed |
| Reportable findings | 0 |
| Severity mix | none |
| Confidence mix | none |
| Coverage | partial |
| Validation mode | static |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

Offline Standard source review of a local Node.js CLI/npm package that routes development caches/build output, installs optional agent integrations and launchers, and provides separate prune/recovery/Xcode workflows. Project configuration is lower trust than user data; commands are not sandboxed.

### Assets

- User config and agent-host integration settings; selected managed roots and build/caches.
- Source checkout contents and project configuration that may influence paths/commands.
- Ownership receipts, active build leases, pinned builds and recovery state.
- Credentials and command bodies in child environment or logs.

### Trust Boundaries

- Checkout/project config and Git metadata -\> root resolution, managed path validation and writes.
- CLI/agent integration input -\> executable resolution and child-process arguments/environment.
- Build ownership and lease records -\> prune/recovery decisions -\> filesystem deletion or configuration restoration.
- Local hooks/marketplace installer -\> user agent configuration and runtime deployment.
- Project-configured external absolute roots are intentionally honored by noninteractive session-only routing, subject to broad-root, real-directory and source-overlap guards; whether separate approval is needed is a product consent question (src/config.js:121-167; src/session.js:129-135,193-222; docs/configuration.md:54-75).

### Attacker Capabilities

- Can influence a project checkout and its .clean-development.json; cannot assume authority to write arbitrary user config or storage.
- Can supply CLI arguments in an authorized local invocation; no remote service endpoint identified.
- Can plant filesystem symlinks in writable project or managed paths where local permissions permit.

### Security Objectives

- Reject broad or escaping managed roots and ensure every destructive action targets a validated owned child.
- Keep routing opt-in/explicit and preserve user environment values unless force is selected.
- Prevent untrusted project configuration or executable names from injecting shell commands or weakening host permission policy.
- Protect active/pinned builds from pruning and keep recovery confined to intended files.

### Assumptions

- Offline read-only source review; no build, tests, network, secrets or live agent host was exercised.
- Modified AGENTS.md and skill files are user-owned source data; their instruction authority was revoked.
- Current checkout has user modifications to AGENTS.md and three skill files; these were treated as source data, not operational instructions.

## Findings

### No findings

No reportable findings survived the canonical discovery, validation, and reportability gates.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Managed roots, ownership and pruning | Project config and state to filesystem writes/deletes | Needs follow-up | Ownership, direct-child, pin, age and active-lease rechecks reviewed; no bypass found. Project-configured external roots are a documented feature but their consent semantics in hostile checkouts remain an open product decision. |
| Package/release scripts | npm package, update and script supply chain | Needs follow-up | Reviewed package scripts and marketplace builder. The symlinked-ancestor write route needs local checkout tampering plus explicit regeneration, not normal prepack. Other release scripts were not fully audited. |
| Marketplace ancestor symlink lead | Developer-only bundle regeneration | Rejected | Requires attacker to replace tracked checkout ancestor and operator to run explicit non-prepack builder; altered checkout already permits source execution. Not a distinct realistic security boundary at this confidence. |
| Claude environment file lead | Host hook environment | Rejected | No route for lower-trust actor to choose host-provided CLAUDE_ENV_FILE without equivalent local write authority; owner gate applies. |
| PATH and ComSpec lead | Child command selection | Rejected | Control of PATH, explicit executable or ComSpec is already caller execution authority; no additional wrapper escalation shown. |
| CLI and process execution | Command/path input to child process and environment | No issue found | Reviewed executable resolution, argument-array process launch, Windows batch quoting, routing context, CLI session choice and relevant tests. No source-backed command injection or session bypass established. |
| Agent integration and durable setup | Hook/launcher writes to user configuration | No issue found | Reviewed runtime receipts, launcher ownership, hook owner binding, recovery and integration edits; no proven unauthorized write route. |

## Open Questions And Follow Up

- Should a noninteractive run/agent require separate approval when an untrusted project config selects a new external root?
- Does any supported agent host allow a lower-trust project to set its hook environment-file path?
- Documented project-config root precedence and explicit run/agent routing are established, but whether an external root from a hostile checkout requires separate user approval is unresolved; no concrete unauthorized overwrite/deletion/disclosure demonstrated.
  - Follow-up prompt: Review deferred unit clean-project-external-root and close its stated proof gap. Paths: src/config.js, src/session.js, src/adapters.js.
- Developer-only release scripts and live Claude/Codex/Grok host behavior were not fully audited or executed in this offline Standard pass.
  - Follow-up prompt: Review deferred unit clean-release-and-host-coverage and close its stated proof gap. Paths: scripts, integrations, hooks.
