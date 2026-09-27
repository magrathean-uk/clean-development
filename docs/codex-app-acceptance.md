# Codex App (macOS): acceptance protocol and blocked evidence

## Recorded result — 27 September 2026

**BLOCKED: no actual Codex App acceptance was performed.** The executable fixture
and its local self-tests are not a GUI, CLI-model, or package-loader acceptance
claim. The native Codex App route remains shipped but unverified.

| Required identity | Recorded value |
| --- | --- |
| Product source baseline | `af12577c6596095fdf91f18e840e9433521ea3d2` (current main when checked) |
| Complete baseline Git tree | `998605cda006d588e9562cabe1eee6c78c2f3a59` |
| Runtime-content SHA-256 | `36129d3843ff2f34ccf0203bf1f5476a447067e41e768ae8e09ac847ca381858` |
| Fixture revision | The PR containing this document; `preflight` records its file SHA-256 |
| Available machine | Debian GNU/Linux 13, Linux `6.18.44`, x86-64; Node `v22.16.0`, npm `10.9.2` |
| Actual installed Codex App version/build | **Unknown — no accessible installed App** |
| Actual App invocation, conversation, restart | **None** |
| Actual App sandbox policy / writable roots | **Not observed** |
| Actual App Cargo artifact paths / local `target` absence | **Not observed** |

Read `AGENTS.md`, [agent integrations](agent-integrations.md), architecture and the
safety model before implementation. Open PRs #24–#33 were inspected; #33 changes
integration ownership and its existing documentation. This work neither includes
that unmerged fix nor edits those files: it adds only this document and
`test/lab/codex-app-acceptance.mjs`.

The container had no `cargo`, `rustc`, or `codex` on PATH, no macOS `/Applications`
mount, and no observed Codex/App process. Remote desktop capability discovery
returned an unconnected service, not an authorised host. `DISPLAY=:0` alone is
not an installed App or a logged-in isolated desktop. No contributor settings,
login credentials, desktop preferences, or build storage were used. The source
archive's complete reconstructed tree matched current main; direct container Git
network access failed DNS resolution. An archive checkout without a local HEAD
reports `source.commit: null`, not a guessed commit. The independently verified
baseline above must accompany that record.

Local validation on the machine above (not App acceptance):

| Invocation / boundary | Result |
| --- | --- |
| `node --test test/lab/codex-app-acceptance.mjs` | **8 passed**, 0 failed/skipped |
| `prepare` for `allow`, `deny-data`, `deny-managed`; `sh -n` on each launcher | **Passed**; disposable setup only, no App/Rust build |
| Independent Python `tomllib` parse of all three generated configs | **Passed**; native skip/PATH and exact writable-root lists, not enforcement |
| `preflight` on this Linux machine | **BLOCKED**, exit 1: no App or Rust toolchain |
| `verify` for allow / deny-data / deny-managed | **BLOCKED**, exit 1 each; 9 / 2 / 2 missing App-shell observations |
| `npm run check` | **Passed**: 36 JavaScript files, 14 version files, generated bundle and bug-report prompt |
| `npm test` | **395 total: 368 passed, 27 skipped, 0 failed**, exit 0 |
| Scoped diff and fixture syntax | **Passed**; only the two new files |

The full-suite skips are 26 native Windows cases and one unavailable real-Cargo
case; none count as passes. An earlier suite attempt was interrupted by the
execution wrapper; the final complete run above exited 0. The three local
preparation roots were `/mnt/data/codex-app-validation/allow`,
`/mnt/data/codex-app-validation/deny-data` and
`/mnt/data/codex-app-validation/deny-managed`. All live initial-shell, routing,
skip, cwd, worktree, restart/resume and sandbox checks remain **BLOCKED**. The
matrix later in this document states protocol expectations, not observed results.

Reproducible commands:

```sh
node --test test/lab/codex-app-acceptance.mjs
node test/lab/codex-app-acceptance.mjs preflight
node test/lab/codex-app-acceptance.mjs prepare /ABS/NEW/allow allow
node test/lab/codex-app-acceptance.mjs prepare /ABS/NEW/deny-data deny-data
node test/lab/codex-app-acceptance.mjs prepare /ABS/NEW/deny-managed deny-managed
node test/lab/codex-app-acceptance.mjs verify /ABS/NEW/allow
npm run check
npm test
```

The preflight and incomplete matrix deliberately exit 1. Successful preparation
means only that isolated CLI setup and Git fixtures were created. No Rust build or
App command has been promoted from this local evidence to host acceptance.

## Isolation gate — mandatory before running an App

Use a **new disposable macOS VM or dedicated disposable desktop OS account** with
an actual installed Codex App and a preinstalled Node/Git/offline Rust toolchain.
Do not run this protocol from a contributor's everyday desktop account. Changing
`HOME`/`CODEX_HOME`, an App command-line flag, or the acknowledgement in `launch.sh`
is **not** isolation of the App's preferences, keychain, login session, singleton
process or existing threads. Do not copy real auth/configuration into the lab.
Authenticate interactively in the disposable account where required.

Close that disposable account's existing App completely. Confirm no original App
process is reused; do not kill other users' sessions. Use an absolute lab path
outside the source checkout and outside the project being opened, preferably
beneath the disposable account's home rather than `/tmp`. Its parent must already
exist and be canonical. Prepare each policy in a **new, absent directory**. The
fixture retains all evidence; it has no uninstall, prune or automatic lab cleanup.

If the App cannot use these isolated locations, cannot preserve the specified
sandbox policy, requires a broad write grant, or cannot be restarted separately,
stop and record **BLOCKED**. Do not repair the trial by changing global settings,
exporting a shim PATH in the agent shell, setting `CARGO_TARGET_DIR`, disabling
the sandbox or executing Codex CLI. Those are different experiments.

The default protocol uses the App's **agent-executed shell tool**, not its
interactive terminal, `codex exec`, an SDK/App Server client, or a plugin loader.
Record the execution surface and tool command from the App transcript.

## Prepare and record the installed App

In the disposable desktop account, with the App closed:

```sh
REPO="$(pwd -P)"                 # this checkout, not an unrelated parent repository
NODE="$(command -v node)"       # record the absolute installed Node path
FIXTURE="$REPO/test/lab/codex-app-acceptance.mjs"
PARENT="$HOME/codex-app-acceptance"  # create this parent explicitly; use canonical paths
mkdir "$PARENT"
LAB="$PARENT/allow"
"$NODE" "$FIXTURE" prepare "$LAB" allow
"$NODE" "$FIXTURE" preflight /Applications/Codex.app > "$LAB/host-before.json"
# Preflight exits 1 until independent App acceptance exists; inspect JSON, not just exit.
```

Use the actual installed bundle path rather than assuming `/Applications/Codex.app`.
On macOS, `preflight BUNDLE` reads `CFBundleShortVersionString`, `CFBundleVersion`
and `CFBundleExecutable` from that bundle's Info.plist and hashes the executable.
It records OS version, architecture, Node, source commit when available, runtime
fingerprint and fixture hash. It does not substitute a bundled CLI version for an
App version. Retain the About/version screenshot and an anonymised machine/VM
label. A different product/bundle requires a separately named host record, not a
silent substitution.

Preparation creates dependency-free Rust projects, a committed lockfile, a real
Git worktree of project `a`, separate project `b`, and fresh skip/sandbox projects.
It runs only the repository's `setup --agents codex` with allowlisted environment
values and fixture-owned homes. It requires a native-shell-environment receipt;
a launcher fallback stops preparation. Cargo uses an empty fixture `CARGO_HOME`,
offline mode and disabled rustup auto-install, while reusing the installed
`RUSTUP_HOME` toolchain. These tool settings are not an OS network sandbox.

The generated host policy specifies `approval_policy = "never"`,
`sandbox_mode = "workspace-write"`, no command network access, excluded implicit
temporary roots, and explicit project/Cargo-home/tmp plus data/managed write roots.
The deliberately excluded `forbidden` sibling is never on that list. Settings
are seeded **before** native setup, outside the owned TOML block. The fixture
hashes the completed config and refuses observations after it changes.
These configuration keys are documented in OpenAI's
[configuration reference](https://developers.openai.com/codex/config-reference/);
consult the installed version's behaviour rather than assuming documentation
proves host enforcement. See also [agent integrations](agent-integrations.md)
for native skip and the separate sandbox permission boundary.

## Launch and first-shell evidence

Inspect the generated `launch.sh`. It starts only an explicitly supplied macOS
`.app/Contents/MacOS/...` executable, uses `env -i`, and includes **no managed shim
PATH or routed session mode in the App's parent**. Native configuration, not the
harness, must introduce those settings. It neither kills nor controls the GUI.

Use the executable path returned by `preflight`, for example:

```sh
"$LAB/launch.sh" --disposable-desktop-account /Applications/Codex.app/Contents/MacOS/Codex 1
```

Record that exact invocation, launch time and App process identity in a separate
operator log. Open only `$LAB/projects/a` in the App; **do not open the lab parent
or the source checkout as the workspace**, which could overgrant write access.
Disable optional local-environment setup actions for this test. Retain the App's
actual selected permissions and effective writable-root evidence.

For the first agent shell, request this exact command, substituting the literal
absolute values for `NODE`, `FIXTURE` and `LAB` (they are not inherited variables):

```sh
cd '/ABS/LAB/projects/a' && '/ABS/NODE' '/ABS/FIXTURE' sample '/ABS/LAB' initial "$(command -v cargo)" "$(command -v clean-development)"
```

Do not prefix `env`, `export`, a login shell, or `clean-development run` here.
Expected: both commands resolve to `LAB/data/bin/...`, native mode is `skip`,
launch epoch is `1`, and there is no static Cargo target variable. A wrong PATH,
missing configuration inheritance, or altered host config fails without routing
a tool. This catches the initial-shell condition before a wrapper could fix it.

## App-shell matrix

For each row, use the same literal shell command above with the listed cwd and
stage. Send changed-cwd requests in the **same App conversation**, not a fresh
independent terminal. The fixture records the incoming environment and shell
resolutions before invoking any child. Do not change its PATH to make a row pass.

| Stage | Exact cwd relative to LAB | Required result |
| --- | --- | --- |
| `initial` | `projects/a` | Native stable PATH; mode `skip`; epoch 1; no build |
| `native-skip` | `projects/native-skip` | Plain Cargo passes through, creates only this project's local `target`; no managed/registry changes |
| `routed` | `projects/a` | Explicit `run --session session-only`; non-empty test executable in its owned managed target, no local `target` |
| `nested-cwd` | `projects/a/src` | Same owned target as project `a`; no `src/target` |
| `changed-cwd` | `projects/b` | Different workspace/owned target from `a`; no local `target` |
| `worktree` | `projects/worktree` | Same Git common directory as `a`, but a distinct checkout-owned target; no local `target` |
| `routed-skip` | `projects/routed-skip` | Explicit skip nested inside a routed child; local `target` in this control only, no managed/registry changes |
| `sandbox` | `projects/sandbox` | Data and managed write probes succeed, excluded sibling write fails, routed Cargo succeeds |
| `resumed` | `projects/a` | After full quit/relaunch with epoch 2, resumed thread sees epoch 2, native skip and stable PATH; explicit route uses original owned target |

**Skip control interpretation:** plain unconfigured Cargo under skip normally
creates a project-local `target`. Requiring its absence would reject correct
pass-through behaviour or encourage hiding it with an override. Local targets
are permitted only in the two separate skip controls. Their existence never
satisfies the no-local-target criterion for any routed project.

The runner issues `cargo test --offline --locked --message-format=json`, checks
non-empty compiler-reported test executables (`profile.test = true` for
`cd_app_fixture`), and checks their real paths,
SHA-256, the workspace record and the independently read ownership marker.
Successful exit without a real artifact fails. The message fields follow the
[Cargo JSON artifact protocol](https://doc.rust-lang.org/cargo/reference/external-tools.html#artifact-messages).
It records command/argv/cwd,
selected non-secret environment fields, version output, stdout/stderr, exit,
signal and source fingerprints. No project configuration is persisted.

For restart, finish other epoch-1 rows first. Fully **quit**, not just close the
window; record termination of the original App process. Relaunch with the same
executable and lab but epoch `2`, then reopen the **same conversation** and run
`resumed`. Record the resumed conversation identity, new App PID/start time and
shell transcript. An environment epoch alone cannot prove GUI restart/resume.
If a stale shell snapshot yields epoch 1, preserve that failure; do not export 2
inside the agent shell. Do not accept a new conversation as resume evidence.

## Denied-root controls — separate fresh App launches

Quit the App and prepare two more labs under the same disposable parent:

```sh
"$NODE" "$FIXTURE" prepare "$PARENT/deny-data" deny-data
"$NODE" "$FIXTURE" prepare "$PARENT/deny-managed" deny-managed
```

Launch each lab's generated `launch.sh` with epoch 1, again using the actual App
executable. Open that lab's project `a`, run `initial`, then in its project
`sandbox` run `sandbox`. No existing target is reused across policy variants.

For `deny-data`, the data probe must fail with a permission error, the managed
probe must succeed, and the routed build must fail with a permission boundary.
For `deny-managed`, reverse the data/managed probe expectations. In both, the
excluded sibling must remain unwritable, and **no routed project-local `target`
may appear**. The runner requires functioning Cargo/rustc version queries before
using any build failure as sandbox evidence. Missing tools, timeouts, arbitrary
errors and broad permissions cannot pass this control.

Do not click an escalation/retry action that grants additional filesystem access.
If App policy makes either omitted directory implicitly writable, record FAIL or
BLOCKED with the effective policy; do not simulate denial using chmod. The
fixture's harmless uniquely named probe files remain only inside its own roots.

## Evidence review, limits and teardown

Run `verify LAB` from the operator's terminal after each lane. Missing observations
are **BLOCKED**, not skipped/passed. Verify also requires different managed targets
for `a`, `b` and the second worktree, and the same `a` target for nested cwd and
resume. It reports mechanical results separately and **always** keeps
`appAcceptance: NOT_ESTABLISHED` pending independent host review. An environment
label or CLI transcript cannot turn that field into App acceptance.

Before recording acceptance, a human reviewer must associate every observation
with the actual App shell transcript and versioned bundle, confirm dedicated
account/VM isolation, initial launch, same-thread cwd transitions, full restart
and actual resume, and confirm non-escalated sandbox enforcement for all three
lanes. Record the source/fixture commit, clean/dirty status, bundle version/build
and hash, anonymised machine, exact launch and tool invocations, evidence paths
and hashes, per-case PASS/FAIL/BLOCKED, reason, reviewer and UTC timestamp. Keep
failure evidence; do not silently overwrite a row with a retry. New attempts use
new directories. Raw logs can contain local paths: review/redact before sharing,
and never include auth.json, cookies, keychain data or whole App configuration.

Commands have a 120 s direct-child timeout and 2 MiB captured-output limit (30 s
setup, 10 s metadata/version queries). Failure/timeout makes the observation fail;
process-tree quiescence is not guaranteed by `spawnSync`. Keep the disposable VM
and evidence until any surviving compiler processes are stopped there. Inventories
refuse symlinks, non-regular files, more than 10,000 entries or 256 MiB to hash;
exceeding a bound is an error, not a complete scan. The fixture is not an adversarial
same-user filesystem sandbox, a cryptographic transcript attestation, or a
billed-token-neutrality test. It does not automate UI interaction.

After evidence review, close the disposable App and discard its dedicated VM or
account using normal administrative controls. Alternatively remove only the exact
reviewed lab directories after checking process termination. No product uninstall,
prune, contributor-home cleanup or changes to the integration implementation are
part of this protocol.
