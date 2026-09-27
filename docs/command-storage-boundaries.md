# Effective-project storage boundaries

Routing checks the managed root, cache root, build root and scratch root against
both the starting project and the effective project selected by a recognised
native directory/manifest option. A command that selects another project must
not reuse the starting project's earlier approval to route inside either source
tree. Existing directories and `CLEAN_DEVELOPMENT_FORCE=1` are not exemptions.

The same read-only boundary predicate is used by session planning, command
explanations and routed tool execution. A conflict makes `explain` report
`blocked` with no applied routing variables. Executing a routed command rejects
with `ERR_MANAGED_STORAGE_IN_PROJECT` before the adapter creates cache/build
subdirectories, ownership receipts or leases or starts the requested command.
This error code is available to programmatic callers; the CLI reports the error
and exits nonzero.

## Order of checks

`run` checks statically discoverable target conflicts after choosing the session
mode but before preparing managed base directories or persisting project
configuration. `runWithShims` checks before materialising its runtime, and
`runTool` rechecks at dispatch. Interactive skip remains available. A disabled
starting project is pass-through, without reading the target configuration.
A disabled target tool/project does not become routed merely because the
starting project was enabled.

Cargo can discover a different authoritative workspace through its selected
executable's bounded `locate-project --workspace` query. That result is checked
again before ownership writes or the actual Cargo command. Read-only explanation
never executes this query, so Cargo predictions remain provisional. If a conflict
is discovered only by that query, an enclosing session may already have prepared
external base directories or its runtime. The query itself executes the trusted
selected Cargo tool; this is not a promise of zero system calls or zero tool
side effects.

## Exact scope

The existing tool argument resolver determines the effective directory; this
change does not add a complete native argument parser. Recognised selectors
include npm-style prefixes/directories, Go `-C`, and Cargo `-C`/`--manifest-path`.
An explicit `--` stops selector inspection. Unknown scripts and absolute-path
commands are not reinterpreted as supported tool invocations.

Canonical paths are used, so symlink/junction aliases and path-prefix similarities
do not defeat the boundary or accidentally classify a sibling as a descendant.
The existing exception for running from the home directory is retained: the home
root does not absorb unrelated children, but a selected project below home is
still protected. Unmarked starting directories retain conservative detection.

Explicit user cache/target overrides are still preserved when the *managed*
configuration is valid; user-selected paths are not automatically adopted as
owned storage. Low-level environment adapters and arbitrary child programs are
not a filesystem sandbox. Native tool flags, project scripts, environment changes
and concurrent same-user filesystem changes still require the user's normal
trust and permission boundaries.

## Verification and rollback

`node --test test/routing-context.test.js` covers every managed root, recognised
selectors, existing storage, both command contexts, force/overrides, pass-through,
public CLI persistence ordering, home boundaries, aliases and deferred Cargo
workspace discovery. The Cargo dispatch test uses a deterministic fixture
executable, not real Cargo acceptance. These tests also run in the native Windows
contract gate.

An existing Cargo relative-target test now starts from a separate caller directory
so it reaches its original explicit-target ownership assertion rather than the
new earlier storage-boundary rejection. Its ownership, non-execution and
no-created-target assertions are unchanged.

Revert the boundary change to roll back. There is no data migration, cache deletion,
configuration rewrite, new dependency or version bump. Do not delete existing
managed data as part of rollback.
