# Releasing

Before validating a release, run `node scripts/build-marketplace.mjs` to refresh the self-contained Claude directory bundle. `npm run check` rejects a stale bundle. Public marketplace listings have their own review and publishing steps; see [the submission worksheet](docs/marketplace-submission.md).

Only a maintainer with npm package access and GitHub release authority can publish.

## One-time repository setup

1. Create the public `magrathean-uk/clean-development` repository.
2. Enable private vulnerability reporting, secret scanning, push protection, Dependabot alerts, and read-only default Actions permissions.
3. Protect `main` and `v*` tags without making a solo-maintainer release impossible.
4. Reserve or publish the `clean-development` package with 2FA.
5. Configure npm trusted publishing for `.github/workflows/publish.yml` in this repository.
6. After trusted publishing succeeds, require 2FA and disallow traditional automation tokens for the package.
7. Enable immutable GitHub releases if available for the repository.

The first npm publish may require a manual 2FA-authenticated `npm publish --access public`. Do not add a long-lived `NPM_TOKEN` to the repository to avoid that step.

## Release procedure

1. Recheck that the npm name and repository target belong to the intended owner.
2. Run real-host acceptance and update the support matrix; do not promote an unverified adapter. For v0.2.0, use fresh isolated projects to verify session-only, persist, and skip through the public launcher, then prove actual Codex shell routing. Keep host sandbox permission and authentication/configuration isolation evidence explicit.
3. Update every file listed in `.version-bump.json`, the registry's own version, and `CHANGELOG.md` to the release version. Include both package-lock root versions. Do not change schema or fixture versions solely because the product version changes.
4. Run:

   ```sh
   npm ci --ignore-scripts
   npm run check
   npm test
   npm run test:package
   ```

5. Test the installed tarball's version and both exports, `session --dry-run`, all three session choices with a fake child command, and isolated setup/status/uninstall. Verify upgrade from the preceding runtime; this package gate requires the preceding release tag, so fetch full tag history first. Run the final tree on exact Node 20.12.2 as the recorded 20.12-series test baseline and on a current supported Node on macOS/Linux; record the source manifest, package SHA-256, exact test totals, and evidence paths in `docs/verification.md`. Review the full tarball file list and make sure it contains no credentials, local config, fixtures with private paths, or build output. Resolve every pending-verification placeholder before release.
6. Merge the release change to protected `main`.
7. Create an annotated `vX.Y.Z` tag at that commit and publish a GitHub release from it.
8. The publish workflow verifies tag/version equality, re-runs checks, builds the tarball, and publishes through npm OIDC with provenance.
9. Install from the public registry in an empty prefix and run `clean-development --version`, `setup --dry-run`, `session --dry-run --json`, and `doctor` in an isolated disposable environment.
10. Record the npm and GitHub release URLs in the changelog.

Never overwrite or republish an existing version. Fix a bad release with a new version; deprecate the affected npm version when appropriate.
