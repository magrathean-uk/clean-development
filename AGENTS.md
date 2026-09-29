# Working on Clean Development

Clean Development is an ESM Node.js CLI with no npm dependencies. Use Node 20.12 or newer. Runtime code lives in `src/`, entry points in `bin/`, and isolated fixtures in `test/`.

Carry authorized changes through their relevant checks without asking again for routine implied steps. Use bounded delegation for independent work when it saves time, with clear file ownership.

## Boundaries

- Preserve user environment overrides, unrelated host settings, argv, cwd, stdio, signals, and exit status.
- Treat source, credentials, toolchains, final deliverables, and unregistered paths as externally owned. Prune only registered, marker-verified Cargo build roots after rechecking leases, pins, and age.
- Keep session planning read-only. `session-only` writes no project config; `persist` creates only the reviewed absent `.clean-development.json`; `skip` removes inherited routing without discarding independent overrides. Native integrations default to skip.
- Test setup, update, uninstall, persistence, and deletion with disposable homes, settings, and storage roots. Never use a contributor's real agent configuration or build storage as a fixture.
- Do not add prompt bootstrap text, telemetry, command recording, postinstall configuration changes, or automatic deletion.
- Legal files (`LICENSE`, `NOTICE`, `docs/legal/`, contributor terms, copyright and attribution strings) are owner-controlled: change them only on the owner's explicit instruction.

## Checks

Run the relevant isolated test first, such as `node --test test/session.test.js` for consent or `node --test test/prune.test.js` for retention. Run `npm run check` and `npm test` for code changes. Documentation-only changes need link, command, and consistency checks, not real-tool builds.

Use `npm run test:package` for distribution changes. It installs temporary tarballs and requires the preceding-release tag named in `scripts/verify-package.mjs` for upgrade verification. See [CONTRIBUTING.md](CONTRIBUTING.md) for broader smoke, fixture, and performance checks.

Keep versioned files in `.version-bump.json`, both root package-lock versions, and the bug-report placeholder synchronized. Keep the Codex (`skills/`) and Claude (`claude-skills/`) skill files identical, and keep `disable-model-invocation: true` in every copy: Claude Code also scans the root `skills/` directory, so a copy without the key puts its description in every turn's context. Codex takes its policy from `agents/openai.yaml`; preserve that explicit-invocation metadata too.

For routing and ownership changes, read [architecture](docs/architecture.md) and [the safety model](docs/safety-model.md). Update the affected configuration, integration, or verification document. A package loader or fixture pass does not establish live host acceptance or billed-token neutrality. Record the exact revision, host version, and check boundary when adding evidence.
