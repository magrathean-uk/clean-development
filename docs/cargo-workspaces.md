# Cargo workspace discovery

Actual routed Cargo commands use `cargo locate-project --workspace` when ancestor
manifests contain potential workspace declarations. Cargo, rather than a partial
TOML parser, resolves workspace exclusions, external members, `package.workspace`
and nested standalone workspaces. The returned canonical workspace path drives
the target directory, ownership receipt, lock and active lease together.

Standalone manifests with no potential workspace declaration use the existing
path-based fast path. This lexical check errs towards querying Cargo, including
when `workspace` occurs in comments or Unicode escapes occur in a manifest.
Nothing runs during `session --dry-run`, `env`, or static workspace identification.
Their Cargo workspace identities are estimates until actual dispatch.

Discovery uses the real executable outside the shim directory and preserves an
explicit `+toolchain`, manifest path, `-C` working directory, and `--config` / `-Z`
options. Arguments after `--` are not interpreted. The user's actual command and
arguments are passed unchanged to the eventual child.

Discovery starts in the same launch cwd as the eventual child. It forwards `-C`
before `locate-project` rather than changing the subprocess cwd itself: rustup
selects a toolchain before Cargo applies `-C`. The selection precedence remains
an explicit `+toolchain`, then `RUSTUP_TOOLCHAIN`, then rustup's directory/file
and default rules from the launch cwd. A toolchain file at the `-C` destination
must not replace the caller's selected toolchain for ownership discovery.
Relative manifest and Cargo configuration paths still use Cargo's `-C` context;
the child's original argv and launch cwd remain unchanged.

The discovery subprocess has a five-second timeout and a 64 KiB output limit.
`CARGO_NET_OFFLINE=true` and `RUSTUP_AUTO_INSTALL=0` apply only to discovery, not to
the build. There is no dependency-resolution command, model call, persistent
cache or project script execution. Tool wrappers retain their own behaviour; this
is not a network or process sandbox.

Failed, timed-out or invalid discovery stops managed build routing before
workspace lock, receipt, lease or target creation. It does not silently assign a
member to an unrelated parent. Explicit skip and disabled projects bypass this
step. Session preparation may already have created the approved empty base
storage directories, as before.

Existing owned targets are retained; this change does not migrate or delete
output. A corrected workspace identity can use a different target directory from
an earlier incorrect identity. Existing pins and ownership markers still apply
to the records they protect. No stable cross-platform acceptance is implied by
unit tests; the real-Cargo fixture test reports a skip when Cargo is unavailable.

Reference: https://doc.rust-lang.org/cargo/commands/cargo-locate-project.html

Toolchain selection: https://rust-lang.github.io/rustup/overrides.html
