import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeFixture, destroyFixture, loadFixture, setup, runFixtureEvent, evaluateEvidence, product, observer, readEvidence } from "./codex-acceptance/fixture.mjs";
import { compareFootprints } from "../scripts/footprint-utils.mjs";

const posix = { skip: process.platform === "win32" ? "POSIX synthetic host transport; native Windows acceptance remains separate" : false };
function fixture(t) { const item = makeFixture(); t.after(() => destroyFixture(item)); return item; }
function pass(item, name, options) {
  const result = evaluateEvidence(item, name, options); assert.equal(result.status, "passed", result.reason);
  assert.equal(result.layer, "fixture-only"); assert.equal(result.liveAcceptance, "not-run");
}

test("Codex transport fixture executes a native child before setup and a skip child after setup", posix, (t) => {
  const item = fixture(t);
  const before = runFixtureEvent(item, { name: "before-setup", loginShell: true });
  assert.equal(before.child.status, 0); assert.equal(before.evidence.shell.loginShell, "true");
  pass(item, "before-setup", { routed: false });
  setup(item);
  const native = runFixtureEvent(item, { name: "after-setup", loginShell: true });
  assert.equal(native.child.status, 0); assert.equal(native.evidence.tool.mode, "skip");
  assert.equal(native.evidence.shell.loginShell, "false", "Owned policy disables the requested login shell in the synthetic transport");
  pass(item, "after-setup", { routed: false });
  assert.equal(native.liveAcceptance, "not-run");
});

test("Codex fixture resumes, forks and delegates synthetic subagents through explicit routing and skip", posix, (t) => {
  for (const event of ["startup", "resume", "fork", "subagent"]) {
    const item = fixture(t); setup(item);
    for (const mode of ["session-only", "skip"]) {
      const name = `${event}-${mode}`, result = runFixtureEvent(item, { name, event, mode });
      assert.equal(result.child.status, 0); assert.equal(result.event, `synthetic-${event}`);
      assert.equal(result.before.complete, true); assert.equal(result.after.complete, true);
      assert.equal(compareFootprints(result.before, result.after).deltas.find((delta) => delta.name === "home").changed, false);
      pass(item, name, { routed: mode === "session-only" });
      assert.deepEqual(result.evidence.tool.argv, ["fixture-write", "space argument", "a&b", "unicode-é"]);
      const host = JSON.parse(fs.readFileSync(path.join(item.evidence, `${name}-host.json`), "utf8"));
      assert.deepEqual(host.argv.slice(-3), ["space argument", "a&b", "unicode-é"]);
    }
  }
});

test("Codex fixture dispatches from changed cwd and honours a disabled project for resumed/forked/subagent children", posix, (t) => {
  const item = fixture(t); setup(item);
  const other = runFixtureEvent(item, { name: "cwd-other", event: "cwd-change", mode: "session-only", project: "other" });
  assert.equal(other.child.status, 0); pass(item, "cwd-other", { routed: true, project: "other" });
  for (const event of ["startup", "resume", "fork", "subagent", "cwd-change"]) {
    const result = runFixtureEvent(item, { name: `disabled-${event}`, event, mode: "session-only", project: "disabled" });
    assert.equal(result.child.status, 0); pass(item, `disabled-${event}`, { routed: false, project: "disabled" });
    assert.ok(result.evidence.tool.cache.startsWith(`${item.projects.disabled}${path.sep}`));
  }
});

test("Codex fixture removes inherited routing for explicit skip and retains child exit status after artifact creation", posix, (t) => {
  const item = fixture(t); setup(item);
  const names = ["PATH", "npm_config_cache", "CLEAN_DEVELOPMENT_SESSION_MODE", "CLEAN_DEVELOPMENT_ACTIVE", "CLEAN_DEVELOPMENT_SESSION_ENV"];
  const inherited = JSON.parse(product(item, ["run", "--session", "session-only", "--", process.execPath, "-e",
    `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))))`]).stdout);
  assert.ok(inherited.npm_config_cache);
  const result = runFixtureEvent(item, { name: "inherited-skip", mode: "skip", inherited: { ...item.env, ...inherited } });
  assert.equal(result.child.status, 0); pass(item, "inherited-skip", { routed: false });
  const failed = runFixtureEvent(item, { name: "failed-child", mode: "session-only", exitStatus: 31 });
  assert.equal(failed.child.status, 31); assert.equal(failed.evidence.tool.status, 31);
  assert.equal(fs.existsSync(failed.evidence.tool.artifact), true);
  assert.equal(evaluateEvidence(item, "failed-child", { routed: true }).status, "failed");
});

test("Codex evidence verifier refuses forged backend, incomplete footprint, missing artifacts and missing live linkage", posix, (t) => {
  const item = fixture(t); setup(item); runFixtureEvent(item, { name: "negative", mode: "session-only" });
  const file = path.join(item.evidence, "negative-tool.json"), original = fs.readFileSync(file, "utf8"), value = JSON.parse(original);
  for (const changed of [{ ...value, backend: "live" }, { ...value, footprintComplete: false }, { ...value, nonce: "wrong-nonce" }, { ...value, artifact: path.join(item.outputs, "absent") }]) {
    fs.writeFileSync(file, JSON.stringify(changed)); assert.equal(evaluateEvidence(item, "negative", { routed: true }).status, "failed");
  }
  fs.writeFileSync(file, original);
  item.backend = "live"; assert.throws(() => runFixtureEvent(item, { name: "must-not-launch" }), /Synthetic host events/);
});

test("Codex lab paths are validated and credential/default-profile state is never copied", posix, (t) => {
  const item = fixture(t);
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NODE_OPTIONS", "BASH_ENV", "SSH_AUTH_SOCK"]) assert.equal(item.env[key], undefined);
  const file = path.join(item.root, "lab.json"), original = fs.readFileSync(file, "utf8"), value = JSON.parse(original);
  value.env.CODEX_HOME = "/outside/agent"; fs.writeFileSync(file, JSON.stringify(value));
  try { assert.throws(() => loadFixture(item.root), /Changed lab (?:path|environment): CODEX_HOME/); } finally { fs.writeFileSync(file, original); }
});

test("Codex live candidate needs actual host version, event and tool-call correlation before child assertions can pass", posix, (t) => {
  const item = makeFixture({ backend: "live", npm: process.execPath }); t.after(() => destroyFixture(item));
  const artifact = path.join(item.outputs, "fixture-artifact"); fs.writeFileSync(artifact, "negative input only");
  const nonce = "01800000-0000-4000-8000-000000000001";
  fs.writeFileSync(path.join(item.evidence, "live-negative-shell.json"), JSON.stringify({ backend: "live", cwd: item.projects.normal, nonce }));
  fs.writeFileSync(path.join(item.evidence, "live-negative-tool.json"), JSON.stringify({ backend: "live", cwd: item.projects.normal, nonce,
    status: 0, signal: null, errorCode: null, artifact, cache: path.join(item.managed, "caches", "npm"), mode: "session-only",
    footprintComplete: true, homeCacheUnchanged: true, homeUnchanged: true, cacheFiles: 1, protocol: "real-offline-npm-cache" }));
  for (const linkage of [null, { event: "startup", sessionId: "session", toolCallId: "tool", nonce },
    { event: "fork", sessionId: "same", parentSessionId: "same", toolCallId: "tool", hostVersion: "1.2.3", nonce },
    { event: "subagent", sessionId: "session", toolCallId: "tool", hostVersion: "1.2.3", nonce }]) {
    assert.equal(evaluateEvidence(item, "live-negative", { routed: true, linkage }).status, "failed");
  }
  const linkage = { event: "startup", sessionId: "session", toolCallId: "tool", hostVersion: "1.2.3", nonce };
  assert.equal(evaluateEvidence(item, "live-negative", { routed: true, linkage }).status, "passed", "Correlation control remains a live candidate, not attested host acceptance");
  const manifest = path.join(item.root, "lab.json"), original = fs.readFileSync(manifest, "utf8"), changed = JSON.parse(original);
  changed.source.fixtureSha256["child.cjs"] = "0".repeat(64); fs.writeFileSync(manifest, JSON.stringify(changed));
  try { assert.equal(evaluateEvidence(item, "live-negative", { routed: true, linkage }).status, "failed", "Observer digest drift must refuse live candidate verification"); }
  finally { fs.writeFileSync(manifest, original); }
});

test("live observer detects a HOME leak outside native cache subdirectories while tool cache routing remains correct", posix, (t) => {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-codex-home-leak-")));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const bin = path.join(scratch, "fake-native-bin"); fs.mkdirSync(bin);
  const npm = path.join(bin, "npm");
  fs.writeFileSync(npm, `#!${process.execPath}\n` + [
    "const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2);",
    "if(a[0]==='config'){console.log(process.env.npm_config_cache);}",
    "else if(a[0]==='pack'){const d=a[a.indexOf('--pack-destination')+1];fs.writeFileSync(path.join(d,'codex-acceptance-fixture-0.0.0.tgz'),'predefined-negative-artifact');console.log(JSON.stringify([{name:'codex-acceptance-fixture',filename:'codex-acceptance-fixture-0.0.0.tgz'}]));}",
    "else if(a[0]==='cache'){fs.mkdirSync(process.env.npm_config_cache,{recursive:true});fs.writeFileSync(path.join(process.env.npm_config_cache,'cache-entry'),'fixture');fs.writeFileSync(path.join(process.env.HOME,'.unmanaged-host-state'),'must-be-detected');}else process.exit(93);"
  ].join("\n"), { mode: 0o700 });
  const item = makeFixture({ backend: "live", scratchRoot: scratch, npm });
  product(item, ["run", "--session", "session-only", "--", process.execPath, observer, "observe", "home-leak"]);
  const value = readEvidence(item, "home-leak");
  assert.equal(value.tool.status, 0); assert.equal(value.tool.footprintComplete, true);
  assert.equal(value.tool.homeCacheUnchanged, true); assert.equal(value.tool.homeUnchanged, false);
  assert.ok(value.tool.cache.startsWith(`${item.managed}${path.sep}`));
  const result = evaluateEvidence(item, "home-leak", { routed: true,
    linkage: { event: "startup", sessionId: "session", toolCallId: "tool", hostVersion: "1.2.3", nonce: value.shell.nonce } });
  assert.equal(result.status, "failed");
});
