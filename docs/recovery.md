# Explicit owned-runtime recovery

`recover` inspects interrupted setup, update and uninstall, plus damaged runtime
metadata. It is not a reinstall command, a filesystem scanner, an ownership
adoption tool or a replacement for agent-configuration review.

## Review first, apply explicitly

Run these commands from a trusted package copy, with the **same HOME/data/config
and agent-home environment** as the installation being inspected:

```sh
clean-development recover --json
# Review every action, retained finding and the returned planId.
clean-development recover --apply --plan-id <reviewed-planId> --json
```

`recover` and `recover --dry-run` are read-only, including on an uninstalled or
missing-volume installation. They do not create locks, directories or reports,
execute a tool, evaluate project code, or edit agent configuration. Shell
redirection of the JSON is the caller's own explicit file write. Project
configuration is deliberately excluded; the installation's user/environment
configuration is authoritative, as it is for setup and update.

When the stable launcher or installed runtime is damaged, run the CLI from a
separate trusted package rather than the broken installed launcher:

```sh
node /absolute/path/to/trusted/package/bin/clean-development.js recover --json
node /absolute/path/to/trusted/package/bin/clean-development.js recover \
  --apply --plan-id <reviewed-planId> --json
```

The examples' angle-bracket values are placeholders, not literal shell input.
There is no automatic repair, implicit approval, `--force`, guessed location,
receipt-selected executable, package download, or automatic artifact deletion.
`--apply` without a 64-character plan ID is rejected. `--apply --dry-run` is also
rejected. A changed plan must be reviewed again. The plan ID is a freshness
precondition, not a signature, authentication token, or saved grant of consent.

The public `clean-development/api` exports `planRecovery({env})` and
`applyRecovery({env, apply: true, planId})`. Apply accepts no caller-supplied
candidate paths or replacement bytes. A plan reports `actions`, `retained`,
`blocked`, exact locations and SHA-256 preconditions. Each retained finding has
an explanation and a specific next step. An apply returns `applied`, `retained`
and `retainedLocks`; partial failure preserves the initiating error and exposes
completed repairs/staging evidence on the API error's `recovery` property.
The CLI exits nonzero on an error or a globally blocked apply. Retained findings
without eligible repairs are not silently treated as repaired: they remain in
the report even when the command has no changes to apply.

## Ownership evidence and operation intent

New explicit CLI setup/update/uninstall operations write
`<stateDir>/recovery.json` while holding the existing setup lock. This bounded
lifecycle witness records the selected locations and directory device/inode
identities, an operation UUID, phase, exact runtime receipt, verified ownership
marker and verified generated launcher bytes. It records no child commands,
prompts, transcripts, credentials or arbitrary user configuration contents.

Phases are `started`, `runtime-published`, and `complete`. Setup/update capture
prior ownership before runtime publication and current ownership before native
integration work. Uninstall captures its intent before removal starts. A retry
of the same incomplete operation retains its original evidence. A different
explicit lifecycle archives the incomplete witness before recording new intent.
The witness is not a queue: plugin discovery, ordinary launches and planning do
not apply it or treat it as consent to install anything.

Existing runtime receipt schema/path/launcher checks are reused. Recovery adds
canonical ancestry, bounded regular-file reads, exact content hashes, physical
identity checks when witnessed, independent snapshot comparison, and
per-candidate revalidation. Ordinary refreshes of `installedAt` and `source` are
not changes to ownership: snapshot comparison checks the version, status,
installation ID, Node/managed paths, bin ownership and complete inventories.
The target file itself is still fingerprinted exactly for apply. A receipt source path is descriptive only; it is
never followed to obtain executable repair content. Missing payload bytes must
come from the **trusted currently executing package** and match the installed
receipt's hash. Another release may be unable to supply them; that is a retained
finding, not permission to change versions.

| Observed state | Explicit recovery behaviour |
| --- | --- |
| Missing configured root, cache/build/scratch base or app-data location | Block. Name the original location to restore. Do not recreate it, choose another drive or infer a mount from its path. |
| Existing root replaced by another real directory | If a lifecycle witness exists, reject changed device/inode identity even when copied marker/receipt text matches. |
| Absent receipted payload leaf in the same verified runtime | Create only the absent file, in its existing canonical parent, from exact hash-matching package bytes. |
| Missing runtime directory or intermediate parent | Retain. Do not recreate a potential mount point or a whole version tree. |
| Unmarked partial copy, unknown staging directory, inactive version | Report and retain. Names such as a version number or `.tmp-...` never grant ownership. An explicit setup may retry its own installation protocol. |
| Missing active receipt and/or ownership marker | Restore exact independent snapshot bytes only with the witnessed runtime identity and other corroboration. Without that evidence, retain. |
| Malformed, mismatched or changed existing receipt/marker | Preserve it, report the mismatch and request a verified backup/manual review. Recovery does not overwrite damaged existing metadata. |
| Missing stable launcher | Recreate exact receipted bytes only after runtime payload verification. Preserve the original Node path/argv contract. |
| Stale launcher after interrupted update | Roll back only bytes exactly matching that operation's recorded intended launcher, to verified prior launcher bytes while the prior receipt remains active. Any additional modification is retained. |
| Uninstall interrupted before tombstone publication | Publish a tombstone from the unchanged witnessed receipt; do not recreate launchers or delete remaining files. Ask for another explicit uninstall to evaluate the remainder. |
| Missing completed uninstall tombstone | Restore its exact independent snapshot. Never resurrect the runtime. |
| Invalid agent integration receipt or changed config home | Retain and explain the mismatch. Do not guess ownership markers, rewrite settings or silently resume integration changes. |
| No witness from a legacy installation | Existing valid receipt plus marker can still authorise absent payload/launcher restoration. Lost receipts/markers cannot be reconstructed from familiar names. |

Recovery of an interrupted first setup can therefore correctly produce **no
eligible repairs**. There was no published ownership evidence for its staging
copy. Preserving that copy and identifying the next explicit setup step is safer
than pretending it is owned. Likewise, recovery does not automatically complete
an update: a verified rollback restores the old active launcher contract; the
operator then explicitly retries update.

## Locks, publication and crash handling

Apply resolves and checks the reviewed plan again before any lock writes. It
then acquires the same `setup.lock` and `runtime.lock` paths used by lifecycle
operations, in that order, and re-resolves the configuration and the entire plan
under both locks. It independently revalidates each candidate immediately before
publication. A candidate changed by a competing writer is retained; earlier
successful repairs are reported rather than rolled back through unverified data.

Recovery's compatible lock adapter requires real canonical directories, regular
owner records, valid schema/token/PID/time, and the acquired directory and file
identities. A valid owner whose PID is confirmed absent by `ESRCH` can have its
lock **renamed to a retained `.recovery-stale-<UUID>` sibling**. An ownerless,
malformed, replaced, inaccessible or otherwise uncertain lock is not removed or
guessed stale by age. Waiting is bounded to 30 seconds per lock. Ordinary release
removes only the lock owned by this recovery operation; that bookkeeping is not
authority to delete installation files or build artifacts.

Repairs use an exclusively created, bounded stage in a verified existing
directory, checked content and file `fsync`, followed by fresh ownership checks.
Payload stages are placed at the verified version root, outside its `bin/` and
`src/` inventories, so retained evidence cannot break the installed runtime's
own package-content checks. An absent target is published
with an atomic hard link, so a last-moment competing file produces `EEXIST`, not
an overwrite. A provably owned interrupted launcher or uninstall receipt is
replaced by rename only after exact precondition checks. Failed stages are
retained, and cleanup cannot replace the original error. Successful no-clobber
publication also retains its staging link as evidence. The plan/result reports
retained evidence; it is not enrolled into automatic pruning or name-based
uninstall ownership. No supported automatic evidence cleanup is added.

Re-running a successful repair plan produces no remaining repairs. A process
killed before target publication leaves its stage and unchanged target. A kill
after publication leaves a complete target; a new plan proposes only the
remaining work. Replaced directories, modified files and uncertain lock
ownership stop that convergence deliberately.

## Reproducible disposable verification

```sh
node --test test/recovery.test.js
node --test test/cli.test.js test/runtime.test.js \
  test/runtime-regressions.test.js test/safety-regressions.test.js
npm run check
npm test
npm run test:package
```

`test/recovery/worker.mjs` is a test-only worker, inert unless explicitly invoked
by the harness. Tests use fresh canonical temporary homes, data/config/managed
roots, synthetic credentials, source manifests, Git metadata and deliverables.
The protected trees are fingerprinted. No contributor agent configuration or
build storage is used. A real filesystem syscall completes before deterministic
injected interruption; no production environment fault switch is introduced.

Coverage includes actual `SIGKILL` and PID-death confirmation during repair,
update and uninstall; IPC/marker-barrier-controlled concurrent setup/uninstall
and recovery; partial copy and publication failures; a 17-byte injected ENOSPC
stage; final-syscall no-clobber races; per-candidate changes; modified inventory,
marker and launcher retention; alias/replacement/missing-volume controls; exact
argv/cwd/stdin/stdout/stderr/exit 23 through a restored launcher; and idempotence.
The synthetic `0.0.9` package tests protocol transitions, **not** compatibility
with a released older package. The separate package gate requires the genuine
`v0.2.0` Git tag and exercises installed tarballs/lifecycle; a missing tag is a
blocked gate, not a reason to manufacture a tag or claim an upgrade pass.

Workers have 15-second event/barrier bounds and 256 KiB output bounds; direct
CLI calls have 20-second/2 MiB bounds. Metadata reads/publications are capped at
2 MiB, receipts at 512 records, and runtime top-level reporting at 128 entries.
Test teardown waits for or kills/reaps its children and checks fixture identity
and its random token before deletion. These are bounded tests, not disk quotas.

## Limits and review boundaries

The initial executed platform is Linux/Node 22. Native Windows/macOS acceptance
requires their own runs. Hard-link publication deliberately fails without an
unsafe fallback on filesystems that do not support it. Read-only inspection is
not an atomic snapshot; file reads may update filesystem access times.

This is not protection against an attacker with the same user's write authority
over every receipt/witness. Hashes and random ownership IDs detect damage and
unrelated files; they are not cryptographic authentication of local metadata.
Directory identity is checked only where an earlier witness recorded it; legacy
receipts do not establish persistent device identity. Inode reuse, remount inode
changes and unusual network filesystems can cause conservative retention.

Final pathname validation and rename/unlink are separate operations. The tests
prove specified cooperative lifecycle interleavings, not all hostile same-user
filesystem races. The shared general lock implementation's separate hardening
work remains relevant. There is no kernel containment or openat-based directory
capability protocol. Process-kill tests do not establish power-loss durability:
files are synced, but multi-file publication, parent-directory persistence and
native integration edits are not one durable filesystem transaction.

Recovery never deletes source, credentials, build storage, archives or final
artifacts. It does not broaden prune authority or remove uninstall tombstones.
Rollback of this feature is a code revert; preserve lifecycle witnesses and
residual repair evidence for inspection. Existing installed files are changed
only by an explicitly reviewed apply or a separate explicit lifecycle command.
