import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ensureOwnedBuildRoot } from "../src/adapters.js";
import { resolveConfig } from "../src/config.js";
import { resolveExecutable } from "../src/runtime.js";
import { applyPrune, listWorkspaceRecords, prunePlan, recordWorkspace } from "../src/state.js";
import { identifyWorkspace } from "../src/workspace.js";

const CLI = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));
const required = new Set((process.env.CD_ARTIFACT_REQUIRE || "").split(",").filter(Boolean));
const payload = Buffer.from([0, 255, 17, 42, 10, 128, 67, 68]);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t, primary) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cd-real-deliverables-")));
  let cleanupSafe = true;
  t.after(() => {
    if (cleanupSafe) fs.rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`retained disposable fixture ${root}: process-group cleanup uncertain`);
  });
  const env = {
    PATH: process.env.PATH, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    CLEAN_DEVELOPMENT_HOME: path.join(root, "home"), CLEAN_DEVELOPMENT_ROOT: path.join(root, "managed"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"), CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"), XDG_CACHE_HOME: path.join(root, "xdg-cache"), XDG_DATA_HOME: path.join(root, "xdg-data"),
    TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
    CARGO_HOME: path.join(root, "cargo-home"), RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(os.homedir(), ".rustup"),
    RUSTUP_AUTO_INSTALL: "0", CARGO_NET_OFFLINE: "true", CARGO_BUILD_JOBS: "2",
    GOENV: "off", GOTOOLCHAIN: "local", GOWORK: "off", GOPROXY: "off", GOSUMDB: "off", GOTELEMETRY: "off", CGO_ENABLED: "0", GOMAXPROCS: "2",
    npm_config_userconfig: path.join(root, "npmrc"), npm_config_globalconfig: path.join(root, "global-npmrc"),
    npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
    PYTHONDONTWRITEBYTECODE: "1", UV_PYTHON_DOWNLOADS: "never", UV_NO_MANAGED_PYTHON: "1", UV_OFFLINE: "1", SOURCE_DATE_EPOCH: "1700000000"
  };
  // Only OS/tool-location inputs are inherited; never contributor config or credentials.
  for (const name of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "GOROOT"]) if (process.env[name]) env[name] = process.env[name];
  const project = path.join(root, "project");
  for (const directory of [project, env.HOME, env.TMPDIR, env.CARGO_HOME, "managed/builds", "managed/caches", "managed/scratch"])
    fs.mkdirSync(path.isAbsolute(directory) ? directory : path.join(root, directory), { recursive: true });
  fs.writeFileSync(env.npm_config_userconfig, "");
  fs.writeFileSync(env.npm_config_globalconfig, "");
  const config = resolveConfig({ cwd: project, env });
  const exec = (command, args, overrides = {}, ok = true) => {
    const result = spawnSync(command, args, { cwd: project, env: { ...env, ...overrides }, encoding: "utf8", timeout: 120000, killSignal: "SIGKILL", detached: process.platform !== "win32", maxBuffer: 2 * 1024 * 1024 });
    if ((result.error || result.status !== 0) && Number.isInteger(result.pid) && result.pid > 0) {
      try { process.kill(-result.pid, "SIGKILL"); }
      catch (error) {
        if (error.code !== "ESRCH") { cleanupSafe = false; throw error; }
      }
    }
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    if (ok) assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
    return result;
  };
  const tools = {};
  const available = (tool, args = ["--version"]) => {
    const binary = resolveExecutable(tool, env, config.locations.binDir, project);
    if (!binary) {
      assert.equal(required.has(tool) || required.has(primary), false, `Required real tool/prerequisite unavailable: ${tool}`);
      t.skip(`real ${tool} unavailable; not artifact acceptance`);
      return null;
    }
    tools[tool] = binary;
    const version = exec(binary, args).stdout.trim().split("\n")[0];
    t.diagnostic(`${tool}: ${version}`);
    return binary;
  };
  const routed = (tool, args, overrides = {}, ok = true) => exec(process.execPath, [CLI, "run", "--session", "session-only", "--", tool, ...args], overrides, ok);
  return { root, env, config, project, exec, routed, tools, available };
}

function treeFiles(directory, limit = 12000) {
  const result = [];
  let visited = 0;
  const visit = (dir, depth = 0) => {
    assert.ok(depth < 64, "fixture directory depth exceeded");
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      assert.ok(++visited < limit, "fixture inventory limit exceeded");
      const file = path.join(dir, item.name);
      assert.equal(item.isSymbolicLink(), false, "unexpected fixture symlink");
      if (item.isDirectory()) visit(file, depth + 1);
      else if (item.isFile()) result.push(file);
    }
  };
  visit(directory);
  return result;
}

function snapshot(files) { return new Map(files.map(file => [file, fs.readFileSync(file)])); }
function unchanged(saved) { for (const [file, bytes] of saved) assert.deepEqual(fs.readFileSync(file), bytes, `changed: ${file}`); }
function evidence(t, f, files) {
  for (const file of files) {
    assert.ok(fs.statSync(file).size > 0);
    t.diagnostic(`${path.relative(f.root, file)} bytes=${fs.statSync(file).size} sha256=${hash(fs.readFileSync(file))}`);
  }
}

async function pruneControl(f, finals, sources) {
  const saved = snapshot([...finals, ...sources]);
  // A labelled synthetic intermediate is enough for non-Cargo tests to exercise
  // actual ownership/age/deletion. Real Cargo below supplies its own compiler data.
  if (!listWorkspaceRecords(f.config).length) {
    const workspace = identifyWorkspace("cargo", [], f.project);
    const owned = ensureOwnedBuildRoot(f.config, workspace);
    recordWorkspace(f.config, workspace, owned);
    fs.writeFileSync(path.join(owned.path, "synthetic-intermediate"), payload);
  }
  const records = listWorkspaceRecords(f.config);
  for (const record of records) fs.writeFileSync(record.file, JSON.stringify({ ...record.value, lastUsedAt: "2000-01-01T00:00:00.000Z" }));
  const plan = prunePlan(f.config, { olderThanDays: 1 });
  assert.equal(plan.filter(entry => entry.eligible).length, records.length);
  await applyPrune(f.config, plan);
  for (const record of records) assert.equal(fs.existsSync(record.value.path), false);
  unchanged(saved);
}

function rejectsManagedOutput(f, tool, args, overrides = {}) {
  const result = f.routed(tool, args, overrides, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Artifact boundary: explicit deliverable output intersects managed build storage/);
  assert.deepEqual(fs.readdirSync(f.config.buildRoot), []);
  assert.deepEqual(listWorkspaceRecords(f.config), []);
}

function nested(f, command) {
  const file = path.join(f.project, "package.json");
  const value = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { name: "cd-deliverable-fixture", version: "0.1.0", private: true };
  value.scripts = { outer: "npm run inner", inner: command };
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

const posix = process.platform === "win32" ? "native Windows command execution not covered by this POSIX fixture" : false;

test("REAL Cargo: release/package bytes stay external; legacy mixed targets are actually prunable", { skip: posix }, async t => {
  const f = fixture(t, "cargo");
  const cargo = f.available("cargo");
  if (!cargo || !f.available("npm") || !f.available("tar")) return;
  fs.mkdirSync(path.join(f.project, "src"));
  const manifest = path.join(f.project, "Cargo.toml");
  const source = path.join(f.project, "src", "main.rs");
  fs.writeFileSync(manifest, '[package]\nname="cd-artifact-fixture"\nversion="0.1.0"\nedition="2021"\n');
  fs.writeFileSync(source, 'fn main() { println!("artifact-bytes-verified"); }\n');
  f.exec(cargo, ["generate-lockfile", "--offline"]);
  const sources = snapshot([manifest, source, path.join(f.project, "Cargo.lock")]);
  f.exec(cargo, ["build", "--release", "--offline", "--locked"]);
  const localBinary = path.join(f.project, "target", "release", "cd-artifact-fixture");
  assert.equal(f.exec(localBinary, []).stdout.trim(), "artifact-bytes-verified");
  f.exec(cargo, ["package", "--offline", "--locked", "--allow-dirty"]);
  const localCrate = path.join(f.project, "target", "package", "cd-artifact-fixture-0.1.0.crate");
  assert.equal(f.exec(f.tools.tar, ["-xOf", localCrate, "cd-artifact-fixture-0.1.0/src/main.rs"]).stdout, fs.readFileSync(source, "utf8"));
  const local = snapshot([localBinary, localCrate]);
  for (const args of [["build", "--release", "--offline"], ["package", "--offline"], ["release"], ["build", "--future-output=unknown"]]) {
    const result = f.routed("cargo", args, {}, false);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cargo artifact boundary/);
    assert.deepEqual(listWorkspaceRecords(f.config), []);
  }
  unchanged(local);
  const finalTarget = path.join(f.root, "final output=東京");
  const finalBinary = path.join(finalTarget, "release", "cd-artifact-fixture");
  const finalCrate = path.join(finalTarget, "package", "cd-artifact-fixture-0.1.0.crate");
  f.exec(cargo, ["build", "--release", "--offline", "--locked", "--target-dir", finalTarget]);
  const binaryBytes = fs.readFileSync(finalBinary);
  fs.unlinkSync(finalBinary); // Disposable fixture only: prove the routed tool regenerates it.
  f.routed("cargo", ["build", "--release", "--offline", "--locked", `--target-dir=${finalTarget}`]);
  assert.deepEqual(fs.readFileSync(finalBinary), binaryBytes);
  assert.equal(f.exec(finalBinary, []).stdout.trim(), "artifact-bytes-verified");
  f.routed("cargo", ["package", "--offline", "--locked", "--allow-dirty", "--target-dir", finalTarget]);
  assert.deepEqual(fs.readFileSync(finalCrate), fs.readFileSync(localCrate));
  const packageFile = nested(f, `cargo package --offline --locked --allow-dirty --target-dir ${quote(finalTarget)}`);
  // package.json changes the source archive; compare payload contents, not stale hash equality.
  f.routed("npm", ["run", "outer"]);
  assert.equal(f.exec(f.tools.tar, ["-xOf", finalCrate, "cd-artifact-fixture-0.1.0/src/main.rs"]).stdout, fs.readFileSync(source, "utf8"));
  nested(f, "cargo build --release --offline");
  const refused = f.routed("npm", ["run", "outer"], {}, false);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Cargo artifact boundary/);
  f.routed("cargo", ["check", "--offline", "--locked"]);
  const record = listWorkspaceRecords(f.config)[0];
  const target = path.join(record.value.path, "cargo", "target");
  assert.ok(treeFiles(target).some(file => file.endsWith(".rmeta")));
  // Historical-layout control: real Cargo uses the old unconditional target
  // environment, bypassing today's shim. It is explicitly NOT a routed pass.
  f.exec(cargo, ["build", "--release", "--offline"], { CARGO_TARGET_DIR: target });
  f.exec(cargo, ["package", "--offline", "--allow-dirty"], { CARGO_TARGET_DIR: target });
  const legacyBinary = path.join(target, "release", "cd-artifact-fixture");
  const legacyCrate = path.join(target, "package", "cd-artifact-fixture-0.1.0.crate");
  assert.equal(f.exec(legacyBinary, []).stdout.trim(), "artifact-bytes-verified");
  assert.equal(f.exec(f.tools.tar, ["-xOf", legacyCrate, "cd-artifact-fixture-0.1.0/src/main.rs"]).stdout, fs.readFileSync(source, "utf8"));
  const rejected = f.routed("cargo", ["package", "--target-dir", target], {}, false);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /intersects managed build storage/);
  evidence(t, f, [finalBinary, finalCrate, legacyBinary, legacyCrate]);
  await pruneControl(f, [localBinary, localCrate, finalBinary, finalCrate], [manifest, source, packageFile, path.join(f.project, "Cargo.lock")]);
  assert.equal(fs.existsSync(legacyBinary), false);
  assert.equal(fs.existsSync(legacyCrate), false);
  unchanged(sources);
});

test("REAL Go: -o split/attached paths and nested npm scripts preserve executable bytes outside compiler cache", { skip: posix }, async t => {
  const f = fixture(t, "go");
  const go = f.available("go", ["version"]);
  if (!go || !f.available("npm")) return;
  fs.writeFileSync(path.join(f.project, "go.mod"), "module example.invalid/cd-artifact-fixture\n\ngo 1.22\n");
  fs.writeFileSync(path.join(f.project, "main.go"), 'package main\nimport "fmt"\nfunc main() { fmt.Println("artifact-bytes-verified") }\n');
  const output = path.join(f.root, "final go binary");
  const flags = ["build", "-trimpath", "-buildvcs=false"];
  const packageFile = nested(f, `go build -trimpath -buildvcs=false -o ${quote(output)} .`);
  const sourceFiles = [packageFile, path.join(f.project, "go.mod"), path.join(f.project, "main.go")];
  const source = snapshot(sourceFiles);
  f.exec(go, [...flags, "-o", output, "."], { GOCACHE: path.join(f.root, "direct-go-cache") });
  const bytes = fs.readFileSync(output);
  for (const nestedScript of [false, true]) {
    fs.unlinkSync(output);
    if (nestedScript) f.routed("npm", ["run", "outer"]);
    else f.routed("go", [...flags, `-o=${output}`, "."]);
    assert.deepEqual(fs.readFileSync(output), bytes);
    assert.equal(f.exec(output, []).stdout.trim(), "artifact-bytes-verified");
  }
  assert.ok(treeFiles(path.join(f.config.cacheRoot, "go", "build")).some(file => /[a-f0-9]{64}-[ad]$/.test(path.basename(file))));
  assert.equal(fs.existsSync(path.join(f.project, "target")), false);
  assert.deepEqual(listWorkspaceRecords(f.config), []);
  rejectsManagedOutput(f, "go", [...flags, "-o", path.join(f.config.buildRoot, "final-binary"), "."]);
  unchanged(source);
  evidence(t, f, [output]);
  await pruneControl(f, [output], sourceFiles);
});

test("REAL npm: default, explicit and nested pack retain tarball payload bytes outside routed cache", { skip: posix }, async t => {
  const f = fixture(t, "npm");
  const npm = f.available("npm");
  if (!npm || !f.available("tar")) return;
  const payloadFile = path.join(f.project, "payload.bin");
  fs.writeFileSync(payloadFile, payload);
  fs.writeFileSync(path.join(f.project, "package.json"), JSON.stringify({ name: "cd-artifact-fixture", version: "0.1.0", files: ["payload.bin"] }));
  const outputDir = path.join(f.root, "npm final=東京");
  fs.mkdirSync(outputDir);
  const packageFile = nested(f, `npm pack --offline --json --pack-destination ${quote(outputDir)}`);
  const source = snapshot([packageFile, payloadFile]);
  const defaultFile = path.join(f.project, "cd-artifact-fixture-0.1.0.tgz");
  const explicitFile = path.join(outputDir, path.basename(defaultFile));
  f.exec(npm, ["pack", "--offline", "--json"]);
  const bytes = fs.readFileSync(defaultFile);
  fs.unlinkSync(defaultFile);
  f.routed("npm", ["pack", "--offline", "--json"]);
  assert.deepEqual(fs.readFileSync(defaultFile), bytes);
  f.exec(npm, ["pack", "--offline", "--json", "--pack-destination", outputDir]);
  for (const mode of ["equals", "nested"]) {
    fs.unlinkSync(explicitFile);
    if (mode === "nested") f.routed("npm", ["run", "outer"]);
    else f.routed("npm", ["pack", "--offline", "--json", `--pack-destination=${outputDir}`]);
    assert.deepEqual(fs.readFileSync(explicitFile), bytes);
  }
  const extracted = spawnSync(f.tools.tar, ["-xOf", explicitFile, "package/payload.bin"], { env: f.env, timeout: 10000, maxBuffer: 65536 });
  assert.equal(extracted.status, 0);
  assert.deepEqual(extracted.stdout, payload);
  assert.equal(f.routed("npm", ["config", "get", "cache"]).stdout.trim(), path.join(f.config.cacheRoot, "node", "npm"));
  assert.deepEqual(listWorkspaceRecords(f.config), []);
  rejectsManagedOutput(f, "npm", ["pack", `--pack-destination=${f.config.buildRoot}`]);
  rejectsManagedOutput(f, "npm", ["pack"], { npm_config_pack_destination: f.config.buildRoot });
  unchanged(source);
  evidence(t, f, [defaultFile, explicitFile]);
  await pruneControl(f, [defaultFile, explicitFile], [packageFile, payloadFile]);
});

test("REAL uv: default dist and explicit -o/--out-dir preserve wheel and sdist payload bytes", { skip: posix }, async t => {
  const f = fixture(t, "uv");
  const uv = f.available("uv");
  if (!uv || !f.available("npm")) return;
  const python = f.available("python3");
  if (!python) return;
  const backend = f.exec(python, ["-I", "-B", "-c", "import setuptools, wheel; print(setuptools.__version__, wheel.__version__)"], {}, false);
  if (backend.status !== 0) {
    assert.equal(required.has("uv"), false, "Required uv build backend unavailable (setuptools/wheel)");
    t.skip("installed setuptools/wheel unavailable; no downloads or fabricated backend");
    return;
  }
  t.diagnostic(`setuptools/wheel: ${backend.stdout.trim()}`);
  fs.writeFileSync(path.join(f.project, "pyproject.toml"), '[build-system]\nrequires=["setuptools", "wheel"]\nbuild-backend="setuptools.build_meta"\n[project]\nname="cd-artifact-fixture"\nversion="0.1.0"\n[tool.setuptools]\npy-modules=["fixture_module"]\n');
  const module = path.join(f.project, "fixture_module.py");
  fs.writeFileSync(module, 'VALUE = "artifact-bytes-verified"\n');
  const outputDir = path.join(f.root, "uv final=東京");
  const flags = ["build", "--offline", "--no-config", "--no-build-isolation", "--python", python];
  const packageFile = nested(f, `uv ${flags.map(quote).join(" ")} -o ${quote(outputDir)}`);
  const sourceFiles = [packageFile, module, path.join(f.project, "pyproject.toml")];
  const sources = snapshot(sourceFiles);
  f.exec(uv, flags);
  const defaults = treeFiles(path.join(f.project, "dist")).filter(file => /\.(whl|tar.gz)$/.test(file));
  assert.equal(defaults.length, 2);
  const checkPayload = files => {
    const script = "import sys,zipfile,tarfile,json,base64\nr=[]\nfor p in sys.argv[1:]:\n if p.endswith('.whl'):\n  with zipfile.ZipFile(p) as z: b=z.read('fixture_module.py')\n else:\n  with tarfile.open(p) as z: b=z.extractfile(next(n for n in z.getnames() if n.endswith('/fixture_module.py'))).read()\n r.append(base64.b64encode(b).decode())\nprint(json.dumps(r))";
    const observed = JSON.parse(f.exec(python, ["-I", "-B", "-c", script, ...files]).stdout);
    for (const value of observed) assert.deepEqual(Buffer.from(value, "base64"), fs.readFileSync(module));
  };
  checkPayload(defaults);
  for (const file of defaults) fs.unlinkSync(file);
  f.routed("uv", flags);
  checkPayload(defaults);
  f.exec(uv, [...flags, "--out-dir", outputDir]);
  const explicit = treeFiles(outputDir).filter(file => /\.(whl|tar.gz)$/.test(file));
  assert.equal(explicit.length, 2);
  for (const mode of ["equals", "nested"]) {
    for (const file of explicit) fs.unlinkSync(file);
    if (mode === "nested") f.routed("npm", ["run", "outer"]);
    else f.routed("uv", [...flags, `--out-dir=${outputDir}`]);
    checkPayload(explicit);
  }
  assert.equal(f.routed("uv", ["cache", "dir", "--no-config"]).stdout.trim(), path.join(f.config.cacheRoot, "python", "uv"));
  assert.deepEqual(listWorkspaceRecords(f.config), []);
  rejectsManagedOutput(f, "uv", [...flags, "--out-dir", f.config.buildRoot]);
  unchanged(sources);
  // sdist/gzip backend metadata may vary: compare exact source members, not a
  // false promise of byte-identical whole archives across backend invocations.
  evidence(t, f, [...defaults, ...explicit]);
  await pruneControl(f, [...defaults, ...explicit], sourceFiles);
});
