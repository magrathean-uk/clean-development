import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveConfig, writeUserConfig } from "../src/config.js";
import { applyXcodePrune, applyXcodeSettings, promptXcodeChoice, restoreXcodeSettings, xcodePaths, xcodePrunePlan, xcodeStatus } from "../src/xcode.js";

// Every test uses a disposable home, disposable fake `defaults`, `xcrun` and `pgrep`, and never touches
// the contributor's real Xcode preferences, simulators or DerivedData.

const cli = path.resolve("bin/clean-development.js");
const skip = process.platform === "win32" ? "fake POSIX tools" : false;
const DAY = 24 * 60 * 60 * 1000;
const HASH = "abcdefghijklmnopqrstuvwxyzab"; // 28 lowercase letters, like Xcode's project hash

const DEFAULTS = `#!/bin/sh
store="$FAKE_DEFAULTS_STORE"
case "$1" in
  read) if [ -f "$store" ]; then cat "$store"; else echo "The domain/default pair of ($2, $3) does not exist" >&2; exit 1; fi ;;
  write) printf '%s\\n' "$5" > "$store" ;;
  delete) rm -f "$store" ;;
  *) exit 2 ;;
esac
`;

const XCRUN = `#!/bin/sh
d="$FAKE_SIMCTL_DIR"
echo "$*" >> "$d/calls.log"
[ -f "$d/unusable" ] && exit 1
[ "$1" = simctl ] || exit 2
shift
set_name=default
if [ "$1" = "--set" ]; then set_name="$2"; shift 2; fi
case "$1 $2 $3" in
  "list devices booted") cat "$d/booted-$set_name.json" 2>/dev/null || echo '{"devices":{}}' ;;
  "list devices unavailable") cat "$d/unavailable.json" 2>/dev/null || echo '{"devices":{}}' ;;
  "delete unavailable "*|"delete all "*|"delete unavailable"|"delete all") exit 0 ;;
  *) exit 2 ;;
esac
`;

const PGREP = `#!/bin/sh
[ "$1" = "-x" ] || exit 2
[ -f "$FAKE_RUNNING_DIR/$2" ] && exit 0
exit 1
`;

function executable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-xcode-")));
  const home = path.join(root, "home");
  const bin = path.join(root, "fake-bin");
  const simctl = path.join(root, "simctl");
  const running = path.join(root, "running");
  for (const directory of [home, bin, simctl, running]) fs.mkdirSync(directory, { recursive: true });
  executable(path.join(bin, "defaults"), DEFAULTS);
  executable(path.join(bin, "xcrun"), XCRUN);
  executable(path.join(bin, "pgrep"), PGREP);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: os.tmpdir(),
    CLEAN_DEVELOPMENT_HOME: home,
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    CODEX_HOME: path.join(root, "codex"),
    FAKE_DEFAULTS_STORE: path.join(root, "defaults-store"),
    FAKE_SIMCTL_DIR: simctl,
    FAKE_RUNNING_DIR: running
  };
  const managed = path.join(root, "managed");
  fs.mkdirSync(managed);
  const config = (xcode) => resolveConfig({ env, includeProject: false, overrides: { root: managed, ...(xcode ? { xcode } : {}) } });
  return {
    root, home, env, managed, config,
    store: env.FAKE_DEFAULTS_STORE,
    preference: () => (fs.existsSync(env.FAKE_DEFAULTS_STORE) ? fs.readFileSync(env.FAKE_DEFAULTS_STORE, "utf8").trim() : null),
    calls: () => (fs.existsSync(path.join(simctl, "calls.log")) ? fs.readFileSync(path.join(simctl, "calls.log"), "utf8").trim().split("\n") : []),
    simctl, running
  };
}

function age(target, days) {
  const when = new Date(Date.now() - days * DAY);
  fs.utimesSync(target, when, when);
}

function project(root, name, { marked = true, days = 60 } = {}) {
  const directory = path.join(root, `${name}-${HASH}`);
  fs.mkdirSync(path.join(directory, "Build"), { recursive: true });
  if (marked) fs.writeFileSync(path.join(directory, "info.plist"), "<plist/>");
  fs.writeFileSync(path.join(directory, "Build", "artifact"), "x");
  for (const target of [path.join(directory, "info.plist"), directory]) if (fs.existsSync(target)) age(target, days);
  return directory;
}

const darwin = { platform: "darwin" };

test("xcode: setup step sets the preference once, remembers nothing when there was none, and is idempotent", { skip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = item.config({ derivedData: true, simulators: false });
  const paths = xcodePaths(config);

  const preview = applyXcodeSettings(config, item.env, { dryRun: true, ...darwin });
  assert.equal(preview.derivedData.action, "would-set");
  assert.equal(item.preference(), null);
  assert.equal(fs.existsSync(paths.derivedData), false);

  const first = applyXcodeSettings(config, item.env, darwin);
  assert.equal(first.derivedData.action, "set");
  assert.equal(item.preference(), path.join(item.managed, "xcode", "DerivedData"));
  assert.equal(fs.lstatSync(paths.derivedData).isDirectory(), true);
  const receipt = JSON.parse(fs.readFileSync(paths.receipt, "utf8"));
  assert.equal(receipt.previous, null);
  assert.equal(receipt.written, paths.derivedData);

  assert.equal(applyXcodeSettings(config, item.env, darwin).derivedData.action, "unchanged");
});

test("xcode: the original preference survives an update and comes back on restore", { skip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(item.store, "/somewhere/old\n");
  const config = item.config({ derivedData: true, simulators: false });
  applyXcodeSettings(config, item.env, darwin);
  const paths = xcodePaths(config);
  assert.equal(JSON.parse(fs.readFileSync(paths.receipt, "utf8")).previous, "/somewhere/old");

  // A later update with another root must not record our own earlier value as "previous".
  const moved = resolveConfig({ env: item.env, includeProject: false, overrides: { root: path.join(item.root, "managed2"), xcode: { derivedData: true, simulators: false } } });
  fs.mkdirSync(moved.root);
  applyXcodeSettings(moved, item.env, darwin);
  assert.equal(item.preference(), path.join(moved.root, "xcode", "DerivedData"));
  assert.equal(JSON.parse(fs.readFileSync(xcodePaths(moved).receipt, "utf8")).previous, "/somewhere/old");

  const restored = restoreXcodeSettings(moved, item.env, darwin);
  assert.equal(restored.action, "restored");
  assert.equal(item.preference(), "/somewhere/old");
  assert.equal(fs.existsSync(xcodePaths(moved).receipt), false);
  assert.equal(fs.existsSync(paths.derivedData), true, "DerivedData folders are never removed by a restore");
});

test("xcode: restore removes the preference when there was none, and leaves a value the owner changed", { skip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = item.config({ derivedData: true, simulators: false });
  applyXcodeSettings(config, item.env, darwin);
  assert.equal(restoreXcodeSettings(config, item.env, darwin).action, "removed");
  assert.equal(item.preference(), null);

  applyXcodeSettings(config, item.env, darwin);
  fs.writeFileSync(item.store, "/owner/changed\n");
  const result = restoreXcodeSettings(config, item.env, darwin);
  assert.equal(result.action, "left-unchanged");
  assert.equal(item.preference(), "/owner/changed");
  assert.equal(fs.existsSync(xcodePaths(config).receipt), false);
});

test("xcode: withdrawing the choice restores the preference", { skip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  applyXcodeSettings(item.config({ derivedData: true, simulators: true }), item.env, darwin);
  const declined = applyXcodeSettings(item.config({ derivedData: false, simulators: false }), item.env, darwin);
  assert.equal(declined.derivedData.action, "removed");
  assert.equal(item.preference(), null);
});

test("xcode: other platforms are left completely alone", { skip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const result = applyXcodeSettings(item.config({ derivedData: true, simulators: true }), item.env, { platform: "linux" });
  assert.equal(result.supported, false);
  assert.equal(item.preference(), null);
  assert.throws(() => xcodePrunePlan(item.config({ derivedData: true, simulators: true }), item.env, { platform: "linux" }), /macOS only/);
});

test("xcode: prune needs an explicit opt-in", { skip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  assert.throws(() => xcodePrunePlan(item.config(), item.env, darwin), /not enabled/);
  assert.throws(() => xcodePrunePlan(item.config({ derivedData: false, simulators: false }), item.env, darwin), /not enabled/);
});

test("xcode: DerivedData prune keeps recent, unmarked and linked folders and removes only old marked projects", { skip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = item.config({ derivedData: true, simulators: false });
  const root = xcodePaths(config).derivedData;
  fs.mkdirSync(root, { recursive: true });
  const old = project(root, "Old", { days: 60 });
  const recent = project(root, "Recent", { days: 2 });
  const unmarked = project(root, "Unmarked", { marked: false, days: 90 });
  const outside = path.join(item.root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, `Linked-${HASH}`));
  fs.mkdirSync(path.join(root, "ModuleCache.noindex"));

  const plan = xcodePrunePlan(config, item.env, darwin);
  const byLabel = Object.fromEntries(plan.entries.map((entry) => [entry.label, entry]));
  assert.equal(byLabel[path.basename(old)].eligible, true);
  assert.equal(byLabel[path.basename(recent)].reason, "recent");
  assert.equal(byLabel[path.basename(unmarked)].reason, "no-xcode-marker");
  assert.equal(byLabel[`Linked-${HASH}`].reason, "not-a-real-directory");
  assert.equal(byLabel["ModuleCache.noindex"], undefined, "shared caches are not project folders");
  assert.equal(fs.existsSync(old), true, "planning deletes nothing");

  const outcome = applyXcodePrune(plan, config, item.env, darwin);
  assert.deepEqual(outcome.map((entry) => entry.status), ["done"]);
  assert.equal(fs.existsSync(old), false);
  for (const kept of [recent, unmarked, path.join(root, `Linked-${HASH}`), path.join(root, "ModuleCache.noindex"), outside]) assert.equal(fs.existsSync(kept), true, kept);
});

test("xcode: a running Xcode stops DerivedData and DeviceSupport removal", { skip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = item.config({ derivedData: true, simulators: true });
  const root = xcodePaths(config).derivedData;
  fs.mkdirSync(root, { recursive: true });
  const old = project(root, "Old");
  fs.writeFileSync(path.join(item.running, "xcodebuild"), "");
  const plan = xcodePrunePlan(config, item.env, darwin);
  assert.equal(plan.activity.running, true);
  assert.equal(plan.entries.find((entry) => entry.path === old).reason, "xcode-running");
  assert.equal(applyXcodePrune(plan, config, item.env, darwin).filter((entry) => entry.status === "done").length, 0);
  assert.equal(fs.existsSync(old), true);
});

test("xcode: an unknown process state is treated as busy, not idle", { skip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = item.config({ derivedData: true, simulators: false });
  const root = xcodePaths(config).derivedData;
  fs.mkdirSync(root, { recursive: true });
  const old = project(root, "Old");
  fs.rmSync(path.join(item.root, "fake-bin", "pgrep"));
  const noPgrep = { ...item.env, PATH: path.join(item.root, "fake-bin") };
  const plan = xcodePrunePlan(config, noPgrep, darwin);
  assert.equal(plan.entries.find((entry) => entry.path === old).reason, "activity-unknown");
});

test("xcode: simulator clean-up is planned first and only runs on apply", { skip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = item.config({ derivedData: false, simulators: true });
  const paths = xcodePaths(config);
  fs.writeFileSync(path.join(item.simctl, "unavailable.json"), JSON.stringify({ devices: { "iOS 17.0": [{ udid: "A", isAvailable: false }, { udid: "B", isAvailable: false }] } }));
  fs.mkdirSync(path.join(paths.testingDevices, "clone-1"), { recursive: true });
  fs.mkdirSync(path.join(paths.simulatorCaches, "dyld"), { recursive: true });
  fs.writeFileSync(path.join(paths.simulatorCaches, "dyld", "cache"), "x");
  const support = path.join(paths.deviceSupport[0], "17.0 (21A329)");
  fs.mkdirSync(support, { recursive: true });
  age(support, 90);
  const fresh = path.join(paths.deviceSupport[0], "18.0 (22A100)");
  fs.mkdirSync(fresh, { recursive: true });

  const plan = xcodePrunePlan(config, item.env, darwin);
  const byCategory = (name) => plan.entries.filter((entry) => entry.category === name);
  assert.equal(byCategory("unavailable-simulators")[0].count, 2);
  assert.equal(byCategory("unavailable-simulators")[0].eligible, true);
  assert.equal(byCategory("testing-simulators")[0].eligible, true);
  assert.equal(byCategory("simulator-caches")[0].eligible, true);
  assert.deepEqual(byCategory("device-support").map((entry) => [path.basename(entry.path), entry.eligible]).sort(), [["17.0 (21A329)", true], ["18.0 (22A100)", false]]);
  assert.equal(item.calls().some((line) => /delete/.test(line)), false, "a plan never deletes");

  const outcome = applyXcodePrune(plan, config, item.env, darwin);
  assert.equal(outcome.filter((entry) => entry.status === "done").length, 4);
  const deletes = item.calls().filter((line) => /delete/.test(line));
  assert.deepEqual(deletes, ["simctl delete unavailable", "simctl --set testing delete all"]);
  assert.equal(fs.existsSync(support), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(paths.simulatorCaches), true, "the caches folder itself stays");
  assert.deepEqual(fs.readdirSync(paths.simulatorCaches), []);
});

test("xcode: a booted simulator blocks cache and device-set removal", { skip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = item.config({ derivedData: false, simulators: true });
  const paths = xcodePaths(config);
  fs.mkdirSync(path.join(paths.simulatorCaches, "dyld"), { recursive: true });
  fs.mkdirSync(path.join(paths.testingDevices, "clone-1"), { recursive: true });
  fs.writeFileSync(path.join(item.simctl, "booted-default.json"), JSON.stringify({ devices: { runtime: [{ udid: "A", state: "Booted" }] } }));
  const plan = xcodePrunePlan(config, item.env, darwin);
  for (const category of ["simulator-caches", "testing-simulators"]) {
    const entry = plan.entries.find((candidate) => candidate.category === category);
    assert.equal(entry.eligible, false);
    assert.equal(entry.reason, "simulator-booted");
  }
  assert.equal(applyXcodePrune(plan, config, item.env, darwin).length, 0);
  assert.equal(fs.existsSync(path.join(paths.simulatorCaches, "dyld")), true);
});

test("xcode: when simctl cannot run, nothing simulator-related is removed", { skip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = item.config({ derivedData: false, simulators: true });
  const paths = xcodePaths(config);
  fs.mkdirSync(path.join(paths.simulatorCaches, "dyld"), { recursive: true });
  fs.writeFileSync(path.join(item.simctl, "unusable"), "");
  const plan = xcodePrunePlan(config, item.env, darwin);
  assert.equal(plan.entries.every((entry) => entry.eligible === false), true);
  assert.equal(plan.entries.find((entry) => entry.category === "simulator-caches").reason, "simctl-unavailable");
  const status = xcodeStatus(config, item.env, darwin);
  assert.equal(status.simulators.usable, false);
});

test("xcode: status reports the preference and sizes without changing anything", { skip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = item.config({ derivedData: true, simulators: false });
  applyXcodeSettings(config, item.env, darwin);
  project(xcodePaths(config).derivedData, "App");
  const status = xcodeStatus(config, item.env, { sizes: true, ...darwin });
  assert.equal(status.preference.matchesManagedRoot, true);
  assert.equal(status.sizes.derivedData.status, "complete");
  assert.ok(status.sizes.derivedData.logicalBytes > 0);
});

test("xcode: the setup questions default to no and treat closed input as no", async () => {
  const config = resolveConfig({ env: { HOME: os.tmpdir(), CLEAN_DEVELOPMENT_HOME: os.tmpdir() }, includeProject: false, overrides: { root: path.join(os.tmpdir(), "cd-xcode-prompt") } });
  const ask = async (text) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk) => { written += chunk; });
    const pending = promptXcodeChoice(config, { input, stream: output, terminal: false });
    if (text !== null) input.write(text);
    input.end();
    return { answer: await pending, written };
  };
  assert.deepEqual((await ask("y\nn\n")).answer, { derivedData: true, simulators: false });
  assert.deepEqual((await ask("\n\n")).answer, { derivedData: false, simulators: false });
  assert.deepEqual((await ask("maybe\nyes\nY\n")).answer, { derivedData: true, simulators: true });
  const closed = await ask(null);
  assert.deepEqual(closed.answer, { derivedData: false, simulators: false });
  assert.match(closed.written, /Nothing changes unless you say yes/);
  assert.match(closed.written, /IDECustomDerivedDataLocation/);
});

test("xcode: configuration accepts the choice in user config only", { skip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const file = writeUserConfig({ ...item.config({ derivedData: true, simulators: false }), agents: [] }, item.env);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).xcode, { derivedData: true, simulators: false });
  assert.deepEqual(resolveConfig({ env: item.env, includeProject: false }).xcode, { derivedData: true, simulators: false });
  fs.rmSync(file);
  const undecided = writeUserConfig({ ...item.config(), agents: [] }, item.env);
  assert.equal("xcode" in JSON.parse(fs.readFileSync(undecided, "utf8")), false);

  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, xcode: { derivedData: "yes" } }));
  assert.throws(() => resolveConfig({ env: item.env, includeProject: false }), /xcode.derivedData must be a boolean/);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, xcode: { archives: true } }));
  assert.throws(() => resolveConfig({ env: item.env, includeProject: false }), /unknown xcode key 'archives'/);
  fs.rmSync(file);
  const projectDirectory = path.join(item.root, "project");
  fs.mkdirSync(projectDirectory);
  fs.writeFileSync(path.join(projectDirectory, ".clean-development.json"), JSON.stringify({ schemaVersion: 1, xcode: { derivedData: true } }));
  assert.throws(() => resolveConfig({ cwd: projectDirectory, env: item.env }), /unknown key 'xcode'/);
});

const cliSkip = process.platform === "darwin" ? false : "the CLI only manages Xcode on macOS";

function run(item, args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: item.root, env: item.env, encoding: "utf8" });
}

test("xcode CLI: setup asks nothing without a terminal and leaves Xcode alone", { skip: cliSkip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const result = run(item, ["setup", "--root", item.managed, "--agents", "claude", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(item.preference(), null);
  const config = JSON.parse(fs.readFileSync(path.join(item.root, "config", "config.json"), "utf8"));
  assert.equal("xcode" in config, false, "an unanswered question is not recorded as no");
  assert.equal(JSON.parse(result.stdout).xcode.decided, false);
});

test("xcode CLI: --xcode dry run previews, --xcode applies, --no-xcode withdraws, uninstall restores", { skip: cliSkip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(item.store, "/before/setup\n");

  const preview = run(item, ["setup", "--root", item.managed, "--agents", "claude", "--xcode", "--dry-run", "--json"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).xcode.derivedData.action, "would-set");
  assert.equal(item.preference(), "/before/setup");
  assert.equal(fs.existsSync(path.join(item.root, "config")), false);

  const setup = run(item, ["setup", "--root", item.managed, "--agents", "claude", "--xcode", "--json"]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(item.preference(), path.join(item.managed, "xcode", "DerivedData"));
  const config = JSON.parse(fs.readFileSync(path.join(item.root, "config", "config.json"), "utf8"));
  assert.deepEqual(config.xcode, { derivedData: true, simulators: true });

  const status = run(item, ["xcode", "status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).preference.matchesManagedRoot, true);

  // update keeps the earlier answer without asking again
  const update = run(item, ["update", "--json"]);
  assert.equal(update.status, 0, update.stderr);
  assert.equal(JSON.parse(update.stdout).xcode.derivedData.action, "unchanged");

  const dry = run(item, ["xcode", "prune", "--json"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).apply, false);

  const both = run(item, ["update", "--xcode", "--no-xcode"]);
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /mutually exclusive/);

  const withdrawn = run(item, ["update", "--no-xcode", "--json"]);
  assert.equal(withdrawn.status, 0, withdrawn.stderr);
  assert.equal(item.preference(), "/before/setup");
  assert.equal(run(item, ["xcode", "prune"]).status, 1, "prune refuses once the choice is withdrawn");

  assert.equal(run(item, ["update", "--xcode", "--json"]).status, 0);
  const uninstall = run(item, ["uninstall", "--json"]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(item.preference(), "/before/setup");
  assert.equal(JSON.parse(uninstall.stdout).xcode.action, "restored");
});

test("xcode CLI: subcommand and option validation", { skip: cliSkip }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  for (const args of [["xcode", "clean"], ["xcode", "status", "--apply"], ["xcode", "prune", "--sizes"], ["xcode", "status", "extra"]]) {
    const result = run(item, args);
    assert.notEqual(result.status, 0, args.join(" "));
  }
});
