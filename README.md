# clean-development 0.6.1

Keeps G's Mac tidy while agents work.

- **Routing.** `~/dev/machine/env.zsh` sends every cache, build and temp file to one root: `/Volumes/4TB/machine/cache` when the 4TB is attached (detected by name plus a write probe), otherwise `~/dev/machine/cache`. Claude Code, Codex and claude-1..5 pin the choice per session.
- **Cleanup.** At session end disposable scratch/internal builds become eligible, subject to ownership, generation, leases and validated paths. Each turn, throttled housekeeping reaps finished/stale sessions and prunes old output. Dependency eviction is a best-effort shallow-mtime cap, not a strict quota or read-aware LRU. Xcode DerivedData is never last-out wiped.
- **Rules for agents.** The session-start message states the mode, the 5 GB rule when the 4TB is away, and any unexpected dot-folders in `~` or `~/dev` (reported, never deleted).

## Safety contract

- Live keys protect builds on **both roots**, including external-pinned internal fallback. Reopening deferred-ended sessions establishes a new live generation; old snapshots/tagged events cannot reap it.
- The same lifecycle lock covers supported hook transitions, selection/rename and explicit lease mutations. A paused owner is never evicted by age. A dead owner requires reviewed `locks --recover ... --apply`; startup stays fail-open, uncertain cleanup stays closed.
- Whole cache anchors and their managed children/trash must be real directories, not redirection links. A candidate leaf link is removable without following its target. Unexpected rename failure, including cross-device failure, retains the source; no unchecked direct-delete fallback.
- Invalid machine/project policy grants no deletion authority. Machine policy is parsed as data by both shell and Node; the shell remains fork-free and compatible with stock Bash 3.2. Project identity is canonical per checkout, not shared Git history.
- Scratch is **not** durable unfinished work, rollback storage or final/partial evidence. Keep unique bytes in the project's durable directory. An explicit job lease protects required paths beyond the conversation; expiry is not proof of process completion.
- Hook completion and deletion completion are different. `events.jsonl` records hook outcomes/version/generation; `deletions.jsonl` correlates queued and completed/failed jobs. One worker per anchor/invocation consumes a manifest, rather than spawning Node for every entry.

These are cooperative same-user safeguards, not a hostile-filesystem sandbox or an OS job supervisor. Kernel-blocked synchronous filesystem calls cannot be interrupted by a JavaScript deadline. See [implementation and remaining acceptance](docs/safety-release.md).

## Explicit work lifetimes

Commands below require the **0.6.1 runtime**, not merely an updated skill/plugin. All preview commands are read-only; mutations require `--apply`.

```sh
clean-development version
clean-development leases list
clean-development leases create --path "$CLEAN_DEV_SCRATCH" --path "$CLEAN_DEV_BUILDS" --minutes 60 --owner 'long build'  # preview
clean-development leases create --path "$CLEAN_DEV_SCRATCH" --path "$CLEAN_DEV_BUILDS" --minutes 60 --owner 'long build' --apply
clean-development leases renew LEASE_ID --minutes 60 --apply
clean-development leases release LEASE_ID --apply

clean-development publish --source "$TMPDIR/result.json" --destination /absolute/project/evidence/result.json  # preview
clean-development publish --source "$TMPDIR/result.json" --destination /absolute/project/evidence/result.json --kind evidence --apply
clean-development locks
clean-development locks --recover lifecycle              # inspect a provably dead owner
clean-development locks --recover lifecycle --apply       # explicit recovery, never a live owner
```

Acquire protection **before** using required paths; protect every scratch/build/cache/project path the job needs. Leases last 1-1440 minutes and must be renewed before expiry; released/expired leases cannot silently be revived. They do not launch, supervise or kill processes. A corrupt registry blocks cleanup until inspected. Released records move into durable `lease-history/`, outside the active-registry inspection limit; recovery metadata is not automatically evicted cache.

Publication currently handles **one regular file**. It creates a durable source hold, copies to the destination device, verifies SHA-256 and mode, fsyncs, then publishes without overwriting. The source is never deleted; conflicting existing output is retained. Identical bytes/mode permit an idempotent retry. Cache/temp and declared disposable project destinations are rejected. Pending/failed publication holds **do not expire**: even parent end or a long copy cannot make the sole source evictable. Success releases its hold; failures or interrupted release require inspection and `leases release HOLD_ID --recovery-confirmed --apply` only after the bytes are durably recovered/published. Retain the receipt/recovery copy and never claim completion without a completed receipt. Package directories explicitly or promote them in project-specific transactions; do not assume recursive directory publication exists.

## Installation and recovery - not automatic deployment

Source validation does not install anything. First inspect the plan:

```sh
./install.sh --dry-run --config
```

When separately approved, `./install.sh --config` installs an immutable versioned runtime and new environment, **preserving existing `storage.conf` overrides**. `--config --replace-config` is the explicit policy-replacement option; unknown flags are rejected in every order. Existing releases are retained; changed bytes/permissions under an existing version are refused. Activation files have private backups, a journal and conflict-aware rollback under `~/dev/machine/state/clean-development/installations/`.

After interrupted installation, inspect its receipt/lock and use `./install.sh --recover TRANSACTION_ID`. Recovery refuses a live/unverifiable installer and never overwrites a subsequent user edit. A published but inactive runtime is retained. Receipts, rollback predecessors and failed reprovision snapshots are not age-trimmed; review their storage separately.

Hook deployment is separate. Preview `fragments/merge-hooks.py FRAGMENT TARGET --dry-run` before any approved merge. Real merges preserve recovery bytes, unrelated handlers and file mode. Changing Codex hooks with positional disablement/unknown preferences is refused until explicitly reviewed/remapped. Trust refresh preserves such state; `clean-development codex-trust` defaults to **managed CD handlers**, with `--all` an explicit broader approval. The dependency-free editor supports ordinary host table syntax; complex/ambiguous TOML is refused in favour of the TOML-aware `codex-hooks-trust` helper, which also preserves disablement. Hash/config consistency is not actual host dispatch evidence.

Policy values live in `~/dev/machine/storage.conf`; paths must be absolute without dot/traversal components, numeric values non-negative plain decimals. Approved internal lab/model overrides remain valid. Reconnection may route subsequent external-pinned shells externally again; no fallback data is copied back. Existing processes retain their own environment.

## Harness scope and validation

Development validation uses current Node **26.12.1**; current LTS **24.22.1** and the minimum supported **20.12.0** are compatibility targets. The [current validation record](docs/validation-2026-10-25-current.md) separates isolated source/native checks from the still-pending live rollout. Test runtimes do not replace the machine's shared Node installation.

| Consumer | Support |
|---|---|
| Claude, Codex, managed numbered Claude seats | Native lifecycle implementation; actual installed-host acceptance remains separate |
| OpenCode | Environment routing only; no native session deletion adapter. `bin/opencode2` filters foreign identities for new client launches; reused-server environment is not validated by that test |
| Plain shells / GUI tools | Tool routing only; no conversation ownership or process supervision |

`run [--session X] -- CMD` remains a no-policy compatibility shim, with direct-child signal forwarding. It creates no lease, budget or durable task. Never interpret a parent's `$TMPDIR` as a handoff protocol.

```sh
npm run check
CLEAN_DEV_TEST_DIR="$TMPDIR/unique-cd-test-root" npm test
```

Tests require explicit scratch and fabricated homes/volumes; adjacent profile tests use fake CLIs/authentication and mocked VPS responses. No real mount, service restart, model call or native login is part of the suite. See [the acceptance matrix](docs/safety-release.md) before considering production rollout.
