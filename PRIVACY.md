# Privacy

Effective date: 26 September 2026.

Clean Development is open-source software maintained by Magrathean UK. This notice describes the CLI and bundled agent integrations in this repository.

## Local processing and storage

Clean Development runs on the machine where you execute it. It reads project manifests, selected configuration, environment variables, filesystem metadata, and installed tool locations to identify a workspace and plan supported cache and build paths. Paths can include a username or a private project name.

When you authorize setup or routing, it stores local configuration, runtime installation and ownership receipts, workspace paths and identifiers, timestamps, and process leases. Supported development tools write their own caches and build output under the chosen root. Saving project settings creates `.clean-development.json` only when requested. Status and doctor output can expose these local paths.

The CLI has no telemetry, analytics, remote account, or publisher-operated backend. It does not send this information to Magrathean UK. It does not collect or store chat transcripts or credentials as part of its own state.

## Other software and services

Commands you run through Clean Development retain their normal environment and behavior. A package manager, build tool, or agent can access the network, use credentials, or send information under its own settings and privacy policy. The routing wrapper is not a network sandbox. When an agent runs the management skill, prompts and command output are handled by that agent's provider. Installing or updating from GitHub or a package registry also contacts those services.

## Retention and control

Local configuration, receipts, and managed files remain until you remove them through the CLI or manage your own files. `prune` previews eligible registered build directories and deletes them only with `--apply`; it does not remove every cache or all local state. `uninstall` removes owned integrations and runtime files subject to its safety checks; managed caches and build data remain. See the [README](README.md) for the exact controls and retained files.

Support through GitHub is voluntary. Public issues are visible to others and handled by GitHub under its own policies. Redact personal paths, credentials, private project names, and command output before sharing. Use the private route in [SECURITY.md](SECURITY.md) for security reports.

## Contact and changes

Use the routes in [SUPPORT.md](SUPPORT.md) for questions about this software or notice. Changes to this notice are published in this repository with an updated effective date.
