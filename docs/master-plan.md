# Implementation and acceptance ledger

This ledger describes the code and the remaining acceptance work. Historical results belong in [verification](verification.md); the package version alone does not identify every later source change.

## Implemented in source

- A local CLI for planning, setup, update, routing, diagnosis, pinning, pruning, and uninstall.
- Read-only manifest detection and session-only, persist, and skip choices. Native integrations default to pass-through skip.
- Shared cache adapters and dynamic per-workspace Cargo output. See [the README](../README.md) for the tool list.
- Opt-in command-local SwiftPM routing with retained scratch, separate Xcode preference/cleanup management, and an explicitly requested simulator test lifecycle. See [SwiftPM](swiftpm.md) and [Xcode](xcode.md) for their acceptance boundaries.
- Versioned runtime files, stable launchers, exact ownership receipts, locks, leases, and conservative removal.
- Explicit pruning limited to registered Cargo build roots. Source, credentials, toolchains, and unregistered output stay outside that ownership.
- Launcher and package routes for the agent names in `src/constants.js`; native adapters for selected hosts.
- Isolated test and package harnesses, offline fixture projects, and a paired dispatch benchmark.

## Acceptance work

| Area | Status |
| --- | --- |
| Source and package tests | Historical passing checkpoints are recorded; repeat for a proposed release |
| Codex CLI and Grok | Named historical model workflows passed; newer versions and broader lifecycle behavior need separate evidence |
| Claude | Management skill and explicit child-command routing have recorded live acceptance; full native lifecycle remains open |
| Antigravity | Short workflow recorded; long-command cancellation remains a recorded host limitation |
| Codex App, OpenCode, Pi, and other host surfaces | Implementations or package routes exist; complete host acceptance remains open |
| Performance | One historical candidate met the provisional 75 ms p95 ceiling; broader Node/platform coverage and the 50 ms target remain open |
| Windows and failure conditions | Native execution, volume loss, disk-full, races, and real concurrency need broader testing |
| Publication | Repository and npm settings describe intent; verify actual public artifacts and remote settings separately |
| Prompt and token behavior | Runtime adds no authored prompt text; billed-token neutrality is not established |

## Deferred scope

Native cache eviction, scratch expiry, additional Apple archive/XCFramework workflows, and further ecosystems need their own storage and concurrency contracts. SwiftPM products and Xcode test results are retained; visibility does not make them eligible for Cargo pruning. See [development-history lessons](development-lessons.md) for the observed workflow gaps behind the current priorities.

See [the roadmap](../ROADMAP.md), [agent integrations](agent-integrations.md), [safety model](safety-model.md), and [performance targets](performance.md). Historical audit checklists remain dated records rather than current completion claims.
