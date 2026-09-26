# Contributing

Open an issue before adding an ecosystem adapter, changing configuration or the public CLI, or changing destructive behavior. Focused fixes and documentation corrections can go straight to a pull request.

## Development

Use Node 20.12 or newer. This package has no npm dependencies; the core checks run directly from a checkout:

```sh
npm run check
npm test
```

`check` validates JavaScript syntax, executable flags, synchronized versions, plugin metadata, and the two management skill variants. `test` runs Node's test runner. For a focused change, start with the relevant file, for example:

```sh
node --test test/session.test.js
```

Consider Clean Development for disposable development caches; review its [session choices](docs/configuration.md#session-choices) before opting in. Using it is optional and does not replace isolated test environments.

## Choose the checks that match the change

| Change | Additional validation |
| --- | --- |
| Package contents, manifests, exports, or runtime installation | `npm run test:package`; requires the preceding-release tag named in `scripts/verify-package.mjs` and installs tarballs in a temporary prefix |
| Tool adapters | `npm run smoke:tools`; inspect which installed tools ran or were skipped |
| Artifact placement across real tools | `node scripts/run-fixture-lab.mjs`; see [the fixture lab](test/lab/README.md) |
| Shim dispatch or caching | `npm run benchmark:overhead`; record host, Node version, sample count, and paired measurements |
| Native integration | Isolated host settings plus the named host/version's actual shell workflow |
| Documentation | Relative links, commands, examples, license text, and agreement with source |

Tests must use temporary homes, settings, storage roots, and fake tools where appropriate. Do not run setup or prune against your real home from the test suite. Keep real-tool checks offline where the harness supports it; never treat a skipped tool as a pass.

## Storage and launcher changes

An adapter needs primary upstream evidence for its environment variable or flag and a fixture showing the resulting path. Mixed credential, configuration, and toolchain homes are not disposable caches. Preserve explicit user overrides and unrelated agent settings.

Launcher changes must preserve arguments, working directory, standard streams, TTY behavior, signals, and exit status. Cover ownership, concurrency, and failure behavior when those contracts change. Do not add postinstall configuration mutation, prompt bootstrap text, telemetry, command recording, or automatic deletion.

Update the affected README, schema, changelog, and integration documentation when the public contract changes. Keep the two management skill bodies synchronized and retain explicit-only host metadata. See [AGENTS.md](AGENTS.md) for repository guidance and [RELEASING.md](RELEASING.md) for release checks.

## Pull requests and reports

Explain the behavior before and after the change, why it matters, and the checks you actually ran. Distinguish fixture coverage from live-host acceptance. Remove private paths, credentials, prompts, and account data from attached output.

Use [SECURITY.md](SECURITY.md) for suspected vulnerabilities and [SUPPORT.md](SUPPORT.md) for questions.

## Licensing

Contributions are submitted under the repository's [MIT License](LICENSE). Contributors retain copyright in their work. No CLA or DCO is required. See [licensing](docs/licensing.md) for the distinction between project and third-party rights.
