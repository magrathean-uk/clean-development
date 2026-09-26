# Releasing

Before validating a release, run `node scripts/build-marketplace.mjs` to refresh the self-contained Claude directory bundle. `npm run check` rejects a stale bundle. Public marketplace listings have their own review and publishing steps; see [the submission worksheet](docs/marketplace-submission.md).

Publishing requires maintainer access to the GitHub repository and npm package. A source version, local tag, or passing package check does not establish a public release.

## Before preparing a release

Confirm package ownership, repository permissions, protected release refs, and npm trusted publishing for `.github/workflows/publish.yml`. Review private vulnerability reporting and repository security settings separately. The presence of workflow files does not establish that these remote settings are enabled.

Keep authentication outside the repository. If a first publication needs an interactive npm login and 2FA, complete that as a separate maintainer action. Do not commit tokens.

## Prepare and verify

1. Update every entry in `.version-bump.json`, the registry's own version, both root package-lock versions, the bug template's version placeholder, and `CHANGELOG.md`. Do not bump unrelated fixture or schema versions.
2. Run the repository checks in an appropriate development environment:

   ```sh
   npm ci --ignore-scripts
   npm run check
   npm test
   npm run test:package
   ```

   The package check needs the preceding-release tag named in `scripts/verify-package.mjs` for its installed-upgrade fixture. Obtain the required history before running that check in a shallow checkout.
3. Inspect the tarball file list, installed executable and exports, fresh skip, session-only, persist, retained project settings, setup/status/uninstall, and upgrade results. Exclude local configuration, credentials, private paths, and build output from the package.
4. Run relevant real-tool and named-host acceptance. Record actual command routing, destination paths, explicit override behavior, and the absence of unexpected project writes. Repeat lifecycle and sandbox checks where the change affects them.
5. Record source revision, Node and OS versions, test totals and skips, package SHA-256, and the unpacked file manifest. Keep package hashes outside the hashed package. Update [verification](docs/verification.md) and the [integration matrix](docs/agent-integrations.md) without promoting untested routes.

The checked-in CI definition covers Node 20, 22, and 24 on macOS and Ubuntu. This is its configured matrix, not a claim that a particular run passed. Native Windows and live host acceptance require their own evidence.

## Publish and check the public artifact

After review, merge the release change, create its annotated `vX.Y.Z` tag, and publish the matching GitHub release. The existing publish workflow runs on a published release, verifies tag/version equality, runs source and package checks, and invokes npm publication with OIDC permission. Confirm trusted-publisher configuration before relying on it.

Install the published package into an empty prefix and inspect its version, read-only session plan, and isolated lifecycle behavior. Record the actual npm and GitHub release URLs in the changelog only after verifying them.

Never overwrite a published version. Release a new version for a correction and consider deprecating the affected npm version. Preserve earlier license grants and attribution in all distributed artifacts.
