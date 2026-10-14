import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { hostBoundaryEnvironment } from "../../scripts/verify-host-boundaries.mjs";
import { verificationSource } from "../../scripts/verification-utils.mjs";
import { snapshotFootprint } from "../../scripts/footprint-utils.mjs";
import { ensureRealDirectory } from "../../src/io.js";

export const repository = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const cli = path.join(repository, "bin", "clean-development.js");
export const observer = path.join(repository, "test", "codex-acceptance", "child.cjs");
export const fakeHost = path.join(repository, "test", "codex-acceptance", "host.cjs");
export const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
export const EVENTS = ["startup", "resume", "fork", "subagent", "cwd-change"];
const PREFIX = "clean-development-codex-acceptance-";

export function sourceIdentity() {
  return { ...verificationSource(repository), fixtureSha256: Object.fromEntries(["fixture.mjs", "host.cjs", "child.cjs", "run.mjs"].map((name) =>
    [name, createHash("sha256").update(fs.readFileSync(path.join(repository, "test", "codex-acceptance", name))).digest("hex")])) };
}

export function makeFixture({ backend = "fixture", scratchRoot = os.tmpdir(), npm = null } = {}) {
  assert.ok(["fixture", "live"].includes(backend));
  assert.ok(ensureRealDirectory(scratchRoot));
  const root = fs.mkdtempSync(path.join(scratchRoot, PREFIX));
  const env = hostBoundaryEnvironment(root, { PATH: "/usr/bin:/bin" });
  // Let the actual host/session choose tool caches. Independent unrelated
  // overrides remain explicit controls in the fixture.
  for (const key of ["npm_config_cache", "npm_config_store_dir", "CARGO_TARGET_DIR", "GOCACHE", "GOMODCACHE"]) delete env[key];
  env.UV_CACHE_DIR = path.join(root, "independent-uv-cache");
  const tools = path.join(root, "tools"), outputs = path.join(root, "outputs"), evidence = path.join(root, "evidence");
  for (const dir of [env.HOME, env.CODEX_HOME, env.XDG_CACHE_HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.TMPDIR, tools, outputs, evidence]) fs.mkdirSync(dir, { recursive: true });
  const projects = Object.fromEntries(["normal", "other", "disabled"].map((name) => [name, path.join(root, `project ${name} é`)]));
  for (const project of Object.values(projects)) {
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "package.json"), '{"name":"codex-acceptance-fixture","version":"0.0.0","private":true,"files":["artifact.txt"]}\n');
    fs.writeFileSync(path.join(project, "artifact.txt"), "predefined offline npm artifact\n");
  }
  fs.writeFileSync(path.join(projects.disabled, ".clean-development.json"), '{"schemaVersion":1,"enabled":false}\n');
  const originalConfig = 'model = "unrelated-fixture-choice"\n';
  fs.writeFileSync(path.join(env.CODEX_HOME, "config.toml"), originalConfig);
  if (backend === "fixture") {
    for (const [name, module, mode] of [["codex", fakeHost, ""], ["npm", observer, "npm "]]) {
      fs.writeFileSync(path.join(tools, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(module)} ${mode}"$@"\n`, { mode: 0o700 });
    }
  } else {
    assert.ok(npm && path.isAbsolute(npm), "Live preparation requires an already installed npm executable");
    fs.accessSync(npm, fs.constants.X_OK);
    assert.ok(fs.statSync(npm).isFile());
    env.PATH = `${path.dirname(npm)}:${env.PATH}`;
  }
  env.PATH = `${tools}:${env.PATH}`; env.CD_CODEX_LAB = root;
  const item = { schemaVersion: 1, owner: "clean-development-codex-acceptance", root, scratchRoot: path.resolve(scratchRoot), backend,
    env, tools, projects, outputs, evidence, managed: path.join(root, "managed"), bin: path.join(root, "data", "bin"), originalConfig,
    npm, source: sourceIdentity(), protected: Object.fromEntries(Object.values(projects).flatMap((project) => ["package.json", "artifact.txt",
      ...(project === projects.disabled ? [".clean-development.json"] : [])].map((name) => path.join(project, name)))
      .map((file) => [file, fs.readFileSync(file, "utf8")])) };
  fs.writeFileSync(path.join(root, "lab.json"), `${JSON.stringify(item, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return item;
}

export function loadFixture(root) {
  assert.ok(root && path.isAbsolute(root) && path.basename(root).startsWith(PREFIX), "Use an exact prepared Codex lab");
  assert.ok(ensureRealDirectory(root));
  const file = path.join(root, "lab.json"), stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size < 1024 * 1024);
  const item = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(item.owner, "clean-development-codex-acceptance"); assert.equal(item.schemaVersion, 1); assert.equal(item.root, root);
  assert.equal(path.dirname(root), item.scratchRoot); assert.ok(["fixture", "live"].includes(item.backend));
  const expected = hostBoundaryEnvironment(root, {});
  const removed = new Set(["npm_config_cache", "npm_config_store_dir", "CARGO_TARGET_DIR", "GOCACHE", "GOMODCACHE"]);
  for (const [key, value] of Object.entries(expected)) {
    if (["PATH", "UV_CACHE_DIR", "RUSTUP_HOME"].includes(key) || removed.has(key)) continue;
    // Older disposable labs may predate a newly added non-path isolation flag;
    // critical native paths below remain mandatory and every present value is
    // checked. This keeps guarded teardown usable across harness improvements.
    if (item.env[key] !== undefined) assert.equal(item.env[key], value, `Changed lab environment: ${key}`);
  }
  const allowed = new Set([...Object.keys(expected).filter((key) => !removed.has(key)), "CD_CODEX_LAB", "RUSTUP_HOME", "PATH"]);
  for (const key of Object.keys(item.env)) assert.ok(allowed.has(key), `Unknown lab environment field: ${key}`);
  assert.equal(item.env.CD_CODEX_LAB, root); assert.equal(item.env.UV_CACHE_DIR, path.join(root, "independent-uv-cache"));
  if (item.backend === "fixture") assert.equal(item.env.PATH, `${path.join(root, "tools")}:/usr/bin:/bin`);
  else {
    assert.ok(typeof item.npm === "string" && path.isAbsolute(item.npm));
    assert.equal(item.env.PATH, `${path.join(root, "tools")}:${path.dirname(item.npm)}:/usr/bin:/bin`);
  }
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP",
    "CLEAN_DEVELOPMENT_HOME", "CLEAN_DEVELOPMENT_DATA_HOME", "CLEAN_DEVELOPMENT_CONFIG_HOME", "CLEAN_DEVELOPMENT_ROOT", "CLEAN_DEVELOPMENT_CACHE_ROOT", "CLEAN_DEVELOPMENT_BUILD_ROOT", "CLEAN_DEVELOPMENT_SCRATCH_ROOT"]) assert.equal(item.env[key], expected[key], `Changed lab path: ${key}`);
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "BASH_ENV", "NODE_OPTIONS", "SSH_AUTH_SOCK"]) assert.equal(item.env[key], undefined);
  for (const [name, project] of Object.entries(item.projects)) assert.equal(project, path.join(root, `project ${name} é`));
  for (const [key, relative] of Object.entries({ tools: "tools", outputs: "outputs", evidence: "evidence", managed: "managed", bin: "data/bin" })) assert.equal(item[key], path.join(root, relative));
  for (const directory of [item.outputs, item.evidence, item.env.HOME, item.env.CODEX_HOME, ...Object.values(item.projects)]) assert.ok(ensureRealDirectory(directory));
  const protectedFiles = Object.values(item.projects).flatMap((project) => ["package.json", "artifact.txt", ...(project === item.projects.disabled ? [".clean-development.json"] : [])].map((name) => path.join(project, name)));
  assert.deepEqual(Object.keys(item.protected).sort(), protectedFiles.sort());
  for (const file of protectedFiles) {
    const details = fs.lstatSync(file); assert.ok(details.isFile() && !details.isSymbolicLink() && details.size < 1024 * 1024);
  }
  return item;
}

export function destroyFixture(item) { loadFixture(item.root); fs.rmSync(item.root, { recursive: true, force: true }); }
export function product(item, args, env = item.env, cwd = item.projects.normal) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); return result;
}
export function setup(item) {
  // A stable native PATH control excludes ephemeral fixture tool executables.
  product(item, ["setup", "--root", item.managed, "--agents", "codex", "--json"], { ...item.env, PATH: "/usr/bin:/bin" });
  const config = fs.readFileSync(path.join(item.env.CODEX_HOME, "config.toml"), "utf8");
  assert.ok(config.startsWith(item.originalConfig)); assert.match(config, /CLEAN_DEVELOPMENT_SESSION_MODE = "skip"/); return config;
}
export function roots(item) {
  return [{ name: "home", path: item.env.HOME }, { name: "native-cache", path: item.env.XDG_CACHE_HOME }, { name: "managed", path: item.managed }, { name: "outputs", path: item.outputs }];
}

export function runFixtureEvent(item, { name, event = "startup", mode = "native", project = "normal", loginShell = false, exitStatus = 0, inherited = item.env } = {}) {
  assert.equal(item.backend, "fixture", "Synthetic host events cannot establish live acceptance");
  assert.match(name || "", /^[a-z][a-z0-9-]*$/); assert.ok(EVENTS.includes(event)); assert.ok(["native", "session-only", "skip"].includes(mode));
  assert.ok(Object.hasOwn(item.projects, project)); assert.ok(Number.isInteger(exitStatus) && exitStatus >= 0 && exitStatus <= 125);
  const args = [event, "--fixture-case", name, "--fixture-login", String(loginShell), "--fixture-status", String(exitStatus), "--", "space argument", "a&b", "unicode-é"];
  const before = snapshotFootprint(roots(item));
  const command = mode === "native" ? path.join(item.tools, "codex") : process.execPath;
  const argv = mode === "native" ? args : [cli, "agent", "codex", "--session", mode, "--", ...args];
  const child = spawnSync(command, argv, { cwd: item.projects[project], env: inherited, encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024 });
  const after = snapshotFootprint(roots(item));
  assert.ok(fs.existsSync(path.join(item.evidence, `${name}-shell.json`)), `Synthetic child produced no evidence: ${child.error?.code || child.stderr}`);
  return { layer: "fixture-only", event: `synthetic-${event}`, child: { status: child.status, signal: child.signal, errorCode: child.error?.code || null }, before, after,
    evidence: readEvidence(item, name), liveAcceptance: "not-run" };
}
export function readEvidence(item, name) {
  assert.match(name || "", /^[a-z][a-z0-9-]*$/);
  return Object.fromEntries(["shell", "tool"].map((layer) => [layer, JSON.parse(fs.readFileSync(path.join(item.evidence, `${name}-${layer}.json`), "utf8"))]));
}
export function evaluateEvidence(item, name, { routed, project = "normal", linkage = null } = {}) {
  try {
    item = loadFixture(item.root);
    const value = readEvidence(item, name);
    assert.equal(value.shell.backend, item.backend); assert.equal(value.tool.backend, item.backend);
    assert.equal(value.tool.status, 0); assert.equal(value.tool.signal, null); assert.equal(value.tool.errorCode, null);
    assert.equal(value.shell.nonce, value.tool.nonce); assert.equal(value.shell.cwd, item.projects[project]); assert.equal(value.tool.cwd, value.shell.cwd);
    assert.ok(value.tool.artifact.startsWith(`${item.root}${path.sep}`)); assert.ok(ensureRealDirectory(path.dirname(value.tool.artifact)));
    const artifact = fs.lstatSync(value.tool.artifact); assert.ok(artifact.isFile() && !artifact.isSymbolicLink() && artifact.size > 0);
    assert.ok(value.tool.cache.startsWith(`${routed ? item.managed : item.projects[project]}${path.sep}`) || (!routed && value.tool.cache.startsWith(`${item.env.HOME}${path.sep}`)));
    if (routed) { assert.equal(value.tool.mode, "session-only"); assert.equal(value.tool.homeCacheUnchanged, true); assert.equal(value.tool.homeUnchanged, true); }
    assert.equal(value.tool.footprintComplete, true);
    assert.ok(value.tool.cacheFiles > 0);
    for (const [file, content] of Object.entries(item.protected)) assert.equal(fs.readFileSync(file, "utf8"), content);
    for (const key of ["normal", "other"]) assert.equal(fs.existsSync(path.join(item.projects[key], ".clean-development.json")), false);
    if (item.backend === "live") {
      assert.equal(value.tool.protocol, "real-offline-npm-cache");
      const currentSource = sourceIdentity();
      for (const key of ["fingerprint", "fingerprintAlgorithm", "fingerprintScope", "fileCount"]) assert.equal(item.source[key], currentSource[key], "Prepared source changed");
      assert.deepEqual(item.source.fixtureSha256, currentSource.fixtureSha256, "Prepared observer/transport changed");
      assert.ok(linkage && EVENTS.includes(linkage.event) && /^[a-zA-Z0-9_-]{1,128}$/.test(linkage.sessionId || "") && /^[a-zA-Z0-9_-]{1,128}$/.test(linkage.toolCallId || ""), "Actual host session/event/tool linkage is required");
      assert.match(linkage.hostVersion || "", /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/);
      assert.equal(linkage.nonce, value.shell.nonce);
      if (["resume", "fork"].includes(linkage.event)) assert.ok(/^[a-zA-Z0-9_-]{1,128}$/.test(linkage.parentSessionId || ""), "Actual session lineage is required");
      if (linkage.event === "fork") assert.notEqual(linkage.sessionId, linkage.parentSessionId);
      if (linkage.event === "subagent") assert.ok(/^[a-zA-Z0-9_-]{1,128}$/.test(linkage.subagentId || ""), "Actual subagent identity is required");
    }
    return { status: "passed", layer: item.backend === "fixture" ? "fixture-only" : "live-candidate", nonce: value.shell.nonce,
      source: item.source,
      liveAcceptance: item.backend === "fixture" ? "not-run" : "unverified", linkage,
      boundary: "Child assertions; synthetic lifecycle events or caller linkage are not independently attested host acceptance" };
  } catch { return { status: "failed", layer: item.backend === "fixture" ? "fixture-only" : "live-candidate", liveAcceptance: "unverified", reason: "child-artifact-routing-footprint-or-host-linkage-check-failed" }; }
}
