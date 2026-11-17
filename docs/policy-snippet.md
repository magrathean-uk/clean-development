<!-- clean-development-policy:v6 (clean-development 0.7.1; public source: magrathean-uk/clean-development/docs/policy-snippet.md) -->
## Storage reference

The installed `env.zsh` (default location: `~/dev/machine/env.zsh`) selects storage and routes Clean Development's cache variables while preserving host toolchain and application homes. `$CLEAN_DEV_MODE` identifies the shell's external or internal storage mode. In agent shells `$TMPDIR` identifies session scratch; `$CLEAN_DEV_BUILDS` identifies build output; cache paths are exposed through the tool-specific environment variables.

`.clean-development.json` uses schema v2 to describe project build and dependency directories, which `clean-development cleanup --project <dir>` can offer.

Scratch and build output is disposable, not the sole home of unfinished work, rollback data or evidence; promote important files into durable project storage. `clean-development report` shows free space and routing problems. `clean-development cleanup` only lists candidates; run `cleanup --apply <id>` after the user's yes. Moved items sit in the Trash until the user empties it. Honour approved machine-policy overrides; do not reset them during installation.
