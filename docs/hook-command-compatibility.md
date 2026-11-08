# Hook command compatibility

The installer writes hooks that call the active runtime shim. Its portable form uses double quotes so the shell expands `$HOME`:

```sh
"$HOME/dev/machine/runtime/clean-development/active/bin/cd-hook" stop claude
```

Replace `stop` with `session-start` or `session-end`, and `claude` with `codex` for the corresponding event and harness.

During upgrades, `doctor` also accepts an absolute path to the current `active/bin/cd-hook` when the path is quoted with single or double quotes. The standard shell-escaped form supports apostrophes in single-quoted paths. An unquoted absolute path is accepted only when it uses letters, digits, `_`, `.`, `/` and `-` (no spaces or shell syntax). Codex trust uses the same parser and only treats paths under this installation's runtime root as managed; versioned runtime shims remain recognized.

The parser understands the standard shell-escaped form for apostrophes in a single-quoted path. It rejects double-quoted absolute paths containing shell expansion characters; the double-quoted `$HOME` installer form remains supported.

Do not single-quote `$HOME`: the shell would pass the literal text instead of expanding it. For an absolute path containing spaces, keep the path quoted.

These forms help diagnose existing settings. Use the supplied hook merge tools to install or update handlers so unrelated configuration is preserved.
