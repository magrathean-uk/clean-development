<!-- clean-development-policy:v4 (clean-development 0.6.0; canonical: bolyki-dev/clean-development/docs/policy-snippet.md) -->
## Storage reference

`~/dev/machine/env.zsh` configures tool homes and caches. `$CLEAN_DEV_MODE` identifies the session's external or internal storage mode. `$TMPDIR` identifies session scratch and `$CLEAN_DEV_BUILDS` identifies build output; cache paths are exposed through the tool-specific environment variables.

`.clean-development.json` uses schema v2 to describe project build and dependency directories. Clean Development's installed runtime and configuration determine routing and retention behaviour.
