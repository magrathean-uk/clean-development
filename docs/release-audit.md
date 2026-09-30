# Source-to-npm release audit

Run this protocol from a reviewed, committed checkout. It creates two independent
local Git clones, packs each through the ordinary `prepack` hook, reads the gzip
and tar bytes independently of npm's reported file list, and tests the resulting
artifact. It never publishes a package or changes CI. The existing package gate
remains separate and unchanged.

## Reproduce

Use a trusted POSIX host with Git, Node and its standard npm CLI. Record the exact
versions; a match on one toolchain does not certify all npm, zlib or OS versions.
Obtain the real preceding-release tag required by `scripts/verify-package.mjs`.
Do not create a replacement tag or relabel current source as the preceding release.
Run the audit through the required Clean Development session wrapper when the
repository's policy requires it. npm discovery skips generated managed shims using
the shared executable resolver; the selected real executable must still resolve
to the standard `npm-cli.js`. No PATH or tool-home override is needed for this.

```sh
git clone https://github.com/magrathean-uk/clean-development.git clean-development
cd clean-development
git fetch origin --tags
git switch --detach <reviewed-commit-sha>
node --version
npm --version
git status --porcelain=v1 --untracked-files=all
npm ci --ignore-scripts
node --test test/release-audit.test.js
npm run check
npm test
npm run test:package
node scripts/audit-release.mjs --output ../release-evidence
(cd ../release-evidence && sha256sum -c SHA256SUMS)
cmp ../release-evidence/a/*.tgz ../release-evidence/b/*.tgz
tar -tzf ../release-evidence/a/*.tgz
```

On macOS use `shasum -a 256 -c SHA256SUMS` instead of `sha256sum`.
The output directory must not exist, its parent must exist, and it must be outside
the checkout. Uncommitted/untracked source changes stop the audit. `--ref <commit>`
selects another locally available source commit; the report separately identifies
the auditor's commit and script hashes. The auditor itself must be reviewed too.
Use a full clone or fetch the genuine missing history for a shallow checkout.

Exit status 0 means the complete protocol passed. Status 2 means the two-build
and exact-artifact installation checks passed but the existing package gate was
blocked by a missing preceding tag. Status 1 means failure; evidence and the new
disposable lab are retained for inspection. Successful/blocked complete runs remove
only their own temporary lab, retaining the evidence directory. No source, real
home, installed user runtime or managed build root is used as a deletion fixture.

## Inputs and reproducibility boundary

The two clones contain the same Git commit and bytes, with no shared object store.
The driver checks every materialised file against its Git blob, uses the executable
bit recorded by Git, and varies checkout names, mtimes (2000 versus 2025), checkout
creation umasks (022 versus 077), time zones (UTC versus Pacific/Honolulu), homes, npm caches and
configuration paths. Prepack and lifecycle commands use a fixed umask of 022. Both ordinary `npm pack` calls execute `npm run check` and
`npm test` through the repository's existing `prepack` script. Neither release
build uses `--ignore-scripts`. The focused tests use that option only when packing
small synthetic parser/policy fixtures; those fixtures are not release evidence.

Child environments retain only executable lookup/platform essentials and explicitly
created disposable locations. Ambient credentials, proxy settings, Node injection,
routing and npm/Git overrides are not forwarded. Empty, separate npm/Git user and
global configurations are used; npm runs offline. Synthetic credential/configuration
canaries are placed outside each checkout in disposable SSH, AWS, Codex and Claude
locations. Actual package payloads and expanded tar metadata are scanned for them,
source/lab/home paths and defined credential/private-path patterns. Reported findings
contain paths and rule IDs, never the matched credential value.

At baseline `af12577c6596095fdf91f18e840e9433521ea3d2`, two controlled packs on Linux
x64, Node 22.16.0 and npm 10.9.2 were already byte-identical: 96 files, 141407 bytes,
SHA-256 `f20c21efcfb131f76849830478da645d3217da442d1857201b1f3d623f353599`.
That preliminary comparison disabled lifecycle scripts; the full protocol above
also executes both prepack gates. All 96 payloads matched tracked source bytes;
120 other tracked files were excluded. These are baseline values, not hashes or
counts for a later candidate containing this document.

An exploratory full prepack under umask 077 failed an existing CLI test: its
fixture requested mode 0640 at file creation (therefore obtained 0600) but asserted
0640 after setup. The product correctly preserved the actual 0600. Rather than
changing unrelated integration tests or suppressing assertions, this protocol
fixes the release-command umask at 022 and records it. Only the small new audit
fixtures explicitly set their intended Git input mode. The preliminary raw-pack
comparison did vary the pack-process umask; a full prepack pass under 077 is not
claimed.

No clean-build nondeterminism was demonstrated, so no custom tar repacker or
metadata rewrite is introduced. There was a reproducible ambient-input hazard:
plain npm pack included an untracked `.opencode/opencode.json` under the broad
files allowlist; a nested `.npmignore` could silently omit committed runtime code.
The driver removes those inputs by building clean committed source. The independent
membership audit rejects either outcome rather than trusting npm's own inventory.
A deliberately tracked host configuration is rejected too. This is an explicit
release protocol, not a replacement for every direct `npm pack` or `npm publish`
invocation; maintainers must use and review it before publication.

## Evidence and independent checks

All hashes and reports stay outside the hashed packages. Paths in reports are
relative; command logs replace the disposable lab and checkout prefixes.

| File | Evidence |
| --- | --- |
| `report.json` | Source commit/tree, auditor identity, exact Node/npm/zlib versions and executable/script hashes, varied inputs, outcomes and limits |
| `a/`, `b/` | Actual tarballs, prepack logs and sorted independent inventories |
| `source-inventory.json` | Every tracked path, Git mode/blob ID, byte count and SHA-256 |
| `source-to-package.json` | Each tar member mapped to its tracked source, both hashes and inclusion rule; no byte transformation accepted |
| `excluded-files.json` | Every unshipped tracked file, its hash and exclusion explanation |
| `versions.json` | Registry and published/source version results; both lock versions and bug prompt also checked |
| `privacy.json` | Rules, canary coverage, environment boundary, findings and explicit scan limits |
| `install.log`, `npm-uninstall.log` | Installation/removal of the exact hashed artifact in a disposable prefix |
| `package-lifecycle.log` | Unmodified `npm run test:package` result, including any missing-tag failure |
| `SHA256SUMS` | Compressed SHA-256 for both tarballs |

Inventories use bytewise UTF-8 path ordering, not locale sorting. The reader verifies
gzip framing/CRC, one member only, tar checksums, bounded sizes, safe paths and
unambiguous regular-file entries. It rejects symlinks/hardlinks, devices, directory
entries, global/unknown PAX metadata, duplicate/case-colliding paths and trailing
payloads. Only reviewed local PAX path/size/time records are accepted. File modes
must match Git; uid/gid and owner/group names cannot contain host identity. Expanded
tar hashes and entry timestamps are recorded, in addition to compressed hashes.

Expected membership is derived from tracked source and this repository's explicit
literal `package.json.files` entries, plus mandatory package/document files. Every
member must be byte-identical to its recorded source; every tracked file is either
mapped or explicitly excluded. New glob rules, dependencies, workspaces or archive
formats fail until their packaging policy is reviewed. Forbidden development,
credential, local-host configuration and archive/log paths cannot be published just
because a broad directory rule includes them. Versions in `.version-bump.json`,
each referenced source/published manifest, both root lock values and the bug-report
placeholder must agree. No version bump or npm metadata reformat is performed.

For an independent implementation, use standard `tar`/Python `tarfile` to enumerate
members, SHA-256 their data, and compare them with `git show <commit>:<source-path>`
and `source-to-package.json`. A clean extraction is not required by this auditor;
it never extracts an untrusted tarball. Matching payloads alone are weaker than the
required whole-archive comparison: headers, ordering and compression count too.

## Installation and preceding-release upgrade

The driver installs the exact A tarball, without disabling install scripts, into a
fresh prefix using a fresh environment. It verifies that npm installation itself
creates no product configuration/data/storage, checks executable and API exports,
performs explicit Codex setup, executes the managed CLI and inspects status. It
then uninstalls, requiring unchanged unrelated Codex text and a managed artifact,
no retained runtime files or launcher, and successful npm package removal. No live
agent or compiler acceptance is claimed.

The existing `npm run test:package` then exercises fresh session modes, retained
project configuration and setup/status/uninstall, plus a genuine tagged-source
preceding-version install and update. Its tag, resolved commit, command and result
are recorded. It packs the preceding tag locally; this is not a comparison with the
previous public npm registry tarball. Missing history is a blocked upgrade check,
not a pass. A separate CI run with real history may supply additional evidence only
when its exact commit and successful package-gate log are recorded; it does not
retroactively change a locally blocked report.

## Limits

This is a bounded, source-aware audit, not a signed provenance statement, universal
secret detector or hostile-build sandbox. Unknown/encoded credentials may escape
pattern detection. Tools and reviewed prepack code can access resources outside
HOME; use a disposable account/VM for untrusted source. Toolchain binaries and npm's
transitive implementation are trusted; hashes make selected inputs inspectable,
not automatically trustworthy. Offline npm prevents registry fallback but is not
OS network isolation. Timeouts bound immediate commands, not arbitrary escaped
subprocesses. Native Windows release reproduction is explicitly unsupported by
this POSIX driver. Cross-version, cross-platform and live-host claims require their
own executed evidence. No CI automation, runtime behaviour, package version, legal
material, public release or automatic publication is changed by this protocol.
