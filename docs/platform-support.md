# Windows and Linux support

Clean Development runs as a local Node.js CLI on Windows, Linux, and macOS.
Use Node 20.12 or newer. The process running the CLI determines filesystem and
environment semantics; a shell prompt or repository name does not change them.
Start diagnosis with the actual command cwd, selected executable, effective
configuration, and installed runtime version.

## Environment and locations

On Linux and macOS, environment names match exactly: `PATH` and `path`, or
`CARGO_TARGET_DIR` and `cargo_target_dir`, are independent variables. On Windows,
names match case-insensitively and routing writes one canonical spelling.
The [npm `npm_config_*` variables](https://docs.npmjs.com/cli/v11/using-npm/config/#environment-variables) are a tool-defined exception: their aliases are
matched case-insensitively on every host. Explicit values are preserved, and skip
removes only unchanged routing values and Clean Development's own native keys.

Linux locations use the configured `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and
`XDG_CACHE_HOME`; Windows uses `LOCALAPPDATA` and `APPDATA`. Explicit Clean
Development data/config/storage overrides take their documented precedence.
Recognized base overrides must be nonempty absolute narrow paths. Invalid values
fail diagnosis rather than silently selecting another location. See
[configuration precedence](config-precedence.md#platform-location-precedence).

The upstream [Node subprocess documentation](https://nodejs.org/api/child_process.html)
describes Windows environment casing and batch dispatch; the
[XDG specification](https://specifications.freedesktop.org/basedir/latest/)
describes Linux base directories. Clean Development deliberately rejects invalid
base overrides instead of applying XDG's ignore-and-fallback rule.

## PATH and launchers

Windows PATH entries may have whole-entry double quotes, including a directory
whose name contains a literal semicolon. Executable lookup, runtime prepend,
skip removal, and durable Codex PATH construction decode the same entry grammar.
Routing preserves unrelated entry spelling and quotes a newly added directory
when its semicolon would otherwise split the entry. Malformed entries are not
repaired or shell-expanded. POSIX entries retain literal quote characters.

Native executables receive argv directly. Windows `.cmd` and `.bat` commands use
the explicit batch adapter. Generated managed launchers protect literal percent
characters in their fixed paths and disable inherited delayed expansion so bang
characters remain literal. This does not change a caller's explicit shell script
or its own argument evaluation. See [Windows command boundaries](windows-command-boundaries.md).

## External storage and WSL

Review storage with the native CLI before running a command. For example:

```powershell
clean-development setup --dry-run --root 'E:\development-cache' --no-xcode
clean-development session --dry-run --json
```

```sh
clean-development setup --dry-run --root /mnt/development-cache --no-xcode
clean-development session --dry-run --json
```

These are read-only examples. Select a real mounted destination whose parent
exists, then apply the reviewed setup/session choice within its authorized scope.
Do not change drive letters, mounts, permissions, or global toolchains merely to
make a preview succeed. A missing external base must produce an error. Source,
credentials, toolchain homes, retained products, and unregistered paths remain
externally owned on every platform.

WSL Linux tools use Linux paths and environment semantics. A Windows executable
launched from WSL has its own path and environment requirements; wrapping it
does not prove its native cache placement. Inspect the actual executable and
owning tool, and validate the path form it consumes. Microsoft documents these
[WSL filesystem and interoperability differences](https://learn.microsoft.com/en-us/windows/wsl/filesystems).
Keep Windows and Linux routing choices distinct when both runtimes are involved.

## Configured checks and evidence limits

Ubuntu/macOS CI runs the full suite on exact Node 20.12.0 and current patches of
the configured 20, 22, and 24 majors. It also requires Cargo, Go, and npm artifact
smoke checks and selected installed-package upgrade checks.

The [native Windows gate](windows-contracts.md) is configured for exact Node
20.12.0 and the configured 22/24 majors. It exercises batch argv, generated
launchers, environment/skip behavior, workspace identity, pruning, probes, and
isolated installed-tarball and preceding-release upgrade checks. A configured
workflow is not a completed acceptance result: record its revision, runner/host,
Node and tool versions, skips, and outcomes before making a support claim.

The [30 September native lab record](verification.md#30-september-native-lab-record)
records local Ubuntu and Windows ARM64 execution on Node 20.12.0, including the
Ubuntu full suite, selected Windows contracts, and genuine release-upgrade gates.
It does not establish that the
configured GitHub Windows matrix passed, or extend that result to x64, Node
22/24, WSL, or live agent workflows.

The ordinary fixture lab is currently POSIX-only. Windows real-artifact smoke
expansion needs a native verification-timeout descendant-cleanup contract first.
Long/UNC paths, non-administrator policies, WSL mixed-runtime workflows, Linux
architectures, external-volume loss, disk/quota exhaustion, and live agent
session/resume behavior require separate named-host evidence. Keep the known
[storage fault cases](../test/fault-lab/FINDINGS.md) visible while improving that
coverage; a successful aggregate suite does not repair its TODO invariants.
