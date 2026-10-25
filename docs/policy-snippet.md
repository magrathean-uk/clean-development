<!-- clean-development-policy:v5 (clean-development 0.6.1; canonical: bolyki-dev/clean-development/docs/policy-snippet.md) -->
## Storage reference

`~/dev/machine/env.zsh` configures tool homes and caches. `$CLEAN_DEV_MODE` identifies the session's external or internal storage mode. `$TMPDIR` identifies session scratch and `$CLEAN_DEV_BUILDS` identifies build output; cache paths are exposed through the tool-specific environment variables.

`.clean-development.json` uses schema v2 to describe project build and dependency directories. Clean Development's installed runtime and configuration determine routing and retention behaviour.

Scratch/build output is disposable, not the sole home of unfinished work, rollback data or evidence. Protect long/quiet jobs with explicit renewable path leases; promote important files into durable project storage and verify publication receipts. The `run` compatibility shim adds no ownership or budget. OpenCode is environment-only until a native lifecycle adapter is separately validated. Honour approved machine-policy overrides; do not reset them during installation.
