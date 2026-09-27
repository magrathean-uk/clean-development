# Disposable storage fault lab

Run from the repository root with Node 20.12 or newer on Linux or macOS:

```sh
node test/fault-lab/lab.mjs --run
```

No npm installation, Cargo installation, administrator access, mounted test
volume, or network service is needed. The command creates a new private temporary
root, prints the `report.json` path, and **retains all fixtures**. No existing
output path is accepted. Do not point any fixture at contributor storage.

Exit status is **0** for all invariants satisfied, **1** for observed invariant
violations, and **2** for incomplete/infrastructure evidence. At the tested main
revision this command deliberately exits **1**, with three violations; see
[the defect report](FINDINGS.md) and [recorded baseline evidence](baseline-evidence.json).
An exit of 23 inside a case is the fake tool's
intentional nonzero exit, not a harness failure.

```sh
node --test test/fault-lab/fault-lab.test.js
npm run check
npm test
```

The test wrapper keeps the three reported failures as actual failing assertions
with named `TODO` annotations, not assertions that unsafe behaviour is correct.
Node's test runner does not count TODO failures towards its failure exit status.
Every other failed check is an ordinary test failure. The standalone lab has no
allowlist and exits nonzero for **any** violated invariant. Remove a corresponding
TODO when its product workstream fixes the issue. Helper-module discovery by
`node --test` is inert; only the explicit `--run` flag starts the CLI lab.

## Contracts checked

The first four are based on [the safety model](../../docs/safety-model.md) and
[architecture](../../docs/architecture.md), or on preserving the initiating error.
The fifth is an explicitly stronger storage-identity expectation: the existing
documents acknowledge same-user races and do not promise persistent mount identity.

1. Source, Git metadata, credentials, final deliverables and unregistered data
   remain outside deletion authority. Every lane fingerprints its entire source
   fixture, including names, types, mode bits, file bytes and link targets, before
   work and after both invocations. The prune lane also checks after retry cleanup.
2. An ordinary build must not recreate a missing managed base, including a base
   that disappears after its initial validation.
3. A failed ownership publication must not launch the tool or authorise a
   marker-only build. An uncertain cleanup retains the staged evidence.
4. The initiating filesystem error must remain the surfaced error; a cleanup
   error must not replace it. The check compares the exact thrown Error object
   before normalising the evidence, as well as its code.
5. Without explicit re-preparation, replacing the managed root with a different
   real directory must not silently grant that directory the old root's authority.
   Path-string stability is **not** evidence that the storage object is unchanged.

Every case also launches a later, new CLI process with the unchanged configuration
and environment, after all hooks have been removed. It runs
`bin/clean-development.js shim <tool> -- ...`; it never runs setup or prepare.
The capture compares the target path, original argv/cwd and intentional exit 23.
An error without a child capture establishes that the fixture tool was not run.
The lab does not mistake an absent capture for a successful build.

## Matrix

| Scenario | Fault boundary and evidence |
| --- | --- |
| `healthy` | Real fake-Cargo launches through the API and then a fresh CLI; establishes destination, receipt, argv/cwd and exit-status control. |
| `missing-managed-root` | Rename the whole configured root away before ordinary dispatch; check that both invocations reject it. |
| `missing-build` | Rename only the configured build base away before dispatch. |
| `missing-cache` | Rename only the cache base away before an npm shim command. |
| `missing-during-marker` | After staging-directory creation, rename the entire managed root away immediately before the marker writer's recursive parent mkdir. |
| `replaced-managed-root` | Seed a registered build, move the managed root away, and create a different real root containing an empty `builds` directory and an unowned sentinel. |
| `enospc-marker-write` | Write exactly 17 bytes of the marker temporary file, then throw synthetic ENOSPC. |
| `enospc-marker-rename` | Throw ENOSPC on the temporary-marker-to-marker rename. |
| `enospc-build-publish` | Throw ENOSPC when publishing the staged build directory; permit ordinary rollback. |
| `enospc-record-publish` | Allow the owned build to publish, then throw ENOSPC on the outside-root state receipt's final rename. |
| `publication-cleanup-error` | Fail directory publication with ENOSPC, then fail removal of that exact staging directory with EACCES. |
| `prune-partial-cleanup` | Delete one known disposable artifact during explicit prune, then throw EIO; inspect retained ownership, run the later CLI, and explicitly retry a revalidated prune. |

All non-injected operations use the real filesystem and unchanged product
modules. Hook predicates select an exact lane, publication phase and path; the
lab verifies the expected hit count. There are no sleeps or probabilistic race
loops. Directory renames establish the missing/replacement boundary synchronously.
Each scenario runs in a new worker process, and `finally` restores every patched
`node:fs` function before its later CLI process starts.

## Safety and evidence bounds

Only newly allocated fixtures are written. Their home, config, application data,
managed storage, temporary directories and tool PATH are independent of the
contributor's environment. Workers inherit no real HOME, tool cache variables,
Node preload options, credentials or package-manager configuration. The two
fixture executables run the current Node binary, create a tiny artifact, record
the destination, and exit; they perform no package installation or compilation.
They reject write destinations outside their lane as an additional guard.

Synthetic ENOSPC is injected at selected JavaScript filesystem boundaries. This
**does not fill a disk**, impose a quota, unmount a volume or simulate every
kernel/filesystem consequence of resource exhaustion. Replacement is a real
same-filesystem directory rename/recreation: different inode, not a different
device or a genuine mount event. A real mount or hostile-filesystem experiment
would be separate evidence. The lab is not an OS filesystem/network sandbox.

Each worker is limited to 20 seconds and 128 KiB of captured output. Its later
CLI has a 10-second/64-KiB limit. Inventories reject more than 512 entries or
1 MiB of file data per lane; the aggregate JSON report is capped at 256 KiB.
These are observation/process bounds, not a filesystem quota. The generators
write fixed small payloads; no unbounded data generator exists. An incomplete
worker or malformed evidence is an infrastructure error, never a pass.

The JSON records every named check, fault hit, original/surfaced error, captured
invocation, before/after root identities, receipt/marker/staging observations,
source hashes and bounded inventory totals. Temporary prefixes are normalised
and UUIDs mapped to consistent aliases, preserving evidence of changed identity.
The checked-out `src/` and `bin/` contents/modes are also hashed before and after.

Explicit lab runs always keep their new root. The test wrapper removes only a
completed run's own root after checking its canonical path, regular ownership
marker, token and device/inode identity. Unexpected test or infrastructure
failures retain the evidence. No product cleanup path is used for lab teardown.

Only Linux execution has been recorded for this change. The lab rejects native
Windows rather than treating unexecuted POSIX fixtures as acceptance evidence;
the wrapper reports a platform skip there. This lab neither changes nor audits
Windows quoting, executable discovery, other PRs' product code, or live agent
integration behaviour.
