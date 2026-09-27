# Command-level artifact boundaries

## Contract

A disposable intermediate exists to execute a check, test, benchmark or program;
it is reproducible working data, not a retained build product. A final deliverable
is an output the command produces for later use: an executable/library, source
package, wheel, documentation export or retained QA report. A release profile is
not the definition: a debug `cargo build` can also produce a deliverable.

Only a recognised intermediate Cargo invocation may receive an automatically
chosen, registered `CARGO_TARGET_DIR`. `cargo build` in every profile, `package`,
`publish`, `rustc`, `doc` and `rustdoc` require an explicit target outside current
and historically recorded managed build roots. The same applies to `--no-run`,
`--timings`, `--artifact-dir` and `--out-dir` output forms. An unsafe explicit path
is rejected, never replaced with another destination. `CLEAN_DEVELOPMENT_FORCE=1`
does not override an explicit Cargo output path or authorise final-output storage.

The automatic intermediate allowlist is `check`/`c`, `test`/`t`, `run`/`r`, `bench`
and `clean`, subject to the flags above. `clean` retains the existing owner and
lease checks. Inspection/help invocations get no injected Cargo target and create
no workspace record. Built-in `b` is treated as `build`, not a disposable shortcut.
Unknown commands, custom aliases, unknown options, malformed/repeated target flags
and ambiguous argument tails fail closed with `ERR_CARGO_ARTIFACT_BOUNDARY`.
Arguments after `--` in `run`, `test` and `bench` belong to the child program and
are not reinterpreted as Cargo output flags.

The shim checks before Cargo discovery, registration, leases or tool execution.
An enclosing explicit routed session may already have prepared its external bases
and installed its runtime. Rejection does not roll those steps back or change
existing artifact bytes. Read-only `explain` reports the same block.

## Direct versus routed commands

The native defaults below assume no independent native configuration or output
environment override. `WORKSPACE` is the Cargo workspace root; `CWD` is the actual
native invocation directory. `MANAGED` is the configured root. An explicit output
outside managed build roots may still be inside the project, if the user chooses.

| Command | Direct native output | Previous unconditional Cargo route | Current routed behaviour / prune exposure |
| --- | --- | --- | --- |
| `cargo check` | `WORKSPACE/target`, primarily metadata/intermediates | `MANAGED/builds/<id>/cargo/target` | Still routes eligible intermediates; registered root can be explicitly pruned after lease/pin/age checks. |
| `cargo build --release` (also debug/custom profiles and `b`) | `WORKSPACE/target/release/<binary>` (or selected profile) plus intermediates | Final binary entered the registered target and could disappear during prune. | Refuses an implicit target. With external `--target-dir`, outputs stay at exactly that target; no new ownership/prune claim. |
| `cargo package` | `WORKSPACE/target/package/<name>-<version>.crate`; verification build also uses target storage | The distribution archive and verification data entered the prunable root. | Refuses an implicit target. External `--target-dir` keeps the archive outside prune authority. `--no-verify` does not make the archive disposable. `--list` is inspection. |
| `cargo test --no-run` / `cargo doc` | Retained test binaries / generated documentation under target | Could become prunable although requested as retained output | Require an external explicit target. Ordinary `test`, `run` and `bench` output remains disposable; choose an external target to retain it. |
| `go build -o FILE` | Exact file (or executable inside the selected directory) | No final-output redirection | `GOCACHE`/`GOMODCACHE` alone are routed. `-o FILE` and `-o=FILE` remain unchanged; recognised managed-output paths are refused. |
| `npm pack` | `CWD/<name>-<version>.tgz` | No final-output redirection | Same tarball path; only `npm_config_cache` changes. |
| `npm pack --pack-destination DIR` | Tarball inside `DIR` | No final-output redirection | Exact directory retained, split/equals forms checked against prune roots. `npm_config_pack_destination` is also checked. |
| `uv build` | Wheel and source distribution in source-directory `dist/` | No final-output redirection | Same deliverables; only `UV_CACHE_DIR` changes. |
| `uv build --out-dir DIR` / `-o DIR` | Wheel/sdist in `DIR` | No final-output redirection | Exact directory retained; split/equals output declarations into prune roots are refused. |
| `npm run outer` -> `npm run inner` -> supported command | Whatever the actual inner command requests | Nested Cargo could inherit a prunable target | Package scripts are not parsed or executed during planning. Each PATH-resolved Cargo child checks its own argv; implicit release/package commands fail, explicit external output succeeds. Cache-only commands keep their final paths. |

For Go, npm and uv, the extra output guard recognises the leading native command
forms shown above (`go test -o` too); it is not a full native configuration or
shell parser. They never acquire build ownership merely by using cache routing.
Prune does not remove shared package/compiler caches. Unknown native configuration,
leading-option forms and arbitrary script-selected destinations remain outside
this narrow explicit-output guard; do not place deliverables inside managed builds.

## Explicit outputs, configuration and nested environments

Use the tool's own path option, for example:

```sh
clean-development run --session session-only -- cargo build --release --target-dir "$PWD/dist/cargo"
clean-development run --session session-only -- cargo package --target-dir "$PWD/dist/cargo"
clean-development run --session session-only -- go build -o "$PWD/dist/program" .
clean-development run --session session-only -- npm pack --pack-destination "$PWD/dist"
clean-development run --session session-only -- uv build --out-dir "$PWD/dist"
```

Parent directories must meet the native tool's requirements. Nothing creates a
new deliverable directory on the user's behalf before the actual tool runs.
Independent `CARGO_TARGET_DIR` and `CARGO_BUILD_TARGET_DIR` are accepted as explicit
outputs, including under force. CLI flags still win natively. A CLI target removes
only unchanged product-injected Cargo values; an independent target and unrelated
cache variables remain untouched. Recorded Cargo provenance is cleared when its
value is removed, so a nested command cannot mistake an obsolete injected target
for the reviewed external output. Conflicting nonempty case variants are refused.
All recognised target/export declarations must be outside prune authority, even
when another output declaration would shadow one of them in the direct command.

Canonical containment checks include symlinks, missing leaf paths, relative paths,
Cargo `-C` and old build roots retained in state. Similar path prefixes are not
containment. Marker/receipt validation and existing leases remain authoritative
for explicit intermediate targets inside managed roots.

Native `.cargo/config` or `config.toml` in an ancestor or `CARGO_HOME`, `--config`,
and unrecognised unstable switches make implicit output selection ambiguous. The
wrapper does not parse TOML, resolve aliases or evaluate scripts to guess intent;
choose an external target or explicitly use native execution:

```sh
clean-development run --session skip -- cargo build --release
```

Skip retains native semantics and independent overrides. It is not an artifact
protection mode. Disabled routing and direct absolute-path tools likewise do not
grant protection against writing to a previously registered managed directory.
No new build-dir feature/toolchain detection, automatic pinning, copying, moving,
source/config rewriting or deletion is introduced.

## Existing data and residual boundaries

This change cannot retrospectively identify valuable files already inside an old
registered target. Before pruning such a root, inspect it and pin it using the
existing explicit pin command if its contents need retention. The patch neither
moves those files nor silently changes their ownership. Rollback is a code revert,
not a data migration; reverting restores the unsafe implicit Cargo behaviour.

A project, compiler wrapper or program can write arbitrary files with the user's
permissions. For example, a build script can bypass PATH shims or choose an output
from an environment variable. Runtime cache routing is not filesystem containment.
Native config evaluation, arbitrary scripts, external tools, same-user changes
after path validation, historical roots from a different state home and persistent
mount identity are not certified by this gate. Explicitly copying a deliverable
into owned storage still exposes it to a later explicit prune.

## Reproduction and acceptance

```sh
node --test test/cargo-artifact-boundary.test.js
node --test test/artifact-deliverables.test.js
CD_ARTIFACT_REQUIRE=cargo,go,npm,uv node --test test/artifact-deliverables.test.js
npm run check
npm test
npm run smoke:tools
```

The first suite uses a labelled fake Cargo to prove non-execution, unchanged argv,
force/override handling, canonical/historical containment, explanation, nested real
npm lifecycle routing, inspection/skip and unchanged external bytes during prune.
It is not compiler acceptance. The second uses installed real tools, empty npm
configuration, isolated HOME/XDG/Cargo homes, offline resolution, dependency-free
Rust/Go/npm projects and installed setuptools/wheel for uv. No backend is installed
or faked. Missing tools/backends are explicit skips; the require variable makes a
missing selected tool or its prerequisite fail. Native Windows is an explicit
POSIX-fixture skip, not acceptance.

The real Cargo case checks executable bytes and execution, `.crate` member bytes,
external target placement, nested scripts, metadata in the managed check target,
and refusal of implicit/unsafe output. A labelled legacy-layout control runs real
Cargo directly with the former unconditional target environment: the real binary
and archive are then removed by an explicitly applied prune, while external
artifacts and source bytes survive. It is a reproduction of the old layout, not
a successful routed command. Go binary and npm archive bytes are compared across
direct/routed/nested runs. uv wheel/sdist source members are compared exactly;
backend gzip metadata is not falsely claimed to be deterministic. All four cases
record versions, relative paths, byte counts and SHA-256, and verify survival after
an actual disposable prune. Non-Cargo prune controls explicitly seed a synthetic
intermediate rather than pretend those tools created Cargo state.

Each child has a 120-second deadline and 2 MiB output cap. Failed POSIX commands
terminate their dedicated process group; uncertain cleanup retains the fixture. Inventories have entry
and depth bounds. Fixture-only output removal proves regeneration before comparison;
this is not product deletion. Successful tests clean their newly created temporary
roots. HOME isolation is not OS containment. See the draft PR evidence for exact
source revision, host versions and which real-tool cases actually ran.

## Primary native-tool references

- [Cargo build: profiles, target-dir and artifact-dir](https://doc.rust-lang.org/cargo/commands/cargo-build.html)
- [Cargo package: archive and verification layout](https://doc.rust-lang.org/cargo/commands/cargo-package.html)
- [Cargo configuration: target-dir and build-dir distinction](https://doc.rust-lang.org/cargo/reference/config.html#buildtarget-dir)
- [Go build: executable and -o semantics](https://pkg.go.dev/cmd/go#hdr-Compile_packages_and_dependencies)
- [npm pack: destination, cache and lifecycle](https://docs.npmjs.com/cli/v11/commands/npm-pack/)
- [uv build: source distribution, wheel and out-dir](https://docs.astral.sh/uv/reference/cli/#uv-build)
