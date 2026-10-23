# Clean Development project context

Clean Development is an ESM Node.js CLI with no npm dependencies. Its supported runtime is Node 20.12 or newer. Runtime code lives in `src/`, entry points in `bin/`, and isolated fixtures in `test/`.

## Product model

The runtime handles environment routing, caller overrides, argv, cwd, stdio, signals and exit status. Cargo retention uses registered build roots, markers, leases, pins and age. Source, toolchains, persistent state and deliverables have different ownership from disposable build output.

Session planning is read-only. `session-only` writes no project configuration; `persist` can create an absent `.clean-development.json`; `skip` removes inherited routing while retaining independent overrides. Native integrations default to skip. Tests use disposable homes, settings and storage roots for setup, update, uninstall, persistence and deletion scenarios.

## Command references

```sh
node --test test/session.test.js
node --test test/prune.test.js
npm run check
npm test
npm run test:package
```

The session and prune suites cover consent and retention respectively. `test:package` installs temporary tarballs and uses the preceding-release tag named in `scripts/verify-package.mjs` for upgrade verification. [CONTRIBUTING.md](CONTRIBUTING.md) describes smoke, fixture and performance checks.

## Configuration and documentation map

`.version-bump.json`, both root package-lock versions and the bug-report placeholder contain version information. Codex skills live in `skills/`; Claude skills live in `claude-skills/`. Claude Code also scans the root `skills/` directory. The `disable-model-invocation` frontmatter controls Claude skill loading; `agents/openai.yaml` contains Codex invocation metadata.

[Architecture](docs/architecture.md) and [the safety model](docs/safety-model.md) describe routing and ownership. Package-loader and fixture results cover different conditions from live host operation or billed-token measurements. The machine integration includes shell routing, `.clean-development.json` project metadata, environment checks and audit tools; their behaviour is documented alongside the integrations.
