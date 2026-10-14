import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { boundaryPlan, prepareBoundaryLab, loadBoundaryLab, hostBoundaryEnvironment, executeHostBoundary, preflightHostBoundary, main }
  from "../scripts/verify-host-boundaries.mjs";

function fixture(t) {
  const scratchRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-boundary-test-")));
  t.after(() => fs.rmSync(scratchRoot, { recursive: true, force: true }));
  return { scratchRoot, item: prepareBoundaryLab({ host: "codex", scratchRoot }) };
}

function installer(item, body) {
  const file = path.join(item.root, "installer.cjs"); fs.writeFileSync(file, body);
  return { executable: process.execPath, args: [file], expectArtifact: "outputs/tool" };
}

test("host boundary plan is read-only and rejects source/broad storage", (t) => {
  const { scratchRoot } = fixture(t), before = fs.readdirSync(scratchRoot);
  const plan = boundaryPlan({ host: "antigravity", scratchRoot });
  assert.equal(plan.automaticHostLaunch, false); assert.equal(plan.modelCalls, false); assert.equal(plan.cleanup, "none");
  assert.deepEqual(fs.readdirSync(scratchRoot), before);
  assert.throws(() => boundaryPlan({ host: "codex", scratchRoot: os.homedir() }), /dedicated/);
  assert.throws(() => boundaryPlan({ host: "codex", scratchRoot: process.cwd() }), /dedicated/);
  assert.throws(() => main(["execute", "--executable", process.execPath]), /prepared/);
});

test("host boundary children have disposable native homes and no inherited credentials or startup injection", (t) => {
  const { item } = fixture(t), env = hostBoundaryEnvironment(item.root, {
    PATH: "/installed/bin", OPENAI_API_KEY: "secret", ANTHROPIC_API_KEY: "secret", AWS_ACCESS_KEY_ID: "secret",
    CODEX_HOME: "/real/codex", CLAUDE_CONFIG_DIR: "/real/claude", BASH_ENV: "/real/startup", NODE_OPTIONS: "--require /real/module", SSH_AUTH_SOCK: "/real/socket",
    DEVELOPER_DIR: "/installed/sdk", RUSTUP_TOOLCHAIN: "pin"
  });
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "BASH_ENV", "NODE_OPTIONS", "SSH_AUTH_SOCK"]) assert.equal(env[key], undefined);
  assert.equal(env.PATH, "/installed/bin"); assert.equal(env.RUSTUP_TOOLCHAIN, "pin"); assert.equal(env.DEVELOPER_DIR, "/installed/sdk");
  for (const key of ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_STATE_HOME", "TMPDIR", "PIP_CACHE_DIR", "npm_config_cache"]) assert.ok(env[key].startsWith(`${item.root}${path.sep}`));
});

test("an explicitly selected installer produces measured output and preserves binary backups and durable state", (t) => {
  const { item } = fixture(t);
  const options = installer(item, [
    "const fs=require('node:fs'),path=require('node:path'); const root=path.dirname(process.argv[1]);",
    "fs.writeFileSync(path.join(root,'outputs','tool'),'binary-v1');",
    "fs.writeFileSync(path.join(root,'outputs','tool.old'),'binary-backup');",
    "fs.writeFileSync(path.join(process.env.XDG_DATA_HOME,'durable-state'),'keep-state');"
  ].join("\n"));
  const report = executeHostBoundary(item, { operation: "install", ...options });
  assert.equal(report.ok, true); assert.equal(report.sourceUnchanged, true); assert.equal(report.outputsPreserved, true);
  assert.equal(report.footprint.complete, true); assert.equal(report.artifact.logicalBytes, 9);
  assert.equal(fs.readFileSync(path.join(item.root, "outputs", "tool.old"), "utf8"), "binary-backup");
  assert.equal(fs.readFileSync(path.join(item.root, "native-data", "durable-state"), "utf8"), "keep-state");
  assert.equal(JSON.stringify(report).includes("binary-backup"), false);
  assert.equal(Object.hasOwn(report, "args"), false); assert.equal(Object.hasOwn(report, "stdout"), false);
});

test("a returned top-level HOME footprint fails the installer boundary without removing it", (t) => {
  const { item } = fixture(t);
  const options = installer(item, [
    "const fs=require('node:fs'),path=require('node:path'); const root=path.dirname(process.argv[1]);",
    "fs.writeFileSync(path.join(root,'outputs','tool'),'binary');",
    "fs.mkdirSync(path.join(process.env.HOME,'.local','bin'),{recursive:true});",
    "fs.writeFileSync(path.join(process.env.HOME,'.local','bin','tool.old'),'retain-backup');"
  ].join("\n"));
  const report = executeHostBoundary(item, { operation: "update", ...options });
  assert.equal(report.ok, false); assert.deepEqual(report.unexpected, ["home"]);
  assert.equal(fs.readFileSync(path.join(item.root, "native-home", ".local", "bin", "tool.old"), "utf8"), "retain-backup");
  assert.equal(report.footprint.deltas.find((delta) => delta.name === "home").files, 1);
});

test("install cannot pass using an old artifact, while a legitimate no-op update is labelled unchanged", (t) => {
  const { item } = fixture(t), artifact = path.join(item.root, "outputs", "tool");
  fs.writeFileSync(artifact, "old-binary");
  const options = { executable: process.execPath, args: ["-e", ""], expectArtifact: "outputs/tool" };
  const install = executeHostBoundary(item, { operation: "install", ...options });
  assert.equal(install.ok, false); assert.equal(install.child, null); assert.equal(install.reason, "install-artifact-already-exists");
  assert.equal(fs.readFileSync(artifact, "utf8"), "old-binary");
  const update = executeHostBoundary(item, { operation: "update", ...options });
  assert.equal(update.ok, true); assert.equal(update.artifactFreshness, "unchanged");
  assert.equal(update.phaseAcceptance, "no-op-boundary-observed"); assert.equal(update.liveAcceptance, "installer-boundary-only");
  assert.deepEqual(update.artifactBefore, update.artifact);
});

test("failed and timed-out children cannot pass even when an artifact exists; command output and secrets are not recorded", (t) => {
  const { item } = fixture(t);
  for (const [body, timeoutMs] of [["process.stdout.write('private-token');process.stderr.write('private-command');process.exit(31);", 10000],
    ["setInterval(()=>{},1000);", 20]]) {
    const options = installer(item, `const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(path.dirname(process.argv[1]),'outputs','tool'),'binary');${body}`);
    const report = executeHostBoundary(item, { operation: "update", timeoutMs, ...options });
    assert.equal(report.ok, false); assert.equal(JSON.stringify(report).includes("private-"), false);
    assert.ok(report.child.exitStatus !== 0 || report.child.errorCode);
  }
});

test("an exit-zero installer with a same-group descendant cannot certify its later footprint", { skip: process.platform === "win32" }, async (t) => {
  const { item } = fixture(t);
  const options = installer(item, [
    "const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');",
    "fs.writeFileSync(path.join(path.dirname(process.argv[1]),'outputs','tool'),'binary');",
    "cp.spawn(process.execPath,['-e',\"setTimeout(()=>require('node:fs').writeFileSync(require('node:path').join(process.env.HOME,'.late-write'),'after-report'),2000)\"],{stdio:'ignore'}).unref();"
  ].join("\n"));
  const report = executeHostBoundary(item, { operation: "install", ...options });
  assert.equal(report.child.exitStatus, 0); assert.equal(report.child.cleanupComplete, false);
  assert.equal(report.child.lifetime, "active-process-group"); assert.equal(report.ok, false);
  // The helper retains uncertainty and does not terminate the successful
  // parent's descendants. This fixture's bounded child ends on its own.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(fs.readFileSync(path.join(item.root, "native-home", ".late-write"), "utf8"), "after-report");
});

test("incomplete observation refuses an installer before execution", (t) => {
  const { item } = fixture(t), options = installer(item, "require('node:fs').writeFileSync(require('node:path').join(require('node:path').dirname(process.argv[1]),'outputs','tool'),'must-not-run');");
  const report = executeHostBoundary(item, { operation: "install", limits: { maxEntries: 1 }, ...options });
  assert.equal(report.ok, false); assert.equal(report.child, null); assert.equal(report.reason, "incomplete-before-observation");
  assert.equal(fs.existsSync(path.join(item.root, "outputs", "tool")), false);
});

test("installer destination and output aliases are rejected without observing their targets", (t) => {
  const { item } = fixture(t);
  assert.throws(() => executeHostBoundary(item, { operation: "install", executable: process.execPath, args: [], expectArtifact: "../outside" }), /outputs/);
  const output = path.join(item.root, "outputs"); fs.rmdirSync(output);
  fs.symlinkSync(process.platform === "win32" ? path.parse(item.root).root : "/usr", output, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => loadBoundaryLab(item.root), /real directory/);
});

test("preflight records exact installed version/help capabilities and remains separate from host lifecycle acceptance", { skip: process.platform === "win32" }, (t) => {
  const { item } = fixture(t), host = path.join(item.root, "fake-codex");
  fs.writeFileSync(host, `#!${process.execPath}\nif(process.argv[2]==='--version')console.log('codex-cli 1.2.3-alpha.4');else if(process.argv[2]==='--help')console.log('resume fork -c, --config CONFIG');else process.exit(97);\n`, { mode: 0o700 });
  const report = preflightHostBoundary(item, host, { inherited: { OPENAI_API_KEY: "private-token" } });
  assert.equal(report.ok, true); assert.equal(report.version, "1.2.3-alpha.4");
  assert.equal(report.capabilities.resume, true); assert.equal(report.capabilities.fork, true);
  assert.equal(report.liveAcceptance, "not-run"); assert.equal(report.authentication, "not-inspected"); assert.equal(report.modelCalls, false);
  assert.match(report.source.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(report.footprint.clean, true);
});
