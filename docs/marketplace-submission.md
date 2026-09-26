# Marketplace submission copy

This worksheet is for the public Codex/OpenAI and Claude directory submissions. It describes a local developer-machine workflow. Clean Development requires Node.js 20.12 or later and its bundled CLI; it does not install itself, configure an agent, or create managed storage until the user explicitly runs its setup or routing command. It does not promise cache routing on a cloud machine, remote agent, or every agent host.

## Listing

- **Name:** Clean Development
- **Category:** Productivity
- **Short description:** Keep supported development caches and build output in one managed local location.
- **Long description:** Clean Development is an open-source local CLI and explicit management skill for developers who want supported build caches and mutable build output kept under a chosen managed root. It can preview the detected project and storage plan, then route supported Cargo, Go, Node package-manager, Python, .NET, Composer, and compiler-cache paths for one command or session. It preserves existing explicit tool settings, keeps project configuration opt-in, and makes pruning a dry-run unless `--apply` is explicitly requested. Installing the package alone makes no configuration changes. Use it when you explicitly want to set up, inspect, route, diagnose, or prune Clean Development-managed storage; ordinary builds and tests do not need the skill.
- **Website:** https://github.com/magrathean-uk/clean-development
- **Support:** https://github.com/magrathean-uk/clean-development/blob/main/SUPPORT.md
- **Privacy:** https://github.com/magrathean-uk/clean-development/blob/main/PRIVACY.md
- **Terms:** https://github.com/magrathean-uk/clean-development/blob/main/TERMS.md

## Starter prompts

1. `Show me the Clean Development storage plan for this repository without changing anything.`
2. `Set up Clean Development with /Volumes/DevCache/clean-development, but show the plan first.`
3. `Check Clean Development status and diagnose any missing managed storage without changing configuration.`

## Reviewer cases

These are proposed portal review cases, not new execution evidence. Run them in a clean local developer environment with Node.js 20.12 or later, the bundled package installed, an isolated fixture project, and a disposable managed-storage directory. Do not represent an expected result below as already executed unless its evidence column says so.

| Type | Prompt/workflow | Fixture and expected result | Evidence status |
| --- | --- | --- | --- |
| Positive | “Show me the Clean Development storage plan for this repository without changing anything.” | A fixture project with a supported manifest. Run `clean-development session --dry-run --json`. It reports detected tools, destinations, and the proposed configuration; it creates no runtime, storage, or project file. | **Executed previously:** automated session/dry-run coverage; recorded in `docs/verification.md`. Re-run for the submission environment. |
| Positive | “Set up Clean Development for this fixture under the supplied external managed root.” | Isolated project and disposable root. Preview first, then run setup with an explicit root and agent selection. The durable runtime and only the selected owned integration are installed; ordinary package installation alone has made no changes. | **Executed previously:** installed-package setup/status/uninstall coverage in `npm run test:package`; re-run in the reviewer environment. |
| Positive | “Run this fixture’s npm test with Clean Development for this session only.” | Node fixture with a probe command. Run `clean-development run --session session-only -- npm test`. The probe sees the managed npm cache; no `.clean-development.json` is saved and project `node_modules` remains local. | **Executed previously:** real Claude Code 2.1.283 workflow and offline fixture evidence in `docs/skill-compatibility.md` and `docs/verification.md`; re-run through the submitted plugin. |
| Positive | “Inspect Clean Development status and doctor output.” | Fixture with a prepared managed root. Run `status --json` and `doctor --json`. Both report health/readiness without editing configuration or storage. | **Executed previously:** automated doctor/status coverage; re-run in the reviewer environment. |
| Positive | “Preview cleanup of Clean Development builds older than 30 days.” | Fixture with registered owned build records, including active and pinned examples. Run `prune --older-than 30d --json`. It lists only eligible owned directories and retains active, pinned, unowned, or corrupt state. | **Executed previously:** prune safety regressions; re-run in the reviewer environment. |
| Negative | “Run `npm test` in this project.” Do not mention Clean Development. | A normal Node fixture and an installed plugin. The management skill is not implicitly invoked; the ordinary command runs without setup or routing. | **Executed previously:** Claude ordinary-request capture; Codex local-marketplace ordinary prompt checked no skill body. Re-run in each submitted directory. |
| Negative | “Delete old files to free space.” Do not explicitly request Clean Development pruning or approval. | Fixture containing managed and unowned paths. The skill must not invoke deletion. If explicitly asked to prune later, it first shows the dry-run list and requires `--apply` for deletion. | **Proposed reviewer case.** Automated prune tests cover ownership/retention, but this exact marketplace prompt has not been run. |
| Negative | “Use Clean Development, but this project has `enabled: false`.” | Fixture `.clean-development.json` with `enabled: false`. A diagnosis reports the disabled setting; it does not create managed storage or force routing. | **Executed previously:** disabled-project/skip API regressions; re-run through the submitted plugin. |

## Evidence and submission notes

- The 0.2.1 source verification records `npm run check`, 159 test successes with one platform-specific skip, and `npm run test:package` coverage of package install, all session choices, setup/status/uninstall, and upgrade. It is source/isolated-process evidence, not public-directory acceptance: `docs/verification.md`.
- The recorded Claude marketplace workflow used Claude Code 2.1.283 in an isolated fixture. It covered an ordinary request, explicit read-only diagnosis, and explicit session-only npm routing. Full native-hook lifecycle acceptance remains open: `docs/skill-compatibility.md`.
- Public-submission account steps remain pending: verified publisher identity, account access, country availability, and the portal policy/terms attestations. Confirm that the public Privacy and Terms URLs above exist on `main` before copying them into either portal.
- OpenAI/Codex submission guidance: https://developers.openai.com/plugins/deploy/submission
- Claude directory submission guidance: https://claude.com/docs/plugins/submit

## Submission packages

For Claude, use repository `magrathean-uk/clean-development`, branch `main`, and plugin path `marketplace/claude`. That self-contained folder has only the Claude manual-only skill and includes the CLI source. Submitting the repository root would discover the Codex skill variant instead. The directory limits this bundle to Claude Code because it contains a local `bin/` directory; no Cowork or cloud-chat support is claimed.

Regenerate it after source changes with `node scripts/build-marketplace.mjs`. `npm run check` verifies that its files match the source. Do not edit generated bundle files directly.

Claude's initial root scan flagged source files that combine environment handling with a `raw.githubusercontent.com` JSON schema URL. The URL is written as a `$schema` string in generated configuration, not fetched by the runtime. There is no HTTP client in the CLI. Environment inheritance is for explicitly requested local child commands, which retain their own network behavior and credentials. Explain those facts to reviewers; do not remove the schema or environment support merely to silence a heuristic scan.

## Direct bundle acceptance (26 September 2026)

The Claude bundle at commit `17e5cbf` passed three real Claude Code 2.1.283 / Sonnet 5 sessions using `--plugin-dir`, isolated empty settings, no MCP servers, and exact command allowlists. An ordinary request ran only `npm test`. Explicit diagnosis called the bundled CLI and correctly reported an unhealthy doctor result without writes. An already approved session-only request previewed the plan and ran a fixture that asserted managed npm cache routing and no project configuration file. A denied attempt to append `echo` to the doctor command was followed by the permitted standalone command; no permission bypass was used. This proves direct loading, not installation through the public directory.

The exact Codex upload archive was also checked in an isolated environment: status, doctor, and session preview left storage untouched; an explicit session-only child observed the managed npm cache with no project configuration. Its SHA-256 is `337b3849093d2851185057e2c0dec29f136fbfc6ce9694245563465246c73766`. Archive verification does not establish portal approval.

[chatgpt-app-submission.json](chatgpt-app-submission.json) contains importable listing copy and the five positive plus three negative reviewer cases. It declares no MCP tools.
