// Opt-in, real-Pi CLI acceptance. No downloads and no credentials are inherited.
// This file is inert under ordinary `node --test`; see ../pi-acceptance.test.js.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PI_VERSION = "0.87.1";
export const CASES = ["discovery-before-setup", "native-default-skip", "modified-launcher-refused",
  "explicit-session-only", "nested-explicit-skip", "inherited-session-only", "uninstall-stops-exposure"];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIMIT = 2 * 1024 * 1024;
const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");
export const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });

export function snapshot(root) {
  const result = {};
  let count = 0;
  let bytes = 0;
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (++count > 3000) throw new Error("Fixture snapshot exceeded its entry limit");
      if (stat.isDirectory()) {
        result[`${path.relative(root, file)}/`] = { directory: true, mode: stat.mode & 0o777 };
        visit(file);
      }
      else {
        assert(stat.isFile() && !stat.isSymbolicLink(), `Not a regular fixture file: ${file}`);
        if ((bytes += stat.size) > 16 * LIMIT) throw new Error("Fixture snapshot exceeded its byte limit");
        result[path.relative(root, file)] = { sha256: hash(fs.readFileSync(file)), mode: stat.mode & 0o777 };
      }
    }
  }
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), `Not a real fixture directory: ${root}`);
    visit(root);
  }
  return result;
}

export function isolatedEnvironment(root) {
  // Deliberate allowlist, not {...process.env}. In particular, no provider keys,
  // NODE_OPTIONS, shell startup files, user npm configuration or session routes.
  return {
    HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    USER: "pi-acceptance", LOGNAME: "pi-acceptance", LANG: "C.UTF-8", TERM: "dumb", CI: "1", NO_COLOR: "1",
    PATH: `${path.join(root, "tools")}${path.delimiter}/usr/bin${path.delimiter}/bin`, SHELL: "/bin/bash",
    TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"), XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    CLEAN_DEVELOPMENT_HOME: path.join(root, "home"), CLEAN_DEVELOPMENT_ROOT: path.join(root, "managed"),
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"), CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"),
    PI_CODING_AGENT_DIR: path.join(root, "pi-agent"), PI_OFFLINE: "1",
    npm_config_userconfig: path.join(root, "npm-user.conf"), npm_config_globalconfig: path.join(root, "npm-global.conf"),
    npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
    CD_PI_CAPTURE: path.join(root, "evidence", "probes.jsonl"),
    CD_PI_TRACE: path.join(root, "evidence", "spawns.jsonl")
  };
}

export function run(file, args, { cwd, env, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const parts = { stdout: "", stderr: "" };
    let failure;
    let escalation; let abandoned; let settled = false;
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(escalation); clearTimeout(abandoned);
      if (error) reject(error); else resolve(result);
    }
    function stop(error) {
      if (failure) return;
      failure = error;
      if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
      escalation = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } }, 1000);
      abandoned = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish(new Error(`${error.message}; cleanup unconfirmed; retain the fixture`));
      }, 3000);
    }
    const timer = setTimeout(() => stop(new Error(`Command deadline exceeded: ${file}`)), timeout);
    for (const stream of ["stdout", "stderr"]) child[stream].on("data", (data) => {
      if (parts[stream].length + data.length > LIMIT) stop(new Error(`Command output limit exceeded: ${file}`));
      parts[stream] = (parts[stream] + data).slice(0, LIMIT);
    });
    child.on("error", (error) => stop(error));
    child.on("close", (code, signal) => finish(failure, { code, signal, ...parts }));
  });
}

const probeSource = `const fs = require('node:fs');
const fields = ['PATH', 'CLEAN_DEVELOPMENT_SESSION_MODE', 'CLEAN_DEVELOPMENT_ACTIVE', 'npm_config_cache', 'NPM_CONFIG_CACHE'];
const parentArgv = fs.readFileSync('/proc/' + process.ppid + '/cmdline').toString().split('\\0').filter(Boolean);
fs.appendFileSync(process.env.CD_PI_CAPTURE, JSON.stringify({
  phase: process.env.CD_PI_PHASE, role: process.argv[2], pid: process.pid, ppid: process.ppid,
  argv: process.argv.slice(2), cwd: process.cwd(), parentArgv,
  npm: process.argv[3] || null, cli: process.argv[4] || null,
  env: Object.fromEntries(fields.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))
}) + '\\n');
`;

// Observation only. The original spawn receives the original arguments/options.
// --require is passed to Pi, never installed in the contributor's NODE_OPTIONS.
const observerSource = `const cp = require('node:child_process');
const fs = require('node:fs');
const original = cp.spawn;
cp.spawn = function(file, args, options) {
  const child = Reflect.apply(original, this, arguments);
  const env = options?.env || process.env;
  if (process.env.CD_PI_TRACE) fs.appendFileSync(process.env.CD_PI_TRACE, JSON.stringify({
    hostPid: process.pid, pid: child.pid || null, file, args,
    cwd: options?.cwd || process.cwd(),
    env: Object.fromEntries(['PATH', 'CLEAN_DEVELOPMENT_SESSION_MODE', 'npm_config_cache']
      .filter(k => env[k] !== undefined).map(k => [k, env[k]]))
  }) + '\\n');
  return child;
};
require('node:module').syncBuiltinESMExports();
`;

export async function createLab({ repo = REPO, npm = path.join(path.dirname(process.execPath), "npm") } = {}) {
  // Resolve prerequisites before creating a fixture so a missing npm leaves nothing behind.
  const npmExecutable = fs.realpathSync(npm);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-pi-")));
  const env = isolatedEnvironment(root);
  const project = path.join(root, "project");
  const pkg = path.join(root, "package");
  for (const dir of ["home", "tmp", "tools", "pi-agent", "evidence", "project", "package", "payloads"]) {
    fs.mkdirSync(path.join(root, dir));
  }
  for (const file of ["npm-user.conf", "npm-global.conf"]) fs.writeFileSync(path.join(root, file), "", { flag: "wx" });
  fs.symlinkSync(process.execPath, path.join(root, "tools", "node"));
  fs.symlinkSync(npmExecutable, path.join(root, "tools", "npm"));
  // All source inputs are verified regular before copying. No contributor project
  // or agent directory becomes the CLI's cwd, HOME, configuration or storage root.
  for (const relative of ["src", "bin", ".pi", ".opencode"]) {
    snapshot(path.join(repo, relative));
    fs.cpSync(path.join(repo, relative), path.join(pkg, relative), { recursive: true, errorOnExist: true });
  }
  fs.copyFileSync(path.join(repo, "package.json"), path.join(pkg, "package.json"), fs.constants.COPYFILE_EXCL);
  const source = snapshot(pkg);
  writeJson(path.join(project, "package.json"), { name: "pi-acceptance-project", version: "1.0.0", private: true,
    scripts: { nested: 'node probe.cjs nested && npm cache add "$CD_PI_PAYLOAD" --offline --ignore-scripts' } });
  fs.writeFileSync(path.join(project, "probe.cjs"), probeSource, { flag: "wx" });
  fs.writeFileSync(path.join(root, "observe-spawns.cjs"), observerSource, { flag: "wx" });
  const originalProject = snapshot(project);
  const settings = { packages: [pkg], quietStartup: true, compaction: { enabled: false }, retry: { enabled: false } };
  writeJson(path.join(env.PI_CODING_AGENT_DIR, "settings.json"), settings);
  fs.mkdirSync(path.join(env.HOME, ".claude"));
  const unrelated = path.join(env.HOME, ".claude", "settings.json");
  writeJson(unrelated, { hooks: { Stop: [{ hooks: [{ type: "command", command: "printf untouched" }] }] } });
  const protectedFiles = [path.join(env.PI_CODING_AGENT_DIR, "settings.json"), unrelated,
    env.npm_config_userconfig, env.npm_config_globalconfig];
  const protectedHashes = protectedFiles.map(file => hash(fs.readFileSync(file)));
  const lab = { root, env, project, pkg, source, originalProject, protectedFiles, protectedHashes,
    cli: path.join(pkg, "bin", "clean-development.js"), bin: path.join(root, "data", "bin"),
    receipt: path.join(root, "data", "state", "runtime.json"),
    nativeCache: path.join(env.HOME, ".npm"), managedCache: path.join(root, "managed", "caches", "node", "npm") };
  lab.checkUnchanged = () => {
    assert.deepEqual(snapshot(project), originalProject, "Project contents changed");
    assert.deepEqual(snapshot(pkg), source, "Package source changed");
    assert.deepEqual(protectedFiles.map(file => hash(fs.readFileSync(file))), protectedHashes, "Unrelated configuration changed");
  };
  return lab;
}

export async function makePayload(lab, phase) {
  assert(/^[a-z-]+$/.test(phase));
  const seed = path.join(lab.root, "payloads", phase);
  fs.mkdirSync(seed);
  writeJson(path.join(seed, "package.json"), { name: `pi-acceptance-${phase}`, version: "1.0.0" });
  fs.writeFileSync(path.join(seed, "index.js"), `module.exports = ${JSON.stringify(phase)};\n`);
  const packed = await run(path.join(lab.root, "tools", "npm"), ["pack", "--ignore-scripts", "--offline", "--json"], {
    cwd: seed, env: { ...lab.env, npm_config_cache: path.join(lab.root, "bootstrap-cache") }
  });
  assert.equal(packed.code, 0, packed.stderr);
  const filename = JSON.parse(packed.stdout)[0].filename;
  assert.equal(path.basename(filename), filename);
  return path.join(seed, filename);
}

export function commandBody(lab, phase, payload) {
  return `set -eu\nexport CD_PI_PHASE=${quote(phase)} CD_PI_PAYLOAD=${quote(payload)}\n` +
    'node probe.cjs direct "$(command -v npm)" "$(command -v clean-development || true)"\n' +
    'npm cache add "$CD_PI_PAYLOAD" --offline --ignore-scripts\nnpm run --silent nested';
}

export function cacheContains(cache, payload) {
  const expected = hash(fs.readFileSync(payload));
  return Object.values(snapshot(path.join(cache, "_cacache", "content-v2"))).some(file => file.sha256 === expected);
}

export function verifyArtifacts(lab, phase, payload, { routed, exposed, basePath = lab.env.PATH }) {
  const probes = fs.readFileSync(lab.env.CD_PI_CAPTURE, "utf8").trim().split("\n").map(JSON.parse).filter(p => p.phase === phase);
  assert.equal(probes.length, 2, "Both a direct child and an npm-script child must actually run");
  const direct = probes.find(p => p.role === "direct");
  const nested = probes.find(p => p.role === "nested");
  assert(direct && nested, "Missing direct/nested process evidence");
  assert.equal(direct.npm, path.join(exposed ? lab.bin : path.join(lab.root, "tools"), "npm"));
  assert.equal(direct.cli, exposed ? path.join(lab.bin, "clean-development") : null);
  assert.equal(direct.env.PATH, exposed ? `${lab.bin}${path.delimiter}${basePath}` : basePath,
    "Only the owned stable bin may be added to the direct shell PATH");
  assert.equal(direct.parentArgv.at(-1), commandBody(lab, phase, payload), "Unexpected direct parent command");
  assert.equal(nested.parentArgv.at(-1),
    'node probe.cjs nested && npm cache add "$CD_PI_PAYLOAD" --offline --ignore-scripts',
    "Unexpected npm-script parent command");
  for (const probe of probes) {
    assert.equal(probe.cwd, lab.project);
    assert.equal(probe.env.CLEAN_DEVELOPMENT_SESSION_MODE, routed ? "session-only" : "skip");
    // A skipped npm shim removes its owned bin before starting native npm.
    // Its lifecycle child therefore inherits native PATH, not stable exposure.
    assert.equal(probe.env.PATH.split(path.delimiter).includes(lab.bin), probe.role === "direct" ? exposed : routed && exposed);
    assert(!probe.env.PATH.split(path.delimiter).includes(path.join(lab.pkg, "bin")), "Exposed the package source bin");
    assert(probe.parentArgv.length > 1, "Missing actual parent-shell argv");
    if (routed) assert.equal(probe.env.npm_config_cache, lab.managedCache);
    else assert(!String(probe.env.npm_config_cache || "").startsWith(path.join(lab.root, "managed")));
  }
  assert(cacheContains(routed ? lab.managedCache : lab.nativeCache, payload), "Tarball bytes missing from the expected cache");
  assert(!cacheContains(routed ? lab.nativeCache : lab.managedCache, payload), "Tarball bytes leaked into the other cache");
  lab.checkUnchanged();
  return { probes, artifact: { sha256: hash(fs.readFileSync(payload)), cache: routed ? lab.managedCache : lab.nativeCache } };
}

export async function startProvider() {
  const cases = new Map();
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/chat/completions");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > LIMIT) throw new Error("Provider request too large");
      }
      const value = JSON.parse(body);
      assert.equal(value.model, "fixed-script"); assert.equal(value.stream, true);
      const latestUser = value.messages.filter(m => m.role === "user").at(-1);
      const text = typeof latestUser?.content === "string" ? latestUser.content
        : latestUser?.content?.filter(c => c.type === "text").map(c => c.text).join("\n");
      const id = text?.match(/CD_PI_ACCEPTANCE:([a-z-]+)/)?.[1];
      const item = cases.get(id);
      assert(item, `Unknown fixture prompt: ${id}`);
      const completed = value.messages.at(-1)?.role === "tool";
      assert.equal(++item.calls, completed ? 2 : 1, "Unexpected retry or extra model request");
      if (!completed) assert(value.tools?.some(tool => tool.function?.name === "bash"), "Pi did not expose Bash");
      requests.push({ case: id, completed, toolNames: value.tools?.map(tool => tool.function?.name) || [] });
      const base = { id: `fixture-${id}`, object: "chat.completion.chunk", created: 1, model: "fixed-script" };
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const chunk = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (completed) chunk({ role: "assistant", content: "Fixture complete." }, null);
      else chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call-${id}`, type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command: item.command, timeout: 15 }) } }] }, null);
      chunk({}, completed ? "stop" : "tool_calls");
      res.end("data: [DONE]\n\n");
    } catch (error) {
      requests.push({ error: error.message });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message, type: "fixture_error" } }));
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { cases, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

export class PiRpc {
  constructor(file, args, options) {
    this.events = []; this.pending = new Map(); this.waiters = new Set(); this.stderr = ""; this.buffer = ""; this.nextId = 0;
    this.child = spawn(file, args, { ...options, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.closed = new Promise(resolve => this.child.once("close", (code, signal) => {
      this.hasClosed = true;
      this.fail(new Error(`Pi exited: code=${code}, signal=${signal}; ${this.stderr}`)); resolve({ code, signal });
    }));
    this.child.on("error", error => this.fail(error));
    this.child.stdin.on("error", error => this.fail(error));
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", data => { this.stderr = (this.stderr + data).slice(-LIMIT); });
    this.child.stdout.on("data", data => {
      try {
        this.buffer += data;
        assert(this.buffer.length <= LIMIT, "Pi RPC record too large");
        let end;
        while ((end = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, end).replace(/\r$/, ""); this.buffer = this.buffer.slice(end + 1);
          if (!line) continue;
          const event = JSON.parse(line);
          assert(this.events.length < 2000, "Too many Pi events");
          this.events.push(event);
          const pending = event.type === "response" && this.pending.get(event.id);
          if (pending) {
            this.pending.delete(event.id);
            if (event.success) pending.resolve(event); else pending.reject(new Error(event.error));
          }
          for (const waiter of [...this.waiters]) if (waiter.type === event.type) {
            this.waiters.delete(waiter); waiter.resolve(event);
          }
        }
      } catch (error) { this.fail(error); }
    });
  }
  fail(error) {
    this.error ||= error;
    for (const pending of this.pending.values()) pending.reject(error);
    for (const waiter of this.waiters) waiter.reject(error);
    this.pending.clear(); this.waiters.clear();
  }
  wait(register, timeout = 30000) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Pi RPC deadline exceeded")), timeout);
      register({ resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
  }
  request(type, values = {}) {
    return this.wait(pending => {
      const id = `acceptance-${++this.nextId}`;
      this.pending.set(id, pending);
      this.child.stdin.write(`${JSON.stringify({ ...values, type, id })}\n`);
    });
  }
  async execute(id, command, { expectError = false } = {}) {
    const start = this.events.length;
    const settled = this.wait(waiter => this.waiters.add({ ...waiter, type: "agent_settled" }));
    await Promise.all([settled, this.request("prompt", { message: `CD_PI_ACCEPTANCE:${id}` })]);
    const events = this.events.slice(start);
    const calls = events.filter(event => event.type === "tool_execution_start");
    const results = events.filter(event => event.type === "tool_execution_end");
    assert.equal(calls.length, 1, "Expected exactly one actual Pi tool execution");
    assert.equal(calls[0].toolName, "bash"); assert.equal(calls[0].args.command, command);
    assert.equal(results.length, 1); assert.equal(Boolean(results[0].isError), expectError);
    return { calls, results };
  }
  async close() {
    if (this.hasClosed) return this.closed;
    if (this.closing) return this.closing;
    this.closing = this.closeOnce();
    return this.closing;
  }
  async closeOnce() {
    this.child.stdin.end();
    let term; let kill; let abandoned;
    try {
      term = setTimeout(() => { try { process.kill(-this.child.pid, "SIGTERM"); } catch {} }, 3000);
      kill = setTimeout(() => { try { process.kill(-this.child.pid, "SIGKILL"); } catch {} }, 5000);
      const deadline = new Promise((_, reject) => {
        abandoned = setTimeout(() => {
          this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.unref();
          reject(new Error("Pi shutdown could not be confirmed; retain the fixture"));
        }, 8000);
      });
      return await Promise.race([this.closed, deadline]);
    } finally { clearTimeout(term); clearTimeout(kill); clearTimeout(abandoned); }
  }
}

export function hostPackage(directory) {
  if (!directory) throw new Error("Pi is not supplied; pass --pi-package with an installed @earendil-works/pi-coding-agent 0.87.1 directory");
  const root = fs.realpathSync(directory);
  const pkg = json(path.join(root, "package.json"));
  assert.equal(pkg.name, "@earendil-works/pi-coding-agent"); assert.equal(pkg.version, PI_VERSION);
  const cli = fs.realpathSync(path.resolve(root, pkg.bin.pi));
  assert(cli.startsWith(`${root}${path.sep}`), "Pi CLI must belong to its package");
  return { root, cli, name: pkg.name, version: pkg.version, cliSha256: hash(fs.readFileSync(cli)) };
}

export async function runAcceptance({ piPackage, repo = REPO, npm } = {}) {
  const report = { schemaVersion: 1, acceptance: "blocked", targetPiVersion: PI_VERSION, observedPiVersion: null,
    machine: { platform: process.platform, arch: process.arch, kernel: os.release(), node: process.version },
    source: { commit: null, tree: null }, cases: CASES.map(name => ({ name, status: "blocked", reason: "Host acceptance has not run" })) };
  let lab; let provider; const hosts = [];
  let active;
  try {
    if (process.platform !== "linux") throw new Error("This protocol currently requires Linux /proc process evidence; other platforms are untested");
    for (const [name, args] of [["commit", ["rev-parse", "HEAD"]], ["tree", ["rev-parse", "HEAD^{tree}"]]]) {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 5000 });
      if (result.status === 0) report.source[name] = result.stdout.trim();
    }
    const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf8", timeout: 5000 });
    report.source.worktreeStatus = status.status === 0 ? status.stdout.trim().split("\n").filter(Boolean) : null;
    const host = hostPackage(piPackage); // No fixture mutation or host process before validation.
    lab = await createLab({ repo, npm }); report.fixtureRoot = lab.root;
    // Deliberately stderr-only: the portable JSON report redacts this locator.
    process.stderr.write(`Disposable Pi evidence retained at ${lab.root}\n`);
    report.source.snapshot = lab.source;
    report.host = host;
    const version = await run(process.execPath, [host.cli, "--version"], { cwd: lab.project, env: lab.env });
    assert.equal(version.code, 0, version.stderr); assert.equal(version.stdout.trim(), PI_VERSION);
    report.observedPiVersion = version.stdout.trim();
    provider = await startProvider();
    const modelsFile = path.join(lab.env.PI_CODING_AGENT_DIR, "models.json");
    writeJson(modelsFile, { providers: { "pi-acceptance": {
      baseUrl: provider.baseUrl, api: "openai-completions", apiKey: "fixture-not-a-credential", models: [
        { id: "fixed-script", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
      ] } } });
    lab.protectedFiles.push(modelsFile); lab.protectedHashes.push(hash(fs.readFileSync(modelsFile)));
    const args = ["--require", path.join(lab.root, "observe-spawns.cjs"), host.cli, "--mode", "rpc", "--no-session", "--offline",
      "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--tools", "bash",
      "--provider", "pi-acceptance", "--model", "fixed-script"];
    const start = async (inherited = false) => {
      const argv = inherited ? [lab.cli, "run", "--session", "session-only", "--", process.execPath, ...args] : args;
      const rpc = new PiRpc(process.execPath, argv, { cwd: lab.project, env: lab.env }); hosts.push(rpc);
      (report.invocations ||= []).push({ executable: process.execPath, argv, cwd: lab.project });
      await rpc.request("get_state"); return rpc;
    };
    const traces = () => fs.existsSync(lab.env.CD_PI_TRACE)
      ? fs.readFileSync(lab.env.CD_PI_TRACE, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    const shellCase = async (rpc, name, { routed = false, exposed = false, wrap = body => body } = {}) => {
      active = report.cases.find(c => c.name === name);
      const payload = await makePayload(lab, name);
      const command = wrap(commandBody(lab, name, payload));
      provider.cases.set(name, { command, calls: 0 });
      const before = traces().length;
      const execution = await rpc.execute(name, command);
      const launches = traces().slice(before).filter(t => path.basename(t.file) === "bash");
      assert.equal(launches.length, 1, "Missing or ambiguous actual host Bash spawn");
      assert.deepEqual(launches[0].args, ["-c", command], "Host changed the Bash command");
      assert.equal(launches[0].cwd, lab.project);
      // Pi 0.87.1 independently prepends its own agent-dir/bin in getShellEnv.
      // Permit that exact host-owned prefix, not arbitrary extra PATH entries.
      const basePath = `${path.join(lab.env.PI_CODING_AGENT_DIR, "bin")}${path.delimiter}${lab.env.PATH}`;
      const evidence = verifyArtifacts(lab, name, payload, { routed, exposed, basePath });
      Object.assign(active, { status: "passed", reason: undefined, command, launches, execution, ...evidence });
    };
    const native = await start();
    assert(!fs.existsSync(path.join(lab.root, "data")), "Discovery created application data");
    assert(!fs.existsSync(path.join(lab.root, "managed")), "Discovery created managed storage");
    await shellCase(native, CASES[0]);
    assert(!fs.existsSync(path.join(lab.root, "data")), "Native command before setup created application data");
    active = report.cases.find(c => c.name === CASES[1]);
    const setup = await run(process.execPath, [lab.cli, "setup", "--agents", "pi", "--json"], { cwd: lab.project, env: lab.env });
    assert.equal(setup.code, 0, setup.stderr);
    const receipt = json(lab.receipt); assert.equal(receipt.status, "installed"); assert.equal(receipt.binDir, lab.bin);
    for (const file of receipt.ownedFiles) assert.equal(hash(fs.readFileSync(file.path)), file.sha256);
    report.runtime = { installationId: receipt.installationId, binDir: receipt.binDir, versionRoot: receipt.versionRoot,
      ownedFiles: receipt.ownedFiles };
    const retained = path.join(lab.bin, "unrelated-kept.txt"); fs.writeFileSync(retained, "keep\n", { flag: "wx" });
    await shellCase(native, CASES[1], { exposed: true });
    active = report.cases.find(c => c.name === CASES[2]);
    const launcher = path.join(lab.bin, "npm"); const original = fs.readFileSync(launcher);
    const tamperCommand = "printf 'must-not-launch\\n'";
    provider.cases.set(CASES[2], { command: tamperCommand, calls: 0 });
    const before = traces().length;
    try {
      fs.appendFileSync(launcher, "\n# disposable acceptance modification\n");
      const execution = await native.execute(CASES[2], tamperCommand, { expectError: true });
      assert.match(JSON.stringify(execution.results), /Owned runtime file was modified|unowned or modified runtime file/,
        "An unrelated Pi error must not count as ownership rejection");
      assert.equal(traces().slice(before).filter(t => path.basename(t.file) === "bash").length, 0);
      Object.assign(active, { status: "passed", reason: undefined, execution }); active = null;
    } finally { fs.writeFileSync(launcher, original); }
    await shellCase(native, CASES[3], { routed: true, exposed: true,
      wrap: body => `clean-development run --session session-only -- /bin/bash -c ${quote(body)}` });
    await shellCase(native, CASES[4], {
      wrap: body => `clean-development run --session session-only -- /bin/bash -c ${quote(`clean-development run --session skip -- /bin/bash -c ${quote(body)}`)}` });
    const inherited = await start(true);
    await shellCase(inherited, CASES[5], { routed: true, exposed: true });
    await inherited.close();
    active = report.cases.find(c => c.name === CASES[6]);
    const stored = snapshot(path.join(lab.root, "managed"));
    const uninstall = await run(process.execPath, [lab.cli, "uninstall", "--json"], { cwd: lab.project, env: lab.env });
    assert.equal(uninstall.code, 0, uninstall.stderr);
    assert.equal(fs.readFileSync(retained, "utf8"), "keep\n");
    assert.deepEqual(snapshot(path.join(lab.root, "managed")), stored, "Uninstall deleted managed artifacts");
    for (const file of receipt.ownedFiles) assert(!fs.existsSync(file.path), `Uninstall retained owned launcher: ${file.path}`);
    await shellCase(native, CASES[6]); // Same already-running Pi instance, not merely a fresh loader.
    for (const file of receipt.ownedFiles) assert(!fs.existsSync(file.path), "Pi recreated an uninstalled runtime launcher");
    lab.checkUnchanged();
    assert(!provider.requests.some(r => r.error), "The deterministic provider rejected a request");
    active = null; report.acceptance = "passed";
  } catch (error) {
    report.error = error.message;
    if (active) Object.assign(active, { status: "failed", reason: error.message });
    if (report.observedPiVersion) report.acceptance = "failed";
  } finally {
    for (const rpc of hosts.reverse()) {
      try { await rpc.close(); } catch (error) { report.cleanupError = error.message; report.acceptance = "failed"; }
    }
    if (provider) { report.providerRequests = provider.requests; await provider.close(); }
    // Retain only this bounded, disposable fixture; never recursively clean a
    // path supplied by the operator. Failed host runs keep evidence for review.
    if (lab) {
      report.stderr = hosts.map(rpc => rpc.stderr);
      report.source.snapshotSha256 = hash(JSON.stringify(lab.source));
    }
  }
  return redact(report, lab?.root, piPackage && path.resolve(piPackage), repo);
}

export function redact(value, root, host, repo) {
  let encoded = JSON.stringify(value);
  for (const [from, to] of [[root, "$FIXTURE"], [host, "$PI_PACKAGE"], [repo, "$SOURCE"]]) {
    if (from) encoded = encoded.replaceAll(JSON.stringify(from).slice(1, -1), to);
  }
  return JSON.parse(encoded);
}

export async function main(argv) {
  const options = {};
  assert.equal(argv.shift(), "--live", "Usage: node test/pi-acceptance/acceptance.mjs --live --pi-package DIR [--report NEW-FILE]");
  while (argv.length) {
    const key = argv.shift(); const value = argv.shift();
    assert(["--pi-package", "--report"].includes(key) && value && !value.startsWith("--"), "Invalid acceptance argument");
    assert(!Object.hasOwn(options, key), `Repeated option: ${key}`); options[key] = value;
  }
  if (options["--report"]) assert(!fs.existsSync(path.resolve(options["--report"])), "Report already exists; refusing overwrite");
  const report = await runAcceptance({ piPackage: options["--pi-package"] });
  if (options["--report"]) writeJson(path.resolve(options["--report"]), report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.acceptance === "passed" ? 0 : report.acceptance === "blocked" ? 2 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--live")) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  });
}
