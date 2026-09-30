# Native Windows contract gate

The `Windows contracts` workflow runs on native GitHub-hosted Windows with Node
20.12.0 (the exact declared minimum), 22 and 24. It provisions Go explicitly and requires real npm and Go cache-query
probes; missing tools fail those tests rather than silently reducing coverage.
Ubuntu/macOS CI retains its full suite, required artifact smoke coverage and
preceding-release package-upgrade checks, and also selects the exact Node minimum.

This is a **scoped contract gate**, not a claim that every legacy Unix-oriented
fixture, every agent integration or the entire Windows product lifecycle is
certified. It runs:

- Dedicated native tests for paths with spaces/ampersands, generated `.cmd`
  launchers, runtime removal preserving unrelated files, setup/update/uninstall,
  CRLF configuration preservation, explicit cache overrides and skip, apply-time
  lease/pin protection, and ordinary process-tree cleanup after a probe timeout.
- The existing native batch argv contract, including shell metacharacters.
- Generated managed launchers in literal percent/bang paths, including a parent
  with delayed expansion enabled; quoted semicolon-containing PATH entries
  through lookup, runtime prepend, skip removal, and durable configuration.
- Platform-specific environment casing, workspace identity, configuration
  precedence, junction containment, and apply-time registry replacement during
  pruning, using the portable ownership suites on the native filesystem.
- Portable storage measurement, status, read-only inspection, bounded leases and
  probe contracts. POSIX-only tests explicitly skip; optional uv runs if present.
- Installed tarball exports and fresh setup/uninstall, exact child argv/cwd through
  an installed managed shim, and genuine preceding-release upgrade verification.
  The separate synthetic package fixture rejects missing and broken shims.

All fixture homes, roots, state and integration files are temporary. No live
agent, account, registry publication, real user configuration or managed data is
used. Workflow permissions are read-only. POSIX executable/mode checks remain enabled on Unix, but are not applied to
Windows ACL-derived stat modes. Regular-file, content, syntax and generated-bundle
checks still run on all platforms; the native job exercises actual .cmd launchers.
Independent test steps still run after a prior test failure to expose additional
failures without making the workflow successful.

The [30 September native lab record](verification.md#30-september-native-lab-record)
documents a completed local Windows 11 ARM64 / Node 20.12.0 run of the 27 selected
files, the named runtime/PATH subsets, and the genuine package-upgrade gate.
That small VM ran the combined selected-file gate serially; its passing result
does not establish execution of the configured GitHub x64 or Node 22/24 jobs.

The test suite deliberately retains
unknown/partial states rather than weakening path or ownership checks to obtain a
passing result.

Run the dedicated tests locally on Windows:

```powershell
node --test test/windows-contract.test.js
node --test --test-name-pattern="Windows" test/runtime-regressions.test.js
node --test test/measurement.test.js test/status.test.js test/inspection.test.js test/bounded-leases.test.js test/probe.test.js test/probe-process.test.js
node --test test/platform-precedence.test.js test/config-precedence.test.js test/workspace.test.js test/prune.test.js test/routing-environment.test.js
node --test test/package-verification.test.js
npm run test:package
```

The dedicated file skips off Windows. A Linux run of that file is syntax/discovery
coverage only, not native acceptance. Consult the exact workflow run and commit
before treating a result as current evidence. Long paths, UNC/network shares,
non-administrator installation, external-volume loss, filesystem races and live
agent session/resume behavior remain separate acceptance work. This workflow
runs the existing preceding-release upgrade gate with full tag history. Configured
coverage is not evidence that this revision passed a native workflow. Real Windows
Cargo/Go/npm artifact smoke remains separate work: its verification-timeout runner
needs a native descendant-cleanup contract before that gate is expanded. See
[platform support](platform-support.md).
