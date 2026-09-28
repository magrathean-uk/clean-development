# Workspace status and advisory build budgets

```sh
node bin/clean-development.js status --workspaces
node bin/clean-development.js status --workspaces --sizes --json
node bin/clean-development.js status --build-budget 20GiB
node bin/clean-development.js status --workspaces --sizes --max-scan-entries 50000 --max-scan-ms 2000 --json
```

For an installed package use `clean-development` with the same arguments. This
command is read-only: no setup, directory creation, repairs, tool execution,
project script execution, lease cleanup, pin changes or deletion. The budget is
an invocation-only advisory threshold, not a saved setting or cleanup trigger.

`--workspaces` adds valid registered workspace records, stable IDs, source and
build paths, last use, pin state, active/uncertain leases and pruning eligibility.
Eligibility uses the same planner as `prune`. A corrupt matching lease can protect
a workspace without proving that a build is running. Paths from other build roots
remain visible but are not scanned as per-workspace data. Missing, unowned, unsafe
or unreadable records are never represented as eligible. Invalid registry files
are ignored and retained; the view is not an inventory of all files on the disk.

Default `status` output remains JSON for compatibility. `--workspaces` or
`--build-budget` selects readable text unless `--json` is supplied. Text output
escapes controls in stored names and paths so they cannot inject terminal escapes.

## Size scope and limits

Size scans are opt-in. `--build-budget` implies both `--sizes` and `--workspaces`.
The default shared scan budget is **200,000 directory entries and 5,000 ms** for the
entire request, not per workspace. Workspace sizes are observed before aggregate
root sizes. Repeated exact roots reuse the same observation. Overlapping but
non-identical roots can consume the budget twice and their results must not be
summed. Scan limits require `--sizes` or `--build-budget`; zero performs no traversal.
The shared time budget is checked before each scanner filesystem read, including
identity and canonical-path rechecks. Once it expires, only already-open directory
handles are closed; no further metadata reads start, including for later roots.
A final read, recheck or close that reaches the deadline makes the observation
partial with a `time-limit` issue, even when enumeration has reached its end.
Already observed bytes remain visible. Legacy totals that depend on a partial
observation stay `null`; an affected advisory budget stays `unknown`. A stalled
filesystem syscall or required handle close cannot be cancelled, so this is not a
hard wall-clock timeout. Output order is stable; which entries an interrupted
directory scan observes depends on filesystem enumeration order.

The scanner reads metadata, never regular-file contents. It rejects noncanonical
or symlink roots, skips descendant symlinks and special files, and skips descendants
whose device ID differs from the root. It streams directory entries rather than
loading entire directories, bounds queued work, closes directory handles, and
rechecks directory identities/canonical paths around enumeration and child stats.
Detected races and failures make the observation partial. It is not an atomic
snapshot, a hostile-filesystem sandbox, or a guarantee against all races. Bind
mounts sharing the same device ID cannot be distinguished by this check.

- `logicalBytes` sums regular-file lengths **per file name**, including multiple
  hard links. It is not physical disk use, space saved, or space reclaimable.
- `allocatedBytes`, where supported, sums regular-file `stat.blocks * 512`,
  deduplicated by device/inode within that scan. Directory/metadata allocation is
  not included. It is `null` when unavailable, including Windows, and is not a
  promise of reclaimed space: external hard links, clones, snapshots and filesystem
  accounting can change the result of deleting data.
- Missing or unsafe roots return unknown (`null`), not a misleading zero. Partial
  scans retain the bytes actually observed. Integer overflow returns `null`, not
  a silently rounded total. A complete observation still describes a changing
  filesystem over an interval, not an atomic point in time.

## JSON contract (schema version 1)

Existing keys such as `version`, `root`, `workspaces` (a count), `runtime` and
`activeWorkspaces` remain. Added keys are:

| Key | Contract |
| --- | --- |
| `schemaVersion`, `inspectedAt` | Report schema and ISO timestamp. |
| `workspaceDetails` | Present with workspace reporting; array of records with `workspaceId`, `name`, `workspace`, `buildRoot`, `path`, `lastUsedAt`, `pinned`, `activeOrUncertain`, `selectedBuildRoot`, `eligible`, `reason`, `size`. |
| `workspaceScope`, `retentionBuildDays` | Scope statement and the unmodified configured age policy. |
| `sizeMeasurements` | With sizes: `caches`, `builds`, `scratch` measurements. |
| `scanLimits` | Shared `maxEntries`, `maxDurationMs`. |
| `bytes` | Legacy root keys: logical bytes only when the measurement is complete; otherwise `null`. Consumers previously assuming a number must handle unknown values. |
| `registeredBuilds`, `eligibleBuilds` | With workspace sizes: selected-root record counts, `status`, `incompleteEntries`, `observedLogicalBytes`, and `reclaimableBytes: null`. |
| `buildBudget` | With a budget: `scope`, `limitBytes`, `status`, `overByBytes`, `advisoryOnly: true`, `retentionUnchanged: true`. |

Measurements contain `schemaVersion: 1`, `path`, `status`, `logicalBytes`,
`allocatedBytes`, `files`, `directories`, `entriesVisited`, `hardlinkDuplicates`,
`symlinksSkipped`, `specialFilesSkipped`, `issueCount`, `issues` and `durationMs`.
`status` is `complete`, `partial`, `missing`, `unsafe` or `unavailable`.
A deliberately unscanned workspace instead has `{status: "not-measured", reason}`.
Issues contain a code and relative path; at most 20 details are retained, while
`issueCount` reports the full number. No file contents or raw error messages are
included. Local paths can still be sensitive; review output before sharing it.

The advisory budget covers **registered build logical bytes under the selected
build root**, not shared caches, arbitrary files, other roots or physical storage.
Unregistered data can make the aggregate build-root measurement much larger.
Budgets accept whole bytes or integer B/KB/MB/GB/TB and KiB/MiB/GiB/TiB quantities;
no fractional/scientific notation. Decimal units use 1000, binary units use 1024.
A complete registered-build observation reports `within` or `over` and an exact
integer `overByBytes` for that observation. Incomplete measurements or unsafe
records produce `unknown` and `overByBytes: null`; a partial scan cannot certify
that a budget is met. Exceeding the budget does not change the process exit status,
retention, pins or leases, and never makes additional data eligible for cleanup.

## API and validation

```js
import { resolveConfig, storageStatus, measureDirectory } from 'clean-development/api';
const report = storageStatus(resolveConfig(), { workspaces: true, sizes: true });
const measurement = measureDirectory('/absolute/canonical/path', { maxEntries: 10000 });
```

`storageStatus` additionally accepts `buildBudgetBytes`, `maxEntries`,
`maxDurationMs`, and `env`; `createSizeScanner` shares one budget across multiple
`measure(path)` calls. `formatStorageStatus` and `parseByteSize` are also exported.
No returned value is an authority to delete. Review a fresh `prune --json` plan;
only an explicit `prune --apply` performs the separately revalidated deletion.

Relevant tests: `test/measurement.test.js`, `test/status.test.js`, and
`test/inspection.test.js`. Filesystem contract:
https://nodejs.org/docs/latest-v22.x/api/fs.html#class-fsstats
