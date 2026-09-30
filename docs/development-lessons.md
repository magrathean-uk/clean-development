# Development-history lessons

This review, dated 30 September 2026, uses prior development conversations to
prioritize product and skill work. Private transcripts, account details, machine
paths, and historical approvals are not bundled with the package or consumed by
the runtime. Historical messages describe what was observed or reported then;
they do not establish current machine state or authorize new changes.

The reviewed archive had a small command-history index and separate full session
rollouts. The index omitted newer turns and some original rollouts were absent.
Repeated delegated transcripts were treated as copies rather than independent
incidents. Reported diagnoses and outcomes were distinguished from recovered
command output. This is a targeted review, not a complete incident census.

## What the history changes about development practice

| Observed problem | Existing contract | Improvement |
| --- | --- | --- |
| Managed routing was healthy while native test output and verification copies accumulated elsewhere | Registered Cargo builds and configured caches are a bounded inventory, not filesystem isolation | Review the task's exact generated paths; reuse stable build roots; make retained Xcode results visible without granting deletion authority |
| Repeated simulator creation consumed storage during ordinary app iteration | A fresh simulator is an explicit one-run lifecycle, separate from normal rebuilding | Reuse a caller-selected available device for ordinary launches; retain failed-run evidence and preserve unrelated activity |
| An incompatible Python or shell was selected, or a package-manager version disagreed with its lockfile | Executable resolution and cache routing preserve caller choices; they do not manage language/toolchain compatibility | Diagnose the selected executable/version and project requirement separately from its cache path; do not silently install, switch global PATH, or bypass routing |
| A root-level command missed configuration kept in a nested package | Discovery follows bounded ancestors and the command's supported target selectors | Inspect the exact command from its actual cwd; do not infer child-package configuration from the repository name |
| A copied VM disk inflated allocated storage, and moved bytes differed from immediate free space | VMs, labs, and final products are externally owned | Preserve sparse layout where required; verify data and the owning runtime before retiring originals; report logical, allocated, and free-space observations separately |
| Repeated approval questions ignored a current multi-project task's stated consent scope | Persistence creates only a reviewed absent project file; children inherit session-only | Review each plan and respect explicit current task scope without repeating the same question; never revive historical approval |
| A diagnostic attributed a parent identity failure to a child path; ordinary process tests missed a native lifecycle race | Uncertain identity and process cleanup must fail conservatively | Preserve error provenance, stop at the failed boundary, and require native lifecycle evidence for the named host |

The [management skill](../skills/clean-development/SKILL.md) now states these
ordinary-development practices. It distinguishes Xcode preferences, simulator
reuse, isolated runs, SwiftPM retained products, remote command boundaries, and
the installed runtime from a source checkout.

## Product change from this review

`xcode status` now identifies the retained test-results root as
`testResults: { path, retention: "retained", prunable: false }`. Optional
`--sizes` adds its observation under `sizes.testResults`, using the existing
bounded metadata scanner. It never creates missing results storage. Xcode prune
does not list or remove result bundles.

This closes one visibility gap; it does not discover arbitrary test databases,
verification copies, native output overrides, or VM state. See [Xcode
management](xcode.md), [status measurement](status.md), and [the safety
model](safety-model.md).

## Priorities before broader cleanup

1. Address the documented [storage fault cases](../test/fault-lab/FINDINGS.md):
   disappearance/replacement of a build base and cleanup masking the original
   publication failure. Another existence check is insufficient evidence that
   physical ownership remains stable across publication.
2. Keep exact-command diagnostics useful: selected executable, actual cwd,
   effective configuration, explicit overrides, predicted destinations, and the
   installed runtime receipt. A preview is not tool-version or artifact-placement
   acceptance.
3. If a broader footprint report is added, require explicit caller-selected
   roots, a shared bounded scan, and retained/externally-owned labels. Do not
   recursively scan source, capture commands, or turn visibility into ownership.
4. Prefer incremental reuse and caller-owned fixture lifetimes over more copies
   or automatic expiry. Preserve release products, recovery baselines, and
   diagnostic evidence until their owning workflow retires them.
5. Continue named-host checks for resume, fork, nested commands, cancellation,
   disabled projects, external-volume failure, and native Windows execution.
   Mocked package/fixture checks do not prove live host acceptance or billed-token
   neutrality.

Some historical bugs are already fixed in the reviewed source: measurement
parent-error attribution, late probe termination after child close, and native
Windows executable-path escaping. These are acceptance principles to retain,
not reasons to add duplicate implementations or weaken their tests.

## Validation boundary

The source change is tested with fake Xcode tools and disposable storage. Tests
verify the results-root label, exact known bytes, default no traversal, missing
root preservation, and retained results surviving actual fixture DerivedData
pruning. No real Xcode preference, simulator, VM, or archived conversation is
modified by this review. Release evidence still needs the exact revision, host
version, and check boundary described in [verification](verification.md).
