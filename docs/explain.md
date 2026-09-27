# Read-only command explanations

`clean-development explain [--session session-only|skip] [--json] -- COMMAND [ARGS...]`
predicts the wrapper environment without launching a child. The API equivalents
are `explainCommand` and `formatExplanation` from `clean-development/api`.

The JSON contract has `schemaVersion: 1` and `kind: "prediction"`. It includes the
selected executable and availability, selected session mode and source, static
workspace identity, resolved configuration paths and their sources, variables
that would be set or preserved, routing status, and explicit limitations. No full
argv or unrelated environment is included, and no report is persisted.

Routing statuses are `predicted`, `skipped`, `disabled`, `blocked`, and `indirect`.
The last means no top-level adapter handles the named command; detected session
cache values are shown, but nested command behaviour is unknown. Absolute paths
to native executables do not automatically select a top-level adapter, matching
`run`. Missing executables are reported, never installed.

Explicit `skip` avoids reading project configuration, including invalid project
JSON, matching the skip launch path. Inherited `persist` becomes session-only;
new persistence proposals belong in `session --dry-run`, not this command.
Inspection does not grant session consent, run a Cargo probe, materialise a
runtime, prepare storage, create leases or modify source files.

Displayed environment values are not a claim about final disk writes. Native
flags and configuration may override them. Cargo `--target-dir` is shown
separately because it takes precedence over the routed environment. Cargo
workspace identities and target paths remain estimates until actual dispatch
resolves nontrivial layouts and applies ownership and active-build checks.
Tool-specific native configuration and arbitrary scripts are not executed to
infer output. A prediction is not proof of routing in a GUI agent, resumed shell
or subagent. Source and project-local dependencies are not automatically moved.

## Terminal rendering

The human-readable explanation escapes control characters inside each generated
line before adding its own line breaks. A command name, path, environment override
or reason therefore cannot introduce an ANSI/OSC control sequence or forge an
extra report line. C0/C1 controls, Unicode directional controls and line/paragraph
separators are displayed as literal escapes. Ordinary Unicode text remains readable.
Backslashes and quotes are escaped too, so a filename containing the literal text
`\n` can be distinguished from a filename containing an actual newline.

This is display encoding, not a change to routing or the report object. The
version-1 JSON data contract preserves the original values after JSON parsing.
Consumers rendering that data must apply their own context-appropriate escaping;
do not treat raw JSON values as terminal-safe strings or executable shell snippets.
No commands are logged or executed, and no file changes result from rendering.
This change covers human-readable `explain` output, not every other CLI formatter,
child-process output, or arbitrary third-party terminals.

```sh
node --test test/explain-rendering.test.js test/explain.test.js
```
