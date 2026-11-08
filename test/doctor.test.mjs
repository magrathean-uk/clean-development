import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { cli, mk, repo, sim, waitFor } from "./helpers.mjs";
import { VERSION, hookShimPath, hookShimText, loadConf, runtimeRoot, stateDir } from "../runtime/lib/conf.mjs";
import { doctor, hookCommand } from "../runtime/lib/doctor.mjs";
import { claudeProfiles, claudeSettings, codexHomes, inventoryExtras, scanLiteralCachePaths, worktreeInventory } from "../runtime/lib/inventory.mjs";
import { managedTrustEntries, trustEntries, trustToml } from "../runtime/lib/codex-trust.mjs";
import { readSizeCache, refreshSizes, spawnSizeRefresh, trashPaths } from "../runtime/lib/sizes.mjs";

const hooks = (env, harness) => ({ hooks: Object.fromEntries(["SessionStart", "Stop", "SessionEnd"].map((event) => [event, [{
  ...(event === "SessionStart" ? { matcher: "startup|resume|clear|compact|fork" } : {}),
  hooks: [{ type: "command", command: hookCommand(env, event, harness), timeout: event === "Stop" ? 5 : event === "SessionStart" ? 30 : harness === "codex" ? 3 : 15,
    ...(event === "Stop" ? { async: false } : {}) }]
}]])) });
const json = (p, value) => mk(p, JSON.stringify(value));
const result = (s) => doctor(s.env, { gui: false });
const row = (r, name) => r.results.find((x) => x.name === name);
const cache = (s, extras = {}, values = {}) => ({ schemaVersion: 1, measuredAt: new Date(Date.now() - 2 * 36e5).toISOString(), durationMs: 12,
  roots: { [s.int]: { deps: 11, builds: 22, scratch: 33, trash: 44, extras }, [s.ext]: { deps: 123456789, builds: 223456789, scratch: 323456789, trash: null, extras: {}, ...values } },
  trash: { [path.join(s.home, ".Trash")]: 87654321 } });
const saveCache = (s, c) => json(path.join(stateDir(s.env), "sizes.json"), c);
function configure(s) {
  mk(path.join(s.home, "dev", "machine", "env.zsh"), `CLEAN_DEV_VERSION=${VERSION}\n`);
  mk(path.join(s.home, ".zshenv"), '. "$HOME/dev/machine/env.zsh"\n');
  fs.chmodSync(mk(path.join(s.home, "dev", "machine", "bin", "clean-development"), "#!/bin/sh\nexit 0\n"), 0o755);
  fs.chmodSync(mk(path.join(runtimeRoot(s.env), VERSION, "bin", "cd-hook"), "#!/bin/sh\nexit 0\n"), 0o755);
  fs.chmodSync(mk(hookShimPath(s.env), hookShimText(s.env)), 0o755);
  json(path.join(s.home, ".claude", "settings.json"), hooks(s.env, "claude"));
  json(path.join(s.home, ".claude", "plugins", "installed_plugins.json"), { plugins: { "clean-development@clean-development": [{ version: VERSION }] } });
  // ~/.codex is always checked: a healthy fixture has its shim hooks and their trust.
  const codexHooks = path.join(s.home, ".codex", "hooks.json"), codexDoc = hooks(s.env, "codex");
  json(codexHooks, codexDoc); mk(path.join(s.home, ".codex", "config.toml"), trustToml(managedTrustEntries(codexHooks, codexDoc)));
  return s;
}

test("doctor treats conflict-preserving installer recovery as a completed receipt", () => {
  const s = configure(sim());
  json(path.join(stateDir(s.env), "installations", "recovered", "receipt.json"), {
    id: "recovered", status: "recovered-preserving-conflicts", version: VERSION
  });
  const check = row(result(s), "deployment receipts");
  assert.equal(check.ok, true, check.detail);
  assert.match(check.detail, /^0 unfinished recovery transaction/);
});

test("plain doctor skips host GUI settings and --gui enables those checks", () => {
  const s = configure(sim());
  const plain = cli(s, ["doctor", "--json"]);
  const gui = cli(s, ["doctor", "--gui", "--json"]);
  const plainNames = JSON.parse(plain.stdout).results.map((x) => x.name);
  const guiNames = JSON.parse(gui.stdout).results.map((x) => x.name);
  assert.ok(!plainNames.includes("GUI launchd env"));
  assert.ok(!plainNames.includes("Xcode DerivedData"));
  assert.ok(guiNames.includes("GUI launchd env"));
  assert.ok(guiNames.includes("Xcode DerivedData"));
});

function snapshot(root) {
  const rows = [];
  function walk(p) {
    const st = fs.lstatSync(p);
    rows.push([path.relative(root, p), st.mode, st.size, st.mtimeMs, st.isFile() ? fs.readFileSync(p).toString("base64") : st.isSymbolicLink() ? fs.readlinkSync(p) : null]);
    if (st.isDirectory()) for (const name of fs.readdirSync(p).sort()) walk(path.join(p, name));
  }
  walk(root); return rows;
}

test("Codex registry discovers configured homes and reports invalid lines", () => {
  const s = sim(), extra = path.join(s.home, "dev/machine/state/third-codex");
  for (const home of [path.join(s.home, ".codex"), extra]) mk(path.join(home, "config.toml"), "");
  mk(path.join(stateDir(s.env), "codex-homes.list"), `# homes\n\n~/dev/machine/state/third-codex\nrelative/home\n~/dev/machine/state/third-codex\n${s.root}/not-configured\n`);
  const r = codexHomes(s.env);
  // A listed home without config.toml stays registered so doctor can FAIL it (0.6.2 review fix).
  assert.equal(r.homes.length, 3); assert.ok(r.homes.includes(`${s.root}/not-configured`)); assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /:4:.*absolute or start with/);
  assert.equal(row(result(s), "Codex homes").ok, false);
});

test("Claude settings registry supports additional configured profiles", () => {
  const s = configure(sim()), custom = path.join(s.home, "dev", "claude-profile", "settings.json");
  json(custom, hooks(s.env, "claude"));
  mk(path.join(stateDir(s.env), "claude-settings.list"), `~/dev/claude-profile/settings.json\n`);
  const registry = claudeSettings(s.env), r = result(s);
  assert.deepEqual(registry.files, [path.join(s.home, ".claude", "settings.json"), custom]);
  assert.equal(registry.errors.length, 0);
  assert.equal(row(r, "Claude settings").ok, true);
  assert.equal(row(r, "Claude hooks (claude-profile)").ok, true);
  mk(path.join(stateDir(s.env), "claude-settings.list"), `${custom}\nrelative/settings.json\n`);
  assert.equal(claudeSettings(s.env).errors.length, 1);
  assert.equal(row(result(s), "Claude settings").ok, false);
});

test("Claude profile registry keeps stale and async per-profile handlers visible and skips absent profiles", () => {
  const s = configure(sim()), base = path.join(s.home, "dev/machine/state/workspace-profiles/profiles");
  const profile = path.join(base, "1/settings.json"), asyncProfile = path.join(base, "3/settings.json");
  const stale = hooks(s.env, "claude");
  stale.hooks.Stop[0].hooks[0].command = "'/old/runtime/clean-development/0.6.6/bin/cd-hook' stop claude";
  json(profile, stale);
  const asynchronous = hooks(s.env, "claude"); asynchronous.hooks.Stop[0].hooks[0].async = true;
  json(asyncProfile, asynchronous);
  mk(path.join(stateDir(s.env), "claude-profiles.list"), [
    "?~/dev/machine/state/workspace-profiles/profiles/1/settings.json",
    "?~/dev/machine/state/workspace-profiles/profiles/2/settings.json",
    "?~/dev/machine/state/workspace-profiles/profiles/3/settings.json"
  ].join("\n") + "\n");
  const registry = claudeProfiles(s.env), r = result(s);
  assert.deepEqual(registry.files, [profile, asyncProfile]);
  const staleCheck = row(r, `Claude profile hooks (${path.relative(s.home, profile)})`);
  const asyncCheck = row(r, `Claude profile hooks (${path.relative(s.home, asyncProfile)})`);
  assert.equal(staleCheck.ok, false); assert.match(staleCheck.detail, /stale per-profile/);
  assert.equal(asyncCheck.ok, false); assert.match(asyncCheck.detail, /async per-profile/);
});

test("doctor supports a single-harness Bash setup and treats its optional plugin as guidance", () => {
  const s = configure(sim());
  for (const file of [path.join(s.home, ".codex/config.toml"), path.join(s.home, ".codex/hooks.json"), path.join(s.home, ".zshenv"), path.join(s.home, ".claude/plugins/installed_plugins.json")]) fs.unlinkSync(file);
  s.env.SHELL = "/bin/bash";
  mk(path.join(s.home, ".bash_profile"), '[ -r "$HOME/dev/machine/env.zsh" ] && . "$HOME/dev/machine/env.zsh"\n');
  const r = result(s);
  assert.equal(row(r, "shell startup").ok, true);
  assert.equal(row(r, "Claude hooks").ok, true);
  assert.equal(row(r, "Codex homes").warn, true);
  assert.equal(row(r, "Claude plugin pin").warn, true);
  assert.equal(r.ok, true, JSON.stringify(r.results.filter((x) => !x.ok && !x.warn)));
});

test("doctor requires zsh routing in .zshenv", () => {
  const s = configure(sim());
  fs.unlinkSync(path.join(s.home, ".zshenv"));
  mk(path.join(s.home, ".zshrc"), '. "$HOME/dev/machine/env.zsh"\n');
  const r = result(s);
  assert.equal(row(r, "shell startup").ok, false);
  assert.match(row(r, "shell startup").detail, /\.zshenv/);
});

test("registries distinguish required missing paths from optional files and follow regular-file symlinks", () => {
  const s = configure(sim()), target = mk(path.join(s.root, "linked-claude-settings.json"), JSON.stringify(hooks(s.env, "claude")));
  const linked = path.join(s.root, "linked", "settings.json"); fs.mkdirSync(path.dirname(linked)); fs.symlinkSync(target, linked);
  mk(path.join(stateDir(s.env), "claude-settings.list"), `${linked}\n`);
  const linkedRow = row(result(s), `Claude hooks (${path.basename(path.dirname(linked))})`);
  assert.equal(linkedRow.ok, true);

  const missingSettings = path.join(s.root, "future-settings.json");
  mk(path.join(stateDir(s.env), "claude-settings.list"), `?${missingSettings}\n`);
  assert.equal(claudeSettings(s.env).errors.length, 0);
  assert.deepEqual(claudeSettings(s.env).optionalMissing, [missingSettings]);
  assert.equal(row(result(s), "Claude settings").warn, true);

  const missingCodex = path.join(s.root, "future-codex");
  mk(path.join(stateDir(s.env), "codex-homes.list"), `?${missingCodex}\n`);
  assert.equal(row(result(s), "Codex homes").warn, true);
  assert.deepEqual(codexHomes(s.env).optionalMissing, [missingCodex]);
  json(path.join(missingCodex, "hooks.json"), hooks(s.env, "codex"));
  mk(path.join(stateDir(s.env), "codex-homes.list"), `${missingCodex}\n`);
  assert.equal(row(result(s), "Codex hooks (future-codex)").ok, true);
  assert.match(row(result(s), "Codex hook trust (future-codex)").detail, /untrusted/);

  mk(path.join(stateDir(s.env), "claude-profiles.list"), `?${missingSettings}\n`);
  const optional = claudeProfiles(s.env);
  assert.equal(optional.errors.length, 0); assert.equal(optional.optionalMissing.length, 1);
  assert.equal(row(result(s), "Claude profiles").warn, true);
  mk(path.join(stateDir(s.env), "claude-profiles.list"), `${path.join(s.root, "future-settings.json")}\n`);
  assert.equal(row(result(s), "Claude profiles").ok, false);
});

test("configured Codex home requires hooks and matching trust", () => {
  const s = configure(sim()), home = path.join(s.root, "configured-codex"), file = path.join(home, "hooks.json");
  mk(path.join(home, "config.toml"), "# fixture\n");
  mk(path.join(stateDir(s.env), "codex-homes.list"), `${home}\n`);
  const failed = cli(s, ["doctor", "--json", "--no-gui"]);
  assert.equal(failed.status, 1, failed.stderr);
  const missing = row(JSON.parse(failed.stdout), "Codex hooks (configured-codex)");
  assert.equal(missing.ok, false); assert.match(missing.detail, /merge fragments\/codex-hooks.json.*clean-development codex-trust --hooks .*configured-codex\/hooks.json/);
  const doc = hooks(s.env, "codex"); json(file, doc);
  assert.equal(row(result(s), "Codex hooks (configured-codex)").ok, true);
  assert.equal(row(result(s), "Codex hook trust (configured-codex)").ok, false);
  // The trust recogniser is owned elsewhere; retain real hash coverage until its shim support lands.
  const managed = managedTrustEntries(file, doc), entries = managed.length ? managed : trustEntries(file, doc);
  assert.equal(entries.length, 3);
  mk(path.join(home, "config.toml"), trustToml(entries));
  const passed = cli(s, ["doctor", "--json", "--no-gui"]);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.equal(row(JSON.parse(passed.stdout), "Codex hook trust (configured-codex)").trustedEnabled, 3);
});

test("the default and explicitly configured Codex homes are checked independently", () => {
  const s = sim();
  const custom = path.join(s.root, "custom-codex");
  mk(path.join(s.home, ".codex/config.toml"), ""); mk(path.join(custom, "config.toml"), "");
  mk(path.join(stateDir(s.env), "codex-homes.list"), `${custom}\n`);
  const r = result(s);
  assert.equal(row(r, "Codex hooks").ok, false);
  assert.equal(row(r, "Codex hooks (custom-codex)").ok, false);
});

test("Codex async Stop is rejected because one-shot exit can strand its lifecycle lock", () => {
  const s = configure(sim()), file = path.join(s.home, ".codex", "hooks.json");
  const doc = hooks(s.env, "codex"); doc.hooks.Stop[0].hooks[0].async = true; json(file, doc);
  const r = result(s);
  assert.match(row(r, "Codex hooks").detail, /Stop async differs/);
  assert.equal(row(r, "Claude hooks").ok, true);
});

test("Claude async Stop is rejected for the configured user hooks", () => {
  const s = configure(sim());
  const bad = hooks(s.env, "claude"); bad.hooks.Stop[0].hooks[0].async = true;
  const main = path.join(s.home, ".claude", "settings.json");
  json(main, bad);
  const check = row(result(s), "Claude hooks");
  assert.equal(check.ok, false); assert.match(check.detail, /Stop async differs/);
  json(main, hooks(s.env, "claude"));
  assert.equal(row(result(s), "Claude hooks").ok, true);
});

test("hook shim validates exact text, current release, regular file and target", () => {
  const s = configure(sim());
  fs.unlinkSync(hookShimPath(s.env)); assert.equal(row(result(s), "hook shim").ok, false);
  fs.chmodSync(mk(hookShimPath(s.env), hookShimText(s.env)), 0o755); assert.equal(row(result(s), "hook shim").ok, true);
  fs.chmodSync(hookShimPath(s.env), 0o644); assert.match(row(result(s), "hook shim").detail, /shim not executable/); fs.chmodSync(hookShimPath(s.env), 0o755);
  mk(hookShimPath(s.env), hookShimText(s.env, "0.6.1")); assert.equal(row(result(s), "hook shim").ok, false);
  mk(hookShimPath(s.env), hookShimText(s.env) + "# altered\n"); assert.equal(row(result(s), "hook shim").ok, false);
  fs.chmodSync(mk(hookShimPath(s.env), hookShimText(s.env)), 0o755);
  fs.chmodSync(path.join(runtimeRoot(s.env), VERSION, "bin/cd-hook"), 0o644); assert.match(row(result(s), "hook shim").detail, /release bin\/cd-hook missing or not executable/);
  fs.unlinkSync(path.join(runtimeRoot(s.env), VERSION, "bin/cd-hook")); assert.equal(row(result(s), "hook shim").ok, false);
  const shimCopy = mk(path.join(s.root, "shim-copy"), hookShimText(s.env));
  fs.unlinkSync(hookShimPath(s.env)); fs.symlinkSync(shimCopy, hookShimPath(s.env)); assert.equal(row(result(s), "hook shim").ok, false);
});

test("retained runtime inventory ignores active and unrelated directories", () => {
  const s = sim();
  for (const name of ["0.6.0", "active", "notes", VERSION]) fs.mkdirSync(path.join(runtimeRoot(s.env), name), { recursive: true });
  const r = row(result(s), "retained runtimes");
  assert.match(r.detail, /0\.6\.0/); assert.doesNotMatch(r.detail, /active|notes|0\.6\.2/);
});

test("unmanaged extras use cached bytes, owner metadata and move markers", () => {
  const s = sim();
  json(path.join(s.int, "tasks/.owner.json"), { repo: "/fixture/repo", harness: "codex", key: "x-fixture", ignored: "omit" });
  mk(path.join(s.int, "moved/MOVED-TO-external-volume-fixture.txt"));
  mk(path.join(s.int, "invalid/.owner.json"), "invalid");
  for (const name of ["deps/file", "builds/file", "scratch/file", "trash/file", "probe-fixture.tmp", ".DS_Store"]) mk(path.join(s.int, name));
  const c = cache(s, { tasks: 9, moved: null }); saveCache(s, c);
  const inventory = inventoryExtras(loadConf(s.env), s.env, { sizes: readSizeCache(s.env), internalWarnBytes: 8 });
  assert.deepEqual(inventory.internal.map((x) => x.name).sort(), ["invalid", "moved", "tasks"]);
  const task = inventory.internal.find((x) => x.name === "tasks");
  assert.equal(task.bytes, 9); assert.equal(task.measuredAt, c.measuredAt); assert.equal(task.overCap, true); assert.ok(task.mtimeMs > 0);
  assert.deepEqual(task.owner, { repo: "/fixture/repo", harness: "codex", key: "x-fixture" });
  assert.equal(inventory.internal.find((x) => x.name === "moved").owner, "MOVED-TO-external-volume-fixture.txt");
  assert.equal(inventory.internal.find((x) => x.name === "invalid").bytes, null);
  assert.ok(row(doctor(s.env, { gui: false, internalWarnBytes: 8 }), "misplaced cache extra tasks").warn);
  const h = cli(s, ["housekeeping"]);
  assert.equal(h.status, 0, h.stderr); assert.match(h.stdout, /tasks:.*owner .*fixture\/repo.*MISPLACED/);
  saveCache(s, cache(s, { tasks: 2 * 1024 ** 3 }));
  assert.match(cli(s, ["housekeeping"]).stdout, /tasks:.*MISPLACED OVER 1 GB/);
  s.env.DEV_STORAGE_VOLUME_TEST = "absent";
  const internal = inventoryExtras(loadConf(s.env), s.env, { sizes: c, internalWarnBytes: 8 });
  assert.equal(internal.external, undefined); assert.equal(internal.internal.find((x) => x.name === "tasks").misplaced, false);
});

test("literal path scan finds plist and adopted tools, skips links and binary files", () => {
  const s = sim(), p = repo(s), conf = loadConf(s.env);
  const plist = mk(path.join(s.home, "Library/LaunchAgents/fixture.plist"), `<plist>\n${s.int}\n</plist>`);
  mk(path.join(p, "tools/nested/path.sh"), `echo ~/dev/machine/cache\necho $HOME/dev/machine/cache\necho ${s.ext}`);
  mk(path.join(p, "tools/binary"), Buffer.from(`\0${s.int}`));
  fs.symlinkSync(plist, path.join(p, "tools/link"));
  const unadopted = path.join(s.home, "dev/source/unadopted"); mk(path.join(unadopted, "tools/no"), s.int);
  const scan = scanLiteralCachePaths(conf, s.env);
  assert.equal(scan.incomplete, false); assert.equal(scan.hits.length, 4);
  assert.deepEqual(scan.hits[0], { file: plist, line: 2 });
  const r = result(s); assert.ok(r.results.some((x) => x.warn && x.name === "literal cache path" && x.detail === `${plist}:2`));
  assert.match(cli(s, ["doctor", "--no-gui"]).stdout, /WARN literal cache path: .*fixture.plist:2/);
  assert.equal(scanLiteralCachePaths(conf, s.env, { deadline: 0 }).incomplete, true);
  mk(path.join(p, "tools/oversized"), Buffer.alloc(1024 ** 2 + 1, 65));
  assert.equal(scanLiteralCachePaths(conf, s.env).incomplete, true);
});

test("literal scan caps its regular file count", () => {
  const s = sim(), p = repo(s), tools = path.join(p, "tools");
  fs.mkdirSync(tools);
  for (let n = 0; n < 2001; n++) fs.writeFileSync(path.join(tools, `${n}.txt`), "small");
  const r = scanLiteralCachePaths(loadConf(s.env), s.env, { deadline: Date.now() + 120000 });
  assert.equal(r.files, 2000); assert.equal(r.incomplete, true);
});

test("doctor warns on stray dev entries, stale and unexpected dots and cached Trash", () => {
  const s = configure(sim());
  mk(path.join(s.home, "dev/run3/file")); mk(path.join(s.home, ".unexpected/file"));
  fs.appendFileSync(s.config, '\nHOME_DOT_ALLOW=".claude .gone"\n'); saveCache(s, cache(s));
  const r = result(s);
  assert.ok(r.ok);
  assert.ok(r.results.some((x) => x.warn && x.name === "stray ~/dev entry" && x.detail.endsWith("/run3")));
  assert.ok(row(r, "stale HOME_DOT_ALLOW .gone").warn);
  assert.ok(row(r, "unexpected dot-folder ~/.unexpected").warn);
  assert.ok(r.results.some((x) => x.warn && x.name === "pending Trash" && x.detail.includes("87654321 bytes")));
  assert.ok(r.results.some((x) => x.warn && x.name === "pending Trash" && x.detail.includes("unknown, refresh sizes")));
  assert.equal(cli(s, ["doctor", "--no-gui"]).status, 0);
});

test("doctor reports a linked worktree outside the external worktree root", () => {
  const s = sim(), p = repo(s), target = path.join(s.home, "dev/linked-worktree");
  const vol = path.join(path.dirname(s.vol), "FixtureVolume");
  fs.renameSync(s.vol, vol);
  fs.writeFileSync(s.config, fs.readFileSync(s.config, "utf8").replaceAll(s.vol, vol).replace(/^EXTERNAL_VOLUME=.*$/m, "EXTERNAL_VOLUME=FixtureVolume"));
  const object = (type, text) => {
    const body = Buffer.from(text), data = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
    const hash = createHash("sha1").update(data).digest("hex"); mk(path.join(p, ".git/objects", hash.slice(0, 2), hash.slice(2)), deflateSync(data)); return hash;
  };
  const tree = object("tree", ""), commit = object("commit", `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nfixture\n`);
  mk(path.join(p, ".git/HEAD"), "ref: refs/heads/fixture\n"); mk(path.join(p, ".git/refs/heads/fixture"), commit + "\n");
  const added = spawnSync("/usr/bin/git", ["-C", p, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", target, "HEAD"], { env: { ...s.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }, encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);
  const allowed = path.join(vol, "dev", "worktrees", "repo");
  fs.mkdirSync(path.dirname(allowed), { recursive: true });
  const allowedAdded = spawnSync("/usr/bin/git", ["-C", p, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", allowed, "HEAD"], { env: { ...s.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }, encoding: "utf8" });
  assert.equal(allowedAdded.status, 0, allowedAdded.stderr);
  const internalAllowed = path.join(s.home, "dev", "machine", "worktrees", "repo");
  fs.mkdirSync(path.dirname(internalAllowed), { recursive: true });
  const internalAdded = spawnSync("/usr/bin/git", ["-C", p, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", internalAllowed, "HEAD"], { env: { ...s.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }, encoding: "utf8" });
  assert.equal(internalAdded.status, 0, internalAdded.stderr);
  const scan = worktreeInventory(loadConf(s.env), s.env);
  assert.equal(scan.incomplete, false); assert.deepEqual(scan.worktrees, [{ repo: p, path: target }]);
  assert.ok(result(s).results.some((x) => x.warn && x.name === "worktree outside root" && x.detail.includes(target)));
  assert.ok(!result(s).results.some((x) => x.warn && x.name === "worktree outside root" && x.detail.includes(allowed)));
  assert.ok(!result(s).results.some((x) => x.warn && x.name === "worktree outside root" && x.detail.includes(internalAllowed)));
  const away = { ...s.env, DEV_STORAGE_VOLUME_TEST: "absent" };
  assert.deepEqual(worktreeInventory(loadConf(away), away).worktrees, [{ repo: p, path: target }], "an existing external worktree stays valid while the volume is away");
  assert.equal(worktreeInventory(loadConf(s.env), s.env, { deadline: 0 }).incomplete, true);
});

test("status sizes is fast without cache and prints cached sentinels and age without measuring", () => {
  const s = sim(), start = Date.now(), unknown = cli(s, ["status", "--sizes"]);
  assert.equal(unknown.status, 0, unknown.stderr); assert.match(unknown.stdout, /sizes unknown: run clean-development sizes --refresh/);
  assert.ok(Date.now() - start < 10000);
  const c = cache(s); saveCache(s, c); mk(path.join(s.ext, "deps/small"), "x");
  const sized = cli(s, ["status", "--sizes"]);
  assert.equal(sized.status, 0, sized.stderr); assert.match(sized.stdout, /123456789 bytes/); assert.match(sized.stdout, /223456789 bytes/);
  assert.ok(sized.stdout.includes(`sizes from ${c.measuredAt} (2 h old)`));
  const data = JSON.parse(cli(s, ["status", "--sizes", "--json"]).stdout);
  assert.deepEqual(data.incomplete, []); assert.equal(data.sizes.deps, 123456789); assert.equal(data.sizesMeasuredAt, c.measuredAt);
});

test("size cache rejects malformed documents and explicit refresh measures fixtures", () => {
  const s = sim();
  for (const bad of [null, {}, { ...cache(s), schemaVersion: 2 }, { ...cache(s), durationMs: -1 }, { ...cache(s), measuredAt: "bad" },
    { ...cache(s), roots: { relative: { deps: 1, builds: 2, scratch: 3, trash: 4, extras: {} } } }, { ...cache(s), trash: { "/somewhere": -1 } }]) {
    saveCache(s, bad); assert.equal(readSizeCache(s.env), null);
  }
  const conf = loadConf(s.env);
  for (const root of [s.int, s.ext]) for (const name of ["deps", "builds", "scratch", "trash", "extra"]) mk(path.join(root, name, "small"), "fixture");
  const c = refreshSizes(conf, s.env, { perPathTimeoutMs: 1000, deadlineMs: 5000 });
  assert.deepEqual(readSizeCache(s.env), c); assert.equal(c.schemaVersion, 1); assert.ok(c.roots[s.ext].deps > 0);
  assert.ok(c.roots[s.int].extras.extra > 0); assert.deepEqual(Object.keys(c.trash), trashPaths(conf, s.env));
  assert.equal(cli(s, ["sizes", "--refresh"]).status, 0);
  const zero = refreshSizes(conf, s.env, { deadlineMs: 0 }); assert.equal(zero.roots[s.ext].deps, null);
});

test("detached size refresher returns promptly and writes only its fixture cache", async () => {
  const s = sim(), sentinel = mk(path.join(s.int, "extra/keep"), "keep");
  const start = Date.now(); assert.equal(spawnSizeRefresh(s.env), true); assert.ok(Date.now() - start < 1000);
  assert.ok(await waitFor(() => readSizeCache(s.env), 5000));
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
});

test("doctor, status, sizes and housekeeping previews leave fixture state unchanged", () => {
  const s = configure(sim()); mk(path.join(s.int, "extras/file")); saveCache(s, cache(s));
  const before = snapshot(s.root);
  for (const args of [["doctor", "--no-gui"], ["status", "--sizes"], ["sizes"], ["housekeeping"]]) {
    const r = cli(s, args); assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(snapshot(s.root), before, args.join(" "));
  }
});

test("a FIFO planted as a pin no longer blocks status; it is reported as invalid ownership", () => {
  const s = sim(), fifo = path.join(s.sessions, "x-fixture0000a.json");
  fs.mkdirSync(s.sessions, { recursive: true });
  const mkfifo = spawnSync("/usr/bin/mkfifo", [fifo], { env: s.env, encoding: "utf8" });
  assert.equal(mkfifo.status, 0, mkfifo.stderr);
  const start = Date.now(), r = cli(s, ["status", "--sizes", "--json"]);
  assert.equal(r.status, 0, r.stderr); assert.ok(Date.now() - start < 15000);
  const out = JSON.parse(r.stdout);
  assert.ok(!out.incomplete.includes("sessions"));
  assert.ok(out.sessions.find((x) => x.key === "x-fixture0000a").errors.includes("invalid ownership metadata"));
});

test("optional workspace inventory reports repositories without project metadata", () => {
  const s = configure(sim());
  s.env.CLEAN_DEV_REPORT_UNADOPTED_REPOS = "1";
  const src = path.join(s.home, "dev", "source");
  mk(path.join(src, "adopted", ".clean-development.json"), "{}"); mk(path.join(src, "adopted", "AGENTS.md"), "x");
  mk(path.join(src, "bare", "README.md"), "x");
  mk(path.join(src, "half", "AGENTS.md"), "x");
  const r = result(s);
  assert.equal(row(r, "repos without .clean-development.json").detail, "2: bare half; no declared buildDirs/depDirs; project cleanup skips it");
  assert.equal(row(r, "repos without AGENTS.md").detail, "1: bare; no agent instructions");
  assert.ok(row(r, "repos without AGENTS.md").warn);
});

test("optional workspace inventory reports an unreadable source directory without failing doctor", () => {
  const s = configure(sim());
  s.env.CLEAN_DEV_REPORT_UNADOPTED_REPOS = "1";
  const src = path.join(s.home, "dev", "source");
  mk(path.join(src, "a", "AGENTS.md"), "x");
  fs.chmodSync(src, 0o000);
  try {
    const r = result(s);
    assert.match(row(r, "repo scan").detail, /^~\/dev\/source unreadable \(EACCES\)/);
    assert.ok(row(r, "repo scan").warn);
  } finally { fs.chmodSync(src, 0o755); }
});

test("doctor skips workspace inventory unless explicitly enabled", () => {
  const s = configure(sim());
  mk(path.join(s.home, "dev/source/unconfigured", "README.md"), "fixture\n");
  const r = result(s);
  assert.equal(row(r, "repo scan"), undefined);
  assert.equal(row(r, "repos without AGENTS.md"), undefined);
  assert.equal(row(r, "repos without .clean-development.json"), undefined);
});

test("doctor accepts hooks written with the absolute active shim path", () => {
  const s = configure(sim());
  const spellings = [
    (shim) => `'${String(shim).replaceAll("'", "'\\''")}'`,
    (shim) => `"${shim}"`,
    (shim) => shim
  ];
  for (const quote of spellings) {
    const absoluteHooks = (harness) => {
      const doc = hooks(s.env, harness), shim = quote(hookShimPath(s.env));
      for (const [event, groups] of Object.entries(doc.hooks)) {
        groups[0].hooks[0].command = `${shim} ${{ SessionStart: "session-start", Stop: "stop", SessionEnd: "session-end" }[event]} ${harness}`;
      }
      return doc;
    };
    const claude = path.join(s.home, ".claude", "settings.json"), claudeDoc = absoluteHooks("claude");
    json(claude, claudeDoc);
    const profile = path.join(s.home, "dev", "machine", "state", "profiles", "primary", "settings.json");
    json(profile, claudeDoc);
    mk(path.join(stateDir(s.env), "claude-profiles.list"), "~/dev/machine/state/profiles/primary/settings.json\n");
    const codexHooks = path.join(s.home, ".codex", "hooks.json"), codexDoc = absoluteHooks("codex");
    json(codexHooks, codexDoc);
    const trusted = managedTrustEntries(codexHooks, codexDoc);
    assert.equal(trusted.length, 3);
    mk(path.join(s.home, ".codex", "config.toml"), trustToml(trusted));

    const r = result(s);
    assert.equal(row(r, "Claude hooks").ok, true, row(r, "Claude hooks").detail);
    assert.equal(row(r, "Claude profile hooks (dev/machine/state/profiles/primary/settings.json)").ok, true);
    assert.equal(row(r, "Codex hooks").ok, true, row(r, "Codex hooks").detail);
    assert.equal(row(r, "Codex hook trust").ok, true, row(r, "Codex hook trust").detail);
  }
});

test("doctor warns when internal free space is under INTERNAL_MIN_FREE_GB and has no stale-internal row", () => {
  const s = configure(sim());
  assert.equal(row(result(s), "internal free space"), undefined);
  fs.writeFileSync(s.config, fs.readFileSync(s.config, "utf8").replace(/^INTERNAL_MIN_FREE_GB=.*$/m, "INTERNAL_MIN_FREE_GB=50000"));
  const r = result(s);
  assert.match(row(r, "internal free space").detail, /free on the internal disk, below the configured 50000 GB warning threshold$/);
  assert.equal(r.results.filter((x) => /stale internal/.test(x.name)).length, 0);
});
