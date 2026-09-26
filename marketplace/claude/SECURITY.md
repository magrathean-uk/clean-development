# Security policy

## Supported versions

Until `1.0.0`, only the latest published version receives security fixes.

## Report privately

Do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/magrathean-uk/clean-development/security/advisories/new). If that route is unavailable, contact the repository owner through the verified contact details on the [Magrathean UK GitHub profile](https://github.com/magrathean-uk) and include only enough information to establish a private channel.

Useful reports include the affected version and platform, the exact command or configuration, impact, a minimal reproduction, and any suggested mitigation. Remove secrets and personal data.

We aim to acknowledge a report within three business days and provide an initial triage within seven. These are targets, not a bounty or guaranteed resolution window. Coordinated disclosure timing will be agreed with the reporter when possible.

## Security scope

Please report any behavior that can cause:

- deletion or overwrite outside a validated, product-owned managed root;
- path traversal or unsafe symlink handling;
- shell, argument, hook, or configuration injection;
- unexpected weakening of an agent sandbox or permission policy;
- credentials, command bodies, prompts, or secrets entering logs or state;
- pruning of an active or pinned build;
- corruption of unrelated Claude, Codex, Grok, or other agent configuration;
- malicious npm, GitHub Actions, plugin, or release-chain behavior.

A supported tool writing its documented output somewhere the project does not yet route is normally a compatibility bug, not a security issue. Unregistered paths are outside automatic prune ownership by design.

## Disclosure and fixes

Validated reports are handled in a private advisory. A fix should include regression coverage, a release note, and a new immutable package version. Published versions are never replaced in place.
