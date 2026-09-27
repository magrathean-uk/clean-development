# Model-facing request text acceptance

## Status and claim boundary

This is an opt-in measurement protocol, not a runtime feature. No capture code is imported by Clean Development. A passing parser, loader, hook command, CLI transcript, inventory, metadata policy, or mocked host is **not** request-text acceptance. Zero captured requests is a blocked result, not zero added tokens.

The automated adapter targets **Claude Code 2.1.283** and the current shipped `marketplace/claude` bundle. It uses the real host's documented gateway setting to receive requests locally. Responses are synthetic, no request is forwarded to a model provider, and the fixture's zero-valued usage fields are protocol placeholders. This establishes request construction only when actually executed on that host. It never establishes inference quality, provider-side final prompts, or billed-token neutrality.

See [skill compatibility](skill-compatibility.md) and [the verification ledger](verification.md) for historical observations, which are not results of this experiment. The dated [local availability record](evidence/request-text-2026-09-27.json) records **no installed supported host and no captured host requests** in the local execution container. A requested version is not an observed version. The separate [CI evidence record](evidence/request-text-ci-2026-09-27.json) contains real Claude Code 2.1.283 observations, source revisions and linked job logs; its overall acceptance verdict remains inconclusive, as detailed below.

No unintended automatic product context injection has been confirmed by these observations; no production integration or skill policy was changed. Do not change a host's invocation policy or remove functionality just to manufacture an equal payload.

## Recorded real-host evidence, 27 September 2026

[Run 3](https://github.com/magrathean-uk/clean-development/actions/runs/36349261567/job/108704589664) and [run 4](https://github.com/magrathean-uk/clean-development/actions/runs/36349404074/job/108705002656) each executed the full nine-lane matrix twice using **real Claude Code 2.1.283**, Ubuntu 24.04.5, Node 22.23.2 and npm 10.9.8. The host's `--version` returned the exact requested version, and its invoked-file SHA-256 was `1859583ce32920595c61ef868bee52e1b1594f7486db209935e01f1e5e804ae2`. Run 4 tested PR head `fcbb50db435b4e0d426799f32711e65da6a97563` as merge commit `c6f01f585bec848fcfddfb9b1d6a96538bec4486`, tree `c9b302864a358da372251afa9984bce06e37efde`.

Across these two runs, **36 authenticated generation payloads were captured from 36 fresh host sessions**. All host processes exited 0 and both source and binary fingerprints remained unchanged. Each native lane also produced a successful host SessionStart response event. Per-request hashes, byte counts, control observations and package hashes are retained in the CI ledger.

| Observed generation request | Actual observation in both repetitions of both runs |
| --- | --- |
| Absent, installed skill inactive, native inactive, combined inactive, explicit native session-only | No exact shipped management body, description or product-reference detector match |
| Explicit skill invocation | Exact shipped Claude skill body present |
| Deliberately automatic description control | Description canary present |
| Deliberate SessionStart stdout control | Hook canary present |

**These are bounded payload observations, not a complete equality pass.** Each lane also sent one unauthenticated request that the receiver rejected. Run 4 identified its method as `HEAD` and its target as an unclassified path, without logging its URL or private contents. Its purpose and exact target are not established. The completeness gate therefore stayed closed, the whole-request comparator did not run, and both workflows returned exit 1. Neither the visible absence of known product strings nor small raw-byte differences establish equality of all system/tool/other text. Do not suppress this rejection or assume it is harmless merely to obtain a pass.

The first two CI attempts installed the exact npm package but could not start its native binary because the harness used `--ignore-scripts`. The subsequent bounded diagnostic exposed that installation error. The protocol now explicitly runs only the pinned host's prescribed `install.cjs` under the disposable environment. This is an apparatus fix, not a Clean Development injection fix. The earlier failed attempts remain in the ledger.

Local unit tests and the separate-process HTTP client validate the apparatus only. CI publishes observation indexes, not request bodies; the ledger is explicitly a transcription of those indexes, not an independently replayable capture. A future complete acceptance run must classify the rejected traffic through the same authorised host interface, retain reviewed capture evidence, rerun the complete comparison and preserve the positive controls. Billing and the other host/lifecycle claims remain unproven.

## Questions kept separate

1. **Request construction:** did enabling native integration, discovering the installed management skill, or choosing routing add any model-facing text? Include names, descriptions, paths, tool schemas, hook output and reminders, not just the complete skill body.
2. **Explicit invocation:** does a deliberate slash invocation load the exact shipped manual-only body? This is a positive control, not an expectation of equal requests.
3. **Runtime behaviour:** did a real host execute its native hook and honour routing/skip? A host event corroborates hook execution; artifact placement and full child semantics need their separate acceptance tests.
4. **Billing:** what did the actual provider bill, under which account, model, cache state and pricing rules? Neither UTF-8 byte counts nor host token estimates answer this.

Claims must name the source revision/fingerprint, observed host version and invoked-file hash, platform, install route, prompt, session type, model option, settings sources and request endpoints. Do not extrapolate an initial print-mode request to interactive development, Codex App, other hosts, later turns, resume/fork/subagents, changed cwd, or subsequent host releases.

## Legitimate observation boundary

For Claude Code, [the gateway connection documentation](https://code.claude.com/docs/en/llm-gateway-connect) documents `ANTHROPIC_BASE_URL` and gateway authentication. This experiment configures that supported interface with a randomly generated fixture credential and a receiver bound to `127.0.0.1`. It does not intercept TLS, install certificates, patch host internals, hook networking functions, collect another user's traffic, or forward saved account credentials.

The receiver accepts only bounded JSON `POST /v1/messages` and `POST /v1/messages/count_tokens`. The latter is recorded separately and cannot satisfy a generation positive control. SSE or ordinary JSON responses terminate the turn without asking the model to run tools. Unexpected endpoints, credentials, encodings, malformed bodies, truncation, missing generation requests and transport errors block acceptance. No headers are saved. Connection/request/body limits are safeguards for a local experiment, not a hardened multi-user proxy.

[Claude's skill contract](https://code.claude.com/docs/en/skills) describes the expected manual-only policy; [hook documentation](https://code.claude.com/docs/en/hooks) describes how SessionStart text can enter context. These documents justify the hypotheses and positive controls. They do not replace observation. [Plugin installation](https://code.claude.com/docs/en/plugins/install) and [CLI options](https://code.claude.com/docs/en/cli-reference) provide the installation and isolated print-mode interfaces.

Do not use undocumented “show prompt” endpoints, guessed debug switches, browser credential extraction, or packet interception when the supported interface is unavailable. Record the missing boundary and keep the claim unproven.

## Isolation and reproducibility

Use a disposable Linux account, VM or ephemeral CI runner with Node 20.12 or newer and the exact independently installed host. HOME/config redirection is **not** operating-system containment. Do not use an account containing private projects, login state, organisation policies, extensions or inherited instructions. The driver refuses known machine-wide Claude managed-settings files; this is not exhaustive policy discovery.

Every lane gets a separate private home, host config, XDG locations, project, temporary directory, product config/data and managed storage. Nothing copies an operator's settings, auth files or caches. The child environment is allowlisted: no ambient provider keys, OAuth tokens, proxy settings, shell startup files, `NODE_OPTIONS`, agent instructions or inherited routing. Auto-update and nonessential traffic are disabled. The project contains only a synthetic package manifest and a Git boundary. The source checkout is not the model's cwd.

The source/runtime/bundle/harness fingerprint is checked before and after. Host version and invoked-file SHA-256 are recorded; the file hash is not a claim to hash every native dependency or prove supply-chain authenticity. CI additionally prints the exact npm package identity, manifest hash and install-lock hash. Record any host auto-update, package mutation or machine-policy discovery as a blocked comparison.

The installer uses a new local marketplace catalog whose only component is a byte-for-byte copy of the **shipped Claude bundle**. In that disposable host config the real host runs:

```sh
claude plugin marketplace add <lane>/marketplace
claude plugin install clean-development@request-acceptance-local --scope user
```

These are generated argv arrays, not commands to paste with the angle-bracket placeholder. The driver checks the command exits and the resulting enabled-plugin setting. “Installed but inactive” means the plugin is **enabled and discoverable**, but its skill was not invoked; it does not mean the plugin was disabled. The negative control changes only its own copied skill. Do not load the repository root as the Claude plugin: that can select the Codex skill variant. A session-only `--plugin-dir` run must be recorded as a different install route, not substituted for this installed-plugin test.

Native lanes separately run the real `clean-development setup --root ... --agents claude --json`, with all directories inside the lane. They require its native-hook receipt and a successful real-host SessionStart response event. Native-inactive retains the native default `skip`. Native-explicit supplies `CLEAN_DEVELOPMENT_SESSION_MODE=session-only` as explicit experiment consent. No project persistence, pruning or uninstallation is performed.

## Paired case matrix

Use the identical ordinary input:

> Explain what a unit test checks in one sentence. Do not use tools.

Each row starts a new process/session; never resume or reuse a conversation after invoking the skill. The default is two repetitions, with the order reversed on the second. The two absent controls bracket each sequence to reveal unrelated drift.

| Lane | Native setup | Installed, enabled management skill | Request / expected evidence |
| --- | --- | --- | --- |
| absent-before | No | No | Ordinary baseline |
| skill-inactive | No | Yes | Ordinary request; inspect complete request for automatic additions |
| native-inactive | Yes, default skip | No | Ordinary request plus actual native-hook event |
| combined-inactive | Yes, default skip | Yes | Ordinary request; detects interaction between discovery and setup |
| native-explicit | Yes, explicit session-only | No | Same ordinary input; any request change needs explanation |
| skill-explicit | No | Yes | Explicit `/clean-development:clean-development` prefix; exact body must reach a generation request |
| description-control | No | Separate deliberately automatic copy | Unique canary description must reach a generation request |
| hook-control | Separate benign stdout hook | No | Unique SessionStart stdout canary must reach a generation request |
| absent-after | No | No | Independent ordinary baseline to check drift |

The intentional canaries are confined to disposable copies/settings. They are not changes to the product and must never be “fixed” by suppressing capture. Together with the explicit-body control they test three ways the apparatus could miss automatic context. An inventory flag alone cannot satisfy any control.

## Run

The first command needs no host and starts no model session. Exit 2 means only that live acceptance has not run:

```sh
node scripts/request-acceptance/run.mjs --preflight
node --test test/request-acceptance.test.js
```

Install the pinned host separately in disposable storage. No implicit install happens in the driver. On an isolated POSIX runner with a reviewed npm registry:

```sh
HOST_ROOT="$(mktemp -d)"
mkdir "$HOST_ROOT/home" "$HOST_ROOT/cache"
env -i PATH="$PATH" HOME="$HOST_ROOT/home" npm_config_cache="$HOST_ROOT/cache" \
  npm install --prefix "$HOST_ROOT/package" --ignore-scripts --no-audit --no-fund \
  @anthropic-ai/claude-code@2.1.283
# Run only the pinned host's own required native installer in the same isolation.
env -i PATH="$PATH" HOME="$HOST_ROOT/home" npm_config_cache="$HOST_ROOT/cache" \
  node "$HOST_ROOT/package/node_modules/@anthropic-ai/claude-code/install.cjs"

node scripts/request-acceptance/run.mjs \
  --claude "$HOST_ROOT/package/node_modules/.bin/claude" \
  --expect-version 2.1.283 --repeats 2 \
  --output "$HOST_ROOT/evidence"
```

The output directory must not exist; its parent must exist. Evidence uses mode 0700 directories and mode 0600 files. CLI inputs reject duplicate/unknown options, relative host/output paths, unsupported repetition counts and non-exact version selectors. An explicit missing or wrong-version host blocks instead of skipping to a fake executable.

The host command recorded per lane uses `--print`, verbose stream JSON, no session persistence, one turn, `claude-sonnet-5`, empty automatic setting sources, the one isolated settings file, strict empty MCP config and noninteractive permission prompts. It does **not** disable skills, replace system instructions, strip tools or use bare/safe mode to conceal plugin discovery. The synthetic reply makes model-requested tool execution unnecessary. A host rejecting these exact options is blocked; do not silently remove isolation controls.

Exit 0 means only `observed-equal-in-tested-scope` with required positive controls. Exit 1 means differences, drift or incomplete acceptance requiring review. Exit 2 means blocked preflight/host prerequisites or an experiment error. Any missing final report is itself incomplete evidence. Timeout/output-limit/uncertain process shutdown cannot pass; retain the fixture for inspection. Each host process is limited to 60 seconds and 1 MiB of CLI output; the receiver permits 12 requests, 2 MiB per body and 16 MiB aggregate per lane.

The dedicated `Request text acceptance` workflow runs the same script on an ephemeral runner, installs the exact real host, passes no provider or repository secrets, and uses read-only repository permissions with commit-pinned actions. It prints a comparison index only. A failed installation, unstarted job, pending run or empty capture is not a host pass. Workflow execution is not automatically interpreted as an acceptance claim.

## Comparison and privacy

Preserve every captured JSON field, including unknown host additions, ordered arrays, role/content boundaries, instructions, tool names/descriptions/schemas, reminders and count requests. Search for the exact current skill body, description and product references; **also compare the whole request sequence**, so absence of known strings cannot hide unrelated added text. Record request count, endpoint, raw UTF-8 byte length and raw-body SHA-256. JSON key ordering is irrelevant; string whitespace and array order are not.

There are only two comparison substitutions: the experiment-controlled lane path becomes `<LANE>`, and the dedicated transport `metadata.user_id` becomes `<TRANSPORT_USER_ID>`. The original metadata is still present in the capture before privacy redaction. Do not normalise general dates, arbitrary UUIDs, model-facing paths, tool text, token values, messages or system blocks. A new dynamic host field must first appear as an unexplained difference, including in the absent controls, rather than being discarded to make tests green.

Privacy redaction occurs **after measurement**, separately from these substitutions. Captures redact known lane/source/operator-home/host/binary paths, the fixture credential, common credential patterns and private identifier fields. Each redacted JSON includes a pointer-level redaction ledger without the removed value. A changed pointer and before/after hashes remain in the comparison index even when both public values redact to the same placeholder. No raw payloads or auth headers are written. Raw hashes cannot reconstruct the redacted values and are not an independent replay of the removed content.

Redaction is not exhaustive secret detection. This driver is for sterile synthetic sessions, not arbitrary existing user captures. Before sharing any local artifact, manually inspect the redacted request bodies, CLI/plugin logs and ledger for private strings or proprietary content. Publish minimal attributable excerpts and structural differences, not entire vendor prompts. CI deliberately uploads **no payload or CLI artifact** and prints only bounded hashes, counts, flags, reasons and pointer indexes. Local evidence is retained; there is no automatic deletion.

A request difference is not automatically an unintended injection defect. Require stable absent controls, a reproducible attributable addition, the correct installed route, valid positive controls and a violated documented expectation. Preserve a minimal redacted counterexample before editing production. After a fix repeat the same pinned matrix and keep the explicit controls working. Do not hide a difference by altering the detector, removing legitimate tool definitions or changing the ordinary prompt.

## Other supported hosts and missing evidence

| Host / version context | Legitimate next measurement boundary | Unproven in this adapter |
| --- | --- | --- |
| Codex CLI; 0.155.1 is historical repository evidence, not an executed version here | Review the exact binary's documented [custom provider base URL and wire API](https://developers.openai.com/codex/config-advanced); configure an explicitly selected local fixture provider, or use a documented complete request export | Native integration plus installed explicit-only skill matrix; complete Responses instructions/input/tools; explicit invocation and provider billing |
| Codex App; version/build unobserved | An authorised disposable App environment and an App-supported complete request capture/export; do not assume CLI provider options apply to the App | All App request text, lifecycle and billing claims |
| Grok Build; 1.0.41 is historical only | Establish a supported full-request gateway/export for the exact installed version before capture; preserve the default CLI-only plugin separately from the optional manual skill | Whether optional skill inventory affects generation requests; metadata is not payload evidence |
| Antigravity; 1.2.10 is historical only | Establish a supported capture/export and explicit discovery semantics on the actual version | Native explicit-only discovery and request equality; the documented launcher route is not skill-discovery evidence |
| OpenCode and Pi; no executed versions in this record | Independently review exact-version documented custom-provider configuration, then capture full messages/system/tool schemas through that supported interface | Native plugin request changes; other host acceptance drafts and synthetic driver tests do not supply this evidence |

Do not publish a host-wide zero-token claim from the Claude result. An unavailable supported capture route leaves **absence of automatically added names/descriptions/body/tool text**, **equality with an absent integration**, **correct explicit invocation**, **later-turn behaviour**, and **billing neutrality** unproven for that host. Source review can identify candidate injection sites, but cannot certify what a proprietary host sends.

A broader follow-up must repeat the matrix with actual ordinary tool-use requests and capture every ensuing request after tool output, changed cwd and resume/fork/subagent transitions, on each supported host/version. For billed-token analysis, separately authorised live provider runs need provider usage records, account/model identity, cache/read/write accounting, retries and pricing context. Fixture responses, CLI counters, inventories and byte counts must be excluded from billing estimates.

## Review and recovery

Core verification remains `npm run check` and `npm test`; the focused test validates this apparatus with explicitly synthetic data and a real separate-process HTTP client. It includes incomplete-capture rejection, automatic-description/tool-schema differences, baseline drift, positive-control failures, privacy-preserving differences, body/request bounds, subprocess termination, exclusive evidence creation and actual disposable native setup without pretending that setup is a host run.

All changes are opt-in tests/docs/CI. Roll back by reverting this change; there is no runtime migration, receipt edit, pruning change or installed user configuration to reverse. Inspect any retained experiment directory and process-lifecycle failure first. Removing an operator-created disposable lab is a separate explicit action, not Clean Development ownership inference or a prune operation.
