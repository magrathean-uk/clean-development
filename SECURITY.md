# Security policy

## Supported versions

Until `1.0.0`, only the latest published version receives security fixes.

## Scope

Clean Development is a local Node.js CLI and npm package that prepares optional managed locations for supported development caches and build output. It also includes integrations that make its stable command and shims available to supported agent hosts.

The security-sensitive boundaries are the source checkout and Git metadata, user configuration, credentials, agent configuration, managed state and build directories, and active processes. Project configuration and commands are not trusted simply because they are present in a checkout.

## Reportable issues

For this policy, a reportable write is unintended or bypasses a documented user-selected setup or persistence flow. Explicit setup and an explicitly selected `persist` flow can modify documented user configuration, runtime, launcher, state, and reviewed project-configuration paths. Those expected writes do not alone establish a vulnerability.

Report a security issue when it could realistically lead to any of the following:

- writing, deleting, or overwriting data outside a validated managed root;
- path traversal, symlink confusion, or unsafe ownership validation;
- shell, argument, hook, or configuration injection;
- routing without the required session choice or weakening a host sandbox or permission policy;
- unexpected disclosure of credentials, prompts, command bodies, or other sensitive data beyond documented local state;
- pruning an active or pinned build; or
- a compromised package, plugin, release, or CI dependency affecting users of this project.

Behavior of an unsupported tool, or a supported tool writing its documented output outside managed storage without bypassing an ownership, confidentiality, or integrity boundary, is normally a compatibility issue.

## Reporting

GitHub private vulnerability reporting was disabled for this repository when reviewed on 2026-09-26. Do not publish secrets, personal data, or exploit details in a public issue.

Email [contact@magrathean.uk](mailto:contact@magrathean.uk) with the subject `SECURITY: clean-development`. This reporting address and subject convention are published in the [Magrathean UK security policy](https://github.com/magrathean-uk/.github/blob/main/SECURITY.md). It provides a fallback while this repository's GitHub private reporting is unavailable.

Include the affected version and platform, impact, exact command or configuration, and a minimal reproduction. Remove secrets and personal data. Do not send live credentials, tokens, or production data. Publication of this address does not establish a delivery or monitoring guarantee.

## Security properties and limitations

The project is designed to reject broad managed roots, preserve user-supplied environment values, keep routing disabled until a session choice is made, and require recorded ownership, age, pin, and active-lease checks before pruning. These controls guide review and do not make a security finding non-reportable.

This tool is not a filesystem sandbox. A compromised project can run package scripts with the user's permissions, and a tool can ignore a routed storage variable. See [docs/safety-model.md](https://github.com/magrathean-uk/clean-development/blob/main/docs/safety-model.md) for the documented design and residual risks.

## Disclosure

We aim to acknowledge a report within three business days and provide an initial triage within seven. These are targets, not a bounty or guaranteed resolution window. Coordinated disclosure timing will be agreed with the reporter when possible.

Handle validated reports through the agreed private channel, using a private advisory when available. A fix should include regression coverage, a release note, and a new immutable package version. Published versions are never replaced in place.

This policy describes the repository boundary and is not a security audit.
