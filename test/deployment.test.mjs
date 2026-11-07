import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { applyTrust, managedTrustEntries, tomlPython, verifyTrustEdit } from "../runtime/lib/codex-trust.mjs";
import { installPackage, treeDigest } from "../installer.mjs";
import { cli, sim, mk, plugin, privateSourceEnabled } from "./helpers.mjs";

const root = path.dirname(plugin);
const python = process.env.CLEAN_DEV_TEST_PYTHON || tomlPython(process.env) || "python3";

test("trust refresh keeps disablement and unknown/removed/unrelated hook state", () => {
  const key = "/h/.codex/hooks.json:stop:0:0";
  const before = `[hooks.state.${JSON.stringify(key)}]\nenabled = false\nfuture_option = 'keep'\ntrusted_hash = "sha256:old"\n\n[hooks.state."/h/.codex/hooks.json:stop:1:0"]\nenabled = false\n\n[analytics]\nenabled = false\n`;
  const after = applyTrust(before, "/h/.codex/hooks.json", [{ key, hash: "sha256:new" }]);
  assert.match(after, /enabled = false\nfuture_option = 'keep'/);
  assert.match(after, /sha256:new/); assert.doesNotMatch(after, /sha256:old/);
  assert.match(after, /hooks\.json:stop:1:0/);
  assert.equal(applyTrust(after, "/h/.codex/hooks.json", [{ key, hash: "sha256:new" }]), after);
  const parsed = spawnSync(python, ["-I", "-c", "import sys,tomllib; t=tomllib.loads(sys.stdin.read()); assert t['hooks']['state'][sys.argv[1]]['enabled'] is False", key], { input: after, encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
});

test("default trust scope never approves unrelated command handlers", () => {
  const entries = managedTrustEntries("/h/hooks.json", { hooks: { Stop: [{ hooks: [
    { type: "command", command: "unrelated-user-hook" },
    { type: "command", command: "'/h/dev/machine/runtime/clean-development/0.6.0/bin/cd-hook' stop codex" },
    { type: "command", command: "echo '/h/dev/machine/runtime/clean-development/0.6.0/bin/cd-hook' stop codex" },
    { type: "command", command: "'/h/dev/machine/runtime/clean-development/0.6.0/bin/cd-hook' stop codex; unrelated-command" },
    { type: "command", command: "'/h/dev/machine/runtime/clean-development/0.6.0/bin/cd-hook' stop claude" }
  ] }] } });
  assert.deepEqual(entries.map((e) => e.key), ["/h/hooks.json:stop:0:1"]);
});

test("restricted offline trust editor refuses ambiguous TOML instead of duplicating state", () => {
  const key = "/h/hooks.json:stop:0:0", entries = [{ key, hash: "sha256:new" }];
  for (const text of [
    `[hooks.state.'${key}']\nenabled = false\n`,
    `[hooks . state . "${key}"]\nenabled = false\n`,
    '[hooks]\nstate = { slot = { enabled = false } }\n',
    'prompt = """\n[hooks.state."not-an-actual-table"]\n"""\n'
  ]) assert.throws(() => applyTrust(text, "/h/hooks.json", entries), /outside the safe editor's supported subset/);
});

test("trust editor accepts the [features] hooks = true switch but refuses root hook state in every spelling", () => {
  const key = "/h/hooks.json:stop:0:0", entries = [{ key, hash: "sha256:new" }];
  // The live ~/.codex shape on 6 Nov 2026 (0.6.2 canary): `codex-trust --apply` refused it as inline hook state.
  const live = `model = "x"\nx = [\n[1, 2],\n]\n\n[features]\nhooks = true\n\n[hooks.state]\n\n[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "sha256:old"\n`;
  const after = applyTrust(live, "/h/hooks.json", entries);
  const r = spawnSync(python, ["-I", "-B", "-c", "import tomllib,sys; d=tomllib.loads(sys.stdin.read()); assert d['features']['hooks'] is True and d['hooks']['state'][sys.argv[1]] == {'trusted_hash':'sha256:new'}, d", key], { input: after, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const text of [
    'hooks = { state = { x = { enabled = false } } }\n[features]\nhooks = true\n',
    'hooks.state."x".enabled = false\n',
    '"hooks" . state = { x = { enabled = false } }\n',
    "'hooks'.'state'.x.enabled = false\n",
    '[hooks]\nstate.x = { enabled = false }\n',
    '[hooks]\n"state" = { x = { enabled = false } }\n',
    // An array element line starting with [ is not a table header, so the root table continues past it.
    'x = [\n[1, 2],\n]\nhooks = { state = { x = { enabled = false } } }\n',
    // 0.6.3 review: escaped spellings of hooks.state, and a quoted trusted_hash a bare one would duplicate.
    `"h\\u006foks" = { state = { ${JSON.stringify(key)} = { enabled = false } } }\n[features]\nhooks = true\n`,
    `["h\\u006foks".state.${JSON.stringify(key)}]\nenabled = false\n`,
    `[hooks]\n"st\\u0061te" = { x = { enabled = false } }\n`,
    `[features]\nhooks = true\n\n[hooks.state.${JSON.stringify(key)}]\n"trusted_hash" = "sha256:old"\n`
  ]) assert.throws(() => applyTrust(text, "/h/hooks.json", entries), /outside the safe editor's supported subset/, text);
});

test("verifyTrustEdit passes only an edit equal to the old config plus the supplied hashes", () => {
  const key = "/h/hooks.json:stop:0:0", entries = [{ key, hash: "sha256:new" }];
  const before = `[features]\nhooks = true\n\n[hooks.state.${JSON.stringify(key)}]\nenabled = false\ntrusted_hash = "sha256:old"\n`;
  verifyTrustEdit(before, applyTrust(before, "/h/hooks.json", entries), entries);
  verifyTrustEdit("model = \"x\"\n", applyTrust("model = \"x\"\n", "/h/hooks.json", entries), entries);
  const env = { ...process.env, CLEAN_DEV_PYTHON: python };
  for (const [after, why] of [
    [before.replace('trusted_hash = "sha256:old"', 'trusted_hash = "sha256:old"\ntrusted_hash = "sha256:new"'), /does not parse/],
    [before.replace("enabled = false", "enabled = true").replace("sha256:old", "sha256:new"), /changes more/],
    [before, /changes more/],
    [`${before}\n[hooks.state."/h/hooks.json:stop:9:9"]\ntrusted_hash = "sha256:new"\n`.replace("sha256:old", "sha256:new"), /changes more/]
  ]) assert.throws(() => verifyTrustEdit(before, after, entries, env), why);
  assert.throws(() => verifyTrustEdit("x = \n", "x = 1\n", entries, env), /does not parse/);
  // 0.6.3 review round 2: type-exact comparison, NaN, and Codex's trimmed key identity.
  assert.throws(() => verifyTrustEdit("flag = 1\n", `flag = true\n\n[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "sha256:new"\n`, entries, env), /changes more/);
  const nan = `x = nan\n\n[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "sha256:old"\n`;
  verifyTrustEdit(nan, applyTrust(nan, "/h/hooks.json", entries), entries, env);
  const alias = `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "sha256:old"\n\n[hooks.state.${JSON.stringify(` ${key} `)}]\ntrusted_hash = "sha256:other"\n`;
  assert.throws(() => verifyTrustEdit(alias, applyTrust(alias, "/h/hooks.json", entries), entries, env), /collide once trimmed/);
});

test("trust verification discovers Python 3.11+ from PATH", () => {
  const s = sim({ mounted: false }), supported = tomlPython(process.env);
  assert.ok(supported, "the Codex trust suite requires Python with tomllib");
  const bin = path.join(s.root, "python-bin"), executable = path.join(bin, "python3");
  fs.mkdirSync(bin); fs.symlinkSync(supported, executable);
  assert.equal(tomlPython({ PATH: bin }), executable);
});

test("verifyTrustEdit needs the interpreter's nonce answer and kills a hung interpreter", () => {
  const key = "/h/hooks.json:stop:0:0", entries = [{ key, hash: "sha256:new" }], before = "model = \"x\"\n";
  const after = applyTrust(before, "/h/hooks.json", entries), s = sim({ mounted: false });
  // /usr/bin/true exits 0 for the tomllib probe and for the check, but never answers.
  assert.throws(() => verifyTrustEdit(before, "garbage = = =\n", entries, { ...process.env, CLEAN_DEV_PYTHON: "/usr/bin/true" }), /without the verification answer/);
  // An interpreter that passes the probe, then ignores SIGTERM: SIGKILL at the deadline, refused, no hang.
  const hung = mk(path.join(s.root, "hung-python"), "#!/bin/sh\ncase \"$4\" in 'import tomllib') exit 0 ;; esac\ntrap '' TERM\nexec /bin/sleep 20\n");
  fs.chmodSync(hung, 0o755);
  const start = Date.now();
  assert.throws(() => verifyTrustEdit(before, after, entries, { ...process.env, CLEAN_DEV_PYTHON: hung }, { timeoutMs: 500 }), /ETIMEDOUT|killed/);
  assert.ok(Date.now() - start < 5000, `returned after ${Date.now() - start} ms`);
});

test("codex-trust --apply writes the live [features] hooks = true shape and leaves a refused config byte-identical", () => {
  const s = sim({ mounted: false }), hooks = path.join(s.home, ".codex", "hooks.json"), config = path.join(s.home, ".codex", "config.toml");
  const command = `'${path.join(s.home, "dev", "machine", "runtime", "clean-development", "active", "bin", "cd-hook")}' stop codex`;
  mk(hooks, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command, async: true, timeout: 5 }] }] } }));
  const [entry] = managedTrustEntries(hooks, JSON.parse(fs.readFileSync(hooks, "utf8")));
  assert.ok(entry, "managed Stop handler selected");
  mk(config, `model = "x"\n\n[features]\nhooks = true\n\n[hooks.state]\n\n[hooks.state.${JSON.stringify(entry.key)}]\ntrusted_hash = "sha256:old"\n`);
  const r = cli(s, ["codex-trust", "--hooks", hooks, "--config", config, "--apply"]);
  assert.equal(r.status, 0, r.stderr);
  const check = spawnSync(python, ["-I", "-B", "-c", "import tomllib,sys; d=tomllib.loads(open(sys.argv[1]).read()); assert d['features']['hooks'] is True and d['hooks']['state'][sys.argv[2]] == {'trusted_hash': sys.argv[3]}, d", config, entry.key, entry.hash], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  // Refused by applyTrust's scan, and (alias collision) by the verifier alone: both leave config.toml byte-identical.
  for (const text of [
    `"h\\u006foks" = { state = { ${JSON.stringify(entry.key)} = { enabled = false } } }\n\n[features]\nhooks = true\n`,
    `[features]\nhooks = true\n\n[hooks.state.${JSON.stringify(entry.key)}]\ntrusted_hash = "sha256:old"\n\n[hooks.state.${JSON.stringify(` ${entry.key} `)}]\ntrusted_hash = "sha256:other"\n`
  ]) {
    mk(config, text);
    const refused = cli(s, ["codex-trust", "--hooks", hooks, "--config", config, "--apply"]);
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /outside the safe editor's supported subset|hook-state keys collide once trimmed/);
    assert.equal(fs.readFileSync(config, "utf8"), text);
  }
  assert.doesNotThrow(() => applyTrust(fs.readFileSync(config, "utf8"), hooks, [entry]), "the alias case is the verifier's alone");
});

test("trust upsert retains multiline unknown arrays and replaces indented hashes only once", () => {
  const key = "/h/hooks.json:stop:0:0";
  const before = `[hooks.state.${JSON.stringify(key)}]\nfuture = [\n[1, 2],\n[3, 4]\n]\n  trusted_hash = "old"\nenabled = false\n`;
  const after = applyTrust(before, "/h/hooks.json", [{ key, hash: "new" }]);
  const r = spawnSync(python, ["-I", "-B", "-c", "import tomllib,sys; s=tomllib.loads(sys.stdin.read())['hooks']['state'][sys.argv[1]]; assert s == {'future':[[1,2],[3,4]],'trusted_hash':'new','enabled':False}", key], { input: after, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("an existing empty trust table at EOF is updated without duplicate identities", () => {
  const key = "/h/hooks.json:stop:0:0";
  const after = applyTrust(`[hooks.state.${JSON.stringify(key)}]`, "/h/hooks.json", [{ key, hash: "new" }]);
  const r = spawnSync(python, ["-I", "-B", "-c", "import tomllib,sys; assert tomllib.loads(sys.stdin.read())['hooks']['state'][sys.argv[1]]['trusted_hash']=='new'", key], { input: after, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("Codex config rebuild carries live hook-state blocks rather than staged state", { skip: !privateSourceEnabled || !fs.existsSync(path.join(root, "bin", "codex-config-install")) }, () => {
  const s = sim({ mounted: false });
  const script = `import runpy,sys,tomllib\nm=runpy.run_path(sys.argv[1]); names=m['APP_MANAGED']; assert 'hooks.state' in names\nstaged='[hooks.state."slot"]\\nenabled = true\\n'\nlive='[hooks.state."slot"]\\nenabled = false\\nfuture_option = "keep"\\n'\nsb=m['blocks'](staged); lb=m['blocks'](live)\nout=''.join(t for k,t in sb if k and not m['family'](k,names)) + ''.join(t for k,t in lb if m['family'](k,('hooks.state',)))\nassert tomllib.loads(out)['hooks']['state']['slot'] == {'enabled':False,'future_option':'keep'}\n`;
  const r = spawnSync(python, ["-I", "-B", "-c", script, path.join(root, "bin", "codex-config-install")], { cwd: s.root, env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("Codex host trust updates preserve whole state and never enable disabled handlers", { skip: !privateSourceEnabled || !fs.existsSync(path.join(root, "bin", "codex-hooks-trust")) }, () => {
  const s = sim({ mounted: false });
  const script = `import runpy,sys\nm=runpy.run_path(sys.argv[1])\nold={'disabled':{'enabled':False,'future':'keep'},'enabled':{'future':'keep'},'unrelated':{'enabled':False}}\nitems=[{'key':k,'trustStatus':'modified','source':'user','currentHash':'sha256:new','enabled':True} for k in ('disabled','enabled')]\nstate,n=m['refreshed_state'](items,('user',),old)\nassert n==1 and state['disabled']==old['disabled'] and state['unrelated']==old['unrelated']\nassert state['enabled']=={'future':'keep','trusted_hash':'sha256:new'}\n`;
  const r = spawnSync(python, ["-I", "-B", "-c", script, path.join(root, "bin", "codex-hooks-trust")], { cwd: s.root, env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("Codex config installation refuses to reassign positional disabled state to changed hooks", { skip: !privateSourceEnabled || !fs.existsSync(path.join(root, "bin", "codex-config-install")) }, () => {
  const s = sim({ mounted: false }), codex = path.join(s.home, ".codex"), staged = path.join(s.root, "staged");
  mk(path.join(codex, "hooks.json"), JSON.stringify({ hooks: { Stop: ["first", "second"] } }));
  mk(path.join(staged, "hooks.json"), JSON.stringify({ hooks: { Stop: ["second", "first"] } }));
  const script = `import runpy,sys\nm=runpy.run_path(sys.argv[1])\nlive={'hooks':{'state':{sys.argv[2]+'/hooks.json:stop:0:0':{'enabled':False,'trusted_hash':'old'}}}}\nassert m['hook_state_errors'](live,sys.argv[2],sys.argv[3])\n`;
  const r = spawnSync(python, ["-I", "-B", "-c", script, path.join(root, "bin", "codex-config-install"), codex, staged], { cwd: s.root, env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("both installer previews and unknown flags leave a fabricated HOME byte-identical", () => {
  const s = sim({ mounted: false });
  const before = treeDigest(s.home);
  for (const [file, shell, args, expected] of [
    [path.join(plugin, "install.sh"), "/bin/sh", ["--dry-run", "--config"], 0],
    [path.join(plugin, "install.sh"), "/bin/sh", ["--config", "--dry-run"], 0],
    [path.join(plugin, "install.sh"), "/bin/sh", ["--unknown"], 2],
    ...(privateSourceEnabled && fs.existsSync(path.join(root, "claude-tooling", "install.sh")) ? [
      [path.join(root, "claude-tooling", "install.sh"), "/bin/bash", ["--dry-run"], 0],
      [path.join(root, "claude-tooling", "install.sh"), "/bin/bash", ["--unknown"], 2]
    ] : [])
  ]) {
    const r = spawnSync(shell, [file, ...args], { env: { ...s.env, CLEAN_DEV_NODE: process.execPath }, cwd: s.root, encoding: "utf8", timeout: 15000 });
    assert.equal(r.status, expected, r.stderr);
    assert.equal(treeDigest(s.home), before, `${file} ${args} must not write HOME`);
  }
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
    ["machine/clean-development/claude-settings.list", "~/dev/machine/state/agent-profiles/shared/settings.json\n"],
    ["machine/clean-development/claude-profiles.list", "~/dev/machine/state/agent-profiles/profiles/example/settings.json\n"]
  ];
  for (const [relative, contents] of sources) mk(path.join(parent, relative), contents);
  mk(path.join(parent, ".clean-development-private-sidecars.json"), JSON.stringify({ schemaVersion: 1, sidecars: [
    ...sources.map(([relative]) => relative), "clean-development/machine/colima"
  ] }));
  return src;
}

test("the private monorepo installs missing sidecars before env.zsh and preserves existing host edits", () => {
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
  assert.equal(fs.readFileSync(path.join(s.home, "dev/machine/state/clean-development/claude-profiles.list"), "utf8"), "~/dev/machine/state/agent-profiles/profiles/example/settings.json\n");
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

test("private monorepo environment extension retains host-only PATH and telemetry settings", { skip: !privateSourceEnabled }, () => {
  const s = sim({ mounted: false }), extension = path.join(s.home, "dev/machine/env.private.zsh");
  fs.mkdirSync(path.dirname(extension), { recursive: true });
  fs.mkdirSync(path.join(s.home, "dev/machine/bin"), { recursive: true });
  fs.copyFileSync(path.join(root, "clean-development/machine/env.zsh"), path.join(s.home, "dev/machine/env.zsh"));
  fs.copyFileSync(path.join(root, "machine/env.private.zsh"), extension);
  const env = { ...s.env, PATH: `${path.join(s.home, "dev/bin")}${path.delimiter}/usr/bin:/bin`, DEV_STORAGE_VOLUME_TEST: "absent" };
  const script = 'set -e; . "$HOME/dev/machine/env.zsh"; printf "%s|%s|%s|%s|%s" "$PATH" "$CARGO_HOME" "$XDG_DATA_HOME" "$CLEAN_DEV_PRIVATE_EXTENSION" "$DEV_ENV_LOADED"';
  const r = spawnSync("/bin/zsh", ["-c", script], { cwd: s.root, env, encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  const [loadedPath, cargoHome, dataHome, privateExtension, envLoaded] = r.stdout.split("|");
  assert.ok(loadedPath.split(path.delimiter).includes("/usr/bin"));
  assert.ok(!loadedPath.split(path.delimiter).includes(path.join(s.home, "dev/bin")));
  assert.equal(cargoHome, path.join(s.home, "dev/machine/toolchains/rust/cargo"));
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

test("legacy removal preview and apply are limited to one fake-home runtime", () => {
  const s = sim({ mounted: false }), old = path.join(s.home, "Library/Application Support/clean-development");
  mk(path.join(old, "runtime/keep.txt"), "fixture only\n");
  const sibling = mk(path.join(s.home, "Library/Application Support/other-app/keep.txt"), "untouched\n");
  const script = path.join(plugin, "remove-legacy.sh");
  const preview = spawnSync("/bin/sh", [script], { env: s.env, encoding: "utf8" });
  assert.equal(preview.status, 0, preview.stderr); assert.match(preview.stdout, /preview only/);
  assert.equal(fs.existsSync(path.join(old, "runtime/keep.txt")), true);
  const applied = spawnSync("/bin/sh", [script, "--apply"], { env: s.env, encoding: "utf8" });
  assert.equal(applied.status, 0, applied.stderr); assert.equal(fs.existsSync(old), false);
  assert.equal(fs.readFileSync(sibling, "utf8"), "untouched\n");
});

test("legacy removal refuses a symlinked parent under fake HOME", () => {
  const s = sim({ mounted: false }), real = path.join(s.root, "outside/Library");
  mk(path.join(real, "Application Support/clean-development/keep.txt"), "untouched\n");
  fs.symlinkSync(real, path.join(s.home, "Library"), "dir");
  const r = spawnSync("/bin/sh", [path.join(plugin, "remove-legacy.sh"), "--apply"], { env: s.env, encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /refusing a linked or non-directory parent/);
  assert.equal(fs.readFileSync(path.join(real, "Application Support/clean-development/keep.txt"), "utf8"), "untouched\n");
});

test("legacy removal checks every configured Codex home and Claude settings file before deleting", () => {
  const s = sim({ mounted: false }), old = path.join(s.home, "Library/Application Support/clean-development");
  mk(path.join(old, "runtime/keep.txt"), "fixture only\n");
  const state = path.join(s.home, "dev/machine/state/clean-development");
  const codexHome = path.join(s.home, "dev", "codex-extra"), codexHooks = path.join(codexHome, "hooks.json");
  const claudeSettings = path.join(s.home, "dev", "claude-settings.json"), claudeProfile = path.join(s.home, "dev", "claude-profile.json");
  mk(codexHooks, '{"command":"~/Library/Application Support/clean-development/runtime/bin/cd-hook"}\n');
  mk(claudeSettings, '{"command":"~/Library/Application Support/clean-development/runtime/bin/cd-hook"}\n');
  mk(claudeProfile, '{"command":"~/Library/Application Support/clean-development/runtime/bin/cd-hook"}\n');
  mk(path.join(state, "codex-homes.list"), `${codexHome}\n`);
  mk(path.join(state, "claude-settings.list"), `${claudeSettings}\n`);
  mk(path.join(state, "claude-profiles.list"), `${claudeProfile}\n`);
  const script = path.join(plugin, "remove-legacy.sh");
  const r = spawnSync("/bin/sh", [script, "--apply"], { env: s.env, encoding: "utf8" });
  assert.equal(r.status, 1);
  for (const file of [codexHooks, claudeSettings, claudeProfile]) assert.ok(r.stderr.includes(file), `missing reference report for ${file}`);
  assert.ok(fs.existsSync(old), "a referenced legacy runtime is preserved");
});

test("legacy removal refuses when a required configured settings file cannot be checked", () => {
  const s = sim({ mounted: false }), old = path.join(s.home, "Library/Application Support/clean-development");
  mk(path.join(old, "runtime/keep.txt"), "fixture only\n");
  const missing = path.join(s.home, "dev/claude-extra/settings.json");
  mk(path.join(s.home, "dev/machine/state/clean-development/claude-settings.list"), `${missing}\n`);
  const r = spawnSync("/bin/sh", [path.join(plugin, "remove-legacy.sh"), "--apply"], { env: s.env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /configured settings file is missing|reference scan was incomplete/);
  assert.ok(fs.existsSync(old), "an incomplete reference scan preserves the runtime");
});

test("the detached delete worker never touches an outside target when a boundary fails or a trash link cannot be removed", () => {
  const s = sim({ mounted: false }), anchor = path.join(s.home, "dev/machine/state/clean-development");
  fs.mkdirSync(anchor, { recursive: true });
  const worker = path.join(plugin, "runtime/bin/cd-delete.mjs"), outside = mk(path.join(s.root, "outside.txt"), "keep\n");
  const oldTime = new Date("2020-01-01T00:00:00.000Z");
  fs.utimesSync(outside, oldTime, oldTime);
  const before = fs.statSync(outside).mtimeMs;
  const run = (entry) => {
    const queue = mk(path.join(s.root, `queue-${path.basename(entry)}.json`), JSON.stringify({
      anchor, eventsFile: null, jobs: [{ id: "fixture", path: entry, source: "fixture" }]
    }));
    return spawnSync(process.execPath, [worker, queue], { env: s.env, encoding: "utf8", timeout: 10000 });
  };
  const outsideResult = run(outside);
  assert.equal(outsideResult.status, 0, outsideResult.stderr);
  assert.equal(fs.statSync(outside).mtimeMs, before, "a rejected boundary does not refresh an outside file");

  const trash = path.join(anchor, "trash"), link = path.join(trash, "outside-link");
  fs.mkdirSync(trash, { recursive: true }); fs.symlinkSync(outside, link); fs.chmodSync(trash, 0o555);
  try {
    const linkResult = run(link);
    assert.equal(linkResult.status, 0, linkResult.stderr);
    assert.equal(fs.statSync(outside).mtimeMs, before, "backoff does not follow a failed trash symlink");
  } finally {
    fs.chmodSync(trash, 0o700);
    fs.rmSync(link, { force: true });
  }
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
  assert.equal(updated.hooks.Stop[0].hooks[1].async, false, "upgrade replaces the old asynchronous Stop");
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
  // The live ~/.codex shape on 6 Nov 2026: the feature switch Codex needs for hooks, plus trust hashes only.
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
    // 0.6.3 review: an escaped key, and a multiline string holding a bracket before the real state table.
    `"h\\u006foks" = { state = { ${k} = { enabled = false } } }\n[features]\nhooks = true\n`,
    `developer_instructions = """\n[\n"""\n\n[hooks.state.${k}]\nenabled = false\n`,
    "not toml = = =\n",
    // 0.6.3 review round 2: the identities Codex resolves to this file (trimmed, file: prefix, .. and symlink aliases).
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
  const before = fs.readFileSync(s.config);
  const r = installPackage(plugin, s.env, { config: true });
  assert.equal(r.status, "committed"); assert.deepEqual(fs.readFileSync(s.config), before);
  const receipt = JSON.parse(fs.readFileSync(r.receipt));
  assert.equal(receipt.status, "committed"); assert.equal(treeDigest(r.runtime), r.digest);
  assert.equal(installPackage(plugin, s.env, { config: true }).digest, r.digest);
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
