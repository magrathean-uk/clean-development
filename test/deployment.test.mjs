import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { hookShimPath, hookShimText, runtimeRoot, VERSION } from "../runtime/lib/conf.mjs";
import { installPackage, treeDigest } from "../installer.mjs";
import { cli, sim, mk, plugin, privateSourceEnabled, privateTestSource, privateTestValue } from "./helpers.mjs";
// Darwin-only: a test that spawns a real hook, CLI or installer, or runs installPackage, needs the kernel flock.
const test = process.platform === "darwin" ? nodeTest : (name, ...a) => { const fn = a.at(-1), o = typeof a[0] === "object" ? a[0] : {}; return nodeTest(name, /\b(hook|cli|installPackage)\(|install\.sh|installer\.mjs|cd-hook|clean-development\.mjs/.test(String(fn)) ? { ...o, skip: "Darwin-only: spawns a real hook, CLI or installer (kernel flock)" } : o, fn); };

const root = path.dirname(plugin);
const python = process.env.CLEAN_DEV_TEST_PYTHON || ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].find((p) => fs.existsSync(p) && spawnSync(p, ["-I", "-c", "import tomllib"]).status === 0) || "python3";

test("config rebuild carries live hook-state blocks rather than staged state", { skip: !privateTestSource("config_merge") || !fs.existsSync(privateTestSource("config_merge")) }, () => {
  const s = sim({ mounted: false });
  const script = `import runpy,sys,tomllib\nm=runpy.run_path(sys.argv[1]); names=m['APP_MANAGED']; assert 'hooks.state' in names\nstaged='[hooks.state."slot"]\\nenabled = true\\n'\nlive='[hooks.state."slot"]\\nenabled = false\\nfuture_option = "keep"\\n'\nsb=m['blocks'](staged); lb=m['blocks'](live)\nout=''.join(t for k,t in sb if k and not m['family'](k,names)) + ''.join(t for k,t in lb if m['family'](k,('hooks.state',)))\nassert tomllib.loads(out)['hooks']['state']['slot'] == {'enabled':False,'future_option':'keep'}\n`;
  const r = spawnSync(python, ["-I", "-B", "-c", script, privateTestSource("config_merge")], { cwd: s.root, env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("config installation refuses to reassign positional disabled state to changed hooks", { skip: !privateTestSource("config_install") || !fs.existsSync(privateTestSource("config_install")) }, () => {
  const s = sim({ mounted: false }), codex = path.join(s.home, ".codex"), staged = path.join(s.root, "staged");
  mk(path.join(codex, "hooks.json"), JSON.stringify({ hooks: { Stop: ["first", "second"] } }));
  mk(path.join(staged, "hooks.json"), JSON.stringify({ hooks: { Stop: ["second", "first"] } }));
  const script = `import runpy,sys\nm=runpy.run_path(sys.argv[1])\nlive={'hooks':{'state':{sys.argv[2]+'/hooks.json:stop:0:0':{'enabled':False,'trusted_hash':'old'}}}}\nassert m['hook_state_errors'](live,sys.argv[2],sys.argv[3])\n`;
  const r = spawnSync(python, ["-I", "-B", "-c", script, privateTestSource("config_install"), codex, staged], { cwd: s.root, env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("both installer previews and unknown flags leave a fabricated HOME byte-identical", () => {
  const s = sim({ mounted: false });
  const before = treeDigest(s.home);
  for (const [file, shell, args, expected] of [
    [path.join(plugin, "install.sh"), "/bin/sh", ["--dry-run", "--config"], 0],
    [path.join(plugin, "install.sh"), "/bin/sh", ["--config", "--dry-run"], 0],
    [path.join(plugin, "install.sh"), "/bin/sh", ["--unknown"], 2],
    ...(privateTestSource("secondary_installer") && fs.existsSync(privateTestSource("secondary_installer")) ? [
      [privateTestSource("secondary_installer"), "/bin/bash", ["--dry-run"], 0],
      [privateTestSource("secondary_installer"), "/bin/bash", ["--unknown"], 2]
    ] : [])
  ]) {
    const r = spawnSync(shell, [file, ...args], { env: { ...s.env, CLEAN_DEV_NODE: process.execPath }, cwd: s.root, encoding: "utf8", timeout: 15000 });
    assert.equal(r.status, expected, r.stderr);
    assert.equal(treeDigest(s.home), before, `${file} ${args} must not write HOME`);
  }
});

// One install.sh --dry-run in its own process group, bounded at 15 s as before. Its preflight runs node --check on every
// runtime file, about thirty Node starts in a row; beside the module suite that passed the bound at a load of 16 to 26.
// A run that reaches the bound is an incomplete observation: its whole group is killed and awaited, and it is
// repeated, three runs at most. A run that finishes is judged strictly.
function dryRunOnce(cwd, env) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", [path.join(plugin, "install.sh"), "--dry-run"], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, 15000);
    const done = async (status, signal, error) => {
      clearTimeout(timer);
      // The group ends with its leader's pipes; a member that kept none is killed and awaited too.
      const alive = () => { try { process.kill(-child.pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
      if (child.pid && alive()) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
      for (const end = Date.now() + 3000; child.pid && alive() && Date.now() < end;) await new Promise((r) => setTimeout(r, 25));
      resolve({ status, signal, stdout, stderr: error ? `${stderr}spawn error: ${error.message}` : stderr, timedOut, groupLeft: !!child.pid && alive() });
    };
    child.on("error", (e) => done(null, null, e));
    child.on("close", (status, signal) => done(status, signal, null));
  });
}
async function dryRun(cwd, env, label) {
  for (let n = 1; n <= 3; n++) {
    const r = await dryRunOnce(cwd, env);
    assert.equal(r.groupLeft, false, `${label}: the dry run's process group is gone`);
    if (!r.timedOut) return r;
    console.log(`${label}: install.sh --dry-run run ${n} reached its 15000 ms bound; ${spawnSync("/usr/bin/uptime", { encoding: "utf8", timeout: 2000 }).stdout?.trim()}`);
  }
  assert.fail(`${label}: three dry runs, each over its 15000 ms bound`);
}

test("installer skips an unsupported local Node and rejects an invalid explicit override", process.platform === "darwin" ? {} : { skip: "Darwin-only: runs install.sh (kernel flock)" }, async () => {
  const s = sim({ mounted: false }), oldNode = path.join(s.home, ".local/bin/node"), fakeBin = path.join(s.root, "bin");
  const realNode = process.execPath;
  fs.mkdirSync(path.dirname(oldNode), { recursive: true });
  mk(oldNode, '#!/bin/sh\nif [ "$1" = "-e" ]; then exit 1; fi\nexec "$REAL_NODE" "$@"\n');
  fs.chmodSync(oldNode, 0o755);
  const supported = mk(path.join(fakeBin, "node"), '#!/bin/sh\nexec "$REAL_NODE" "$@"\n');
  fs.chmodSync(supported, 0o755);
  const env = { ...s.env, PATH: `${fakeBin}:/usr/bin:/bin`, REAL_NODE: realNode }; delete env.CLEAN_DEV_NODE;
  const selected = await dryRun(s.root, env, "supported local Node");
  assert.equal(selected.status, 0, selected.stderr);
  const invalid = await dryRun(s.root, { ...env, CLEAN_DEV_NODE: path.join(s.root, "missing-node") }, "invalid override");
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /CLEAN_DEV_NODE is not executable/);
  const unsupported = await dryRun(s.root, { ...env, CLEAN_DEV_NODE: oldNode }, "unsupported override");
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /CLEAN_DEV_NODE must be Node\.js 20\.12 or later/);
});

test("runtime launchers skip an unsupported preferred Node before using a supported local Node", () => {
  const s = sim({ mounted: false }), runtime = path.join(s.root, "runtime");
  fs.mkdirSync(path.join(runtime, "bin"), { recursive: true });
  for (const file of ["clean-development", "cd-hook"]) fs.copyFileSync(path.join(plugin, "runtime", "bin", file), path.join(runtime, "bin", file));
  const oldNode = path.join(s.home, "dev/machine/toolchains/node/current/bin/node"), log = path.join(s.root, "node-selection.log");
  mk(oldNode, '#!/bin/sh\nif [ "$1" = "-e" ]; then exit 1; fi\nprintf old >> "$NODE_SELECTION_LOG"\nexec "$REAL_NODE" "$@"\n'); fs.chmodSync(oldNode, 0o755);
  const supported = mk(path.join(s.home, ".local/bin/node"), '#!/bin/sh\nif [ "$1" = "-e" ]; then exec "$REAL_NODE" "$@"; fi\nprintf supported >> "$NODE_SELECTION_LOG"\nexec "$REAL_NODE" "$@"\n'); fs.chmodSync(supported, 0o755);
  const marker = path.join(s.root, "runtime-launched");
  for (const file of ["clean-development.mjs", "cd-hook.mjs"])
    mk(path.join(runtime, "bin", file), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(file)});\n`);
  const env = { ...s.env, PATH: "/usr/bin:/bin", REAL_NODE: process.execPath, NODE_SELECTION_LOG: log };
  delete env.CLEAN_DEV_NODE;
  for (const file of ["clean-development", "cd-hook"]) {
    const r = spawnSync("/bin/sh", [path.join(runtime, "bin", file), "session-start", "claude"], { cwd: s.root, env, encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 0, `${file}: ${r.stderr}`);
    assert.equal(fs.readFileSync(marker, "utf8"), file === "clean-development" ? "clean-development.mjs" : "cd-hook.mjs");
  }
  assert.equal(fs.readFileSync(log, "utf8"), "supportedsupported", "unsupported preferred Node was skipped for both launchers");
});

test("stable hook shim exits successfully when its Node-backed launcher fails", () => {
  const s = sim({ mounted: false }), shim = hookShimPath(s.env), versionDir = path.join(runtimeRoot(s.env), VERSION);
  mk(path.join(versionDir, "bin/cd-hook"), "#!/bin/sh\nexit 0\n"); fs.chmodSync(path.join(versionDir, "bin/cd-hook"), 0o755);
  mk(path.join(s.home, "dev/machine/bin/clean-development"), "#!/bin/sh\necho unavailable >&2\nexit 127\n");
  fs.chmodSync(path.join(s.home, "dev/machine/bin/clean-development"), 0o755);
  mk(shim, hookShimText(s.env)); fs.chmodSync(shim, 0o755);
  const r = spawnSync("/bin/sh", [shim, "session-start", "claude"], { cwd: s.root, env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /unavailable/);
});

test("installer discovers Node in the conventional user-local location", () => {
  const s = sim({ mounted: false }), localNode = path.join(s.home, ".local/bin/node");
  fs.mkdirSync(path.dirname(localNode), { recursive: true }); fs.symlinkSync(process.execPath, localNode);
  const env = { ...s.env, PATH: "/usr/bin:/bin" }; delete env.CLEAN_DEV_NODE;
  const r = spawnSync("/bin/sh", [path.join(plugin, "install.sh"), "--dry-run"], { cwd: s.root, env, encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /status.*preview/);
});

function privateMonorepoSource(s) {
  const parent = path.join(s.root, "private-source"), src = path.join(parent, "clean-development");
  fs.mkdirSync(parent, { recursive: true }); fs.symlinkSync(plugin, src, "dir");
  mk(path.join(parent, "machine/env.private.zsh"), "private env fixture\n");
  const sources = [
    ["machine/env.private.zsh", "private env fixture\n"],
    ["machine/clean-env-allow.list", "PRIVATE_ROUTE\n"],
    ["machine/clean-development/codex-homes.list", "~/dev/machine/state/extra-codex\n"],
    ["machine/clean-development/claude-settings.list", "~/dev/machine/state/workspace-profiles/shared/settings.json\n"],
    ["machine/clean-development/claude-profiles.list", "~/dev/machine/state/workspace-profiles/profiles/example/settings.json\n"]
  ];
  for (const [relative, contents] of sources) mk(path.join(parent, relative), contents);
  mk(path.join(parent, ".clean-development-private-sidecars.json"), JSON.stringify({ schemaVersion: 1, sidecars: [
    ...sources.map(([relative]) => relative), "clean-development/machine/colima"
  ] }));
  return src;
}

test("installer syntax-checks the exact Colima sidecar source named by the private manifest", () => {
  const s = sim({ mounted: false }), parent = path.join(s.root, "renamed-source"), src = path.join(parent, "package-copy");
  fs.mkdirSync(parent, { recursive: true });
  fs.cpSync(plugin, src, { recursive: true });
  mk(path.join(parent, "clean-development", "machine", "colima"), "#!/bin/sh\nif then\n");
  mk(path.join(parent, ".clean-development-private-sidecars.json"), JSON.stringify({
    schemaVersion: 1, sidecars: ["clean-development/machine/colima"]
  }));
  assert.throws(() => installPackage(src, s.env, { config: true, dryRun: true }), /preflight \/bin\/sh:/);
});

test("a manifest-enabled source project installs missing sidecars before env.zsh and preserves existing host edits", () => {
  const s = sim({ mounted: false }), src = privateMonorepoSource(s);
  const preview = installPackage(src, s.env, { config: true, dryRun: true });
  const privateTarget = path.join(s.home, "dev/machine/env.private.zsh"), envTarget = path.join(s.home, "dev/machine/env.zsh");
  const colimaTarget = path.join(s.home, "dev/machine/bin/colima");
  assert.ok(preview.files.indexOf(privateTarget) >= 0 && preview.files.indexOf(privateTarget) < preview.files.indexOf(envTarget));
  assert.ok(preview.files.includes(colimaTarget), "explicit private manifest enables the optional Colima shim");
  assert.equal(fs.existsSync(privateTarget), false, "preview is read-only");
  installPackage(src, s.env, { config: true });
  assert.equal(fs.readFileSync(privateTarget, "utf8"), "private env fixture\n");
  assert.equal(fs.readFileSync(colimaTarget, "utf8"), fs.readFileSync(path.join(plugin, "machine/colima"), "utf8"));
  assert.equal(fs.statSync(colimaTarget).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(path.join(s.home, "dev/machine/state/clean-development/claude-profiles.list"), "utf8"), "~/dev/machine/state/workspace-profiles/profiles/example/settings.json\n");
  fs.writeFileSync(privateTarget, "host edit\n");
  installPackage(src, s.env, { config: true });
  assert.equal(fs.readFileSync(privateTarget, "utf8"), "host edit\n");
});


test("standalone clones ignore neighboring private settings without an explicit manifest", () => {
  const s = sim({ mounted: false }), parent = path.join(s.root, "standalone-source"), src = path.join(parent, "clean-development");
  fs.mkdirSync(parent, { recursive: true }); fs.symlinkSync(plugin, src, "dir");
  mk(path.join(parent, "machine/env.private.zsh"), "private fixture that must not be read\n");
  const preview = installPackage(src, s.env, { config: true, dryRun: true });
  assert.ok(!preview.files.includes(path.join(s.home, "dev/machine/env.private.zsh")));
  assert.ok(!preview.files.includes(path.join(s.home, "dev/machine/bin/colima")));
});

test("source environment extension retains host-only PATH and telemetry settings", { skip: !privateSourceEnabled }, () => {
  const s = sim({ mounted: false }), extension = path.join(s.home, "dev/machine/env.private.zsh");
  fs.mkdirSync(path.dirname(extension), { recursive: true });
  fs.mkdirSync(path.join(s.home, "dev/machine/bin"), { recursive: true });
  fs.copyFileSync(path.join(root, "clean-development/machine/env.zsh"), path.join(s.home, "dev/machine/env.zsh"));
  fs.copyFileSync(path.join(root, "machine/env.private.zsh"), extension);
  const env = { ...s.env, PATH: `${path.join(s.home, "dev/bin")}${path.delimiter}/usr/bin:/bin`, DEV_STORAGE_VOLUME_TEST: "absent" };
  const marker = privateTestValue("private_extension_marker");
  assert.match(marker || "", /^[A-Z_][A-Z0-9_]*$/);
  const script = `set -e; . "$HOME/dev/machine/env.zsh"; printf "%s|%s|%s|%s|%s|%s" "$PATH" "$CARGO_HOME" "$CLEAN_DEV_CARGO_CACHE_HOME" "$XDG_DATA_HOME" "$${marker}" "$DEV_ENV_LOADED"`;
  const r = spawnSync("/bin/zsh", ["-c", script], { cwd: s.root, env, encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  const [loadedPath, cargoHome, cargoCacheHome, dataHome, privateExtension, envLoaded] = r.stdout.split("|");
  assert.ok(loadedPath.split(path.delimiter).includes("/usr/bin"));
  assert.ok(!loadedPath.split(path.delimiter).includes(path.join(s.home, "dev/bin")));
  assert.equal(cargoHome, path.join(s.home, "dev/machine/toolchains/rust/cargo"));
  assert.equal(cargoCacheHome, cargoHome, "the private host extension explicitly opts its configured Cargo home into cache cleanup");
  assert.equal(dataHome, path.join(s.home, "dev/machine/state/share"));
  assert.equal(privateExtension, "1");
  assert.equal(envLoaded, "1");
});

test("sidecars created during installer preflight or activation are never overwritten", () => {
  for (const racePhase of ["preflight", "runtime-published"]) {
    const s = sim({ mounted: false }), src = privateMonorepoSource(s);
    const target = path.join(s.home, "dev/machine/env.private.zsh"), hostFile = `host sidecar from ${racePhase}\n`;
    const result = installPackage(src, s.env, { config: true, onPhase: (phase) => {
      if (phase === racePhase) mk(target, hostFile);
    } });
    assert.equal(result.status, "committed");
    assert.equal(fs.readFileSync(target, "utf8"), hostFile, `${racePhase} file must remain host-owned`);
  }
});

test("private sidecar install preserves an existing symlink target", () => {
  const s = sim({ mounted: false }), src = privateMonorepoSource(s), target = path.join(s.home, "dev/machine/env.private.zsh");
  const linked = mk(path.join(s.root, "host-private-env.zsh"), "host-owned sidecar\n");
  fs.symlinkSync(linked, target);
  installPackage(src, s.env, { config: true });
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(target), linked);
  assert.equal(fs.readFileSync(linked, "utf8"), "host-owned sidecar\n");
});

test("private sidecar installer refuses a group- or world-writable source", () => {
  const s = sim({ mounted: false }), src = privateMonorepoSource(s), source = path.join(path.dirname(src), "machine/env.private.zsh");
  fs.chmodSync(source, 0o666);
  try { assert.throws(() => installPackage(src, s.env, { config: true }), /unsafe private sidecar source/); }
  finally { fs.chmodSync(source, 0o600); }
});

test("hook merge preserves unrelated handlers, mode and recovery bytes; preview is read-only", () => {
  const s = sim({ mounted: false }), target = path.join(s.home, ".claude", "settings.json");
  const before = JSON.stringify({ model: "fixture", hooks: { Stop: [{ hooks: [
    { type: "command", command: "unrelated-notifier" },
    { type: "command", command: "'/h/dev/machine/runtime/clean-development/0.5.0/bin/cd-hook' stop claude", async: true }
  ] }] } });
  mk(target, before); fs.chmodSync(target, 0o640);
  const args = ["-I", "-B", path.join(plugin, "fragments", "merge-hooks.py"), path.join(plugin, "fragments", "claude-hooks.json"), target];
  const digest = treeDigest(s.home);
  assert.equal(spawnSync(python, [...args, "--dry-run"], { env: s.env, encoding: "utf8" }).status, 0);
  assert.equal(treeDigest(s.home), digest);
  const r = spawnSync(python, args, { env: s.env, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr);
  const after = fs.readFileSync(target, "utf8"); assert.match(after, /unrelated-notifier/); assert.doesNotMatch(after, /0\.5\.0/);
  const updated = JSON.parse(after);
  assert.equal(updated.model, "fixture");
  assert.equal(updated.hooks.Stop[0].hooks[0].command, "unrelated-notifier");
  assert.equal(updated.hooks.Stop[0].hooks.length, 1, "upgrade removes the managed Stop handler");
  assert.deepEqual(Object.keys(updated.hooks).sort(), ["SessionStart", "Stop"]);
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  const backups = path.join(s.home, "dev", "machine", "state", "clean-development", "hook-backups");
  assert.equal(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0], "original"), "utf8"), before);
  assert.equal(spawnSync(python, args, { env: s.env, encoding: "utf8" }).status, 0);
  assert.equal(fs.readFileSync(target, "utf8"), after, "merge remains byte-idempotent");
});

test("hook merge refuses positional Codex disablement changes before any write", () => {
  const s = sim({ mounted: false }), target = path.join(s.home, ".codex", "hooks.json");
  mk(target, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "old" }] }] } }));
  mk(path.join(s.home, ".codex", "config.toml"), `[hooks.state.${JSON.stringify(`${target}:stop:0:0`)}]\nenabled = false\ntrusted_hash = "old"\n`);
  const before = treeDigest(s.home);
  const r = spawnSync(python, ["-I", "-B", path.join(plugin, "fragments", "merge-hooks.py"), path.join(plugin, "fragments", "codex-hooks.json"), target], { env: s.env, encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /positional/); assert.equal(treeDigest(s.home), before);
});

test("hook merge accepts [features] hooks = true with trust-hash-only state, and still refuses a top-level inline hooks table", () => {
  const s = sim({ mounted: false }), target = path.join(s.home, ".codex", "hooks.json"), config = path.join(s.home, ".codex", "config.toml");
  const merge = () => spawnSync(python, ["-I", "-B", path.join(plugin, "fragments", "merge-hooks.py"), path.join(plugin, "fragments", "codex-hooks.json"), target], { env: s.env, encoding: "utf8" });
  mk(target, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "old" }] }] } }));
  // The supported Codex config shape: the hook feature switch and managed trust hashes.
  mk(config, `model = "x"\n\n[features]\nhooks = true\n\n[hooks.state]\n\n[hooks.state.${JSON.stringify(`${target}:stop:0:0`)}]\ntrusted_hash = "sha256:old"\n`);
  const r = merge();
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(target, "utf8"), /cd-hook/);
  const k = JSON.stringify(`${target}:stop:0:0`);
  for (const text of [
    `hooks = { state = { ${k} = { enabled = false } } }\n[features]\nhooks = true\n`,
    `hooks.state.${k}.enabled = false\n[features]\nhooks = true\n`,
    `"hooks".state = { ${k} = { enabled = false } }\n`,
    `[hooks]\nstate.${k} = { enabled = false }\n`,
    `x = [\n[1, 2],\n]\nhooks = { state = { ${k} = { enabled = false } } }\n`,
    // review: an escaped key, and a multiline string holding a bracket before the real state table.
    `"h\\u006foks" = { state = { ${k} = { enabled = false } } }\n[features]\nhooks = true\n`,
    `developer_instructions = """\n[\n"""\n\n[hooks.state.${k}]\nenabled = false\n`,
    "not toml = = =\n",
    // review round 2: the identities Codex resolves to this file (trimmed, file: prefix, .. and symlink aliases).
    `[hooks.state]\n${JSON.stringify(` ${target}:stop:1:0 `)} = { enabled = false }\n`,
    `[hooks.state.${JSON.stringify(`file:${target}:stop:0:0`)}]\nenabled = false\n`,
    `[hooks.state.${JSON.stringify(`${path.dirname(target)}/../.codex/hooks.json:stop:0:0`)}]\nenabled = false\n`,
    `[hooks.state.${JSON.stringify(`${s.home}/codex-alias/hooks.json:stop:0:0`)}]\nenabled = false\n`,
    `[hooks.state.${k}]\ntrusted_hash = "a"\n\n[hooks.state.${JSON.stringify(` ${target}:stop:0:0`)}]\ntrusted_hash = "b"\n`
  ]) {
    if (!fs.existsSync(path.join(s.home, "codex-alias"))) fs.symlinkSync(path.dirname(target), path.join(s.home, "codex-alias"));
    mk(config, text);
    mk(target, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "old" }] }] } }));
    const refused = merge();
    assert.equal(refused.status, 1, text); assert.match(refused.stderr, /positional/);
  }
  // State for another hooks file, a relative key (Codex never expands one), or trust hashes only, is no positional
  // preference for this target.
  mk(config, `[hooks.state.".codex/hooks.json:stop:0:0"]\nenabled = false\n`);
  mk(target, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "old" }] }] } }));
  assert.equal(merge().status, 0);
  mk(config, `developer_instructions = """\n[\n"""\nx = [\n[1, 2],\n]\n\n[features]\nhooks = true\n\n[hooks.state."/other/hooks.json:stop:0:0"]\nenabled = false\n`);
  mk(target, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "old" }] }] } }));
  assert.equal(merge().status, 0);
  // macOS /usr/bin/python3 (3.9) has no tomllib: the merge refuses with the reason instead of guessing.
  if (fs.existsSync("/usr/bin/python3") && spawnSync("/usr/bin/python3", ["-I", "-c", "import tomllib"]).status !== 0) {
    mk(target, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "old" }] }] } }));
    const old = spawnSync("/usr/bin/python3", ["-I", "-B", path.join(plugin, "fragments", "merge-hooks.py"), path.join(plugin, "fragments", "codex-hooks.json"), target], { env: s.env, encoding: "utf8" });
    assert.equal(old.status, 1); assert.match(old.stderr, /tomllib/);
  }
});

test("installation preserves policy overrides, retains immutable releases and has a receipt", () => {
  const s = sim({ mounted: false });
  fs.appendFileSync(s.config, `LAB_ROOT=${s.home}/dev/approved-travel-lab\n`);
  const selectedNode = path.join(s.root, "stable-node"); fs.symlinkSync(process.execPath, selectedNode);
  const installEnv = { ...s.env, CLEAN_DEV_NODE: selectedNode };
  const before = fs.readFileSync(s.config);
  const r = installPackage(plugin, installEnv, { config: true });
  assert.equal(r.status, "committed"); assert.deepEqual(fs.readFileSync(s.config), before);
  const receipt = JSON.parse(fs.readFileSync(r.receipt));
  assert.equal(receipt.status, "committed"); assert.equal(treeDigest(r.runtime), r.digest);
  const launcher = fs.readFileSync(path.join(s.home, "dev/machine/bin/clean-development"), "utf8");
  assert.ok(launcher.includes(`node='${selectedNode}'`), "the unresolved stable installation path survives Node realpath resolution");
  assert.match(launcher, /node_ok\(\)/, "the installed launcher validates its Node path before use");
  assert.equal(installPackage(plugin, installEnv, { config: true }).digest, r.digest);
  mk(path.join(r.runtime, "unexpected-edit"), "different release bytes");
  assert.throws(() => installPackage(plugin, s.env), /immutable release differs/);
});

for (const phase of ["staged", "runtime-published", "file-0", "file-1", "layout-ready"]) {
  test(`installation failure at ${phase} restores activation bytes and keeps recovery evidence`, () => {
    const s = sim({ mounted: false });
    const wrapper = mk(path.join(s.home, "dev", "machine", "bin", "clean-development"), "old wrapper\n");
    const envFile = mk(path.join(s.home, "dev", "machine", "env.zsh"), "# old env\n");
    const colimaFile = mk(path.join(s.home, "dev", "machine", "bin", "colima"), "old colima\n");
    assert.throws(() => installPackage(plugin, s.env, { config: true, onPhase: (p) => { if (p === phase) throw new Error(`injected ${p}`); } }), /rolled-back/);
    assert.equal(fs.readFileSync(wrapper, "utf8"), "old wrapper\n");
    assert.equal(fs.readFileSync(envFile, "utf8"), "# old env\n");
    assert.equal(fs.readFileSync(colimaFile, "utf8"), "old colima\n");
    const journals = path.join(s.home, "dev", "machine", "state", "clean-development", "installations");
    const receipt = JSON.parse(fs.readFileSync(path.join(journals, fs.readdirSync(journals)[0], "receipt.json")));
    assert.equal(receipt.status, "rolled-back"); assert.equal(receipt.conflicts.length, 0);
  });
}

test("rollback never overwrites a new user edit after activation", () => {
  const s = sim({ mounted: false });
  const wrapper = mk(path.join(s.home, "dev", "machine", "bin", "clean-development"), "old\n");
  assert.throws(() => installPackage(plugin, s.env, { onPhase: (p) => {
    if (p === "file-0") { mk(wrapper, "concurrent user edit\n"); throw new Error("injected conflict"); }
  } }), /recovery-required/);
  assert.equal(fs.readFileSync(wrapper, "utf8"), "concurrent user edit\n");
});

test("activation never overwrites a mode-only user edit made after its backup", () => {
  const s = sim({ mounted: false });
  const wrapper = mk(path.join(s.home, "dev", "machine", "bin", "clean-development"), "old activation\n");
  fs.chmodSync(wrapper, 0o750);
  assert.throws(() => installPackage(plugin, s.env, { onPhase: (phase) => {
    if (phase === "runtime-published") fs.chmodSync(wrapper, 0o600);
  } }), /activation conflict/);
  assert.equal(fs.readFileSync(wrapper, "utf8"), "old activation\n");
  assert.equal(fs.statSync(wrapper).mode & 0o777, 0o600);
  const transactions = path.join(s.home, "dev", "machine", "state", "clean-development", "installations");
  const receipt = JSON.parse(fs.readFileSync(path.join(transactions, fs.readdirSync(transactions)[0], "receipt.json")));
  assert.equal(receipt.status, "rolled-back");
  assert.equal(receipt.files[0].intent, false, "a refused edit is not this installer's output to restore");
  assert.match(receipt.error, /activation conflict/);
});

test("rollback preserves a pre-activation user edit even when it matches the planned output", () => {
  const s = sim({ mounted: false });
  installPackage(plugin, s.env);
  const wrapper = path.join(s.home, "dev", "machine", "bin", "clean-development");
  fs.chmodSync(wrapper, 0o600);
  assert.throws(() => installPackage(plugin, s.env, { onPhase: (phase) => {
    if (phase === "runtime-published") fs.chmodSync(wrapper, 0o755);
  } }), /activation conflict/);
  assert.equal(fs.statSync(wrapper).mode & 0o777, 0o755, "rollback must not claim a user edit as its own write");
});

for (const phase of ["preflight", "runtime-published"]) test(`installer refuses a linked target at ${phase} even when its bytes match the backup`, () => {
  const s = sim({ mounted: false });
  const wrapper = mk(path.join(s.home, "dev", "machine", "bin", "clean-development"), "old activation\n");
  const replacement = mk(path.join(s.home, "replacement"), "old activation\n");
  assert.throws(() => installPackage(plugin, s.env, { onPhase: (p) => {
    if (p === phase) { fs.unlinkSync(wrapper); fs.symlinkSync(replacement, wrapper); }
  } }), /unsafe activation target/);
  assert.equal(fs.readlinkSync(wrapper), replacement);
  assert.equal(fs.readFileSync(replacement, "utf8"), "old activation\n");
});

test("abrupt installer death is explicitly recoverable without deleting the published runtime", () => {
  const s = sim({ mounted: false });
  const wrapper = mk(path.join(s.home, "dev", "machine", "bin", "clean-development"), "old activation\n");
  const script = `import { installPackage } from ${JSON.stringify(pathToFileURL(path.join(plugin, "installer.mjs")).href)};
    installPackage(${JSON.stringify(plugin)}, process.env, { onPhase: (phase) => { if (phase === "file-0") process.exit(71); } });`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: s.root, env: s.env, encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 71, child.stderr);
  const transactions = path.join(s.home, "dev", "machine", "state", "clean-development", "installations");
  const id = fs.readdirSync(transactions)[0];
  const receipt = JSON.parse(fs.readFileSync(path.join(transactions, id, "receipt.json")));
  assert.equal(receipt.status, "activating");
  fs.unlinkSync(path.join(s.home, "dev/machine/state/clean-development/install.lock"));
  assert.throws(() => installPackage(plugin, s.env), /unfinished install transaction/);
  const recovered = spawnSync("/bin/sh", [path.join(plugin, "install.sh"), "--recover", id], {
    cwd: s.root, env: { ...s.env, CLEAN_DEV_NODE: process.execPath }, encoding: "utf8", timeout: 10000 });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(fs.readFileSync(wrapper, "utf8"), "old activation\n");
  assert.equal(treeDigest(receipt.runtime), receipt.digest, "published immutable recovery bytes remain available");
  assert.equal(JSON.parse(fs.readFileSync(path.join(transactions, id, "receipt.json"))).status, "rolled-back");
  installPackage(plugin, s.env);
  const activeWrapper = fs.readFileSync(wrapper, "utf8");
  const staleRecovery = spawnSync("/bin/sh", [path.join(plugin, "install.sh"), "--recover", id], {
    cwd: s.root, env: { ...s.env, CLEAN_DEV_NODE: process.execPath }, encoding: "utf8", timeout: 10000 });
  assert.notEqual(staleRecovery.status, 0); assert.match(staleRecovery.stderr, /no unfinished transaction/);
  assert.equal(fs.readFileSync(wrapper, "utf8"), activeWrapper, "a rolled-back receipt cannot undo a later install");
});

test("abrupt installer death is recoverable through --recover without a manual unlink of install.lock", () => {
  const s = sim({ mounted: false });
  const wrapper = mk(path.join(s.home, "dev", "machine", "bin", "clean-development"), "old activation\n");
  const script = `import { installPackage } from ${JSON.stringify(pathToFileURL(path.join(plugin, "installer.mjs")).href)};
    installPackage(${JSON.stringify(plugin)}, process.env, { onPhase: (phase) => { if (phase === "file-0") process.exit(71); } });`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: s.root, env: s.env, encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 71, child.stderr);
  const transactions = path.join(s.home, "dev", "machine", "state", "clean-development", "installations");
  const id = fs.readdirSync(transactions)[0];
  const receipt = JSON.parse(fs.readFileSync(path.join(transactions, id, "receipt.json")));
  assert.equal(receipt.status, "activating");
  const lock = path.join(s.home, "dev/machine/state/clean-development/install.lock");
  assert.equal(fs.existsSync(lock), true, "the dead installer left its lock");
  const recovered = spawnSync("/bin/sh", [path.join(plugin, "install.sh"), "--recover", id], {
    cwd: s.root, env: { ...s.env, CLEAN_DEV_NODE: process.execPath }, encoding: "utf8", timeout: 10000 });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stderr, /install\.lock reclaimed: owner exited \(lock free\)/);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.readFileSync(wrapper, "utf8"), "old activation\n");
  assert.equal(treeDigest(receipt.runtime), receipt.digest, "published immutable recovery bytes remain available");
  assert.equal(JSON.parse(fs.readFileSync(path.join(transactions, id, "receipt.json"))).status, "rolled-back");
  installPackage(plugin, s.env);
  const activeWrapper = fs.readFileSync(wrapper, "utf8");
  const staleRecovery = spawnSync("/bin/sh", [path.join(plugin, "install.sh"), "--recover", id], {
    cwd: s.root, env: { ...s.env, CLEAN_DEV_NODE: process.execPath }, encoding: "utf8", timeout: 10000 });
  assert.notEqual(staleRecovery.status, 0); assert.match(staleRecovery.stderr, /no unfinished transaction/);
  assert.equal(fs.readFileSync(wrapper, "utf8"), activeWrapper, "a rolled-back receipt cannot undo a later install");
});

test("installer recovery can record a reviewed user edit without overwriting it", () => {
  const s = sim({ mounted: false }), parent = path.join(s.root, "accept-current-source"), src = path.join(parent, "clean-development");
  fs.mkdirSync(parent, { recursive: true }); fs.symlinkSync(plugin, src, "dir");
  const envFile = mk(path.join(s.home, "dev/machine/env.zsh"), "old environment\n");
  const script = `import { installPackage } from ${JSON.stringify(pathToFileURL(path.join(src, "installer.mjs")).href)};
    installPackage(${JSON.stringify(src)}, process.env, { config: true, onPhase: (phase) => { if (phase === "file-2") process.exit(71); } });`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: s.root, env: s.env, encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 71, child.stderr);
  const transactions = path.join(s.home, "dev/machine/state/clean-development/installations"), id = fs.readdirSync(transactions)[0];
  const receiptFile = path.join(transactions, id, "receipt.json");
  fs.writeFileSync(envFile, "user reviewed environment\n");
  fs.unlinkSync(path.join(s.home, "dev/machine/state/clean-development/install.lock"));
  const recoverArgs = [path.join(src, "install.sh"), "--recover", id];
  const recoverEnv = { ...s.env, CLEAN_DEV_NODE: process.execPath };
  const first = spawnSync("/bin/sh", recoverArgs, { cwd: s.root, env: recoverEnv, encoding: "utf8", timeout: 10000 });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, "recovery-required");
  assert.throws(() => installPackage(src, s.env), /unfinished install transaction/);
  const accepted = spawnSync("/bin/sh", [...recoverArgs, "--accept-current"], { cwd: s.root, env: recoverEnv, encoding: "utf8", timeout: 10000 });
  assert.equal(accepted.status, 0, accepted.stderr);
  const result = JSON.parse(accepted.stdout);
  assert.equal(result.status, "recovered-preserving-conflicts");
  assert.deepEqual(result.preserved, [envFile]);
  assert.equal(fs.readFileSync(envFile, "utf8"), "user reviewed environment\n");
  assert.equal(JSON.parse(fs.readFileSync(receiptFile)).status, "recovered-preserving-conflicts");
  installPackage(src, s.env);
  assert.equal(fs.readFileSync(envFile, "utf8"), "user reviewed environment\n");
  const stale = spawnSync("/bin/sh", recoverArgs, { cwd: s.root, env: recoverEnv, encoding: "utf8", timeout: 10000 });
  assert.notEqual(stale.status, 0); assert.match(stale.stderr, /no unfinished transaction/);
  const invalid = spawnSync("/bin/sh", [path.join(src, "install.sh"), "--accept-current"], { cwd: s.root, env: recoverEnv, encoding: "utf8", timeout: 10000 });
  assert.equal(invalid.status, 2); assert.match(invalid.stderr, /requires --recover/);
});

test("rollback restores file mode even when old and new activation bytes are identical", () => {
  const s = sim({ mounted: false });
  installPackage(plugin, s.env);
  const wrapper = path.join(s.home, "dev", "machine", "bin", "clean-development");
  fs.chmodSync(wrapper, 0o600);
  assert.throws(() => installPackage(plugin, s.env, { onPhase: (phase) => { if (phase === "file-0") throw new Error("mode rollback fixture"); } }), /rolled-back/);
  assert.equal(fs.statSync(wrapper).mode & 0o777, 0o600);
});

// Removed-event merging uses the existing quoted-command grammar and preserves unrelated order.
test("hook merge drops managed Stop and SessionEnd entries while preserving mixed groups", () => {
  for (const harness of ["claude", "codex"]) {
    const s = sim({ mounted: false }), target = path.join(s.home, ".config", "settings.json");
    const managed = (event) => ({ type: "command", command: `"$HOME/dev/machine/runtime/clean-development/active/bin/cd-hook" ${event} ${harness}` });
    const unrelated = { type: "command", command: "unrelated" };
    mk(target, JSON.stringify({ hooks: {
      Stop: [{ matcher: "keep", hooks: [managed("stop"), unrelated, managed("stop")] }, { hooks: [unrelated] }],
      SessionEnd: [{ hooks: [managed("session-end")] }],
      Other: [{ hooks: [unrelated] }]
    } }));
    const r = spawnSync(python, ["-I", "-B", path.join(plugin, "fragments/merge-hooks.py"), path.join(plugin, `fragments/${harness}-hooks.json`), target], { env: s.env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(fs.readFileSync(target));
    assert.equal(doc.hooks.SessionEnd, undefined);
    assert.deepEqual(doc.hooks.Stop, [{ matcher: "keep", hooks: [unrelated] }, { hooks: [unrelated] }]);
    assert.deepEqual(doc.hooks.Other, [{ hooks: [unrelated] }]);
    assert.deepEqual(Object.keys(doc.hooks).sort(), ["Other", "SessionStart", "Stop"]);
  }
});

test("hook merge refuses customised stale handlers and preserves all bytes on failure", () => {
  for (const command of [
    '"$HOME/dev/machine/runtime/clean-development/active/bin/cd-hook" stop claude --custom',
    '"$HOME/dev/machine/runtime/clean-development/active/bin/cd-hook" session-end claude',
    '"$HOME/dev/machine/runtime/clean-development/active/bin/other" stop claude'
  ]) {
    const s = sim({ mounted: false }), target = path.join(s.home, ".claude", "settings.json");
    const before = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } });
    mk(target, before);
    const digest = treeDigest(s.home);
    const r = spawnSync(python, ["-I", "-B", path.join(plugin, "fragments/merge-hooks.py"), path.join(plugin, "fragments/claude-hooks.json"), target], { env: s.env, encoding: "utf8" });
    assert.equal(r.status, 1); assert.match(r.stderr, /customized managed command requires review: Stop/);
    assert.equal(treeDigest(s.home), digest); assert.equal(fs.readFileSync(target, "utf8"), before);
  }
});

// Release upgrades never use the real HOME, runtime root or harness configuration.
function legacyRelease() {
  const s = sim({ mounted: false }), legacy = path.join(runtimeRoot(s.env), "0.7.0");
  const wrapper = mk(path.join(s.home, "dev/machine/bin/clean-development"),
    '#!/bin/sh\nif [ "$1" = version ]; then echo 0.7.0; exit 0; fi\necho "unexpected legacy command: $*" >&2\nexit 89\n');
  fs.chmodSync(wrapper, 0o755);
  mk(path.join(legacy, "VERSION"), "0.7.0\n");
  fs.chmodSync(mk(path.join(legacy, "bin/cd-hook"), "#!/bin/sh\nexit 0\n"), 0o755);
  fs.chmodSync(mk(hookShimPath(s.env), hookShimText(s.env, "0.7.0")), 0o755);
  const hooks = {};
  for (const harness of ["claude", "codex"]) {
    const target = path.join(s.home, `.${harness}`, harness === "claude" ? "settings.json" : "hooks.json");
    const managed = (action) => ({ type: "command", command: `"$HOME/dev/machine/runtime/clean-development/0.7.0/bin/cd-hook" ${action} ${harness}` });
    mk(target, JSON.stringify({ keep: harness, hooks: {
      SessionStart: [{ hooks: [managed("session-start")] }],
      Stop: [{ hooks: [managed("stop"), { type: "command", command: "keep-other-stop" }] }],
      SessionEnd: [{ hooks: [managed("session-end")] }]
    } }));
    hooks[harness] = target;
  }
  const codexConfig = mk(path.join(s.home, ".codex/config.toml"), '[features]\nhooks = true\n');
  const envFile = mk(path.join(s.home, "dev/machine/env.zsh"), "# original environment\n");
  const activation = [wrapper, hookShimPath(s.env), envFile, ...Object.values(hooks)];
  return { ...s, legacy, wrapper, hooks, codexConfig, activation, before: activation.map((file) => fs.readFileSync(file)),
    legacyDigest: treeDigest(legacy), env: { ...s.env, CLEAN_DEV_NODE: process.execPath } };
}

function rollbackRecords(s, dir = path.join(runtimeRoot(s.env), "rollback")) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((name) => path.join(dir, name)) : [];
}

test("current release upgrade records rollback before switching, refreshes hooks and retains 0.7.0", () => {
  const s = legacyRelease();
  let record;
  let observed = false;
  const result = installPackage(plugin, s.env, { config: true, onPhase: (phase) => {
    if (phase !== "rollback-recorded") return;
    observed = true;
    [record] = rollbackRecords(s);
    const text = fs.readFileSync(record, "utf8");
    assert.ok(text.includes(`rt='${s.legacy}'`)); assert.match(text, /--rollback/);
    s.activation.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), s.before[index]));
  } });
  assert.ok(observed); assert.equal(result.version, VERSION);
  assert.equal(treeDigest(s.legacy), s.legacyDigest);
  assert.equal(spawnSync(s.wrapper, ["version"], { env: s.env, encoding: "utf8" }).stdout.trim(), VERSION);
  assert.ok(fs.readFileSync(hookShimPath(s.env), "utf8").includes(result.runtime));
  for (const [harness, target] of Object.entries(s.hooks)) {
    const document = JSON.parse(fs.readFileSync(target));
    assert.equal(document.keep, harness); assert.equal(document.hooks.SessionEnd, undefined);
    assert.deepEqual(document.hooks.Stop, [{ hooks: [{ type: "command", command: "keep-other-stop" }] }]);
    assert.deepEqual(document.hooks.SessionStart, JSON.parse(fs.readFileSync(path.join(plugin, `fragments/${harness}-hooks.json`))).hooks.SessionStart);
  }
  assert.equal(fs.readFileSync(s.codexConfig, "utf8"), '[features]\nhooks = true\n');
  const firstBytes = fs.readFileSync(record);
  const sourceCommit = spawnSync("git", ["-C", plugin, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(firstBytes.toString().includes(`Source commit: ${sourceCommit}`));
  assert.match(path.basename(record), new RegExp(`^rollback-\\d{4}-\\d{2}-\\d{2}T.*Z-.*-from-0\\.7\\.0-to-${VERSION.replaceAll(".", "\\.")}\\.md$`));
  const retried = installPackage(plugin, s.env, { config: true });
  assert.equal(retried.digest, result.digest);
  assert.equal(treeDigest(s.legacy), s.legacyDigest);
  assert.deepEqual(fs.readFileSync(record), firstBytes, "retry never rewrites the first record");
  const records = rollbackRecords(s);
  assert.equal(records.length, 2);
  const second = records.find((file) => file !== record);
  assert.ok(path.basename(second).includes(`-from-${VERSION}-to-${VERSION}.md`));
  assert.ok(fs.readFileSync(second, "utf8").includes(JSON.parse(fs.readFileSync(retried.receipt)).id));
});

for (const phase of ["rollback-recorded", "file-3", "layout-ready"]) {
  test(`upgrade failure at ${phase} restores all activation files and retry succeeds`, () => {
    const s = legacyRelease();
    assert.throws(() => installPackage(plugin, s.env, { config: true, onPhase: (current) => {
      if (current === phase) throw new Error(`injected ${phase}`);
    } }), /rolled-back/);
    s.activation.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), s.before[index]));
    assert.equal(treeDigest(s.legacy), s.legacyDigest);
    assert.equal(installPackage(plugin, s.env, { config: true }).status, "committed");
  });
}

test("recorded rollback command restores a committed upgrade and refuses repeated rollback", () => {
  const s = legacyRelease();
  const installed = installPackage(plugin, s.env, { config: true });
  const text = fs.readFileSync(rollbackRecords(s)[0], "utf8");
  const command = text.split("```sh\n")[1].split("\n```")[0];
  const result = spawnSync("/bin/sh", ["-c", command], { cwd: s.root, env: s.env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, "rolled-back");
  s.activation.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), s.before[index]));
  assert.equal(treeDigest(s.legacy), s.legacyDigest); assert.equal(treeDigest(installed.runtime), installed.digest);
  const repeated = spawnSync("/bin/sh", ["-c", command], { cwd: s.root, env: s.env, encoding: "utf8", timeout: 15000 });
  assert.equal(repeated.status, 1); assert.match(repeated.stderr, /no committed transaction/);
  console.log(`negative rollback: ${repeated.stderr.trim()}`);
  assert.equal(installPackage(plugin, s.env, { config: true }).status, "committed");
});

test("upgrade refuses unsafe rollback record before activation and succeeds after correction", () => {
  const s = legacyRelease(), recordDir = path.join(s.root, "records");
  fs.symlinkSync(path.dirname(s.wrapper), recordDir, "dir");
  assert.throws(() => installPackage(plugin, s.env, { recordDir }), (error) => {
    assert.match(error.message, /unsafe rollback record directory/); console.log(`negative record: ${error.message}`); return true;
  });
  s.activation.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), s.before[index]));
  fs.unlinkSync(recordDir); assert.equal(installPackage(plugin, s.env, { recordDir }).status, "committed");
});

test("upgrade refuses customised hooks and Codex preferences before switching and permits retry", () => {
  for (const refusal of ["custom-command", "codex-preferences"]) {
    const s = legacyRelease(), target = refusal === "custom-command" ? s.hooks.claude : s.codexConfig;
    const original = fs.readFileSync(target);
    if (refusal === "custom-command") fs.writeFileSync(target, original.toString().replace('stop claude', 'stop claude --custom'));
    else fs.appendFileSync(target, `\n[hooks.state.${JSON.stringify(`${s.hooks.codex}:stop:0:0`)}]\nenabled = false\n`);
    const before = treeDigest(s.home);
    assert.throws(() => installPackage(plugin, s.env), (error) => {
      assert.match(error.message, /customized managed command|positional disablement/);
      console.log(`negative ${refusal}: ${error.message.trim()}`); return true;
    });
    assert.equal(treeDigest(s.home), before);
    fs.writeFileSync(target, original); assert.equal(installPackage(plugin, s.env).status, "committed");
  }
});

test("upgrade refuses hooks changed after preflight and preserves the new edit", () => {
  const s = legacyRelease();
  assert.throws(() => installPackage(plugin, s.env, { onPhase: (phase) => {
    if (phase === "preflight") fs.writeFileSync(s.hooks.claude, '{"hooks":{},"new":"user edit"}');
  } }), (error) => {
    assert.match(error.message, /hook changed after preflight/); console.log(`negative hook race: ${error.message}`); return true;
  });
  assert.equal(JSON.parse(fs.readFileSync(s.hooks.claude)).new, "user edit");
  assert.deepEqual(fs.readFileSync(s.wrapper), s.before[0]);
  assert.equal(installPackage(plugin, s.env).status, "committed");
});

test("rollback options require an ID and cannot combine with install or recovery options", () => {
  const s = legacyRelease();
  for (const args of [["--rollback"], ["--rollback", "id", "--config"], ["--rollback", "id", "--recover", "id"]]) {
    const result = spawnSync(process.execPath, [path.join(plugin, "installer.mjs"), ...args], { env: s.env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 2); assert.match(result.stderr, /needs a transaction ID|cannot be combined/);
    console.log(`negative options: ${result.stderr.trim()}`);
  }
});


test("record-dir CLI supports quoted paths outside home, previews without writes and records first installs", () => {
  const s = sim(), recordDir = path.join(s.root, "records with 'quote");
  const run = (args) => spawnSync(process.execPath, [path.join(plugin, "installer.mjs"), ...args], {
    cwd: s.root, env: s.env, encoding: "utf8", timeout: 15000
  });
  const before = treeDigest(s.root);
  const preview = run(["--dry-run", "--record-dir", path.basename(recordDir)]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(treeDigest(s.root), before);
  for (let i = 0; i < 2; i++) {
    const installed = run(["--record-dir", path.basename(recordDir)]);
    assert.equal(installed.status, 0, installed.stderr);
  }
  const records = rollbackRecords(s, recordDir);
  assert.equal(records.length, 2);
  assert.ok(records.some((file) => path.basename(file).includes(`-from-none-to-${VERSION}.md`)));
  assert.deepEqual(rollbackRecords(s), [], "custom directory replaces the default");
  for (const file of records) {
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /Source commit: [a-f0-9]{40}/);
    assert.match(text, /--rollback/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test("record-dir option refuses missing values and recovery combinations without writes", () => {
  const s = sim(), before = treeDigest(s.root);
  for (const args of [["--record-dir"], ["--record-dir", "--config"],
    ["--record-dir", s.root, "--recover", "id"], ["--rollback", "id", "--record-dir", s.root]]) {
    const result = spawnSync(process.execPath, [path.join(plugin, "installer.mjs"), ...args], { env: s.env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /needs a directory|cannot be combined/);
    console.log(`negative record-dir options: ${result.stderr.trim()}`);
  }
  assert.equal(treeDigest(s.root), before);
});


test("rollback record publication failure preserves activation and permits retry without overwriting a record", () => {
  const s = legacyRelease(), recordDir = path.join(s.root, "records");
  const link = fs.linkSync;
  let collision;
  fs.linkSync = (src, dest) => {
    if (path.dirname(dest) === recordDir) {
      collision = dest;
      fs.writeFileSync(dest, "existing rollback record");
    }
    return link(src, dest);
  };
  try {
    assert.throws(() => installPackage(plugin, s.env, { recordDir }), (error) => {
      assert.match(error.message, /EEXIST.*transaction rolled-back/s);
      console.log(`negative record collision: ${error.message}`);
      return true;
    });
  } finally { fs.linkSync = link; }
  s.activation.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), s.before[index]));
  assert.equal(fs.readFileSync(collision, "utf8"), "existing rollback record");
  const retry = installPackage(plugin, s.env, { recordDir });
  assert.equal(retry.status, "committed");
  assert.notEqual(retry.rollbackRecord, collision);
  assert.equal(fs.readFileSync(collision, "utf8"), "existing rollback record");
});
