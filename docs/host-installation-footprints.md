# Host installer and updater footprints

Agent launch routing, an agent's own updater and its installer have separate
lifecycles. A successful launch or version check does not establish where an
installer writes binaries, backups, credentials, session data or native caches.
`scripts/verify-host-boundaries.mjs` provides opt-in, phase-controlled observation
without editing existing agent homes or deleting any output.

## Plan, prepare and preflight

`plan` is read-only. `prepare` allocates a disposable lab beneath the selected,
existing canonical scratch directory. Its native HOME, XDG/AppData homes, agent
configuration, supported tool caches and temporary files stay within that lab.
The child environment excludes inherited credentials and shell injection while
retaining installed executable/SDK/toolchain choices. Host updates are disabled
for metadata preflight. Existing installed executable aliases are allowed;
disposable output/config aliases are refused.

```sh
clean-development run --session session-only -- \
  node scripts/verify-host-boundaries.mjs plan \
  --host codex --scratch-root "$CLEAN_DEVELOPMENT_SCRATCH_ROOT"

clean-development run --session session-only -- \
  node scripts/verify-host-boundaries.mjs prepare \
  --host codex --scratch-root "$CLEAN_DEVELOPMENT_SCRATCH_ROOT"
```

Copy the returned exact root to `LAB`, then select an already installed executable:

```sh
clean-development run --session session-only -- \
  node scripts/verify-host-boundaries.mjs preflight \
  --lab "$LAB" --executable /absolute/installed/codex
```

Preflight executes `--version` and `--help` only. It records an exact bounded
version, machine/source fingerprint, result status, observed help capabilities and
before/after aggregate metadata for explicitly selected roots. It records no raw
help/output, credential data or authentication state. It never starts a model.
Failed commands, source drift or incomplete observations cannot pass.

## Explicit installer/update execution

Prepare a separate lab for the owning install/update workflow. Review that exact
host's destination controls and choose an existing installer executable. Pass its
actual argv after `--`; the helper neither rewrites arguments nor adds an inferred
destination flag. Do not use remote pipe-to-shell installation as a substitute for
a reviewed executable. Supply destination arguments naming the prepared lab's
`outputs/` directory and declare its expected artifact.

```sh
clean-development run --session session-only -- \
  node scripts/verify-host-boundaries.mjs execute \
  --lab "$LAB" --operation install --executable /absolute/reviewed/installer \
  --expect-artifact outputs/bin/tool -- \
  ACTUAL_INSTALLER_DESTINATION_ARGUMENTS
```

Use `--operation update` for the owning update entrypoint. An install requires the
declared artifact to be absent before execution; an old binary plus a successful
no-op command cannot pass an install. Update reports include before/after artifact
metadata and `artifactFreshness: created|metadata-changed|unchanged|missing-or-unsafe`.
An unchanged update artifact is labelled `no-op-boundary-observed`, without a claim
that the updater changed or validated its product. Artifacts must be nonempty
regular files beneath `outputs/`; aliases and unavailable output paths fail.

Allowed growth defaults to selected config/data/cache/state/tmp/output roots. New
native HOME entries fail the boundary check unless HOME was explicitly reviewed
with `--allow-growth home,...`. Every observed delta remains visible. This lets a
fixed native host path receive a narrow compatibility decision; it does not turn
that path into managed disposable cache. The helper always retains binaries,
backups, durable state and reports, including failed-run evidence. There is no
automatic deletion, relocation, adoption or prune invocation.

Each executed child has a bounded output/time limit. Reports retain child status,
signal and sanitized error code, source identity, selected-root existence/count/
logical-byte deltas, completeness and declared artifact metadata. Arbitrary argv,
command bodies and child stdout/stderr are not recorded. Incomplete before scans
refuse execution; failed/timed-out children and partial after scans cannot pass.
On POSIX, each child has a dedicated process group. An exit-zero parent with a
still-active or uncertain process group fails before its footprint is reported as
accepted; those descendants are retained rather than silently terminated. Failure
cleanup targets only that newly created group. Windows does not have this POSIX
group observation and reports that boundary explicitly. Processes that deliberately
leave the group remain outside this observation protocol.
An observation covers selected roots and a bounded period. It is not an OS
sandbox, an atomic whole-disk audit or proof that background updater activity has
finished. Finish the owning lifecycle before taking its acceptance observation.

## Evidence classification and remaining host work

The automated negative fixtures prove detection of a default HOME binary backup,
preservation of declared backups/state, command failure/timeout, stale install
artifacts, unsafe aliases and incomplete observation. They are fixture evidence.
Installed Codex/Claude version/help checks are metadata evidence. The tool reports
`installer-boundary-only` for explicit installer execution, never model/lifecycle
acceptance.

| Observed footprint from the machine audit | Owning verification still required |
| --- | --- |
| Antigravity staging, installed executable and `.old` backup | Reviewed install/update entrypoint, actual destination controls and backup lifecycle |
| Gemini home state | Fresh isolated native-profile and installer/update behavior |
| AWS session cache | The particular cache-writing command and its effective native configuration |
| Secondary Claude/OpenCode homes | Explicitly owned durable history/config/credential inventory before any relocation |

Do not infer creating commands from returned filenames or from earlier relocation
records. Installed binaries and durable agent state remain externally owned.
This implementation provides the executable observation protocol; it has not run
an Antigravity/Gemini/AWS install/update or relocated those homes. Existing active
Claude Code/desktop sessions and their settings remain untouched. Cleanup remains
a separately reviewed owning-tool operation.
