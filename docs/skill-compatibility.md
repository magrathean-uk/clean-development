# Management skill compatibility

The management workflow uses the same CLI in Codex, Claude Code, Antigravity (agy), and Grok Build. The two bundled `SKILL.md` bodies are identical; their host metadata differs. Skill installation is separate from storage setup and from consent to route a task.

| Host | Management instructions | Routing command after a session-only choice |
| --- | --- | --- |
| Codex | Install the Codex marketplace plugin; select the Clean Development skill explicitly. Its `agents/openai.yaml` disables implicit invocation. | `clean-development agent codex --session session-only -- ...` |
| Claude Code | Install through the Claude marketplace, which selects `claude-skills/`, then invoke `/clean-development:clean-development`. That variant sets `disable-model-invocation: true`. | `clean-development agent claude --session session-only -- ...` |
| Antigravity / agy | Use the launcher, or explicitly ask AGY to read the bundled skill file for a management task. Native explicit-only discovery has not been established. | `clean-development agent antigravity --session session-only -- ...` |
| Grok Build | Use the default CLI-only plugin, or opt into the user skill below for `/clean-development`. | `clean-development agent grok --session session-only -- ...` |

The literal `...` means host arguments; replace it with the intended arguments or omit it. `antigravity` is the Clean Development agent name; `agy` is the executable. The launcher is for Codex CLI. Inside the Codex App or another already-open host, run approved child commands with `clean-development run --session session-only -- COMMAND...` instead of trying to change the parent's environment with `session`.

## Grok's optional explicit skill

Grok supports user skills at `~/.grok/skills/<name>/SKILL.md` and documents `disable-model-invocation: true` as slash-command-only. To opt in, copy the **Claude variant**, `claude-skills/clean-development/SKILL.md`, to `~/.grok/skills/clean-development/SKILL.md`, then use `/clean-development`. Check for an existing skill before copying; retain customizations instead of overwriting them. [Grok skill documentation](https://docs.x.ai/build/features/skills-plugins-marketplaces)

If `GROK_HOME` is customized, use its `skills/clean-development/` directory. This optional skill registration is not part of `clean-development setup`. The default Grok marketplace still points at `.grok-plugin/`, which deliberately has no skills, commands, or agents. Do not load the repository root with `grok --plugin-dir` for that default route: it can discover the root Codex skill, whose invocation policy is stored in Codex-specific metadata.

## Antigravity's boundary

AGY accepts the root `skills/` layout, but its documented skill discovery includes autonomous invocation, and no equivalent of Codex's or Claude's explicit-only policy was verified. AGY's plugin validator does not establish that the Claude marketplace's custom skill directory is honored. Do not advertise installing the repository root as a context-neutral AGY skill route. Use the launcher for routing and explicitly request a read of the bundled `SKILL.md` when management guidance is wanted. [Antigravity skill documentation](https://www.agy.dev/docs/skills/)

## Workflow checks

The skill now distinguishes inspection, setup, routing, and cleanup. Read-only diagnosis does not prompt for activation; an established session choice is reused; `doctor` exit 1 is reported as unhealthy state; and cleanup uses the requested retention age for both preview and apply. An inherited native `skip` never silently overrides the user's approved choice because commands pass `--session` explicitly.

`npm run check` enforces matching workflow bodies, the Claude/Grok manual-invocation field, and Codex's explicit-only policy. The installed-package gate requires both skill variants and Codex's policy file. The launcher regression exercises Codex, Claude, AGY, and Grok command names, both session modes, argv, working directory, environment routing, and child exit status using isolated fake executables.

## Current host evidence — 26 September 2026

- **Repository validation:** `npm run check` and `npm run test:package` passed; the package contains 58 files, including both skill variants and Codex's policy. `npm test` completed with 159 passing tests, one platform-specific skip, and no failures. The four-host launcher matrix uses isolated executables, not live model sessions.
- **Codex CLI 0.155.1:** a local marketplace add/install/list cycle passed in a disposable `CODEX_HOME`. The plugin was enabled. An ordinary debug prompt contained no management skill body; this is not an explicit-invocation or billed-token acceptance test.
- **Grok 1.0.41:** `.grok-plugin` validation passed with zero components. In a disposable home, `inspect --json` discovered the Claude variant at `.grok/skills/clean-development/SKILL.md` as a user skill with `userInvocable: true`. The inventory does not expose `disable-model-invocation`; its manual-only meaning is documented by Grok. No model session was started.
- **AGY 1.2.10:** `plugin validate` accepted the repository's root plugin and found one skill. This establishes package shape, not explicit-only discovery or model behaviour.
- **Claude Code 2.1.283:** installed from the official npm package, then tested against source revision `7a9c97f` with a disposable home, configuration directory, and project. Strict plugin-manifest validation and marketplace validation/add/install/list passed. The installed plugin exposed one namespaced `/clean-development:clean-development` skill. Actual CLI requests captured by a localhost fixture contained neither its description nor body for an ordinary prompt; explicit slash invocation included the exact body from `claude-skills/clean-development/SKILL.md`. The startup hook exited successfully with empty output, the `agent claude --session skip -- --version` launcher passed, and the fixture project retained only its original `package.json`. The fixture used a dummy key and synthetic responses, so this proves host loading and request construction, not model behaviour or billing. A real-model run still requires login: `claude auth status` reported `loggedIn: false`. The inventory's estimated ~58 always-on tokens did not establish that the manual skill was sent; the captured request is the stronger evidence. See the [Claude skill contract](https://code.claude.com/docs/en/skills).

These checks do not replace real-host model acceptance. Existing routing observations and remaining sandbox, lifecycle, and native-host gaps are in [verification.md](verification.md). No installed user host settings were changed by these checks.
