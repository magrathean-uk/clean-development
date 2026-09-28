import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Source-contract checks are deliberately separate from the opt-in REAL host
// test below. Neither this driver nor a fake tool is OpenCode acceptance.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "bin", "clean-development.js");
const plugin = path.join(repo, ".opencode", "plugins", "clean-development.js");
const nativeWindows = process.platform === "win32";
const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const fields = ["PATH", "CLEAN_DEVELOPMENT_SESSION_MODE", "CLEAN_DEVELOPMENT_ACTIVE",
  "CLEAN_DEVELOPMENT_SESSION_ENV", "npm_config_cache", "NPM_CONFIG_CACHE", "GOCACHE", "gocache"];
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cd-opencode-")));
  let retain = false;
  const originals = new Map();
  t.after(() => {
    try { for (const [file, digest] of originals) assert.equal(hash(file), digest, `source changed: ${file}`); }
    finally { if (!retain) fs.rmSync(root, { recursive: true, force: true }); }
  });
  const at = (...parts) => path.join(root, ...parts);
  for (const name of ["home", "bin", "tmp", "config", "xdg-config", "xdg-cache", "xdg-data", "xdg-state", "a", "b", "disabled", "cache-b", "evidence"]) {
    fs.mkdirSync(at(name));
  }
  for (const name of ["a", "b", "disabled"]) fs.writeFileSync(at(name, "package.json"), "{}\n");
  write(at("b", ".clean-development.json"), { schemaVersion: 1, cacheRoot: at("cache-b") });
  write(at("disabled", ".clean-development.json"), { schemaVersion: 1, enabled: false });
  for (const file of [at("a", "package.json"), at("b", "package.json"), at("disabled", "package.json"), at("b", ".clean-development.json"), at("disabled", ".clean-development.json")]) originals.set(file, hash(file));
  fs.writeFileSync(at("npmrc"), "");
  fs.writeFileSync(at("gitconfig"), "");
  // Allowlist, not {...process.env}: no real credentials, npm settings, agent
  // configuration, NODE_OPTIONS, shell startup overrides or inherited routes.
  const env = {
    HOME: at("home"), USERPROFILE: at("home"), SHELL: "/bin/sh", LANG: "C.UTF-8",
    PATH: [at("bin"), path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter),
    TMPDIR: at("tmp"), TMP: at("tmp"), TEMP: at("tmp"),
    XDG_CONFIG_HOME: at("xdg-config"), XDG_DATA_HOME: at("xdg-data"),
    XDG_CACHE_HOME: at("xdg-cache"), XDG_STATE_HOME: at("xdg-state"),
    CLEAN_DEVELOPMENT_HOME: at("home"), CLEAN_DEVELOPMENT_DATA_HOME: at("data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: at("config"), CLEAN_DEVELOPMENT_ROOT: at("managed"),
    CLAUDE_CONFIG_DIR: at("claude"), CODEX_HOME: at("codex"), GROK_HOME: at("grok"),
    npm_config_userconfig: at("npmrc"), npm_config_globalconfig: at("npmrc"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: at("gitconfig")
  };
  const snapshot = `Object.fromEntries(${JSON.stringify(fields)}.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))`;
  fs.writeFileSync(at("capture.cjs"), `const fs=require('node:fs');fs.writeFileSync(process.argv[2],JSON.stringify({cwd:process.cwd(),env:${snapshot}}),{flag:'wx'});\n`);
  // Bounded artifact-producing tool, not a real npm installation or registry call.
  fs.writeFileSync(at("tool.cjs"), `const fs=require('node:fs'),path=require('node:path');
const cache=process.env.npm_config_cache||process.env.NPM_CONFIG_CACHE||path.join(process.env.HOME,'native-npm');
const artifact=path.join(cache,process.argv[3]+'.sentinel');fs.mkdirSync(cache,{recursive:true});
fs.writeFileSync(artifact,'fixture\\n',{flag:'wx'});
fs.writeFileSync(process.argv[2],JSON.stringify({cwd:process.cwd(),env:${snapshot},artifact}),{flag:'wx'});\n`);
  fs.writeFileSync(at("bin", "npm"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(at("tool.cjs"))} "$@"\n`, { mode: 0o755 });
  const request = (name, project) => ({ name, cwd: at(project), shell: at("evidence", `${name}-shell.json`), tool: at("evidence", `${name}-tool.json`) });
  const command = (r) => `${quote(process.execPath)} ${quote(at("capture.cjs"))} ${quote(r.shell)} && npm ${quote(r.tool)} ${quote(r.name)}`;
  fs.writeFileSync(at("driver.mjs"), `import fs from 'node:fs';import {spawnSync} from 'node:child_process';
import {CleanDevelopmentPlugin} from ${JSON.stringify(pathToFileURL(plugin).href)};
const requests=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const plugin=await CleanDevelopmentPlugin({directory:process.cwd()});const results=[];
for(const r of requests){ const output={env:{}};try{await plugin['shell.env']({cwd:r.cwd},output);
const run=spawnSync('/bin/sh',['-c',r.command],{cwd:r.cwd,env:{...process.env,...output.env},encoding:'utf8',timeout:15000,maxBuffer:65536});
results.push({name:r.name,blocked:false,status:run.status,error:run.error?.message,stderr:run.stderr});
}catch(error){results.push({name:r.name,blocked:true,error:error.message});}}
console.log(JSON.stringify({parent:${snapshot},results}));\n`);
  const item = { root, at, env, request, command, retain: () => { retain = true; } };
  return item;
}

function runCli(item, args, env = item.env) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: item.at("a"), env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result;
}

function sourceRun(item, requests, extra = {}, launch = false) {
  const input = item.at("evidence", `requests-${crypto.randomUUID()}.json`);
  write(input, requests.map((r) => ({ ...r, command: item.command(r) })));
  let args = [item.at("driver.mjs"), input];
  if (launch) {
    fs.writeFileSync(item.at("bin", "opencode"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(item.at("driver.mjs"))} "$@"\n`, { mode: 0o755 });
    args = [cli, "agent", "opencode", "--session", "session-only", "--", input];
  }
  const result = spawnSync(process.execPath, args, {
    cwd: item.at("a"), env: { ...item.env, ...extra }, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return JSON.parse(result.stdout);
}

function artifact(item, r, cache, mode) {
  const shell = read(r.shell);
  const tool = read(r.tool);
  assert.equal(shell.cwd, r.cwd);
  assert.equal(tool.cwd, r.cwd);
  assert.equal(shell.env.CLEAN_DEVELOPMENT_SESSION_MODE, mode);
  assert.equal(tool.artifact, path.join(cache, `${r.name}.sentinel`));
  assert.equal(fs.readFileSync(tool.artifact, "utf8"), "fixture\n");
  return { shell, tool };
}

const sourceOptions = { skip: nativeWindows && "POSIX shell fixture; no native Windows acceptance claim" };

test("OpenCode source contract: startup, setup, launcher, cwd switch and disabled project", sourceOptions, (t) => {
  const item = fixture(t);
  const before = item.request("before-setup", "a");
  assert.equal(sourceRun(item, [before]).results[0].status, 0);
  const initial = artifact(item, before, item.at("home", "native-npm"), "skip");
  assert.equal(initial.shell.env.PATH, item.env.PATH);
  assert.equal(fs.existsSync(item.at("data")), false);
  assert.equal(fs.existsSync(item.at("managed")), false);
  runCli(item, ["setup", "--agents", "opencode", "--json"]);
  const ordinary = item.request("ordinary-after-setup", "a");
  assert.equal(sourceRun(item, [ordinary]).results[0].status, 0);
  const normal = artifact(item, ordinary, item.at("home", "native-npm"), "skip");
  assert.equal(normal.shell.env.PATH.split(path.delimiter)[0], item.at("data", "bin"));

  const requests = [item.request("routed-a", "a"), item.request("routed-b", "b"), item.request("disabled", "disabled"), item.request("return-a", "a")];
  const observed = sourceRun(item, requests, {}, true);
  assert.equal(observed.parent.npm_config_cache, undefined, "launcher must defer parent cache injection");
  assert.equal(observed.parent.CLEAN_DEVELOPMENT_SESSION_ENV, undefined);
  assert.ok(observed.results.every((r) => r.status === 0), JSON.stringify(observed.results));
  artifact(item, requests[0], item.at("managed", "caches", "node", "npm"), "session-only");
  artifact(item, requests[1], item.at("cache-b", "node", "npm"), "session-only");
  const disabled = artifact(item, requests[2], item.at("home", "native-npm"), "skip");
  assert.equal(disabled.shell.env.PATH, item.env.PATH);
  assert.equal(disabled.shell.env.CLEAN_DEVELOPMENT_ACTIVE, "");
  assert.equal(disabled.shell.env.CLEAN_DEVELOPMENT_SESSION_ENV, "");
  artifact(item, requests[3], item.at("managed", "caches", "node", "npm"), "session-only");
  assert.equal(fs.existsSync(item.at("a", ".clean-development.json")), false);
  for (const p of ["a", "b", "disabled"]) assert.equal(fs.existsSync(item.at(p, "target")), false);
  t.diagnostic(JSON.stringify({ boundary: "source-contract only", parent: observed.parent,
    artifacts: [before, ordinary, ...requests].map((r) => ({ name: r.name, shell: read(r.shell), tool: read(r.tool) }))
  }).split(item.root).join("<LAB>"));
});

test("OpenCode source contract: independent cache values survive skip and uninstall", sourceOptions, (t) => {
  const item = fixture(t);
  runCli(item, ["setup", "--agents", "opencode", "--json"]);
  for (const project of ["a", "disabled"]) {
    const r = item.request(`override-${project}`, project);
    const observed = sourceRun(item, [r], { npm_config_cache: item.at("user-cache") }, true);
    assert.equal(observed.results[0].status, 0);
    artifact(item, r, item.at("user-cache"), project === "disabled" ? "skip" : "session-only");
  }
  const binDir = item.at("data", "bin");
  runCli(item, ["uninstall", "--json"]);
  const receipt = item.at("data", "state", "runtime.json");
  const digest = hash(receipt);
  assert.equal(read(receipt).status, "uninstalled");
  const r = item.request("after-uninstall", "a");
  const observed = sourceRun(item, [r], { PATH: `${binDir}${path.delimiter}${item.env.PATH}`, CLEAN_DEVELOPMENT_SESSION_MODE: "session-only" });
  assert.equal(observed.results[0].status, 0);
  artifact(item, r, item.at("home", "native-npm"), "session-only");
  assert.equal(hash(receipt), digest, "automatic hook must not replace the uninstall tombstone");
  assert.equal(fs.existsSync(path.join(binDir, "npm")), false);
});

for (const mode of ["disabled", "skip"]) {
  for (const [injected, independent] of [["npm_config_cache", "NPM_CONFIG_CACHE"], ["GOCACHE", "gocache"]]) {
    test(`OpenCode source regression: ${mode} rejects inherited ${injected} even beside ${independent}`, sourceOptions, (t) => {
      const item = fixture(t);
      const old = item.at("old-cache");
      const r = item.request("must-not-run", mode === "disabled" ? "disabled" : "a");
      const observed = sourceRun(item, [r], {
        CLEAN_DEVELOPMENT_SESSION_MODE: mode === "skip" ? "skip" : "session-only",
        CLEAN_DEVELOPMENT_SESSION_ENV: JSON.stringify({ [injected]: old }),
        [injected]: old, [independent]: item.at("user-cache")
      });
      assert.equal(observed.results[0].blocked, true, "an additive merge must not resurrect the removed parent spelling");
      assert.match(observed.results[0].error, new RegExp(`cannot safely unset.*${injected}`, "i"));
      assert.equal(fs.existsSync(r.shell), false, "no child starts after rejection");
      assert.equal(fs.existsSync(r.tool), false);
      assert.equal(fs.existsSync(old), false);
      assert.equal(fs.existsSync(item.at("data")), false);
    });
  }
}

test("OpenCode source contract: same-spelling user replacement is retained, unchanged injection is rejected", sourceOptions, (t) => {
  const item = fixture(t);
  const marker = JSON.stringify({ npm_config_cache: item.at("old-cache") });
  const r = item.request("user-replacement", "disabled");
  const observed = sourceRun(item, [r], { CLEAN_DEVELOPMENT_SESSION_ENV: marker, npm_config_cache: item.at("user-cache") });
  assert.equal(observed.results[0].status, 0);
  artifact(item, r, item.at("user-cache"), "skip");
  const blocked = item.request("unchanged-injection", "disabled");
  assert.equal(sourceRun(item, [blocked], { CLEAN_DEVELOPMENT_SESSION_ENV: marker, npm_config_cache: item.at("old-cache") }).results[0].blocked, true);
  assert.equal(fs.existsSync(blocked.shell), false);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 15_000) {
  const deadline = Date.now() + ms;
  do { const value = await check(); if (value) return value; await sleep(50); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

// Opt-in executable protocol. No downloads, model calls, real user settings or
// workflow changes. A supplied but missing/broken host fails, never skips.
test("OpenCode REAL HOST: additive shell.env lifecycle and rejection before PTY spawn", {
  skip: !process.env.OPENCODE_ACCEPTANCE_BINARY ? "BLOCKED: set OPENCODE_ACCEPTANCE_BINARY to an installed absolute binary path" : nativeWindows && "POSIX protocol; Windows host not tested",
  timeout: 240_000
}, async (t) => {
  const item = fixture(t);
  const binary = process.env.OPENCODE_ACCEPTANCE_BINARY;
  const evidence = {
    schemaVersion: 1, boundary: "real OpenCode HTTP PTY child execution; not model-tool or token-neutrality certification",
    sourceCommit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim() || null,
    sourceDirty: Boolean(spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout.trim()),
    pluginSha256: hash(plugin), node: process.version, platform: process.platform, arch: process.arch,
    hostVersion: null, hostBinarySha256: null, cases: [], status: "blocked"
  };
  const redact = (s) => String(s).split(item.root).join("<LAB>").split(repo).join("<SOURCE>").split(binary).join("<OPENCODE>");
  const record = (name, value) => evidence.cases.push({ name, ...value });
  const hosts = new Set();
  const password = crypto.randomBytes(24).toString("hex");
  async function stop(host) {
    if (!host || !hosts.has(host)) return;
    if (Number.isInteger(host.child.pid) && !host.closed) {
      try { process.kill(-host.child.pid, "SIGTERM"); } catch (e) { if (e.code !== "ESRCH") throw e; }
      try { await until(() => host.closed, "host shutdown", 5000); }
      catch { try { process.kill(-host.child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; } await until(() => host.closed, "forced host shutdown", 5000); }
    }
    fs.writeFileSync(item.at("evidence", `${host.name}-host.log`), redact(host.log), { flag: "wx" });
    hosts.delete(host);
  }
  let failure;
  try {
    assert.ok(path.isAbsolute(binary), "OPENCODE_ACCEPTANCE_BINARY must be an absolute executable path");
    const version = spawnSync(binary, ["--version"], { env: item.env, cwd: item.at("a"), encoding: "utf8", timeout: 15_000, maxBuffer: 65536 });
    assert.equal(version.status, 0, version.error?.message || version.stderr);
    evidence.hostVersion = version.stdout.trim();
    evidence.hostBinarySha256 = hash(fs.realpathSync(binary));
    assert.ok(evidence.hostVersion, "host must identify its version");

    const pluginDir = item.at("xdg-config", "opencode", "plugins");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "clean-development.js"), `import fs from 'node:fs';import real from ${JSON.stringify(pathToFileURL(plugin).href)};
export default async ctx=>{const hooks=await real(ctx);return {'shell.env':async(input,output)=>{
const row={cwd:input.cwd,parent:Object.fromEntries(${JSON.stringify(fields)}.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))};
try{await hooks['shell.env'](input,output);row.ok=true;}catch(e){row.ok=false;row.error=e.message;throw e;}finally{fs.appendFileSync(${JSON.stringify(item.at("evidence", "hook.jsonl"))},JSON.stringify(row)+'\\n');}}};};\n`);
    write(item.at("xdg-config", "opencode", "opencode.json"), { autoupdate: false, share: "disabled", enabled_providers: [], mcp: {} });
    fs.writeFileSync(item.at("bin", "opencode"), `#!/bin/sh\nexec ${quote(binary)} "$@"\n`, { mode: 0o755 });
    const hostEnv = { ...item.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" };

    async function start(name, extra = {}, routed = false) {
      const args = ["serve", "--hostname", "127.0.0.1", "--port", "0"];
      const command = routed ? process.execPath : binary;
      const argv = routed ? [cli, "agent", "opencode", "--session", "session-only", "--", ...args] : args;
      const child = spawn(command, argv, { cwd: item.at("a"), env: { ...hostEnv, ...extra }, stdio: ["ignore", "pipe", "pipe"], detached: true });
      const host = { name, child, closed: false, log: "", url: null };
      hosts.add(host);
      child.on("close", () => { host.closed = true; });
      child.on("error", (e) => { host.error = e; });
      const collect = (data) => { host.log = (host.log + data).slice(-65536); host.url ||= host.log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      await until(() => {
        if (host.error || host.closed) throw host.error || new Error(`OpenCode exited: ${redact(host.log)}`);
        return host.url;
      }, "OpenCode listen address", 30_000);
      host.api = async (route, method = "GET", body, cwd = item.at("a")) => {
        const url = new URL(route, host.url); url.searchParams.set("directory", cwd);
        const response = await fetch(url, { method, headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
        const chunks = []; let size = 0;
        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const next = await reader.read(); if (next.done) break;
              size += next.value.byteLength;
              assert.ok(size <= 2 * 1024 * 1024, "bounded HTTP response");
              chunks.push(Buffer.from(next.value));
            }
          } finally { await reader.cancel(); reader.releaseLock(); }
        }
        const text = Buffer.concat(chunks).toString("utf8");
        return { status: response.status, body: text ? JSON.parse(text) : null };
      };
      const health = await host.api("/global/health");
      assert.equal(health.status, 200);
      assert.equal(health.body.healthy, true);
      assert.equal(health.body.version, evidence.hostVersion, "CLI and running server versions must agree");
      record(`${name}-health`, { result: "passed", version: health.body.version, invocation: [command, ...argv], log: item.at("evidence", `${name}-host.log`) });
      const spec = await host.api("/doc");
      assert.equal(spec.status, 200);
      assert.ok(spec.body.paths?.["/pty"]?.post, "host must expose the real PTY endpoint; never substitute the source driver");
      return host;
    }
    async function execute(host, r, cache, mode, rejection = false) {
      const response = await host.api("/pty", "POST", { command: "/bin/sh", args: ["-c", item.command(r)], cwd: r.cwd, title: r.name }, r.cwd);
      if (rejection) {
        assert.ok(response.status >= 400, "unsafe launch must fail, not silently ignore the hook exception");
        assert.equal(fs.existsSync(r.shell), false);
        assert.equal(fs.existsSync(r.tool), false);
        const hook = fs.readFileSync(item.at("evidence", "hook.jsonl"), "utf8").trim().split("\n").map(JSON.parse).at(-1);
        assert.equal(hook.cwd, r.cwd); assert.equal(hook.ok, false);
        assert.match(hook.error, /cannot safely unset inherited Clean Development routing/);
        record(r.name, { result: "passed", rejection: hook.error, httpStatus: response.status, shellArtifactAbsent: true, toolArtifactAbsent: true });
        return;
      }
      assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response));
      await until(() => {
        try { read(r.tool); return true; }
        catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return false; throw error; }
      }, `${r.name} complete tool artifact`);
      const observed = artifact(item, r, cache, mode);
      const hook = fs.readFileSync(item.at("evidence", "hook.jsonl"), "utf8").trim().split("\n").map(JSON.parse).at(-1);
      assert.equal(hook.cwd, r.cwd); assert.equal(hook.ok, true, "loader-only success is insufficient");
      record(r.name, { result: "passed", ...observed, parent: hook.parent });
      return observed;
    }

    let host = await start("ordinary");
    await execute(host, item.request("host-before-setup", "a"), item.at("home", "native-npm"), "skip");
    assert.equal(fs.existsSync(item.at("data")), false);
    assert.equal(fs.existsSync(item.at("managed")), false);
    runCli(item, ["setup", "--agents", "opencode", "--json"]);
    await execute(host, item.request("host-after-setup", "a"), item.at("home", "native-npm"), "skip");
    await stop(host);

    host = await start("launcher", {}, true);
    await execute(host, item.request("host-routed-a", "a"), item.at("managed", "caches", "node", "npm"), "session-only");
    assert.equal(evidence.cases.at(-1).parent.npm_config_cache, undefined);
    assert.equal(evidence.cases.at(-1).parent.CLEAN_DEVELOPMENT_SESSION_ENV, undefined);
    await execute(host, item.request("host-switch-b", "b"), item.at("cache-b", "node", "npm"), "session-only");
    const disabled = await execute(host, item.request("host-disabled", "disabled"), item.at("home", "native-npm"), "skip");
    assert.equal(disabled.shell.env.PATH, item.env.PATH);
    assert.equal(disabled.shell.env.CLEAN_DEVELOPMENT_ACTIVE, "");
    assert.equal(disabled.shell.env.CLEAN_DEVELOPMENT_SESSION_ENV, "");
    await execute(host, item.request("host-return-a", "a"), item.at("managed", "caches", "node", "npm"), "session-only");
    await stop(host);

    host = await start("user-override", { npm_config_cache: item.at("user-cache") }, true);
    await execute(host, item.request("host-user-a", "a"), item.at("user-cache"), "session-only");
    await execute(host, item.request("host-user-disabled", "disabled"), item.at("user-cache"), "skip");
    await stop(host);

    // Seed a legacy/external parent injection deliberately. The real host,
    // not the source driver, must reject it before starting a PTY child.
    const stale = { CLEAN_DEVELOPMENT_SESSION_MODE: "session-only", CLEAN_DEVELOPMENT_SESSION_ENV: JSON.stringify({ npm_config_cache: item.at("old-cache") }), npm_config_cache: item.at("old-cache") };
    for (const mixed of [false, true]) {
      host = await start(`unsafe-${mixed}`, { ...stale, ...(mixed ? { NPM_CONFIG_CACHE: item.at("user-cache") } : {}) });
      await execute(host, item.request(`host-stale-${mixed}`, "disabled"), null, null, true);
      await stop(host);
    }
    assert.equal(fs.existsSync(item.at("old-cache")), false);

    host = await start("uninstall", {}, true);
    await execute(host, item.request("host-pre-uninstall", "a"), item.at("managed", "caches", "node", "npm"), "session-only");
    runCli(item, ["uninstall", "--json"]);
    const receipt = item.at("data", "state", "runtime.json"); const digest = hash(receipt);
    await execute(host, item.request("host-after-uninstall", "a"), item.at("home", "native-npm"), "session-only");
    assert.equal(hash(receipt), digest);
    assert.equal(fs.existsSync(item.at("data", "bin", "npm")), false);
    await stop(host);
    host = await start("uninstalled-restart");
    await execute(host, item.request("host-uninstalled-restart", "a"), item.at("home", "native-npm"), "skip");
    assert.equal(hash(receipt), digest);
    assert.equal(fs.existsSync(item.at("a", ".clean-development.json")), false);
    for (const p of ["a", "b", "disabled"]) assert.equal(fs.existsSync(item.at(p, "target")), false);
    evidence.status = "passed";
  } catch (error) {
    evidence.status = evidence.hostVersion ? "failed" : "blocked";
    evidence.error = error.message;
    failure = error;
  } finally {
    for (const host of hosts) {
      try { await stop(host); } catch (error) { evidence.cleanupError = error.message; evidence.status = "failed"; failure ||= error; }
    }
    const text = redact(`${JSON.stringify(evidence, null, 2)}\n`);
    fs.writeFileSync(item.at("evidence", "result.json"), text, { flag: "wx" });
    if (process.env.OPENCODE_ACCEPTANCE_EVIDENCE) {
      const file = process.env.OPENCODE_ACCEPTANCE_EVIDENCE;
      assert.ok(path.isAbsolute(file), "evidence destination must be absolute");
      fs.writeFileSync(file, text, { flag: "wx" }); // Never overwrite prior evidence.
    }
    item.retain();
    t.diagnostic(`Redacted evidence: ${item.at("evidence", "result.json")}; disposable lab retained for inspection.`);
  }
  if (failure) throw failure;
});
