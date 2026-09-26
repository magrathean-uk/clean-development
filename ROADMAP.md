# Roadmap

## Current follow-up

- Keep session-choice acceptance current: read-only plans, interactive defaults, explicit modes, exact persistence, skip, and disabled projects.
- Repeat named-host workflows when integration code or host versions change. Finish Codex App, Claude native lifecycle, OpenCode, Pi, and launcher-only host acceptance.
- Measure paired shim overhead, cold/warm reuse, concurrent worktrees, and external-volume failures across supported environments.
- Complete native Windows process, path, signal, and integration checks.
- Verify public-registry installation and remote release settings when publishing. Do not infer availability from package metadata.
- Capture comparable model-facing requests before making broader prompt or token claims.

[Verification](docs/verification.md) records the evidence boundaries; [the implementation ledger](docs/master-plan.md) separates shipped code from acceptance.

## Later adapters

Consider SwiftPM scratch paths and Xcode DerivedData with separate treatment for archives and release evidence. Maven, Gradle, CMake, Bazel, Ruby, Elixir, Dart, and framework output need upstream storage contracts and artifact-placement fixtures before support is added.

Cache eviction, scratch expiry, or idle maintenance must account for active processes and tool-specific ownership. These are proposals, not current features.

## Non-goals

- Scanning and deleting arbitrary existing home-directory clutter.
- Replacing package managers or build systems.
- Treating hooks or PATH shims as a filesystem sandbox.
