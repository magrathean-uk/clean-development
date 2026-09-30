# Opt-in Xcode management (macOS)

Clean Development can also look after Xcode's regenerable leftovers. It is **off until you say yes**: `setup`
asks two questions on an interactive terminal (both default to no), and a noninteractive `setup` without a flag
leaves Xcode alone and does not record an answer.

```sh
clean-development setup --root /absolute/path --agents claude,codex          # asks on a terminal
clean-development setup --root /absolute/path --agents claude,codex --xcode     # yes to both, no prompt
clean-development update --no-xcode                                            # withdraw both, restore Xcode
clean-development xcode status [--sizes] [--json]
clean-development xcode prune [--older-than DAYS] [--json]                      # dry run
clean-development xcode prune --older-than 30 --apply
```

The answer is stored in the user configuration as `"xcode": { "derivedData": true, "simulators": true }`. It is
user-level only; a project `.clean-development.json` may not contain `xcode`. `update` reuses the stored answer and
never asks again; `--xcode` or `--no-xcode` replaces it. The flags are mutually exclusive and an error off macOS.

`xcode status` reports the configured DerivedData root and the retained `xcode/test-results` root, including when
Xcode management is disabled. It scans sizes only with `--sizes`, using the bounded metadata scanner shared by the
reported roots. The test-results measurement includes retained bundles from `xcode test-run`; it reports logical
file-name bytes, not reclaimable space. JSON labels this root as `testResults` with `retention: "retained"` and
`prunable: false`, and places its optional measurement under `sizes.testResults`. Status never creates absent roots,
and `xcode prune` never lists or removes test results. Review evidence before removing it through its storage owner.

## The two choices

**`derivedData`: route DerivedData into the managed root.** Setup creates `<root>/xcode/DerivedData` and sets one Xcode
preference: `defaults write com.apple.dt.Xcode IDECustomDerivedDataLocation -string <root>/xcode/DerivedData`. The key was
checked in the `IDEFoundation` framework of Xcode 27; Xcode and `xcodebuild` both read it, and an explicit
`-derivedDataPath` still wins. Setup stores the previous value (or its absence) in `state/xcode.json`.
`update --no-xcode` and `uninstall` put that value back, but only if the preference still holds the value Setup wrote:
a value you changed or removed since is left alone. If the preference cannot be read, restoration stops and keeps
the receipt so it can be retried when `defaults` is available again. Existing DerivedData is never moved, copied or deleted by setup, update or
uninstall.

**`simulators`: allow `xcode prune` to clear simulator and device leftovers.** Nothing else in Clean Development
deletes any of this, and `xcode prune` never runs by itself.

## What `xcode prune` can remove

It prints a plan first. `--apply` acts on the entries marked `remove` and re-checks each one immediately before acting.
Missing or malformed `simctl` device data is treated as unknown state and blocks the affected simulator cleanup,
including when the data becomes unreadable after planning. A valid empty `devices` object means no devices were found.
Filesystem cleanup requires canonical directory paths, including every ancestor. A symlinked Developer directory or
an ancestor replaced by a symlink after planning is retained.

| Category | Needs | What is removed | Kept when |
| --- | --- | --- | --- |
| `derived-data` | `derivedData` | project folders of `<root>/xcode/DerivedData` older than the age | recent; no Xcode `info.plist` marker; not a real directory; Xcode running or unknown |
| `device-support` | `simulators` | folders of `~/Library/Developer/Xcode/{iOS,watchOS,tvOS,visionOS,xrOS} DeviceSupport` older than the age (they regenerate when a device connects) | recent; not a real directory; Xcode running or unknown |
| `unavailable-simulators` | `simulators` | `xcrun simctl delete unavailable` (simulators whose runtime is gone) | none found; `simctl` cannot run |
| `testing-simulators` | `simulators` | `xcrun simctl --set testing delete all` (the `~/Library/Developer/XCTestDevices` set) | a simulator is booted; `simctl` cannot run |
| `simulator-caches` | `simulators` | the contents of `~/Library/Developer/CoreSimulator/Caches` (rebuilt on next boot; the folder stays) | a simulator is booted; `simctl` cannot run |

The age defaults to `retention.buildDays` (30). Age is the newest modification time of the project folder and its
`info.plist`, so it is a cheap check, not a scan of the tree. Xcode's shared `ModuleCache.noindex` and similar folders
are not project folders and are never listed. Other simulators, installed runtimes, archives, provisioning profiles,
signing material and the default `~/Library/Developer/Xcode/DerivedData` are never touched.

## Opt-in one-run simulator tests

`xcode test-run` provides a fresh simulator for one explicitly requested child command. It is independent of the
`simulators` setup choice and does not enable pruning:

```sh
clean-development xcode test-run \
  --device-type com.apple.CoreSimulator.SimDeviceType.iPhone-17 \
  --runtime com.apple.CoreSimulator.SimRuntime.iOS-26-0 \
  --session session-only -- node ./scripts/run-ios-tests.mjs
clean-development xcode test-cleanup RUN_ID
```

Supply exact installed device-type and runtime identifiers. Before it changes simulator state, the command checks
that Xcode, Simulator, `xcodebuild`, and `xctest` are not running and that their state can be determined. It creates
one uniquely named device in the host's default CoreSimulator device set, records its exact UDID, and launches the
child directly with its original arguments, cwd, and inherited stdio. The default device set is under the user's
home directory, so the simulator's temporary device data lives there while the run is active. Results and the
ownership receipt are kept under the configured managed root at `xcode/test-results/<run-id>` and
`xcode/test-run-records/<run-id>.json`. For this feature the managed root must be a real canonical directory outside
both the home directory and the current project, including when `--session skip` is selected.

The child uses the same command-time routing as `clean-development run`: supported direct and nested tool commands
receive the managed shims in a routed session, while `skip` and a project's `enabled: false` retain native execution.
Project tool switches and cache destinations apply to the child. The simulator receipt and result locations use the
user-level Xcode configuration so a project cannot redirect later simulator cleanup. Explicit tool environment
overrides remain preserved. Direct supported tool targets are checked for source/storage conflicts before simulator
provisioning. A source checkout change does not refresh an already installed runtime.

The child receives these environment variables:

| Variable | Value |
| --- | --- |
| `CLEAN_DEVELOPMENT_XCODE_TEST_RUN_ID` | Receipt ID for this run |
| `CLEAN_DEVELOPMENT_XCODE_SIMULATOR_UDID` | Exact fresh simulator UDID |
| `CLEAN_DEVELOPMENT_XCODE_DEVICE_TYPE` | Selected device-type identifier |
| `CLEAN_DEVELOPMENT_XCODE_RUNTIME` | Selected runtime identifier |
| `CLEAN_DEVELOPMENT_XCODE_RESULTS_PATH` | Managed results directory for this run |

The command does not rewrite child arguments or construct an `xcodebuild` invocation. An app test runner should read
the UDID and results path after it starts, then pass Xcode a destination such as
`platform=iOS Simulator,id=<CLEAN_DEVELOPMENT_XCODE_SIMULATOR_UDID>`, disable parallel testing for this one-device
run, and place its result bundle under `CLEAN_DEVELOPMENT_XCODE_RESULTS_PATH`. For example, a small Node runner can
build `xcodebuild test` arguments using `process.env.CLEAN_DEVELOPMENT_XCODE_SIMULATOR_UDID` and
`path.join(process.env.CLEAN_DEVELOPMENT_XCODE_RESULTS_PATH, "App.xcresult")`, then spawn `xcodebuild` directly.
Expanding those variables in the calling shell will happen too early; consume them inside the child runner.

After the child exits or receives SIGINT/SIGTERM, the command shuts down and deletes only the exact simulator whose
identity still matches the receipt. It preserves the child's exit status. If a test process remains active, activity
cannot be checked, the owning command is still finishing, or device/receipt identity changed, cleanup is retained with
a receipt. Malformed device-list members, including missing or invalid UDIDs, are unknown state and cannot establish
that the owned simulator is absent. After the original `xcode test-run` command exits and Xcode test activity stops, retry only that run with
`clean-development xcode test-cleanup RUN_ID`. SIGKILL, power loss, or an interrupted creation can leave a receipt
and device; the command does not guess which unreceipted simulator to remove. Result bundles are retained for
inspection and can be removed later through the configured external storage owner.

Deletion never follows symlinks and stays inside the expected parent. If `pgrep` cannot say whether Xcode or
`xcodebuild` is running, DerivedData and DeviceSupport are kept. DerivedData is Apple's regenerable build cache, not a
place for products you need: copy release builds out before pruning. This is a different decision from SwiftPM
scratch (see [swiftpm.md](swiftpm.md)), which Clean Development never deletes.

## Limits

- macOS only. Other platforms ignore the setting and reject the flags.
- The simulator runtimes themselves live in `/Library/Developer/CoreSimulator` disk images and are not relocated.
- A simulator device set is not moved; only leftovers are removed.
- `xcodebuild` is not shimmed. It follows the preference; a build that passes `-derivedDataPath` is unchanged.
- The tests use fake `defaults`, `xcrun` and `pgrep` in a disposable home. The real Xcode preference and real
  `simctl` were read but not written during development; `simctl` needs Xcode's first launch to have run.

Related: [configuration](configuration.md), [safety model](safety-model.md).
