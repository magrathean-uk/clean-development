# Isolated footprint verification

The opt-in fixture helpers in `scripts/harness-utils.mjs` and
`scripts/footprint-utils.mjs` support predefined native-tool and host acceptance
checks. They are verification code, never runtime telemetry. They launch no
commands or installers themselves and make no contributor configuration changes.

## Native fixture environment

`isolatedNativeEnvironment(root, inherited, { overrides })` returns an environment
whose native `HOME`, Windows application-data homes, XDG configuration/data/cache/
state homes, agent config homes, supported tool caches and temporary paths belong
to a disposable fixture root. Clean Development cache/build/scratch selections
also belong to that fixture. The helper creates nothing: the harness creates its
needed directories before launching a child. Allocate the fixture root beneath
the already reviewed scratch destination, and run verification through
`clean-development run --session session-only -- ...`.

The additive helper leaves `isolatedEnvironment`'s CLI-only contract intact.
Native verification must deliberately opt in. It preserves executable PATH,
installed Rustup selection, SDK variables and toolchain pins. Cargo's user home
defaults to a disposable home; an intentionally prepared hermetic Cargo home can
be supplied through `overrides`. Existing hermetic Git controls remain intact.
Inherited npm settings are replaced with fixture config/cache paths, and Rustup
automatic installation is disabled. A fixture must add its own offline/no-download
arguments and explicit native-output destinations; changing HOME is no sandbox.
Selected installed toolchains remain externally owned and must not be updated by
a fixture.

## Selected-root observations

Call `snapshotFootprint([{ name, path }, ...], { limits })` before and after a
predefined fixture child. Selection is explicit: 1 to 32 named absolute roots,
such as the disposable native home, selected cache, selected managed build root,
and a declared retained-output path. Filesystem roots and the observer's real
home directory are rejected. Overlapping selections are observed separately;
their totals must not be added as a whole-disk measurement.

The report records root existence and physical identity, aggregate entry/file/
directory counts, logical file bytes, skipped links/mounts/special files, elapsed
time and completeness. It records neither file contents nor child filenames,
commands, arguments, prompts or environment values. No directory is deleted or
adopted as owned from an observation.

The default shared budget is 20,000 metadata entries, depth 32 and 2 seconds;
explicit limits cannot exceed 200,000 entries, depth 128 and 60 seconds. Directory
enumeration is incremental. Symlink boundaries are rejected; descendant links,
different-device directories and special files are skipped. A skipped boundary,
metadata error, observed replacement/change, or exhausted budget makes the report
incomplete. Time checks are cooperative between filesystem operations: a stalled
filesystem syscall is not cancelled by this metadata helper.

`compareFootprints(before, after)` requires identical selections and reports
existence/identity and aggregate count/byte deltas. Its `clean` value is `null`
when either observation is incomplete. A complete unchanged result means only
that the selected aggregate footprint was unchanged between those observations.
The observations are not atomic and do not prove no transient writes, same-size
content changes, access outside selected roots, or safety against concurrent
same-user path replacement. Only predefined disposable fixture trees should be
used for acceptance checks.

## Failure and evidence boundary

Capture a child's status immediately after execution, before viewing its log.
The log must already have a validated destination beneath selected scratch:

```sh
clean-development run --session session-only -- swift test > "$selected_log" 2>&1
child_status=$?
tail -50 "$selected_log"
exit "$child_status"
```

A failed log viewer must not replace the child status. A timeout, failed child,
partial scan or observer error cannot be presented as a successful footprint
acceptance. Reports should identify source revision/content fingerprint, host/tool
version, selected roots and their completeness, and the concrete artifact checked.
Fixture tests exercise route-stripping into disposable HOME and safe fake
`python3 -m pip` dispatch through a nested shell. They establish harness behavior;
they do not establish live Claude/Codex lifecycle or real pip/Swift acceptance.

Runtime receipt `installedAt` and `installationId` identify the owned versioned
installation. Repeated unchanged ensures verify ownership without rewriting its
receipt. `updatedAt` records a change in receipt content; a verification-only
ensure does not advance either date. New versioned installations retain their own
marker identity and creation time, while existing archived inventories remain
available for recovery and uninstall checks.
