---
name: clean-development
description: Storage placement and cleanup guidance for configured macOS development workstations. Use before builds with chosen output paths, VM, container or simulator work, copies between volumes, cleanup offers, large downloads or model pulls, or questions about disk space and file placement.
---

# Clean Development 0.8.0

Run `clean-development version` before relying on a command. Commands: `report`, `cleanup`. The only hook is a SessionStart line.

## Modes

A shell is in external mode when the configured volume is mounted and its cache is writable, otherwise internal. Each shell checks on its own, so the mode can change mid-session. Never override the routing variables. Check `echo $CLEAN_DEV_MODE $DEVCACHE`. Internal mode supports normal builds; VM images, models and datasets stay at their external paths. Sourcing `env.zsh` creates the routed folders; `DEV_ENV_INSPECT_ONLY=1` creates nothing.

## Placement

| Work | Location |
| --- | --- |
| Temporary files, previews | `$TMPDIR` |
| Throwaway build output | `$CLEAN_DEV_BUILDS` |
| Dependency caches | `$DEVCACHE/deps/<tool>` (Cargo homes stay host-managed) |
| Worktrees and jobs | `$CLEAN_DEV_WORK/<kind>/<repo>/<task>` |
| VMs, models, datasets | `LAB_ROOT`, `MODELS_ROOT` or the project's data path |
| Source, evidence, rollback, handovers | The repository or a durable records directory |

Never keep unfinished work, rollback data or evidence only in cache or scratch. List a project's Git-ignored `buildDirs` and `depDirs` in `.clean-development.json`. Stop only jobs you started. Before downloads above `BIG_DOWNLOAD_GB`, make sure the external volume is mounted.

## Report and cleanup

- `clean-development report` is read-only; `report --check` exits 1 on a routing problem.
- `clean-development cleanup [--project <dir>]` lists candidates, changes nothing and ends with `list: <id>`.
- `clean-development cleanup --apply <id> [--skip N,...] [--project <dir>]` moves approved items to the volume Trash with a `MANIFEST.txt`; exit 3 and nothing moved if the list changed.

## When to offer cleanup

Offer a review at a hand-over to another chat, a plan reset, a milestone close, or when the SessionStart line says `cleanup available` (a filling drive). Run `cleanup --project <dir>`, show the list and ask. Run `--apply <id>` only after the user's yes, with `--skip` for anything declined. Space returns only when the user empties the Trash.

Tidy at each milestone close and at the first turn after six hours of work: stop your VMs and simulators after their job, delete your throwaway guests, and remove your merged worktrees, finished job and build output and scratch that can be rebuilt; keep evidence and unfinished work. Run `clean-development cleanup` and offer the rest, moving it to the Trash with `--apply` only after the user's yes.
