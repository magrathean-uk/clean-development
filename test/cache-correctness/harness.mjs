import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const cli = path.join(sourceRoot, "bin/clean-development.js");
export const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
export const write = (file, contents) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); };
export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export const expected = (lane) => `${lane.name}|${lane.source}|${lane.flag}|dep${lane.version}\n`;
export function assertOutput(actual, wanted) { assert.equal(actual, wanted, "stale output or cross-project contamination"); }

// Include untracked/empty directories, modes and symlink targets; never traverse
// links. Metadata access times are intentionally not an immutability assertion.
export function inventory(root, { maxEntries = 20000, maxBytes = 64 * 1024 * 1024 } = {}) {
  let bytes = 0;
  const result = {};
  const visit = (file, relative) => {
    assert.ok(Object.keys(result).length < maxEntries, "inventory entry bound exceeded");
    const st = fs.lstatSync(file);
    const entry = { mode: st.mode & 0o777, type: st.isSymbolicLink() ? "link" : st.isDirectory() ? "directory" : "file" };
    if (st.isSymbolicLink()) entry.target = fs.readlinkSync(file);
    else if (st.isFile()) {
      bytes += st.size; assert.ok(bytes <= maxBytes, "inventory byte bound exceeded");
      entry.sha256 = sha256(fs.readFileSync(file));
    } else assert.ok(st.isDirectory(), "unsupported inventory entry");
    result[relative] = entry;
    if (st.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), `${relative}/${name}`);
  };
  visit(root, ".");
  return result;
}
export function assertUnchanged(before, root) { assert.deepEqual(inventory(root), before, `unplanned source write: ${root}`); }
export function executable(name, search = process.env.PATH || "") {
  for (const directory of search.split(path.delimiter).filter(path.isAbsolute)) {
    const file = path.join(directory, name);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch { /* next PATH entry */ }
  }
  return null;
}
export async function until(predicate, description, timeoutMs = 60000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `deadline waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export function assertOverlap(results) {
  assert.ok(Math.max(...results.map((r) => r.started)) < Math.min(...results.map((r) => r.ended)), "cold tool processes did not overlap");
}
export function assertInside(root, file) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), `artifact outside selected root: ${file}`);
  assert.ok(fs.statSync(file).isFile() && fs.statSync(file).size > 0, "missing/empty artifact");
}

export class Lab {
  constructor(tool) {
    this.tool = tool;
    this.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `clean-development-cache-${tool}-`)));
    this.token = crypto.randomUUID();
    write(path.join(this.root, ".lab-owner"), this.token);
    this.identity = fs.lstatSync(this.root);
    const home = path.join(this.root, "home");
    this.env = {
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
      HOME: home, USERPROFILE: home, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC",
      XDG_CACHE_HOME: path.join(home, ".cache"), XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"), XDG_STATE_HOME: path.join(home, ".local/state"),
      CLEAN_DEVELOPMENT_HOME: home, CLEAN_DEVELOPMENT_DATA_HOME: path.join(this.root, "data"),
      CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(this.root, "config"), CLEAN_DEVELOPMENT_ROOT: path.join(this.root, "managed"),
      CARGO_HOME: path.join(this.root, "cargo-home"), CARGO_NET_OFFLINE: "true", CARGO_BUILD_JOBS: "1", RUSTUP_AUTO_INSTALL: "0",
      GOPATH: path.join(this.root, "gopath"), GOTOOLCHAIN: "local", GOWORK: "off", GOENV: "off", GOPROXY: "off", GOSUMDB: "off",
      GOTELEMETRY: "off", CGO_ENABLED: "0", GOMAXPROCS: "2",
      npm_config_userconfig: path.join(this.root, "config/npm-user"), npm_config_globalconfig: path.join(this.root, "config/npm-global"),
      npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
      npm_config_fetch_retries: "0", npm_config_registry: "http://127.0.0.1:9/",
      UV_PYTHON_DOWNLOADS: "never", UV_NO_MANAGED_PYTHON: "1", UV_NO_PROGRESS: "1", UV_OFFLINE: "1", UV_NO_CONFIG: "1",
      UV_CONCURRENT_DOWNLOADS: "2", UV_CONCURRENT_BUILDS: "1", UV_CONCURRENT_INSTALLS: "2", PYTHONDONTWRITEBYTECODE: "1",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(this.root, "config/git"), GIT_TERMINAL_PROMPT: "0",
      GIT_TEMPLATE_DIR: path.join(this.root, "empty"),
      TMPDIR: path.join(this.root, "tmp"), TMP: path.join(this.root, "tmp"), TEMP: path.join(this.root, "tmp")
    };
    for (const relative of ["home", "tmp", "empty", "config", "cargo-home", "artifacts", "control", "logs", "sources"]) fs.mkdirSync(path.join(this.root, relative));
    for (const file of [this.env.npm_config_userconfig, this.env.npm_config_globalconfig, this.env.GIT_CONFIG_GLOBAL]) write(file, "");
    write(path.join(this.root, ".clean-development.json"), '{"schemaVersion":1}\n');
    this.report = { schemaVersion: 1, kind: "real-cache-correctness", tool, status: "running", platform: process.platform, arch: process.arch,
      node: process.version, os: os.release(), versions: {}, scenarios: [], commands: [], assertions: [],
      sourceFingerprint: sha256(JSON.stringify([inventory(path.join(sourceRoot, "src")), inventory(path.join(sourceRoot, "bin"))])),
      limits: { commandMs: 120000, commandOutputBytes: 4 * 1024 * 1024, sourceEntries: 20000, sourceBytes: 64 * 1024 * 1024 },
      boundary: "POSIX disposable fixture, no network except optional loopback fixture server; not a filesystem sandbox" };
    this.children = new Set();
    this.serial = 0;
  }
  record(name, details = {}) { this.report.assertions.push({ name, ...details }); }
  start(command, args, cwd = this.root, extraEnv = {}, timeoutMs = 120000) {
    const serial = ++this.serial;
    const started = performance.now();
    const child = spawn(command, args, { cwd, env: { ...this.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.children.add(child);
    const chunks = { stdout: [], stderr: [] }; let size = 0; let failure = null;
    const kill = (signal = "SIGKILL") => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const timer = setTimeout(() => { failure = "command timeout"; kill(); }, timeoutMs);
    for (const name of ["stdout", "stderr"]) child[name].on("data", (chunk) => {
      size += chunk.length;
      if (size > this.report.limits.commandOutputBytes) { failure = "command output bound exceeded"; kill(); }
      else chunks[name].push(chunk);
    });
    child.on("error", (error) => { failure = `${error.code}: ${error.message}`; });
    const done = new Promise((resolve) => child.on("close", (code, signal) => {
      clearTimeout(timer); this.children.delete(child);
      const result = { code, signal, failure, started, ended: performance.now(), stdout: Buffer.concat(chunks.stdout).toString(), stderr: Buffer.concat(chunks.stderr).toString() };
      for (const name of ["stdout", "stderr"]) write(path.join(this.root, `logs/${serial}-${name}.log`), result[name]);
      this.report.commands.push({ serial, command, args, cwd, code, signal, failure, started, ended: result.ended,
        stdout: { bytes: Buffer.byteLength(result.stdout), sha256: sha256(result.stdout), log: `logs/${serial}-stdout.log` },
        stderr: { bytes: Buffer.byteLength(result.stderr), sha256: sha256(result.stderr), log: `logs/${serial}-stderr.log` } });
      resolve(result);
    }));
    return { child, done, kill };
  }
  async command(command, args, cwd = this.root, env = {}, options = {}) {
    const result = await this.start(command, args, cwd, env, options.timeoutMs).done;
    assert.equal(result.failure, null, result.failure || "");
    if (!options.allowFailure) assert.equal(result.code, 0, `${command} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
    return result;
  }
  routedStart(tool, args, cwd, env = {}) { return this.start(process.execPath, [cli, "run", "--session", "session-only", "--", tool, ...args], cwd, env); }
  async routed(tool, args, cwd, env = {}) {
    const result = await this.routedStart(tool, args, cwd, env).done;
    assert.equal(result.failure, null, result.failure || "");
    assert.equal(result.code, 0, `${tool}: ${result.stderr}\n${result.stdout}`);
    return result;
  }
  async version(tool, args = ["--version"]) {
    const selected = executable(tool, this.env.PATH);
    if (!selected) throw Object.assign(new Error(`${tool} unavailable`), { code: "LAB_TOOL_UNAVAILABLE" });
    const result = await this.command(selected, args, this.root, {}, { timeoutMs: 10000 });
    this.report.versions[tool] = result.stdout.trim() || result.stderr.trim();
    return selected;
  }
  async git(args, cwd) { return this.command(executable("git"), ["-c", `core.hooksPath=${path.join(this.root, "empty")}`, "-c", "commit.gpgsign=false", ...args], cwd); }
  async checkouts(prepare) {
    const lanes = ["A", "B", "W1", "W2"].map((name) => ({ name, root: path.join(this.root, `sources/${name}/same-name`), source: "source01", version: 1, flag: "flag0" }));
    for (const lane of lanes.slice(0, 2)) {
      fs.mkdirSync(lane.root, { recursive: true }); await prepare(lane);
      await this.git(["init", "--quiet", "."], lane.root);
      await this.git(["add", "."], lane.root);
      await this.git(["-c", "user.name=Cache Lab", "-c", "user.email=cache-lab@example.invalid", "commit", "--quiet", "-m", "fixture"], lane.root);
    }
    for (const lane of lanes.slice(2)) {
      await this.git(["worktree", "add", "--quiet", "--detach", lane.root, "HEAD"], lanes[0].root);
    }
    const commits = await Promise.all([lanes[0], ...lanes.slice(2)].map(async (lane) => (await this.git(["rev-parse", "HEAD"], lane.root)).stdout.trim()));
    assert.equal(new Set(commits).size, 1);
    const common = await Promise.all([lanes[0], ...lanes.slice(2)].map(async (lane) => fs.realpathSync(path.resolve(lane.root, (await this.git(["rev-parse", "--git-common-dir"], lane.root)).stdout.trim()))));
    assert.equal(new Set(common).size, 1);
    const other = (await this.git(["rev-parse", "--absolute-git-dir"], lanes[1].root)).stdout.trim();
    assert.notEqual(fs.realpathSync(other), common[0]);
    this.record("two independent repositories and two linked worktrees", { names: lanes.map((lane) => lane.name), commonCommit: commits[0] });
    this.lanes = lanes;
    return lanes;
  }
  snapshot() { return inventory(path.join(this.root, "sources")); }
  unchanged(before) { assertUnchanged(before, path.join(this.root, "sources")); this.record("all four source trees unchanged"); }
  async zip(file, entries) {
    const spec = path.join(this.root, `control/zip-${++this.serial}.json`); write(spec, JSON.stringify(entries));
    await this.command(executable("python3"), ["-I", "-c", "import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[2],'w') as z:\n for n,v in sorted(json.load(open(sys.argv[1])).items()):\n  i=zipfile.ZipInfo(n,(1980,1,1,0,0,0)); i.external_attr=0o100644<<16; z.writestr(i,v)\n", spec, file]);
  }
  async finish(error = null, keep = false) {
    for (const child of this.children) { try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; } }
    await until(() => this.children.size === 0, "remaining lab children to exit", 10000);
    const fingerprint = sha256(JSON.stringify([inventory(path.join(sourceRoot, "src")), inventory(path.join(sourceRoot, "bin"))]));
    assert.equal(fingerprint, this.report.sourceFingerprint, "product source changed during lab");
    this.report.status = error ? error.code === "LAB_TOOL_UNAVAILABLE" ? "blocked" : "failed" : "passed";
    if (error) this.report.error = { code: error.code || "ASSERTION_FAILED", message: error.message };
    const json = JSON.stringify(this.report, null, 2).split(this.root).join("<LAB>").split(sourceRoot).join("<SOURCE>");
    assert.ok(Buffer.byteLength(json) < 2 * 1024 * 1024, "report size bound exceeded");
    write(path.join(this.root, "report.json"), `${json}\n`);
    if (!error && !keep) this.remove();
    return { ...JSON.parse(json), evidenceRoot: keep || error ? this.root : null };
  }
  remove() {
    const st = fs.lstatSync(this.root);
    assert.ok(st.isDirectory() && !st.isSymbolicLink() && st.dev === this.identity.dev && st.ino === this.identity.ino);
    assert.equal(fs.realpathSync(this.root), this.root); assert.equal(fs.readFileSync(path.join(this.root, ".lab-owner"), "utf8"), this.token);
    // Versioned Go modules are read-only. Only chmod directories within this
    // freshly owned fixture; never follow a cache/toolchain symlink.
    const writable = (file) => { const s = fs.lstatSync(file); if (s.isDirectory() && !s.isSymbolicLink()) { fs.chmodSync(file, s.mode | 0o700); for (const n of fs.readdirSync(file)) writable(path.join(file, n)); } };
    writable(this.root); fs.rmSync(this.root, { recursive: true });
  }
}
