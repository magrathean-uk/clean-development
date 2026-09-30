# Roadmap

## Current follow-up

- Keep session-choice acceptance current: read-only plans, interactive defaults, explicit modes, exact persistence, skip, and disabled projects.
- Repeat named-host workflows when integration code or host versions change. Finish Codex App, Claude native lifecycle, OpenCode, Pi, and launcher-only host acceptance.
- Measure paired shim overhead, cold/warm reuse, concurrent worktrees, and external-volume failures across supported environments.
- Prioritize the documented disappearing/replaced build-base and publication-error cases in [the storage fault lab](test/fault-lab/FINDINGS.md). Preserve physical ownership evidence and the original failure before expanding cleanup scope.
- Use [development-history lessons](docs/development-lessons.md) to guide diagnostics: exact command cwd, selected tool/version, retained-output visibility, simulator reuse, and distinct logical/allocated/free-space evidence. Native test data and retained products remain outside Cargo pruning.
- Complete native Windows process, path, signal, and integration checks.
- Expand the [recorded native ARM64 / exact-Node-minimum checks](docs/verification.md#30-september-native-lab-record) to the configured Node 22/24 and other architecture gates; add verification-timeout descendant cleanup before requiring Windows artifact smoke. Add Linux architecture and external-volume/quota evidence independently of portable fixtures. See [platform support](docs/platform-support.md).
- Verify public-registry installation and remote release settings when publishing. Do not infer availability from package metadata.
- Capture comparable model-facing requests before making broader prompt or token claims.

[Verification](docs/verification.md) records the evidence boundaries; [the implementation ledger](docs/master-plan.md) separates shipped code from acceptance.

## Later adapters

The opt-in [SwiftPM](docs/swiftpm.md) and [Xcode](docs/xcode.md) implementations have separate output and cleanup contracts. Additional Apple archive/XCFramework workflows, Maven, Gradle, CMake, Bazel, Ruby, Elixir, Dart, and framework output need upstream storage contracts and artifact-placement fixtures before support is added.

Cache eviction, scratch expiry, or idle maintenance must account for active processes and tool-specific ownership. These are proposals, not current features.

## Non-goals

- Scanning and deleting arbitrary existing home-directory clutter.
- Replacing package managers or build systems.
- Treating hooks or PATH shims as a filesystem sandbox.
