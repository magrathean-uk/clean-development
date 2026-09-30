# Experimental opt-in SwiftPM adapter

This adapter handles `swift build` and `swift test`. It is disabled by default:
`tools.swift` must be `true` in the effective Clean Development configuration,
and a routed session must be selected. Installing a Swift shim is not opt-in.
`enabled: false`, `tools.swift: false` and explicit session `skip` keep native
execution. There is no automatic installation of Swift or package dependencies.

## Why Swift scratch is retained, not disposable

SwiftPM's scratch directory is not just a compiler cache. Its `.build` tree can
contain binary products, test executables, build intermediates, checked-out
dependencies, plugin working data and generated reports. A release executable
can be the only deliverable a user has. Therefore this adapter **never assigns
SwiftPM scratch to Clean Development's `buildRoot` or `scratchRoot`** and never
registers Swift output with Cargo pruning.

| Data | Direct SwiftPM | Opt-in adapter |
| --- | --- | --- |
| Shared dependency/manifest cache | Native shared cache or `--cache-path` | `cacheRoot/swiftpm`, unless explicitly selected natively; no automatic eviction |
| Mixed scratch: objects, executables, tests, dependency checkouts | Package `.build`, or native scratch selection | Native by default; optional retained per-package directory described below |
| Release binaries and default generated SBOMs within build output | Native build-product directory | Same SwiftPM layout in **retained** scratch, never disposable storage |
| Archives, explicit XCTest XML/attachments and SBOM destinations | Native command/output flags | Unchanged native destinations; never moved, adopted or deleted |
| `.swiftpm`, `Package.resolved`, editable dependencies, credentials, SDKs and toolchains | Native configuration and commands | Not relocated by this adapter |

Only registered, marker-verified Cargo directories are eligible for Clean
Development prune. Swift directories are absent from that registry. Pins and
retention days do not apply to them. A user explicitly choosing a native output
path inside existing disposable storage remains responsible for that choice;
the adapter does not rewrite it or grant it new ownership.

## Configuration and preview

For **cache-only** routing, set `"tools": { "swift": true }`. SwiftPM scratch
remains native `.build`. Do not interpret that mode as source-write isolation.

For scratch relocation, create a separate retained base yourself after mounting
the intended volume, then configure it. Example paths are illustrative:

```sh
mkdir /Volumes/Development/RetainedSwift
```

```json
{
  "schemaVersion": 1,
  "root": "/Volumes/Development/Disposable",
  "tools": { "swift": true },
  "swiftpmWorkspaceRoot": "/Volumes/Development/RetainedSwift"
}
```

```sh
clean-development explain -- swift build
clean-development run --session session-only -- swift build
clean-development run --session session-only -- swift test
clean-development run --session session-only -- swift build -c release --show-bin-path
```

`swiftpmWorkspaceRoot` has **no implicit default**. Its per-key precedence is
command/API overlay > `CLEAN_DEVELOPMENT_SWIFTPM_WORKSPACE_ROOT` > effective project
config > user config. This field does not enable `tools.swift`. The API overlay
is available through `resolveConfig`; there is no new CLI `--swiftpm-*` flag.
Existing setup persists the field from its selected user/environment/API config.
Setting ordinary `--root` does not derive or replace the retained root.

The retained base must be an existing canonical directory, disjoint from the
starting/selected source projects, disposable roots and application data/config.
A home-directory caller is not itself a source project. A root inside a historical
Cargo directory carrying an ownership marker is also refused. All required bases
are checked before adapter preparation. The adapter does not recreate a missing
base or fall back to another disk. Enclosing session preparation can still create
its ordinary external base directories before a later runtime failure.

Below the retained base, each canonical package path receives
`swiftpm-<readable-basename>-<16-hex-path-digest>/scratch`. That path is stable across
commits and sessions, but separate for different checkouts/worktrees. A bounded,
revalidated `.clean-development-swiftpm.json` identity marker prevents accidental
adoption of an existing unmarked directory. It is not a deletion receipt or a
sandbox boundary. Incomplete publication is retained and fails visibly; there is
no automatic repair/removal. Concurrent first publishers may require a retry.
SwiftPM keeps its own native scratch locking.

## Native controls and precedence

The adapter inserts only absolute `--scratch-path` and `--cache-path` arguments
immediately after `build` or `test`, and only when no corresponding native override
was supplied. Every original argument stays in the same order, original cwd stays
unchanged, and child stdio, signals and exit status use the existing foreground
runner. No Swift path environment variable is injected, so a nested process or a
later package cannot inherit a stale adapter scratch path.

- `--package-path PATH` and `--package-path=PATH` select the package. Relative paths
  are interpreted from the original cwd. Discovery walks canonical ancestors to
  the nearest `Package.swift`; it neither executes the manifest nor merges nested
  packages into an enclosing package. Configuration is read from the canonical
  selected directory. Distinct Git worktrees retain distinct identities.
- `--scratch-path`, legacy `--build-path`, or an explicitly present
  `SWIFTPM_BUILD_DIR` prevent generated scratch selection. SwiftPM 6.2.1 itself
  selects `SWIFTPM_BUILD_DIR` before `--scratch-path`, then legacy `--build-path`,
  then `.build`. Relative environment values use the original cwd. Its internal
  `SWIFTPM_TESTS_MODULECACHE` setting can suppress that environment override.
  The adapter does not reimplement or change these native precedence rules.
- `--cache-path` prevents a generated cache flag. `SWIFTPM_CACHE_PATH` is **not** a
  verified portable native interface in the inspected SwiftPM version. When it
  is explicitly present, the adapter conservatively leaves cache selection native
  rather than overriding a caller's intended setting; it does not promise SwiftPM
  honours it. Use documented `--cache-path` for portable explicit selection.
- Native variables are preserved byte-for-byte, including module-cache and SBOM
  variables. Presence checks use exact native names on Linux/macOS and
  case-insensitive names on Windows, including explicitly empty values; unrelated
  POSIX case variants remain unchanged but do not suppress routing. SwiftPM itself
  determines whether a native value is meaningful on the host.
  `CLEAN_DEVELOPMENT_FORCE=1` never discards these Swift overrides.
- `--xunit-output`, `--attachments-path` and current documented
  `--sbom-output-dir` values remain user deliverables. Compiler forwarding options
  such as `-Xswiftc` consume their own next argument; option-looking compiler values
  are not misread as package/cache selectors. Shell redirections remain the shell's
  responsibility. Configuration, security and SDK flags are not changed.

Examples:

```sh
clean-development run -- swift build --package-path ../OtherPackage
clean-development run -- swift build --scratch-path /absolute/user-products
clean-development run -- swift test --parallel --xunit-output /absolute/qa/results.xml
clean-development run -- swift package archive-source --output /absolute/releases/source.zip
```

On the verified Swift 6.2.1 XCTest runner, XML output was produced with
`--parallel`; merely passing `--xunit-output` to the serial XCTest run did not
produce the file. This is native behaviour, not a relocation guarantee.

## Deliberate limits and recovery

This is a bounded arity-aware build/test grammar (512 arguments), not a parser
for arbitrary Swift/compiler/plugin command languages. Unknown or ambiguous
build/test options, duplicate path selectors, response files, missing values and
unsupported multi-root workspace selection fail **before adapter writes or child
execution** when opted in. It accepts the documented common build/test options
listed in `src/swiftpm.js`; it does not guess how a future option consumes values.
`swift test list` and `swift test last` are not currently adapted. Use explicit
`--session skip` for an unchanged native invocation of an unsupported form.

`swift run`, `swift package` (including archive-source, clean, reset, plugin,
publish, edit and generate-sbom), compiler/script invocations, SDK commands and
help/version pass through without adapter flags. A normal native package command
can still create `.build` or `.swiftpm`. To clean retained scratch with SwiftPM,
explicitly provide that scratch path to the native command; never assume a
pass-through `swift package clean` targets the relocated build.

No filesystem sandbox, compiler-version isolation or process-tree containment is
added. Package manifests, plugins and tests remain executable code with the user's
permissions. We do not claim archives/XCFramework workflows (Xcode DerivedData is a separate opt-in, see [xcode.md](xcode.md)),
remote dependencies, alternative build systems, cross-compilation, native Windows
Swift, or all same-user filesystem races are verified. Point-in-time checks cannot
protect a root changed after validation. Back up valuable retained products.

Disabling `tools.swift`, selecting skip, or reverting this feature stops new
routing; existing retained products and caches are not moved or removed. Existing
managed installations require an explicit setup/update to install the new Swift
shim. This source PR does not release or upgrade an installed runtime.

## Primary-source research and executable evidence

Research date: 27 September 2026. Current upstream documentation was inspected at
SwiftPM commit `24a8a7b071d9fc92540ce464f648bd01f91428cd`; executed Linux toolchain:
**Swift 6.2.1 (`swift-6.2.1-RELEASE`)**, x86_64. Current documentation can describe
newer features than that toolchain (notably SBOM output). Recognition/preservation
of newer flags is not a claim that 6.2.1 implements them.

Primary references:

- [Current Swift build command and output options](https://github.com/swiftlang/swift-package-manager/blob/24a8a7b071d9fc92540ce464f648bd01f91428cd/Sources/PackageManagerDocs/Documentation.docc/SwiftBuild.md).
- [Current Swift test command](https://docs.swift.org/latest/documentation/packagemanagerdocs/swifttest).
- [Source archive output](https://docs.swift.org/latest/documentation/packagemanagerdocs/packagearchivesource).
- [SBOM destinations](https://docs.swift.org/latest/documentation/packagemanagerdocs/generatingsboms) and [SE-0509 native environment/CLI precedence](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0509-swift-sboms-via-swiftpm.md).
- [SwiftPM 6.2.1 location options, including legacy scratch and unsupported multi-root controls](https://github.com/swiftlang/swift-package-manager/blob/swift-6.2.1-RELEASE/Sources/CoreCommands/Options.swift).
- [Scratch selection and separate configuration/security/cache state](https://github.com/swiftlang/swift-package-manager/blob/swift-6.2.1-RELEASE/Sources/CoreCommands/SwiftCommandState.swift).
- [SWIFTPM_BUILD_DIR handling](https://github.com/swiftlang/swift-package-manager/blob/swift-6.2.1-RELEASE/Sources/SPMBuildCore/BuildSystem/BuildSystem.swift).

Repeat the deterministic and required real-tool checks:

```sh
node --test test/swiftpm.test.js test/config.test.js
CLEAN_DEVELOPMENT_REAL_SWIFT=1 node --test test/swiftpm-real.test.js
npm run check
npm test
```

The real suite requires installed Swift, Git and unzip on Linux/macOS; opting in
with a missing tool **fails**, rather than reporting a successful skip. It builds
actual executables, runs XCTest, compares object bytes and mtimes across warm
builds, switches A → B → A across real Git worktrees, builds a nested package and
a release configuration, compares native/routed archive bytes in a standalone
clone, checks requested XML output, native flag/environment precedence, disabled/
skip/cache-only behaviour, nonzero compiler/test exits and retention across explicit
prune. SwiftPM's normal archive scratch is exercised in its own disposable control
project, not mistaken for a routing fallback in the build projects.

The default unit suite explicitly skips expensive real builds; the dedicated
SwiftPM workflow requires them on macOS. Set
`CLEAN_DEVELOPMENT_SWIFT_EVIDENCE=/absolute/new-report.json` to write versioned JSON
with host versions, operation statuses, durations and hashes. The report path must
be absent. A failing lab retains its fixture for inspection. It contains no
contributor environment/configuration. Successful test-lab teardown is separate
from production cleanup behaviour, which never deletes Swift products.
