import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { applyTrust, managedTrustEntries } from "../runtime/lib/codex-trust.mjs";
import { installPackage, treeDigest } from "../installer.mjs";
import { sim, mk, plugin } from "./helpers.mjs";

const root = path.dirname(plugin);
const python = process.env.CLEAN_DEV_TEST_PYTHON || "/opt/homebrew/bin/python3";

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
  ]) assert.throws(() => applyTrust(text, "/h/hooks.json", entries), /host codex-hooks-trust/);
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

test("Codex config rebuild carries live hook-state blocks rather than staged state", { skip: !fs.existsSync(path.join(root, "bin", "codex-config-install")) }, () => {
  const s = sim({ mounted: false });
  const script = `import runpy,sys,tomllib\nm=runpy.run_path(sys.argv[1]); names=m['APP_MANAGED']; assert 'hooks.state' in names\nstaged='[hooks.state."slot"]\\nenabled = true\\n'\nlive='[hooks.state."slot"]\\nenabled = false\\nfuture_option = "keep"\\n'\nsb=m['blocks'](staged); lb=m['blocks'](live)\nout=''.join(t for k,t in sb if k and not m['family'](k,names)) + ''.join(t for k,t in lb if m['family'](k,('hooks.state',)))\nassert tomllib.loads(out)['hooks']['state']['slot'] == {'enabled':False,'future_option':'keep'}\n`;
  const r = spawnSync(python, ["-I", "-B", "-c", script, path.join(root, "bin", "codex-config-install")], { cwd: s.root, env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("Codex host trust updates preserve whole state and never enable disabled handlers", { skip: !fs.existsSync(path.join(root, "bin", "codex-hooks-trust")) }, () => {
  const s = sim({ mounted: false });
  const script = `import runpy,sys\nm=runpy.run_path(sys.argv[1])\nold={'disabled':{'enabled':False,'future':'keep'},'enabled':{'future':'keep'},'unrelated':{'enabled':False}}\nitems=[{'key':k,'trustStatus':'modified','source':'user','currentHash':'sha256:new','enabled':True} for k in ('disabled','enabled')]\nstate,n=m['refreshed_state'](items,('user',),old)\nassert n==1 and state['disabled']==old['disabled'] and state['unrelated']==old['unrelated']\nassert state['enabled']=={'future':'keep','trusted_hash':'sha256:new'}\n`;
  const r = spawnSync(python, ["-I", "-B", "-c", script, path.join(root, "bin", "codex-hooks-trust")], { cwd: s.root, env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("Codex config installation refuses to reassign positional disabled state to changed hooks", { skip: !fs.existsSync(path.join(root, "bin", "codex-config-install")) }, () => {
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
    ...(fs.existsSync(path.join(root, "claude-tooling", "install.sh")) ? [
      [path.join(root, "claude-tooling", "install.sh"), "/bin/bash", ["--dry-run"], 0],
      [path.join(root, "claude-tooling", "install.sh"), "/bin/bash", ["--unknown"], 2]
    ] : [])
  ]) {
    const r = spawnSync(shell, [file, ...args], { env: { ...s.env, CLEAN_DEV_NODE: process.execPath }, cwd: s.root, encoding: "utf8", timeout: 15000 });
    assert.equal(r.status, expected, r.stderr);
    assert.equal(treeDigest(s.home), before, `${file} ${args} must not write HOME`);
  }
});

test("hook merge preserves unrelated handlers, mode and recovery bytes; preview is read-only", () => {
  const s = sim({ mounted: false }), target = path.join(s.home, ".claude", "settings.json");
  const before = JSON.stringify({ model: "fixture", hooks: { Stop: [{ hooks: [
    { type: "command", command: "unrelated-notifier" },
    { type: "command", command: "'/h/dev/machine/runtime/clean-development/0.5.0/bin/cd-hook' stop claude" }
  ] }] } });
  mk(target, before); fs.chmodSync(target, 0o640);
  const args = ["-I", "-B", path.join(plugin, "fragments", "merge-hooks.py"), path.join(plugin, "fragments", "claude-hooks.json"), target];
  const digest = treeDigest(s.home);
  assert.equal(spawnSync(python, [...args, "--dry-run"], { env: s.env, encoding: "utf8" }).status, 0);
  assert.equal(treeDigest(s.home), digest);
  const r = spawnSync(python, args, { env: s.env, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr);
  const after = fs.readFileSync(target, "utf8"); assert.match(after, /unrelated-notifier/); assert.doesNotMatch(after, /0\.5\.0/);
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
    assert.throws(() => installPackage(plugin, s.env, { config: true, onPhase: (p) => { if (p === phase) throw new Error(`injected ${p}`); } }), /rolled-back/);
    assert.equal(fs.readFileSync(wrapper, "utf8"), "old wrapper\n");
    assert.equal(fs.readFileSync(envFile, "utf8"), "# old env\n");
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
  const recovered = spawnSync("/bin/sh", [path.join(plugin, "install.sh"), "--recover", id], {
    cwd: s.root, env: { ...s.env, CLEAN_DEV_NODE: process.execPath }, encoding: "utf8", timeout: 10000 });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(fs.readFileSync(wrapper, "utf8"), "old activation\n");
  assert.equal(treeDigest(receipt.runtime), receipt.digest, "published immutable recovery bytes remain available");
});

test("rollback restores file mode even when old and new activation bytes are identical", () => {
  const s = sim({ mounted: false });
  installPackage(plugin, s.env);
  const wrapper = path.join(s.home, "dev", "machine", "bin", "clean-development");
  fs.chmodSync(wrapper, 0o600);
  assert.throws(() => installPackage(plugin, s.env, { onPhase: (phase) => { if (phase === "file-0") throw new Error("mode rollback fixture"); } }), /rolled-back/);
  assert.equal(fs.statSync(wrapper).mode & 0o777, 0o600);
});

test("reprovision partial-move rollback preserves originals that never moved", { skip: !fs.existsSync(path.join(root, "runbook", "claude-work", "reprovision.sh")) }, () => {
  const source = fs.readFileSync(path.join(root, "runbook", "claude-work", "reprovision.sh"), "utf8");
  const rollback = source.slice(source.indexOf("rollback() {"), source.indexOf("on_exit() {"));
  for (let failAt = 1; failAt <= 5; failAt++) {
    const s = sim({ mounted: false });
    const sharedRoot = path.join(s.root, "shared-state"), backup = path.join(s.root, "backup");
    fs.mkdirSync(backup);
    for (const d of ["skills", "plugins", "agents", "output-styles", "themes"]) mk(path.join(sharedRoot, "shared", d, "original"), d);
    const script = `emulate -L zsh\nset -u\nROOT=$1; B=$2; fail_at=$3\ntypeset -a saved_src saved_bak moved absent\ninstall_started=0\n${rollback}\ni=0\nfor d in skills plugins agents output-styles themes; do\n (( ++i ))\n if (( i == fail_at )); then break; fi\n /bin/mv "$ROOT/shared/$d" "$B/$d" || exit 1\n moved+=("$d")\ndone\nrollback\n`;
    const r = spawnSync("/bin/zsh", ["-f", "-c", script, "reprovision-fixture", sharedRoot, backup, String(failAt)], { cwd: s.root, env: s.env, encoding: "utf8", timeout: 5000 });
    assert.equal(r.status, 0, r.stderr);
    for (const d of ["skills", "plugins", "agents", "output-styles", "themes"]) assert.equal(fs.readFileSync(path.join(sharedRoot, "shared", d, "original"), "utf8"), d);
  }
});
