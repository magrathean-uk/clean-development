# Hook command compatibility

The installer writes hooks that call the active runtime shim. Its portable form uses double quotes so the shell expands `$HOME`:

```sh
"$HOME/dev/machine/runtime/clean-development/active/bin/cd-hook" stop claude
```

Replace `stop` with `session-start` or `session-end`, and `claude` with `codex` for the corresponding event and harness.

During upgrades, `doctor` also accepts an absolute path to the current `active/bin/cd-hook` when the path is quoted with single or double quotes. An unquoted absolute path is accepted when it contains no spaces. Codex trust checks use the same command parser and also recognize absolute paths to versioned runtime shims so existing trust entries can be maintained.

Do not single-quote `$HOME`: the shell would pass the literal text instead of expanding it. For an absolute path containing spaces, keep the path quoted.

These forms help diagnose existing settings. Use the supplied hook merge tools to install or update handlers so unrelated configuration is preserved.
