# Runtime installation verification

The runtime is a set of individually published files, not an atomic installation transaction. The application-data lock serializes cooperating setup and uninstall calls; the runtime lock serializes runtime synchronization. Neither lock makes a multi-file upgrade indivisible.

## Ownership rule

A receipt authorizes only its recorded paths and unchanged digests. A file reached through a directory symlink or junction is not at its recorded canonical path, even when the resolved target is still inside the same version directory and has identical bytes. Runtime content hashing therefore validates the file's parent as a real, canonical directory first. Empty-directory cleanup makes the same check before removal, including when all recorded files below that directory have disappeared.

This applies to active inventories, adoption of a fully published runtime copy before its receipt exists, and removal using archived inventories. Unknown files and directory aliases do not gain ownership from a familiar filename, a matching hash, or containment within a runtime directory. The existing leaf-symlink, root-marker, receipt-schema, allowed-launcher and digest checks remain in place.

For example, copying `runtime/<version>/src` to an unrecorded `runtime/<version>/unrecorded-copy` and replacing `src` with a directory link must not authorize deletion of the copy. Before the canonical-directory checks, containment and matching digests admitted that alias: health reported success, repeated setup accepted it, and uninstall removed unrecorded files. The same problem affected archived inventories and empty descendant directories.

## Interruption model

`test/runtime-installation.test.js` uses disposable application-data roots and a synthetic earlier package version. It completes each real filesystem operation and then injects an exception at that boundary. Only lock cleanup unwinds. No sleeps, real agent settings, tool launches or project mutations are needed.

The checkpoints cover receipt archival, staging-directory creation, each of the three top-level copies (`bin`, `src`, `package.json`), marker publication, version-directory publication, every stable launcher, and active-receipt publication. The unchanged POSIX shell helper's executable-mode update is also included. The test derives the launcher set from the receipt so added launchers cannot silently escape the matrix.

Each interrupted state is used independently for a later setup attempt and uninstall; health and removal planning are checked against unchanged filesystem snapshots. This is publication-state evidence, not power-loss/fsync durability, abrupt-process-death, stale-lock-recovery or genuine preceding-release compatibility evidence. The separate package verifier requires the real preceding-release tag.

| Interruption or state | Later setup | Health | Explicit runtime uninstall |
| --- | --- | --- | --- |
| Archive published; staging absent or incomplete | Can retry from the earlier receipt; abandoned staging directories remain | Reports that the earlier version needs updating | Removes receipted earlier files; retains staging content |
| Complete new version directory, before launcher replacement | Can validate that published copy and finish | Still reports the earlier installed version | Removes earlier receipted files; retains the not-yet-receipted new copy |
| One or more changed launchers, before the new receipt | Refuses the mismatch with the earlier launcher inventory | Reports that the earlier version needs updating | Removes unchanged earlier launchers; retains changed launchers and the new copy |
| New active receipt published | Idempotent setup succeeds | Healthy when active files are unchanged and executable | Removes unchanged files from the active and archived versions |
| Active receipt missing, existing launchers and archives present | Refuses existing launchers without their current ownership evidence; automatic activation is inert | Not installed | Does not infer current ownership from archived inventories; leaves the files |
| Modified active file or launcher | Refuses the recorded-content mismatch | Unhealthy | Retains modified files and removes only unchanged recorded files |
| Modified archived runtime file | Active setup is independent of that archived content | Active-version health can still be healthy | Retains the modified file and the unresolved archive |
| Active directory alias, or an alias in a receipt-less published copy | Refuses the non-canonical parent | Active receipt is unhealthy; a missing receipt reports not installed | Does not delete the unrecorded target |
| Archived directory alias, including empty nested targets | Active setup is independent of that archive | Active-version health does not certify archives | Retains the unrecorded target and unresolved archive |

A syntactically valid but unrecognized archive such as an unrelated `{}` JSON file is retained. Health checks the active installation only; neither healthy status nor a removal preview certifies that every archived file is safe to remove.

## Remaining boundaries

The canonical-directory check closes the demonstrated ownership alias. It does not add a pending-installation journal, recover mixed-version launcher publication, or change receipt formats. An interrupted launcher update can still need manual recovery using known-good package and receipt evidence. Do not treat matching new launcher bytes as permission to overwrite a file whose ownership is uncertain.

Uninstall is also incremental: it can remove confirmed owned launchers or files before encountering an uncertain version directory. An unresolved runtime may therefore be partially removed, and its marker may already have been removed. Retained paths need inspection; they are not evidence of a complete usable installation. Unreceipted staging directories are deliberately not reclaimed automatically.

Filesystem validation is a point-in-time check, not a defence against every same-user replacement between validation and I/O. No changes are made to `runTool`, command launching, agent configuration, routing, session consent, or managed build pruning.

Run the focused verification with:

```sh
node --test test/runtime-installation.test.js test/runtime.test.js test/runtime-regressions.test.js test/safety-regressions.test.js
npm run check
npm test
npm run test:package
```

See [architecture](architecture.md), [the safety model](safety-model.md), and [verification](verification.md) for the wider contracts and package-check prerequisites.
