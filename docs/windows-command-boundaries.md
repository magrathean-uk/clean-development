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
silently substitute that value or run a side-effect argument. These tests execute
only on native Windows; a Linux skip is not acceptance evidence.

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
