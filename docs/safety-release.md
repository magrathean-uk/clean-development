# Safety release scope and acceptance

This document describes the current Clean Development source, version 0.6.8. It is **not a deployment receipt**: publishing source does not install the runtime or configure Claude Code or Codex hooks. The 0.6.1 work was integrated into the main source line; later changes and review notes are recorded in [CHANGELOG.md](../CHANGELOG.md). Validate the exact version and host configuration before relying on runtime behaviour.

## Delivered contracts

| Review area | Implemented source behaviour | Durable regression evidence |
|---|---|---|
| F1 fallback/resume loss | All live keys veto every build selector, on either root. JSON ownership is authoritative for new records; resume advances an ended generation, clears the compatibility end marker and preserves root history. Stale revisions/tagged end events cannot reap a new owner. | `test/safety.test.mjs`: Claude/Codex fallback, absent/reconnected resume, stale snapshots and tagged end/idempotent starts |
| F2 admission/paths | Invalid policy has no cleanup authority; shell parses data, never executes it. Unsafe anchors/managed parents/trash links are refused. Candidate leaf links are not followed. Failed rename retains the source. Invalid legacy config has no inferred delete authority; invalid v2 cannot be silently migrated. | `test/policy.test.mjs`, `test/safety.test.mjs`; ordinary link and external/internal controls retained |
| F3 installer rollback | Activation files are restored only when they still match this install's recorded output. User edits and linked targets remain conflicts; `--accept-current` records and preserves inspected conflicts so recovery can finish without overwriting them. Failed recovery bytes stay available. | `test/deployment.test.mjs`: injected activation failures, concurrent edits, mode-only rollback, abrupt process exit and explicit recovery |
| F4 deployment/trust | Strict truthful previews; immutable runtime and permission/content identity; durable backup/activation intent and conflict-aware rollback. Target topology/bytes/mode are revalidated before write intent; pre-activation user edits are not rollback targets. Dead-installer recovery is explicit. Hook settings have recovery copies; Codex preference changes require review; refresh/rebuild preserve disablement and unknown state. | Deployment fixtures inject stage/publication/file/layout failures, abrupt child exit, concurrent edit, mode-only rollback, pre-activation mode/link changes, previews and trust/merge guards |
| F5 activity/ownership | Canonical per-checkout owner veto; explicit bounded leases for long/quiet jobs and cache consumers. Unknown activity/measurement does not mean zero. Corrupt protection blocks cleanup. | Lifetime/cache-alias/lease expiry/registry tests; positive owner controls |
| F6 deadlines/completion | Shared ownership lock; cooperative start/end/Stop deadlines, a 1.5-second Stop work budget and a 5-second harness timeout, plus bounded Git/du probes; defer incomplete work rather than silently drop ownership. Hook outcomes carry release/generation/duration; deletion workers have distinct correlated completion events. One batch worker per anchor/invocation, with queue manifests instead of huge argument lists. | Open-stdin and stalled-Git tests; batching/receipt and lock replacement/recovery tests |
| F7 OpenCode boundary | OpenCode can use the sourced environment routing. This package does not ship a client launcher, server manager or native session-cleanup adapter. | `README.md` support table and `test/env-modes.sh` routing fixtures; no OpenCode service is invoked |
| F8 unique work/jobs | Explicit path protection; single-file destination-side verified no-clobber publication, non-expiring source hold and durable receipt. Important output is not certified merely because a model finishes. | Publication conflict/source-mutation/receipt-failure/retry and failed-copy parent-end/recovery-confirmation tests |

The runtime has no npm dependencies and requires Node 20.12 or later. Codex TOML merge and trust operations require Python 3.11 or later for `tomllib`; other helper paths use their documented Python interpreter. Tests use fabricated homes and volumes. Parent-monorepo scripts run only when the test suite receives an explicit private-source opt-in.

## Deliberate compatibility choices

- Keep existing fork-free suffix-derived routing keys for this patch. Full original IDs are checked before overwriting/ending metadata; a collision is refused, **not** transparently isolated. A full-ID/hash routing migration remains separate work.
- Legacy mode/JSON/end files remain readable. New metadata records include `stateVersion`, `phase`, `generation`, original identity, canonical checkout and observed roots; `.mode` is the shell's routing projection. Do not run old and new cleanup writers concurrently during rollout.
- A host end event without a generation cannot identify which earlier incarnation it meant. Snapshot fencing and a common lock close tested races; arbitrary late untagged native events still need actual host-contract validation. No claim of a universally fenced distributed lifecycle is made.
- A pinned internal session stays internal after reconnect. External-pinned later shells may use the reconnected root again; no automatic copy-back. This patch does not invent replacement-volume UUID policy.
- Whole-cache/layout redirection links are unsupported for cleanup; parent aliases such as macOS `/var -> /private/var` remain usable. Descriptor-relative hostile path-swap protection is not implemented; this is cooperative same-user code.
- A consumer/job lease protects paths for 1-1440 minutes, not the lifetime of an arbitrary process. Acquire/renew before using them; list every required path. Publication instead creates a durable, non-expiring source hold: a failed/incomplete copy must not make unique bytes evictable. Only verified success or explicitly recovery-confirmed release clears that hold. No PID-only ownership claim, automatic detached-job survival or process-name killing is added.
- Dependency recency is still shallow-mtime approximation. Unleased deep writes/reads are not fully known. The cap is best effort, not a hard resource envelope; unique evidence never becomes disposable merely because a cap is exceeded.
- Publication handles one regular file, not directories or arbitrary application transactions. It never removes its source. A missing/failed receipt requires inspection even when a destination exists; identical-byte/mode retry is supported.
- Journals, lease history, failed publication copies and reprovision recovery snapshots are intentionally durable. They are not automatic cache-eviction targets; storage/acceptance policy for retiring them remains an explicit decision.

## Safe inspection and failure recovery

`doctor`, `status`, housekeeping/reap previews, lease previews and installer preview perform no intentional probe/lock/state writes. `doctor` separates configured/trusted/disabled support from untested dispatch/completion, detects stale/duplicate/options-mismatched hooks and checks runtime receipts when present. A receipt digest covers sorted relative names, permissions and bytes. An inactive retained old runtime is not itself a fault.

Runtime locks are not stolen because they are old. `locks --recover lifecycle` previews recovery only for a provably dead recorded process; add `--apply` after inspection. Unverifiable/active owners are refused. Installer locks use the install receipt and `install.sh --recover ID`. If a current file differs from both the pre-install and installed bytes, recovery leaves it untouched and stays pending. After inspecting that file, `install.sh --recover ID --accept-current` records the conflict as preserved and resolves the receipt; it does not overwrite the file. Recovery guard failure itself requires inspection, not recursive age takeover.

Hook completion does not mean all bytes were reclaimed. `events.jsonl` reports the handler; `deletions.jsonl` reports each queued and completed/failed deletion ID. Deletion queue manifests live in validated trash and use uniquely renamed targets, never an unchecked original pathname. A worker failure leaves trash/recovery evidence for later inspected retry. Batching bounds workers per invocation, not machine-wide concurrent job count.

## Test and rollout gates

The 0.6.1 source checks are summarised in [the release record](release-0.6.1.md). Those historical results do not establish full 0.6.8 validation or satisfy the native-host, hardware and deployment gates below. Version-specific changes and checks are listed in [CHANGELOG.md](../CHANGELOG.md).

1. Run `npm run check` and `npm test` with a unique explicit `CLEAN_DEV_TEST_DIR` on available Node versions. All sentinels and destructive targets stay in that directory. Tests must not invoke actual account/model/network/storage operations.
2. Run the original positive controls as well as the added negative tests; do not call a fixture-confirmed fix production acceptance. Verify read-only inspection and retained rollback bytes.
3. Review policy overlay preservation, source pins, effective hook graph and explicit disabled Codex entries. Hook merges/config rebuilds deliberately refuse changed positional preferences; resolve intent before applying, never reset state to make installation pass.
4. Before a canary, back up touched configuration, retain a runnable previous runtime and stop conflicting old/new cleanup writers. Install only one disposable launch path/project, then add concurrent owners. Updating a plugin/skill alone is not runtime or hook deployment.
5. Exercise actual supported harness startup/resume/Stop/end, sandbox writes, completion receipts and generation semantics. If multiple profiles are configured, validate each profile with its own existing authentication; do not move account paths or copy credentials.
6. Exercise real removable/read-only/reconnected storage only with disposable media and ordinary workflows stopped. No live-yank, service restart, reboot or paid/model call is part of this source test suite.
7. Verify rollback before expanding; stop destructive canary work if live/foreign sentinels disappear, unfinished/recovery bytes are lost, disablement changes, roots are misadopted or completion cannot be verified. Preserve evidence, not broad cleanup.

## Still outside this patch

- A native OpenCode session/location/tool-environment adapter and reused-server acceptance. Third-party launcher integrations require separate validation.
- Fully generated restore kits, automatic skill-export retirement and a machine-wide deployment manifest covering every historical distribution. Historical payloads were not rewritten as if they were current.
- A general workload file/CPU/disk envelope, OS supervision, reboot-resume protocol or arbitrary directory/publication transaction framework. The new lease/publication primitives are an explicit small foundation for those consumers.
- Root-marker adoption/mount replacement policy, full-ID routing migration, native descriptor-relative race protection and actual long-lived read-only consumer acceptance.
- Minimum Node 20.12.0 is fixture-tested. Real host/hardware behaviour must still be labelled tested or untested from actual runs, never inferred from syntax alone.

These boundaries are intentional: the two deterministic loss bugs and deployment hazards do not depend on building a universal daemon or silently migrating every account, tool and backup.
