# Clean Development for Claude Code

Clean Development keeps supported development caches and build output in a managed local location. This bundle supports local Claude Code sessions. It does not require a published npm package.

## Requirements

- Node.js 20.12 or later.
- Claude Code with this plugin enabled.

Invoke the manual-only management skill with `/clean-development:clean-development`. The plugin includes the CLI source, so when a global `clean-development` command is unavailable, use `node ${CLAUDE_PLUGIN_ROOT}/bin/clean-development.js` with the same arguments.

## Consent and routing

Installation does not configure storage, change project settings, or route commands. For inspection, use `status --json` and `doctor --json`. Before choosing a route for a repository, review `session --dry-run --json`; use session-only routing or save project settings only after the user chooses. `setup --agents claude` is an explicit opt-in for the native Claude integration.

Routing applies only to explicitly wrapped child commands. Their command arguments, working directory, tool behavior, and exit status remain their own.

## Data handling

The bundle has no remote cache backend, telemetry, or network service. Managed data stays on the local machine at the location chosen during setup or routing.

Local paths can include usernames and private project names. Configuration, workspace records, ownership receipts, and managed files remain locally until removed through the documented controls. There is no publisher service retaining data received from Claude. Wrapped commands retain the normal environment, including credentials, and may contact their own package registries or services. Claude processes prompts and tool output under its own policies. Clean Development does not upload those records to the publisher and is not a network sandbox.

[Privacy](PRIVACY.md) · [Support](SUPPORT.md) · [Software terms](TERMS.md) · [License](LICENSE)
