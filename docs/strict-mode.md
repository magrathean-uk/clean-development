# Experimental Linux strict mode

`strict` is an explicitly selected filesystem boundary for **one command**, not
another spelling of `run`, a saved session choice, or an agent integration.
Normal routing is unchanged and is still not a sandbox. Strict mode does not
read normal project/user configuration, create runtime shims, acquire pruning
receipts, or expose normal managed state to the workload.

```sh
clean-development strict --experimental --policy /absolute/strict-policy.json \
  --dry-run -- gcc main.c -o /absolute/empty-release-dir/program

clean-development strict --experimental --policy /absolute/strict-policy.json \
  -- gcc main.c -o /absolute/empty-release-dir/program
```

Every execution needs `--experimental`, an explicitly named policy and the
`--` command separator. An environment variable, project file, previous setup,
`persist` or an agent decision cannot enable it. Dry-run validates and prints the
mount contract without creating directories, running tools or establishing that
the kernel permits isolation. It omits command bodies and environment values.

## Version 1 policy and ownership

Prepare dedicated directories yourself, outside the source checkout and normal
prunable Cargo builds. Strict mode never installs prerequisites or creates a
missing configured base. Paths must be existing, absolute, normalised, canonical
real directories; aliases and overlapping grants are rejected.

```json
{
  "version": 1,
  "sources": ["/home/test/projects/example"],
  "managed": "/home/test/strict-storage",
  "toolchains": [],
  "artifacts": ["/home/test/releases/attempt-001"],
  "env": {
    "PATH": "/usr/local/go/bin:/usr/bin:/bin",
    "GOROOT": "/usr/local/go",
    "GOTOOLCHAIN": "local",
    "GOPROXY": "off",
    "CGO_ENABLED": "0"
  }
}
```

Run from a cwd inside one declared source root. The example's Go settings are
optional configuration for an independently installed Go toolchain, not an
installation instruction. Use `gcc` directly on Debian: the `cc` alternative can
point into `/etc/alternatives`, which is deliberately not exposed.

| Class | Authority and lifetime |
| --- | --- |
| `sources` | Read-only bind mounts at their existing absolute paths, including Git metadata. No source file creation, mutation, chmod, unlink or rename. Contents, including secrets deliberately placed here, are readable. Between 1 and 32 roots. |
| `managed` | Parent of a new private `strict-*/work` for each invocation. Only that fresh work directory is writable/visible, not sibling runs, normal caches or ownership state. Existing base required. No reuse, receipt adoption or automatic pruning. |
| `toolchains` | Optional additional read-only directories, for example a dedicated SDK below `/opt` or a specific Rust toolchain below the test account's home. Between 0 and 32 roots. The system `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64` are already read-only grants; do not redeclare them. |
| `artifacts` | Optional existing **empty, dedicated** directories, writable at their original paths. Final output flags must name these destinations. They are outside managed/source/toolchain grants and are never registered for prune. Reusing a non-empty destination fails before execution. Between 0 and 32 roots. |
| Other host paths | Not mounted. The synthetic root and its parent-directory scaffolding are read-only. `/tmp` resolves to this run's managed scratch, not host `/tmp`. Only four device files (`null`, `zero`, `random`, `urandom`) are exposed. |

Writable roots must belong to the executing user and not be group/world-writable.
Broad/system roots, overlapping roots and nested mounts below explicit roots are
rejected. Source metadata traversal rejects sockets, devices and FIFOs, does not
follow symlinks, and stops at 100,000 entries. Symlinks can resolve only into the
sandbox's existing grants. An ownership-marker file at any writable root's
ancestor is rejected conservatively, including malformed markers. This is a guard
against placing finals under an already prunable tree, **not** a persistent promise
that the user will never later register an ancestor for deletion.

Artifact directories are grants, not an export service. Commands write final
bytes there directly; a failed build can leave partial output. There is no copying,
moving, atomic publication, inferred final-artifact classification, overwrite
recovery or deletion. A valuable binary left in managed scratch remains scratch;
put final deliverables in the explicitly declared artifact directory.

## Environment and tool behaviour

Ambient environment and credentials are not inherited by the sandbox bootstrap or
workload. Strict mode creates a fresh HOME, TMPDIR and XDG directories below work,
and defaults `CARGO_HOME`, `CARGO_TARGET_DIR`, `GOCACHE`, `GOMODCACHE`, `GOPATH` and
`npm_config_cache` below the same run. `CLEAN_DEVELOPMENT_STRICT_WORK` names that
writable directory for explicit shell commands. Other adapters are not inferred.

`env` supplies explicit string overrides. These never grant filesystem access:
an override or an output flag outside the mounts fails rather than being silently
rewritten. Environment values travel over a private control descriptor, not as
host command-line assignments, and are applied only after isolation/capability
dropping. The control and readiness descriptors close before the actual command.
The command receives inherited descriptors 0/1/2 without byte transformation.

`CLEAN_DEVELOPMENT_STRICT_WORK`, shell identity/readonly keys (`UID`, `EUID`, `PPID`,
`BASHOPTS`, `BASH_VERSINFO`, `SHELLOPTS`) and shell cwd/bookkeeping keys (`PWD`,
`OLDPWD`, `SHLVL`, `_`) cannot be overridden. No ambient PATH, agent session mode,
cache variables, preload options or credentials are copied. Explicitly supplying
a secret in `env`, in argv or over stdin is a deliberate grant to the workload;
this is not a secret-management service.

Unlike normal dynamic Cargo routing, these are **per-invocation static defaults**.
Multiple workspaces within one invocation need explicit separate output paths
inside work where the tool requires them. A package manager that insists on
writing `node_modules`, a lockfile or generated source into the checkout will
fail; strict mode does not secretly copy the checkout or make it writable.
Dependencies must already be available through reviewed read-only grants or
provided inputs. There is no network namespace route to the host/network.

## Isolation implementation and fail-closed behaviour

The backend uses installed util-linux/GNU tools and Tini, not a bundled or
automatically installed bubblewrap binary. The launcher requires an ordinary
non-root Linux user with matching real/effective UID, root-owned protected system
utilities at the exact paths in `src/strict.js`, and kernel permission for
unprivileged user/mount/PID/network/IPC/UTS namespaces. A missing utility,
unsupported option, namespace denial, mount failure, policy error, or capability
failure stops execution. There is no fallback to `run`, `skip`, chmod simulation,
a writable checkout or the host filesystem.

The trusted bootstrap establishes private mount propagation and a fresh tmpfs
root, makes non-recursive bind mounts, remounts the protected grants read-only,
then chroots. It drops all capability bounding, inheritable and ambient sets
before exec, and sets `no_new_privs`. The executed command's effective/permitted/
inheritable sets were independently checked as zero in the live fixture. The
workload sees mapped UID 0 **inside its user namespace**, not host root.

**No procfs, sysfs, whole host home, `/etc`, `/run` or host device tree is
automatically exposed.** `/proc` is empty even on machines that permit mounting a fresh procfs;
this is a fixed policy, not a weaker fallback. `/dev/fd`-style symlinks consequently
cannot provide proc-backed descriptor reopening. Tools requiring procfs, NSS,
`/etc/alternatives`, certificates, system configuration or `/proc/self/exe` may
fail. For example, the tested Go needs an explicit `GOROOT`; the live build first
disables Go's telemetry in its disposable HOME. These are compatibility limits,
not reasons to mount host `/proc` or the whole home.

The tmpfs root has a 64 MiB skeleton limit. Writable storage and process resource
use have **no quota**. Mount namespace teardown discards only the in-memory
skeleton. All host-side run directories, scratch and final outputs are retained,
including on failure. The implementation contains no cleanup or deletion path.

## Command and process contract

The original command array is passed as separate arguments, never joined/eval'd.
A fixed privileged-mode Bash bootstrap performs cwd/env setup and `exec -- "$@"`;
startup files and imported shell functions cannot run in that bootstrap. An
executable name containing `=` remains a command, not an `env` assignment.

Tini is PID 1, reaps children and forwards to the workload's process group. The
outer namespace waiter ignores the explicitly relayed signals; Tini resets their
dispositions inside isolation. The CLI forwards HUP, INT, QUIT, TERM, USR1, USR2,
ALRM, PIPE and WINCH without broadcasting into the caller's process group.
Cancellation before the trusted handoff aborts the incomplete namespace and
returns `128 + signal`; it does not start a later workload. The readiness handoff
is not an application-specific guarantee that a custom handler is already set.

Command exit codes are returned unchanged. A terminating signal uses the CLI's
conventional `128 + signal` representation, not a claim that the outer Node
process itself died from that signal. Catchable signal handlers may choose their
own status. Parent-death signalling plus an expected-parent check closes the
launcher-before-parent-death-registration window; killing the namespace init also
kills descendants that created a separate session/process group. A detached child
can avoid an ordinary group-directed TERM, but cannot outlive destruction of its
PID namespace. There is no automatic timeout or TERM-to-KILL escalation during a
normal running command.

This is a non-interactive build boundary. No controlling terminal is acquired;
PTY/session/job-control transparency, STOP/CONT forwarding, real-time signals,
extra inherited descriptors and long-running daemons are outside this experiment.
Do not use it as an interactive desktop/agent sandbox.

## Exact threat model and limitations

Assume the launcher, kernel and system isolation utilities are trusted, the user
reviews the explicit mount policy, and no outside process concurrently substitutes
host paths. Within that boundary, project scripts, compilers and their nested
processes may deliberately attempt filesystem writes: the kernel's read-only
mounts and absent host paths, not tool cooperation, enforce the host-write limit.
Fresh writable grants avoid pre-existing hardlink/socket aliases to protected
files. Tests also cover symlink and hardlink attempts, direct remount/chroot
attempts, credential reads and host-loopback access.

This is **not a VM, a kernel exploit defence, a hostile multi-user race-proof
mount broker or a complete syscall sandbox**. No production seccomp policy,
cgroup/resource quota, disk quota, CPU/memory/network-service accounting, encrypted
storage or concurrent-path pinning is supplied. Validation and mounting are
separate operations. Host root or a hostile same-user process outside isolation
can change/read the underlying files and interfere with the launcher. Writable
results and caches remain untrusted bytes after the command; do not execute or
publish them without the review appropriate to their origin.

The whole standard toolchain trees are readable. Secrets or live filesystem Unix
sockets placed there, or in an additional toolchain grant, are **not protected** by
read-only mounting: connecting to a mounted socket can invoke a host service.
Use clean toolchain trees. Source roots explicitly containing sockets are refused.
Kernel interfaces reachable through retained stdin/stdout/stderr are deliberate
caller capabilities; redirecting those descriptors to a valuable file or socket
can authorise writes outside the directory grants. The caller must choose them
accordingly. Denial tests do not establish protection against every filesystem,
kernel version, mount race, FUSE/network filesystem or exploit technique.

## Verification, operation and recovery

```sh
node --test test/strict.test.js
# Separately, in a disposable ordinary Linux account with prerequisites installed:
CLEAN_DEVELOPMENT_STRICT_TEST=1 node --test test/strict-linux.test.js
npm run check
npm test
```

The opt-in real fixture requires installed gcc, Go and Python as test tools. It
fails, rather than skips, when explicitly requested prerequisites/permissions are
unavailable. It uses real builds and syscalls, not mocked sandbox success. The
normal suite skips that expensive/environment-dependent acceptance entry.
Evidence and fixtures are retained at the printed private temporary path.
See [the dated evidence](strict-mode-evidence.md) for actual versions and results.

On failure inspect the original error and retained run. Repair permissions or
provide a supported isolated host; never retry unsandboxed automatically. Run from
a new empty artifact destination. Reverting the code removes the command without
changing normal setup/routing; it does not delete any retained storage or finals.

Implementation references: upstream [unshare](https://man7.org/linux/man-pages/man1/unshare.1.html),
[setpriv](https://man7.org/linux/man-pages/man1/setpriv.1.html),
[mount namespaces](https://man7.org/linux/man-pages/man7/mount_namespaces.7.html),
[GNU env signal handling](https://www.gnu.org/software/coreutils/manual/html_node/env-invocation.html),
and [Tini](https://github.com/krallin/tini). The executed util-linux version is 2.41;
newer documentation's `--forward-signals` option is not assumed or used.
