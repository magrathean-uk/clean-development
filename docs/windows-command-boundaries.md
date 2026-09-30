# Windows batch command boundaries

`spawnInherited` runs ordinary native executables with an argv array and without
shell parsing. Windows `.cmd`/`.bat` wrappers require `cmd.exe`; the dedicated
`windowsBatchInvocation` adapter constructs that invocation. Its input executable,
arguments and environment remain explicit caller choices. This is not a service
that accepts untrusted remote requests, and the adapter is not a general-purpose
shell sanitiser.

Arguments are first quoted for the Windows native argv parser, then escaped for
the two cmd parses involved in ordinary percent-star batch forwarding. The command
path has its own escaping. The invocation uses `/d /v:off /s /c`, and newlines and
NUL bytes in commands/arguments are rejected before launching. Native programs
continue to receive raw argv rather than the batch representation.

## Executable discovery and PATH

Windows executable discovery treats a wholly double-quoted PATH component as one
literal directory. For example, `"C:\tools;cache,=+";C:\fallback` searches the
semicolon-containing directory first, not fragments of that directory or the
fallback tool. Both quoted absolute and relative entries are supported; relative
entries resolve against the requested child cwd. PATH order, runtime exclusions
and candidate inspection still apply after decoding. Explicit executable paths
remain caller-selected and are not decoded as PATH lists.

Only whole-entry double quotes are removed. Apostrophes, whitespace, percent and
bang syntax, carets, commas, equals signs and plus signs are not trimmed, expanded
or shell-evaluated. Empty entries, including `""`, are ignored; use `.` or `"."` to
request cwd lookup. Malformed quote syntax is skipped rather than repaired; an
unclosed quote makes the remaining tail ambiguous and it is skipped as one entry.
POSIX PATH parsing is unchanged, including literal quote characters in filenames.
The caller's environment is not rewritten.

## Managed and npm-generated launchers

Managed launchers escape percent characters in their fixed installation paths and
disable inherited delayed expansion before invoking Node. That protection begins
after the batch file has been entered. A caller that enables `/v:on` can expand
bang characters in the launcher's own pathname before entry; use the adapter's
`/v:off` dispatch for that pathname. The inherited-policy regression uses a plain
entry pathname with identical generated contents, while retaining percent/bang
characters in the installed runtime path it invokes.

The child command is the launcher's final executable line. Batch EOF restores its
local environment scope and preserves the child's native exit status. A trailing
`exit /b`, `goto :eof`, or `endlocal` can reset that status; expanding `%ERRORLEVEL%`
can instead read an independent caller-defined environment variable. The native
regression checks success, nonzero and high unsigned 32-bit exit codes, exact
argv/cwd, and preservation of the child's inherited `ERRORLEVEL` value.

The native Node 20.12.0 / npm 10.5.0 lab also reproduced an external boundary:
the [npm-generated wrapper](https://github.com/npm/cli/blob/v10.5.0/node_modules/cmd-shim/lib/index.js)
uses unquoted `SET dp0=%~dp0`. An ampersand in npm's installation prefix can split
that assignment before Clean Development executes. Use an ordinary installation
prefix with this npm version. The package regression retains npm's actual
generated launcher, uses an ordinary Windows install/temp prefix, and exercises
adversarial names in its source cwd plus the separate managed-launcher path tests.

## Native regression matrix

`test/windows-argv.test.js` exercises `.cmd` and `.bat` wrappers in ordinary and
`node_modules/.bin` directories. It checks literal metacharacters, percent-variable
syntax, quotes/backslashes, empty/whitespace values, Unicode and exit status. A
controlled side-effect filename confirms that the test's argument remains data.

`test/windows-command-path.test.js` adds executable directory names containing
spaces/ampersands, brackets, carets, bangs, percent-variable syntax, unmatched
percent signs, punctuation, apostrophes and non-ASCII text. Both batch extensions
must preserve arguments and nonzero status. An environment variable deliberately
has a different value from its literal spelling in the path. The test must not
silently substitute that value or run a side-effect argument. Quoted PATH cases
also place impostor tools in cwd and a later PATH entry, and verify selection,
child cwd, exact argv and nonzero status for `.cmd` and `.bat` wrappers. They cover
spaces, semicolons, commas, equals signs and plus signs individually and together,
plus empty entries, runtime exclusions and generated-shim rejection. Parser-only
and POSIX-boundary assertions run everywhere applicable. Execution cases run only
on native Windows; a Linux skip is not acceptance evidence.

```sh
node --test test/windows-argv.test.js test/windows-command-path.test.js
```

## Review boundary

CodeQL has reported shell-construction flows in the adapter and foreground runner
on PRs #14/#15. A successful analysis workflow means the analysis completed, not
that the warnings disappeared. The regression matrix is evidence for its tested
wrapper contract, not a formal proof of all shell inputs or a reason to suppress
findings automatically. Review the actual source-to-sink traces before accepting
those warnings; no CodeQL suppression or security-rule exclusion is added here.

The contract does not cover arbitrary batch scripts using `CALL`, enabling delayed
expansion or evaluating their arguments as commands. Explicitly asking to execute
a shell or a command-evaluating tool retains that tool's behaviour. It does not
create a sandbox, authenticate executable contents, restrict a caller's environment
or protect against every same-user change after executable discovery. Tool scripts,
installed versions, UNC/long-path behaviour and unusual process policies need their
own acceptance evidence.
