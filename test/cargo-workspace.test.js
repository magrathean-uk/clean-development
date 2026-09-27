import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveCargoWorkspace } from "../src/cargo-workspace.js";
import { resolveConfig } from "../src/config.js";
import { resolveExecutable, runTool } from "../src/runtime.js";
import { activeWorkspaceIds, listWorkspaceRecords, prunePlan } from "../src/state.js";
import { planSession } from "../src/session.js";
import { identifyWorkspace } from "../src/workspace.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-cargo-discovery-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const member = path.join(workspace, "member");
  const excluded = path.join(workspace, "excluded");
  const external = path.join(root, "external");
  const standalone = path.join(workspace, "standalone");
  for (const directory of [workspace, member, excluded, external, standalone]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(workspace, "Cargo.toml"), '[workspace]\nmembers=["member", "../external"]\nexclude=["excluded", "standalone"]\nresolver="2"\n');
  for (const [name, directory] of Object.entries({ member, excluded, external, standalone })) {
    fs.mkdirSync(path.join(directory, "src"));
    fs.writeFileSync(path.join(directory, "src", "lib.rs"), "pub fn fixture() {}\n");
    fs.writeFileSync(path.join(directory, "Cargo.toml"), `[package]\nname="${name}"\nversion="0.1.0"\n${name === "external" ? 'workspace="../workspace"\n' : ""}${name === "standalone" ? "\n[workspace]\n" : ""}`);
  }
  const env = isolatedEnvironment(root);
  const config = resolveConfig({ cwd: member, env });
  return { root, workspace, member, excluded, external, standalone, env, config };
}

test("Cargo discovery forwards selection context, stays offline and does not mutate its input environment", (t) => {
  const item = fixture(t);
  const args = ["+nightly", "-C", "workspace/member", "-Z", "unstable-options", "check", "--config", "net.retry=0", "--manifest-path=Cargo.toml", "--", "--manifest-path", "ignored"];
  const env = { ...item.env, CARGO_NET_OFFLINE: "false", RUSTUP_AUTO_INSTALL: "1" };
  const result = resolveCargoWorkspace(args, { executable: "cargo", cwd: item.root, env, invoke(command, argv, options) {
    assert.equal(command, "cargo");
    assert.deepEqual(argv, ["+nightly", "locate-project", "--workspace", "--message-format=json", "--manifest-path", path.join(item.member, "Cargo.toml"), "-Z", "unstable-options", "--config", "net.retry=0"]);
    assert.equal(options.cwd, item.member);
    assert.equal(options.env.CARGO_NET_OFFLINE, "true");
    assert.equal(options.env.RUSTUP_AUTO_INSTALL, "0");
    assert.equal(options.timeout, 5000);
    assert.equal(options.maxBuffer, 65536);
    return { status: 0, stdout: JSON.stringify({ root: path.join(item.workspace, "Cargo.toml") }) };
  } });
  assert.equal(result.root, item.workspace);
  assert.equal(result.effectiveCwd, item.member);
  assert.equal(env.RUSTUP_AUTO_INSTALL, "1");
  assert.equal(env.CARGO_NET_OFFLINE, "false");
  assert.equal(fs.existsSync(item.config.root), false);
});

test("standalone packages without workspace metadata need no subprocess", (t) => {
  const item = fixture(t);
  const project = path.join(item.root, "plain");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "Cargo.toml"), '[package]\nname="plain"\nversion="0.1.0"\n');
  const result = resolveCargoWorkspace([], { executable: "unused", cwd: project, env: item.env, invoke() { assert.fail("unexpected subprocess"); } });
  assert.equal(result.root, project);
});

test("read-only session planning does not query Cargo or create managed directories", (t) => {
  const item = fixture(t);
  const before = fs.readdirSync(item.root).sort();
  planSession({ cwd: item.member, config: item.config, env: { ...item.env, PATH: "" } });
  assert.deepEqual(fs.readdirSync(item.root).sort(), before);
  assert.equal(fs.existsSync(item.config.root), false);
});

test("Cargo discovery rejects failed, timed-out, malformed and non-manifest responses", (t) => {
  const item = fixture(t);
  for (const response of [
    { status: 101, stdout: "" }, { error: { code: "ETIMEDOUT" }, status: null },
    { status: 0, stdout: "{}" }, { status: 0, stdout: "not json" },
    { status: 0, stdout: '{"root":"Cargo.toml"}' },
    { status: 0, stdout: JSON.stringify({ root: path.join(item.root, "missing", "Cargo.toml") }) }
  ]) {
    assert.throws(() => resolveCargoWorkspace([], { executable: "cargo", cwd: item.member, env: item.env, invoke: () => response }), /Cargo workspace/);
  }
  assert.equal(fs.existsSync(item.config.locations.stateDir), false);
  assert.equal(fs.existsSync(item.config.buildRoot), false);
});

function fakeCargo(item) {
  const bin = path.join(item.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "cargo"), `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv.includes('locate-project')) { process.stdout.write(JSON.stringify({root:process.env.QUERY_ROOT})); process.exit(0); }\nfs.writeFileSync(process.env.CAPTURE, JSON.stringify({target:process.env.CARGO_TARGET_DIR,workspace:process.env.CLEAN_DEVELOPMENT_WORKSPACE_ID,args:process.argv.slice(2)}));\nif(process.env.HOLD) setTimeout(() => {}, 300);\n`, { mode: 0o755 });
  return { ...item.env, PATH: bin, CAPTURE: path.join(item.root, "capture.json") };
}

test("authoritative Cargo roots drive targets and receipts for excluded, external and nested packages", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t);
  const env = fakeCargo(item);
  for (const directory of [item.config.cacheRoot, item.config.buildRoot, item.config.scratchRoot]) fs.mkdirSync(directory, { recursive: true });
  for (const [cwd, root] of [[item.excluded, item.excluded], [item.external, item.workspace], [item.member, item.workspace], [item.standalone, item.standalone]]) {
    assert.equal(await runTool("cargo", ["check", "--offline"], { config: item.config, cwd, env: { ...env, QUERY_ROOT: path.join(root, "Cargo.toml") } }), 0);
    const observed = JSON.parse(fs.readFileSync(env.CAPTURE, "utf8"));
    const identity = identifyWorkspace("cargo", [], cwd, { root });
    assert.equal(observed.workspace, identity.id);
    assert.equal(observed.target, path.join(item.config.buildRoot, identity.id, "cargo", "target"));
    assert.deepEqual(observed.args, ["check", "--offline"]);
    assert.equal(listWorkspaceRecords(item.config).find(({ value }) => value.workspaceId === identity.id).value.workspace, root);
  }
  assert.equal(listWorkspaceRecords(item.config).length, 3);
});

test("discovered workspace identity is also used for active leases and pin protection", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t);
  const env = { ...fakeCargo(item), QUERY_ROOT: path.join(item.workspace, "Cargo.toml"), HOLD: "1" };
  for (const directory of [item.config.cacheRoot, item.config.buildRoot, item.config.scratchRoot]) fs.mkdirSync(directory, { recursive: true });
  const execution = runTool("cargo", ["check"], { config: item.config, cwd: item.external, env });
  const id = identifyWorkspace("cargo", [], item.external, { root: item.workspace }).id;
  const deadline = Date.now() + 3000;
  while (!activeWorkspaceIds(item.config).has(id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(activeWorkspaceIds(item.config).has(id));
  assert.equal(prunePlan(item.config, { olderThanDays: 0 }).find((entry) => entry.workspaceId === id).reason, "active");
  assert.equal(await execution, 0);
  const record = listWorkspaceRecords(item.config).find(({ value }) => value.workspaceId === id);
  fs.writeFileSync(record.file, JSON.stringify({ ...record.value, pinned: true, lastUsedAt: "2000-01-01T00:00:00.000Z" }));
  assert.equal(prunePlan(item.config, { olderThanDays: 0 }).find((entry) => entry.workspaceId === id).reason, "pinned");
});

test("skip and disabled projects do not invoke workspace discovery", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t);
  const env = fakeCargo(item); // No QUERY_ROOT: discovery would return invalid JSON.
  for (const options of [
    { config: item.config, env: { ...env, CLEAN_DEVELOPMENT_SESSION_MODE: "skip" } },
    { config: { ...item.config, enabled: false }, env }
  ]) {
    assert.equal(await runTool("cargo", ["check"], { ...options, cwd: item.external }), 0);
    assert.equal(JSON.parse(fs.readFileSync(env.CAPTURE, "utf8")).target, undefined);
  }
  assert.equal(fs.existsSync(item.config.locations.stateDir), false);
});

test("workspace identities agree with real Cargo for members, excludes, external links and nested workspaces", (t) => {
  const executable = resolveExecutable("cargo", process.env, null);
  if (!executable) { t.skip("Cargo is not installed on this host"); return; }
  const version = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5000, env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" } });
  if (version.status !== 0) { t.skip("Cargo has no usable installed toolchain on this host"); return; }
  t.diagnostic(version.stdout.trim());
  const item = fixture(t);
  for (const [cwd, expected] of [[item.member, item.workspace], [item.excluded, item.excluded], [item.external, item.workspace], [item.standalone, item.standalone]]) {
    assert.equal(resolveCargoWorkspace([], { executable, cwd, env: item.env }).root, expected);
    assert.equal(fs.existsSync(path.join(cwd, "Cargo.lock")), false);
    assert.equal(fs.existsSync(path.join(cwd, "target")), false);
  }
  assert.equal(fs.existsSync(item.config.root), false);
});


test("attached Cargo directory and unstable flags retain their meaning", (t) => {
  const item = fixture(t);
  const args = ["+nightly", "-Cworkspace/member", "-Zunstable-options", "check"];
  assert.equal(identifyWorkspace("cargo", args, item.root).effectiveCwd, item.member);
  resolveCargoWorkspace(args, { executable: "cargo", cwd: item.root, env: item.env, invoke(command, argv) {
    assert.deepEqual(argv.slice(-2), ["-Z", "unstable-options"]);
    return { status: 0, stdout: JSON.stringify({ root: path.join(item.workspace, "Cargo.toml") }) };
  } });
  assert.throws(() => resolveCargoWorkspace(["check", "--manifest-path", "a", "--manifest-path", "b"], {
    executable: "cargo", cwd: item.root, env: item.env
  }), /provided more than once/);
});


test("Cargo -C applies to relative target ownership checks before execution", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t);
  // Keep managed storage outside both command contexts so this regression
  // reaches the distinct explicit-target ownership check.
  const caller = path.join(item.root, "caller");
  fs.mkdirSync(caller);
  const env = { ...fakeCargo(item), QUERY_ROOT: path.join(item.workspace, "Cargo.toml") };
  for (const directory of [item.config.cacheRoot, item.config.buildRoot, item.config.scratchRoot]) fs.mkdirSync(directory, { recursive: true });
  const target = path.join(item.config.buildRoot, "unregistered", "target");
  const relative = path.relative(item.member, target);
  await assert.rejects(runTool("cargo", ["+nightly", "-C", item.member, "-Zunstable-options", "check", "--target-dir", relative], {
    config: item.config, cwd: caller, env
  }), /Refusing unowned explicit Cargo target/);
  assert.equal(fs.existsSync(env.CAPTURE), false);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(listWorkspaceRecords(item.config), []);
});
