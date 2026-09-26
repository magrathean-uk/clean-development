## Change

Describe the problem and the resulting behavior. Link an issue or upstream storage contract where relevant.

## Verification

List the checks actually run and their results. Explain skipped checks. For documentation-only changes, verify links, examples, and agreement with source.

For runtime changes, include the relevant isolated tests plus `npm run check` and `npm test`. For packaging changes, include `npm run test:package`. Distinguish fixtures from named-host acceptance.

## Risk

Describe any effect on path ownership, deletion, configuration, arguments, signals, compatibility, or migration. Explain how explicit environment overrides and unrelated host settings remain intact.

Remove credentials, private paths, prompts, and account information from attached logs. Follow SECURITY.md for suspected vulnerabilities.
