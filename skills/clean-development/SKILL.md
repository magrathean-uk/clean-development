---
name: clean-development
description: Storage placement and cleanup guidance for configured macOS development workstations. Use before builds with chosen output paths, VM, container or simulator work, copies between volumes, pruning or cleanup, large downloads or model pulls, or questions about disk space and file placement.
---

# Clean Development 0.6.8

Check `clean-development version` before relying on a command. Claude Code and Codex have native lifecycle hooks when configured. OpenCode supports environment routing only; it has no native session ownership or cleanup integration.

## Storage modes

Follow the configured external volume. A shell uses external mode when the configured mount and cache are present and writable. Otherwise it uses the internal cache. Each shell makes this check independently, so the mode can change during a session. Never override the routing variables.

The sample policy uses `/Volumes/External/dev` and `/Volumes/External/dev/lab`. Change `~/dev/machine/storage.conf` to match the workstation before installation. Internal mode supports normal development. VM images, models, datasets and other configured external-only stores remain at their external paths.

Check `echo $CLEAN_DEV_MODE $DEVCACHE` for the active mode and cache. If the internal disk falls below `INTERNAL_MIN_FREE_GB`, review the available space before starting a large build or download. Before downloads above `BIG_DOWNLOAD_GB`, make sure the configured external volume is available.

## File placement

| Work | Location |
| --- | --- |
| Temporary files and session previews | `$TMPDIR` |
| Throwaway build output | `$CLEAN_DEV_BUILDS` |
| Dependency caches | `$DEVCACHE/deps/<tool>` through each tool's configured variable |
| Git worktrees, jobs and bundles | `$CLEAN_DEV_WORK/<kind>/<repo>/<task>` |
| VM homes | Below the configured `LAB_ROOT` |
| Models and datasets | Below the configured `MODELS_ROOT` or the project's configured data path |
| Source, evidence, rollback copies and handovers | The repository or a durable project records directory |

Never use cache or scratch as the only copy of unfinished work, rollback data or evidence. Use project configuration `.clean-development.json` to list Git-ignored `buildDirs` and `depDirs` that the runtime may clean.

## Cleanup and recovery

- `clean-development housekeeping` and `clean-development reap` preview by default. Review listed paths before using `--apply`.
- `clean-development doctor` reports installation health, hook configuration, storage policy and known state. It does not test hook dispatch or completion.
- Unexpected dot-folders and `~/dev` entries are reports only. Adjust the allowlists in `storage.conf`; do not remove reported files through Clean Development.
- Keep unfinished jobs under `$CLEAN_DEV_WORK/jobs/<project>/` so their outputs survive the launching session. Stop only jobs you started.
- Use renewable path leases for long or quiet jobs. `clean-development publish` can copy a regular file to durable project storage, verify it and hold the source until the publication is completed.
- For leases and verified publication, read [the 0.6.1+ command reference](references/0.6.1.md). For deployment limits and remaining acceptance work, read [the safety and acceptance guide](../../docs/safety-release.md).

## Host setup

Install the runtime and environment files with the repository instructions. Source `~/dev/machine/env.zsh` from the startup file used by the active shell: `~/.zshenv` for zsh, or the Bash startup file loaded by development tools. Merge the relevant Claude Code or Codex hook fragment separately; plugin installation only installs this guidance skill. Use `clean-development doctor --no-gui` to review the configured host; this package does not install a launchd environment helper.

The doctor checks default Claude and Codex settings only when those configuration files exist. To include extra profiles, list absolute or `~/`-relative paths in `~/dev/machine/state/clean-development/claude-settings.list`, `claude-profiles.list` or `codex-homes.list`. Codex entries are home directories; Claude entries are settings files. Prefix intentionally absent entries with `?`; otherwise every listed path is required.

The environment loader also supports an optional `~/dev/machine/env.private.zsh` file for host-specific integrations; inspection mode never sources it. The public environment preserves locale, toolchain homes, VM and model stores, Docker configuration, and telemetry preferences. Additional non-secret variables can be retained by `clean-development run --clean-env` through `~/dev/machine/state/clean-development/childenv-allow.list`. The sample storage policy is not a universal machine configuration; adjust it for the host.
