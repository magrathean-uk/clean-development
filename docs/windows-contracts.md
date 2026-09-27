# Native Windows contract gate

The `Windows contracts` workflow runs on native GitHub-hosted Windows with Node
22 and 24. It provisions Go explicitly and requires real npm and Go cache-query
probes; missing tools fail those tests rather than silently reducing coverage.
Existing Ubuntu/macOS CI and its full suite, required artifact smoke coverage and
preceding-release package-upgrade checks remain unchanged.

This is a **scoped contract gate**, not a claim that every legacy Unix-oriented
fixture, every agent integration or the entire Windows product lifecycle is
certified. It runs:

- Dedicated native tests for paths with spaces/ampersands, generated `.cmd`
  launchers, runtime removal preserving unrelated files, setup/update/uninstall,
  CRLF configuration preservation, explicit cache overrides and skip, apply-time
  lease/pin protection, and ordinary process-tree cleanup after a probe timeout.
- The existing native batch argv contract, including shell metacharacters.
- Portable storage measurement, status, read-only inspection, bounded leases and
  probe contracts. POSIX-only tests explicitly skip; optional uv runs if present.

All fixture homes, roots, state and integration files are temporary. No live
agent, account, registry publication, real user configuration or managed data is
used. Workflow permissions are read-only. The test suite deliberately retains
unknown/partial states rather than weakening path or ownership checks to obtain a
passing result.

Run the dedicated tests locally on Windows:

```powershell
node --test test/windows-contract.test.js
node --test --test-name-pattern="Windows batch" test/runtime-regressions.test.js
node --test test/measurement.test.js test/status.test.js test/inspection.test.js test/bounded-leases.test.js test/probe.test.js test/probe-process.test.js
```

The dedicated file skips off Windows. A Linux run of that file is syntax/discovery
coverage only, not native acceptance. Consult the exact workflow run and commit
before treating a result as current evidence. Long paths, UNC/network shares,
non-administrator installation, external-volume loss, filesystem races and live
agent session/resume behavior remain separate acceptance work. This workflow does
not run the existing preceding-release upgrade gate on Windows.
