# Explain leading native cache options

The environment selected by Clean Development is not necessarily the path a native tool will use. `explain` now reports a recognised leading cache-option prefix for npm and uv alongside the unchanged environment prediction.

```sh
node bin/clean-development.js explain -- npm --cache /absolute/native-cache config get cache
node bin/clean-development.js explain -- uv --cache-dir /absolute/native-cache cache dir
node bin/clean-development.js explain -- uv --no-cache cache dir
```

This remains read-only. The inspected command is not executed, storage is not prepared, full argv is not logged, and user flags are not rewritten. In particular, Clean Development's force mode changes its environment routing, not native command-line precedence.

## Deliberate inspection boundary

Only the leading sequence of recognised options is inspected: npm `--cache VALUE` / `--cache=VALUE`; uv `--cache-dir VALUE` / `--cache-dir=VALUE`, `--no-cache`, `--no-cache-dir` and `-n`. Inspection stops at the first command, unknown option or `--`. This avoids treating flags for a script launched by `uv run` or another child as native cache settings. Put the supported cache options before the command to include them in the explanation.

This is not a complete native parser. A flag after `install`, `sync`, `run`, an unknown option or `--` is deliberately not inferred, even where a native tool might accept it. An empty declarations list means no supported leading declaration was found, not that there are no overrides. npx and other executables are outside this feature's scope.

Values are literal declarations: relative paths, tildes and environment-variable spellings are not expanded or canonicalised. Multiple declarations do not select a winner. Missing, oversized or unsafe-to-interpret values are labelled unknown. Inspection is bounded to 32 declarations and 8192 characters per value.

uv's no-cache mode requests temporary cache storage. It is not a promise of zero writes.

## Additive JSON data

For an active npm or uv environment prediction, `routing.nativeCacheOptions` contains `scope`, `declarations`, `stopReason`, `ambiguous`, `effectiveDestination: null` and `observed: false`. Existing environment variables and report schema version remain unchanged. Each declaration names its option and environment variable, an effect (`path-override`, `temporary-cache` or `unknown`), and a literal value or null. Skip, disabled and blocked flows retain their existing early-return behaviour.

The text formatter escapes values through the shared diagnostic renderer. JSON retains supported literal values; consumers must encode them for their own output context.

## Verification

`node --test test/native-cache-options.test.js` checks inspection boundaries, invalid values, bounded work, immutability, read-only public CLI behaviour, force-mode explanations and display/JSON separation. Real npm and available uv executables are tested with fixed offline cache queries in disposable homes. npm is required by this suite; unavailable uv is an explicit skip. A successful native query demonstrates that installed version's behaviour in the fixture, not arbitrary script output or a real agent session.

Native contracts: https://docs.npmjs.com/cli/v11/using-npm/config/ and https://docs.astral.sh/uv/reference/cli/#uv-cache-dir.
