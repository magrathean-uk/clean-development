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

## The two choices

**`derivedData`: route DerivedData into the managed root.** Setup creates `<root>/xcode/DerivedData` and sets one Xcode
preference: `defaults write com.apple.dt.Xcode IDECustomDerivedDataLocation -string <root>/xcode/DerivedData`. The key was
checked in the `IDEFoundation` framework of Xcode 27; Xcode and `xcodebuild` both read it, and an explicit
`-derivedDataPath` still wins. Setup stores the previous value (or its absence) in `state/xcode.json`.
`update --no-xcode` and `uninstall` put that value back, but only if the preference still holds the value Setup wrote:
a value you changed since is left alone. Existing DerivedData is never moved, copied or deleted by setup, update or
uninstall.

**`simulators`: allow `xcode prune` to clear simulator and device leftovers.** Nothing else in Clean Development
deletes any of this, and `xcode prune` never runs by itself.

## What `xcode prune` can remove

It prints a plan first. `--apply` acts on the entries marked `remove` and re-checks each one immediately before acting.

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
