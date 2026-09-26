# Safety model

Clean Development changes paths used by compilers and package managers and can delete old managed build directories when explicitly asked. The design therefore treats ownership evidence as more important than convenient discovery.

## Assets to protect

- source code and Git metadata;
- credentials, package-manager configuration, signing material, and toolchains;
- final release artifacts and QA evidence;
- unrelated agent settings and hooks;
- active builds and long-running development servers;
- command arguments, prompts, transcripts, and private repository names.

## Trust boundaries

The local user chooses the managed root and runs setup. Tool shims execute with that user's permissions. Project configuration is repository-controlled and therefore untrusted until the project itself is trusted. Agent plugin packages and the npm/GitHub release chain are supply-chain boundaries.

## Session choices and source writes

`session --dry-run` reads the project and storage plan without creating files or launching a process. Manifest detection is limited to ancestor directories and selected project metadata; it never executes a manifest, installs dependencies, or recursively scans source.

Interactive launchers show the plan and offer `session-only`, `persist`, and `skip`. Noninteractive `agent`, `run`, and stable launcher calls default to `session-only`, which can prepare managed storage and launch routed tools but cannot write project configuration. Direct native host entry points default to `skip`. Routed choices reject managed destinations inside the detected project. Only an explicit `persist` choice creates the reviewed `.clean-development.json`; the contents are shown before the terminal choice and are available through `--dry-run` for scripted review. The file contains tool configuration rather than a saved grant of consent. Children inherit `session-only`, so a persistence choice does not authorize a write in another project.

Persistence retains existing configuration and refuses symlink/non-file targets or changes detected between review and creation. It verifies the resulting content against the reviewed bytes. It changes no source manifests, lockfiles, agent configuration, or instruction files. Managed base-directory preparation happens before persistence, so a failed persistence attempt may leave prepared directories outside the source tree.

`skip` bypasses runtime creation, removes the managed shim path, and removes unchanged values recorded as injected by the enclosing session. It preserves independent tool overrides and existing files. Already installed native integrations may keep their stable command path, but they set or honor `skip`; their shims resolve and execute the real tools without managed routing. This happens without asking the model or opening a terminal prompt. The choice does not uninstall existing agent integrations or change the host's sandbox policy.

Shared-cache variables are applied at session start. Cargo output remains under command-time workspace selection, ownership validation, and active leases; session approval does not bypass those protections. These choices manage routing and project configuration, not a sandbox: an agent still needs its own permission to write both runtime/state and managed artifacts.

## Controls

- Broad roots such as `/` and the home directory are rejected.
- Prune candidates come from state created during an actual routed Cargo build, not a filesystem name scan or cache-only command.
- A candidate must be a real direct child of the currently configured build root, and its random on-disk ownership marker must match the state receipt.
- Ownership, age, pin, and active-lease checks are repeated immediately before deletion.
- Active PID leases and pins block pruning.
- Prune defaults to reporting; deletion requires `--apply`.
- Existing tool variables and agent PATH policies are preserved by default.
- Codex PATH snapshots omit the current project, active virtual/Conda environments, temporary paths, and `node_modules/.bin` entries; npm/npx setup falls back to its stable launcher instead of persisting a package-runner PATH.
- Grok setup writes one marked `toolset.bash.cmd_prefix` that sources an owned runtime helper. The helper defaults an unset session mode to `skip`, so making the shim directory win does not itself route commands. It preserves an existing user prefix and refuses unsupported TOML forms. Grok 1.0.34 model-shell acceptance resolved the managed Cargo shim after login-PATH capture and created no project-local `target`.
- Setup and uninstall share a stale-recoverable lock; runtime synchronization and per-workspace mutation are also serialized, while concurrent first builds use atomic directory publication.
- State collections, lock directories, runtime roots, and launcher directories reject symlinks and non-canonical paths. Unknown lease and archived-receipt files are retained rather than interpreted or deleted.
- Missing managed base roots are not recreated during ordinary builds, reducing the risk of filling the wrong disk when an external volume disappears.
- Runtime uninstall verifies exact path and SHA-256 receipts and leaves modified or unrelated files in place.
- Agent integration receipts are schema-checked and ownership-marker-checked. New native TOML blocks are bound to a SHA-256 of their exact normalized content; hashless legacy blocks require the recorded shape and this installation's runtime-bin PATH prefix. Native Claude, Codex, and Grok receipts are bound to the config path resolved from the setup environment. Claude session environment edits also require the receipt's owner and exact whole-line markers. A changed relevant config home, owner mismatch, or ambiguous block fails closed before unrelated content is edited.
- OpenCode's additive `shell.env` contract cannot delete parent variables. Its launcher therefore defers static cache routing to command shims. If an older or external OpenCode parent still carries session-injected cache variables, entry into a disabled project fails before the shell command runs instead of leaking that routing.
- Plugin lifecycle entry points remain dormant until explicit setup has installed a runtime receipt. The receipt enables native exposure only; default `skip` still prevents routing. The management skill is user-invoked only in Claude and Codex metadata.
- Direct child executables are spawned without a shell, so argv is not joined or reparsed. Windows `.cmd` and `.bat` tools use `ComSpec` with metacharacter escaping, multiline and NUL rejection, and verbatim arguments.
- State contains paths, IDs, timestamps, tool names, and PIDs, not command bodies or prompts.
- npm installation has no lifecycle mutation.
- GitHub Actions use least-privilege permissions and commit-pinned actions.

## Residual risks

A compromised local project can execute arbitrary package scripts with the user's existing permissions. A malicious tool can ignore its cache variable. PID reuse can make a stale lease appear active, which causes retention rather than deletion. A user can place valuable files inside a product-owned managed build directory; explicit prune can then remove them. Same-user adversarial filesystem races, disk-full interruption, and hostile network filesystems still need broader testing before a stable release.

Report vulnerabilities through [SECURITY.md](../SECURITY.md).
