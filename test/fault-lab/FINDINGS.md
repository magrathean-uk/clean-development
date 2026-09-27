# Storage fault findings

Tested baseline: `af12577c6596095fdf91f18e840e9433521ea3d2` (main on 27 September
2026), source tree `998605cda006d588e9562cabe1eee6c78c2f3a59`.
Host: Linux x64, Node v22.16.0, npm 10.9.2.

Read `AGENTS.md`, `docs/safety-model.md` and `docs/architecture.md`; checked open
PRs #24–#33 before editing. In particular, #25 owns prune/state validation, #27
owns session preparation, #29 owns routing, and #30 owns probe cleanup. This
harness does not edit any of those modules or tests. It adds only files under
`test/fault-lab/`; the existing generated marketplace bundle is unchanged.

The supplied archive was verified against main's complete Git tree because
container Git networking was unavailable. Publication uses the verified upstream
commit as parent, not the local archive bookkeeping commit. The lab's JSON also
records an exact hash of the product `src/` and `bin/` files used by its processes.

Reproduce all findings and controls:

```sh
node test/fault-lab/lab.mjs --run
# Expected on the baseline: exit 1, three invariant violations, no infrastructure errors.
```

## FL-01 — ordinary ownership publication recreates a disappeared root

Classification: demonstrated violation of the documented missing-base contract.
Failing check: `missing-during-marker/storage-identity`.

Relevant baseline code: `src/adapters.js:81–85,111–123` and
`src/io.js:102–113`.

Sequence:

1. Configure `<lane>/managed` and create its build base. Start an ordinary routed
   Cargo dispatch with no explicit target override.
2. Let `ensureOwnedBuildRoot()` validate the build root and create its temporary
   direct child.
3. Immediately before `writeTextAtomic()` calls recursive `mkdirSync()` on the
   marker's parent, rename the entire managed root to `<lane>/retired-root`.
   The path is now genuinely absent; the original directory remains available
   for independent comparison.
4. Allow that real mkdir and the remaining publication operations to execute.

Expected: reject before recreating the missing managed/build bases or launching
the tool, retain uncertainty, and require restoration or explicit preparation.

Observed: recursive marker-parent creation recreates the entire missing path on
the still-present parent filesystem. The build marker and outside-root receipt
publish successfully. The fake Cargo process writes its artifact and exits 23.
A fresh CLI invocation with identical configuration also writes there and exits
23, without a warning. The old root is untouched, but the new root/build base has
a different inode. The target **string** remains identical.

Impact: the early missing-base check does not prevent this precise validation-to-
publication race from allocating output on a replacement directory. The same
mechanism could matter when external storage disappears; this lab demonstrates
the directory race, not an actual unmount or cross-device write.

Fix direction for the storage/I/O owners: ownership publication must not use a
recursive writer that can recreate already-validated managed ancestors. Preserve
and revalidate the relevant directory identity across publication and fail closed
when it changes. Another preliminary existence check alone is not proof that all
later races are closed. No product fix is included here.

## FL-02 — a different real root is silently accepted at the same path

Classification: demonstrated storage-identity hardening gap against the lab's
explicit stronger invariant, **not** a claim that current documentation promises
persistent mount/device identity. Same-user filesystem races remain a documented
residual risk.
Failing check: `replaced-managed-root/storage-identity`.

Relevant baseline code: `src/adapters.js:81–109,111–124` and
`src/state.js:103–121`.

Sequence:

1. Complete one routed build, retaining its outside-root workspace receipt.
2. Move the whole managed root to a retained sibling directory.
3. Create a different ordinary directory at the configured root path with an
   empty `builds` child and an unowned sentinel. Do not change configuration or
   run setup/prepare.
4. Run the same command, then repeat it in a fresh CLI process.

Expected under the lab's stronger invariant: do not silently approve a different
storage object under an old configured path.

Observed: the missing workspace child is created with a new ownership UUID. The
existing workspace receipt is replaced with the new UUID; both commands execute
against the new directory, return 23, and the fresh CLI emits no warning. The
retired directory and replacement's pre-existing sentinel retain their bytes.

There is **no alternate pathname fallback**. Physical-directory replacement and
string-based rerouting are different findings, and the report tests them
separately. This reproduces neither source deletion nor foreign-file overwrite.

Fix/design direction: decide and document the root re-approval contract. A
persistent root identity/receipt outside managed storage, or a conservative
refusal to recreate a previously registered missing workspace, needs review for
normal user cleanup, remounts and cross-platform identity semantics. Do not infer
that using a random workspace marker alone binds the parent root across runs.

## FL-03 — rollback failure replaces the initiating ENOSPC error

Classification: demonstrated loss of the original filesystem error.
Failing check: `publication-cleanup-error/original-error`.

Relevant baseline code: `src/adapters.js:122–128`.

Sequence:

1. Let the temporary build directory and complete ownership marker be created.
2. Throw one synthetic ENOSPC Error from the staging-to-final-directory rename.
3. In its catch handler, throw a distinct EACCES Error from removal of that exact
   temporary directory. All other filesystem calls remain real.

Expected: retain the initiating ENOSPC object/code as the primary failure,
separately expose cleanup uncertainty, keep the stage, and launch no tool.

Observed: the caller receives the cleanup EACCES object, not the ENOSPC object;
the initiating error is not surfaced. The temporary
stage remains and no tool runs. After removing the fault hooks, the fresh CLI
creates the intended target and exits 23; the interrupted stage remains byte-for-
byte unchanged. Destination fallback and unsafe deletion were not observed.

Fix direction for the ownership-publication owner: catch cleanup errors
separately, preserve/rethrow the initiating error, attach bounded cleanup evidence
without claiming completion, and retain uncertain staging. No product module is
changed by this PR.

## Controls that held

Missing managed root/build base/cache base **before dispatch** was rejected by
both the API dispatch and the fresh CLI. Each error named the missing configured
base; no base was recreated and no fixture tool ran.

ENOSPC at the marker partial-write, marker-rename, directory-publication and
state-receipt-publication boundaries prevented tool execution and preserved the
original error when rollback did not itself fail. Unpublished staging was either
retained untouched or removed by the ordinary successful rollback, as recorded.

A failed state receipt publication left a marker-only build. The later CLI
refused it with `without a matching state receipt` rather than adopting it,
overwriting its marker, or choosing a different destination. This is a safe but
non-self-recovering state; the lab does not fabricate a receipt or delete it to
make the retry pass.

Partial prune cleanup surfaced its original EIO, retained the ownership marker
and receipt, and left an unregistered sibling unchanged. A later normal build
used the same target; a separate, newly checked explicit prune then removed only
the owned build and its receipt. The source fingerprint still matched.

Across all twelve scenarios, source bytes, names, types and modes remained
unchanged; no source `target` appeared. Original argv/cwd were retained in every
executed child. No alternate target pathname was observed, including in the
physical-root replacement cases. These observations cover this bounded matrix,
not arbitrary races, actual compiler behaviour or real full-disk failure modes.

## Recorded validation

[The compact baseline evidence](baseline-evidence.json) records all twelve
scenario outcomes, the product-source hashes, full-report SHA-256, byte bounds
and verification counts. It is a historical observation, not an allowlist.

| Command | Observed result |
| --- | --- |
| `node test/fault-lab/lab.mjs --run` | Exit 1: 94 checks, 91 satisfied, three violations, no infrastructure errors |
| `node --test test/fault-lab/fault-lab.test.js` | Exit 0: 96 passed, three real failing assertions annotated TODO |
| `npm run check` | Exit 0: source syntax, 14 version files, generated bundle and bug-report version passed |
| `npm test` | Exit 0: 458 passed, 27 skipped, three TODOs; 488 total |

The three TODOs are not counted as safety passes. The complete standalone report
was 76,428 bytes; retained fixture files, excluding that report, totalled 28,221
bytes. Source/bin content and mode hashes were identical before and after the
lab. Native Windows cases and the unavailable real-Cargo check remain normal
full-suite skips; this lab executes only its own tiny fake tools.
