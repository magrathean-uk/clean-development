# Contributing

Thanks for helping improve Clean Development. Please keep changes within the supported product scope and use isolated fixtures for tests.

## Supported scope

This version targets macOS with Claude Code or Codex lifecycle hooks. OpenCode has environment routing only. Linux CI covers source checks and fixtures; it is not a supported runtime target. The `machine/storage.conf` file is an editable example and must not be treated as a universal policy.

## Before opening a pull request

- Keep cache, scratch and build paths governed by machine configuration.
- Preserve fail-closed behaviour when policy, ownership or path safety is uncertain.
- Do not test against a live user home, real removable volume or authenticated coding-agent account. Use the fabricated homes and volumes in the test suite.
- If a runtime version changes, update the coordinated release metadata and run `npm run check`.
- Codex TOML merge and trust tests need Python 3.11 or later. Optional integration checks for a containing source monorepo require the explicit `CLEAN_DEV_TEST_PRIVATE_SOURCE=1` opt-in.

Run the source checks and isolated suite with a fresh test directory:

```sh
npm run check
CLEAN_DEV_TEST_DIR="$(mktemp -d /tmp/clean-development.XXXXXX)" npm test
```

Use an internal fixture path; `test/env-modes.sh` refuses paths on the mounted `External` volume.

Pull requests should describe the behaviour changed, the fixture or check that covers it, and any host-specific acceptance that remains unverified. A passing fixture suite does not establish live host deployment behaviour.
