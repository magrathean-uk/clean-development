# Literal Windows executable tokens

A batch-file path can legitimately contain an equals sign. The command token supplied to `cmd.exe` must protect that delimiter separately from quoted child arguments. Do not replace this with a filename-based decision about whether a wrapper forwards `%*`.

The native contract covers `.cmd` and `.bat` files, repeated equals signs, adjacent carets and spaces, mixed punctuation, exact child arguments, nonzero exit status and an inert prefix-executable trap. Existing percent/exclamation expansion, Unicode, quoting and shell-metacharacter tests remain enabled.

Run `node --test test/windows-command-path.test.js test/windows-command-token.test.js` on native Windows. Portable construction checks are not proof of native command execution: Windows-only cases explicitly skip elsewhere. The Windows contracts workflow requires these cases on both Node 22 and 24.

This change is limited to executable-token encoding. It does not make arbitrary evaluating batch scripts safe, change native executable invocation, suppress CodeQL findings or authorise changes to shell configuration. Existing security-review findings still require source-to-sink review.
