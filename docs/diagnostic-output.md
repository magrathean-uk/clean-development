# Diagnostic text and JSON

`explain`, `status --workspaces` and `probe` keep their existing public formatter exports and report schemas. Their human-readable output is produced by a shared pure module, `src/diagnostic-formatters.js`.

Each generated line is escaped once before formatter-owned newlines join it to the next line. This makes C0/C1 controls, Unicode direction controls and line/paragraph separators visible instead of letting a stored path or diagnostic value alter the display. Literal backslashes, quotes and unpaired surrogates remain distinguishable from actual control characters. Ordinary Unicode and emoji are retained.

The source report is not changed. `--json` retains the exact data values; callers displaying parsed JSON must encode values for their own terminal, HTML or other output context. Plain-text output is for people, not a replacement JSON schema or a shell-safe command representation.

This boundary covers these three report formatters. It does not filter arbitrary child-process output, change routing or cleanup decisions, or sanitise commands before execution.

Run the pure regressions with `node --test test/diagnostic-formatters.test.js`. The separate `test/diagnostic-public-exports.test.js` verifies the existing module exports and a read-only status CLI round trip. Both suites also run in the native Windows contract workflow.
