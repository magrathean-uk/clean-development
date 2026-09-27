import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { resolveConfig } from "../src/config.js";
import { ensureRuntime } from "../src/runtime.js";
import { resolveExecutable } from "../src/executable.js";
import { HELP, parseOptions, random, pairOrders, summarize, sha256, hashFile, readOptional,
  systemLoad, inventory, storageDelta, fixtureSources, isolatedEnvironment, commandRunner } from "./fixtures/benchmark-overhead.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let options;
try { options = parseOptions(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exit(2); }
if (options.help) { console.log(HELP); process.exit(0); }
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 12)) throw new Error("Node >=20.12 is required");
const go = resolveExecutable("go", process.env, null, sourceRoot);
const git = resolveExecutable("git", process.env, null, sourceRoot);
if (!go || !git) throw new Error("A real Go toolchain and Git are required; no fake-tool fallback");
// Reserve the output before expensive work, refusing overwrite or symlink targets.
const outputFd = options.output ? fs.openSync(options.output, "wx", 0o600) : null;
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-paired-")));
const owner = `${process.pid}:${root}`;
fs.writeFileSync(path.join(root, ".benchmark-owner"), owner, { flag: "wx" });
const runner = commandRunner(), env = isolatedEnvironment(root, go, git);
const rng = random(options.seed), startedAt = new Date().toISOString();
const initialLoad = systemLoad();
const notify = (message) => console.error(`[benchmark ${process.version}] ${message}`);
const interrupt = () => runner.interrupt();
process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
const run = (command, args, cwd = root, childEnv = env) => runner.run(command, args, { cwd, env: childEnv });
const gitRun = (args, cwd = root) => run(git, ["-c", `core.hooksPath=${path.join(root, "empty-hooks")}`, "-c", "core.autocrlf=false", ...args], cwd);
const repository = path.join(root, "fixture-repository");
const worktrees = [path.join(root, "worktree-a"), path.join(root, "worktree-b")];
const artifactName = process.platform === "win32" ? "bench.exe" : "bench";
const buildArgs = ["build", "-trimpath", "-buildvcs=false", "-p=2", "-o", `dist/${artifactName}`, "."];
let runtime, source, version, fixtureCommit, initialSourceHashes;
const records = { short: [], cold: [], cacheHit: [], warmIncremental: [], concurrent: [] };
const proofs = [], warmup = [];
let completed = false;
function relative(value) { return value.split(root).join("$FIXTURE"); }
function storage(label, mode) {
  return mode === "shim" ? path.join(root, label, "managed", "caches", "go") : path.join(root, label, "direct-cache", "go");
}
function environment(label, mode) {
  const common = { ...env, CLEAN_DEVELOPMENT_ROOT: path.join(root, label, "managed") };
  if (mode === "direct") return { ...common, GOCACHE: path.join(storage(label, mode), "build"), GOMODCACHE: path.join(storage(label, mode), "modules") };
  return { ...common, PATH: `${runtime.binDir}${path.delimiter}${env.PATH}` };
}
function prepareStorage(label) {
  for (const mode of ["direct", "shim"]) fs.mkdirSync(path.join(storage(label, mode), "build"), { recursive: true });
  for (const name of ["caches", "builds", "scratch"]) fs.mkdirSync(path.join(root, label, "managed", name), { recursive: true });
}
function executable(mode) { return mode === "direct" ? go : path.join(runtime.binDir, process.platform === "win32" ? "go.cmd" : "go"); }
function stamp(cwd, value) { fs.writeFileSync(path.join(cwd, "stamp.go"), `package main\nconst stamp uint64 = ${value}\n`); }
function clearOutput(cwd) {
  fs.mkdirSync(path.join(cwd, "dist"), { recursive: true });
  fs.rmSync(path.join(cwd, "dist", artifactName), { force: true });
}
function artifact(cwd) {
  const file = path.join(cwd, "dist", artifactName), stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0);
  assert.equal(fs.realpathSync.native(file), file);
  assert.equal(fs.existsSync(path.join(cwd, "target")), false, "Unexpected project-local Cargo target");
  return { path: relative(file), bytes: stat.size, sha256: hashFile(file) };
}
async function timedArm(mode, label, cwds, args, building) {
  // Inventories, output deletion and evidence hashing are OUTSIDE timing.
  if (building) {
    const space = fs.statfsSync(root);
    assert.ok(space.bavail * space.bsize > 1024 ** 3, "Less than 1 GiB free; stop before another build");
    for (const cwd of cwds) clearOutput(cwd);
  }
  const before = building ? inventory(storage(label, mode)) : null;
  const order = cwds.length > 1 && rng() < 0.5 ? [...cwds].reverse() : [...cwds];
  const start = performance.now();
  const settled = await Promise.allSettled(order.map((cwd) => run(executable(mode), args, cwd, environment(label, mode))));
  const end = performance.now();
  const failed = settled.find((r) => r.status === "rejected");
  if (failed) throw failed.reason; // Both lanes have closed before leaving this arm.
  const children = settled.map((r, i) => ({ ...r.value, cwd: order[i] }));
  const result = { ms: children.length === 1 ? children[0].ms : end - start,
    children: children.map((c) => ({ ms: c.ms, cwd: relative(c.cwd), exitCode: c.exitCode })),
    stdoutSha256: children.map((c) => sha256(c.stdout)) };
  if (children.length > 1) {
    result.overlapMs = Math.min(...children.map((c) => c.end)) - Math.max(...children.map((c) => c.start));
    result.launchSkewMs = Math.max(...children.map((c) => c.start)) - Math.min(...children.map((c) => c.start));
    assert.ok(result.overlapMs > 0, "Concurrent worktrees did not overlap");
  }
  if (building) {
    result.artifacts = cwds.map(artifact);
    result.cache = storageDelta(before, inventory(storage(label, mode)));
    assert.ok(result.cache.files > 0 && result.cache.logicalBytes > 0, "Missing compiler cache artifacts");
  } else for (const child of children) assert.equal(child.stdout.trim(), version);
  return result;
}
async function pairs(phase, count, label, cwds, args, setStamp) {
  const orders = pairOrders(count, rng);
  for (let i = 0; i < count; i += 1) {
    if (setStamp) cwds.forEach((cwd, lane) => stamp(cwd, setStamp + i * 2 + lane));
    const pair = { index: i, order: orders[i], before: systemLoad() };
    for (const mode of pair.order) pair[mode] = await timedArm(mode, label, cwds, args, Boolean(setStamp));
    pair.after = systemLoad();
    if (setStamp) assert.deepEqual(pair.direct.artifacts, pair.shim.artifacts, "Paired build artifacts differ");
    records[phase].push(pair);
    if (phase !== "short" || (i + 1) % 25 === 0) notify(`${phase}: ${i + 1}/${count} pairs`);
  }
}
async function cacheProof(label, mode, cwd, kind) {
  const childEnv = environment(label, mode);
  const location = JSON.parse((await run(executable(mode), ["env", "-json", "GOCACHE", "GOMODCACHE", "GOTELEMETRY", "GOTOOLCHAIN"], cwd, childEnv)).stdout);
  assert.equal(location.GOCACHE, path.join(storage(label, mode), "build"));
  assert.equal(location.GOMODCACHE, path.join(storage(label, mode), "modules"));
  assert.equal(location.GOTELEMETRY, "off");
  const before = inventory(storage(label, mode)); clearOutput(cwd);
  const trace = await run(executable(mode), [...buildArgs.slice(0, 1), "-x", ...buildArgs.slice(1)], cwd, childEnv);
  const compileLines = trace.stderr.split(/\r?\n/).filter((line) => /(?:^|[\\/])compile(?:\.exe)?"?\s/.test(line));
  assert.equal(compileLines.length, 0, "Identical rebuild did not reuse compiler cache");
  const files = [...inventory(path.join(storage(label, mode), "build"))].filter(([name]) => /[a-f0-9]{64}-d$/.test(path.basename(name)));
  assert.ok(files.length > 0, "No content-addressed Go build artifacts");
  const [sampleName] = files.sort(([a], [b]) => a.localeCompare(b))[0];
  const samplePath = path.join(storage(label, mode), "build", sampleName);
  proofs.push({ label, mode, kind, cwd: relative(cwd), environment: location, compilerInvocations: compileLines.length,
    moduleCacheFiles: inventory(path.join(storage(label, mode), "modules")).size,
    linkInvocations: trace.stderr.split(/\r?\n/).filter((line) => /(?:^|[\\/])link(?:\.exe)?"?\s/.test(line)).length,
    traceSha256: sha256(trace.stderr), traceBytes: Buffer.byteLength(trace.stderr), artifact: artifact(cwd),
    cache: storageDelta(before, inventory(storage(label, mode))),
    sampleCacheArtifact: { path: relative(samplePath), bytes: fs.statSync(samplePath).size, sha256: hashFile(samplePath) } });
}
try {
  version = (await run(go, ["version"])).stdout.trim();
  const goMatch = version.match(/^go version go(\d+)\.(\d+)/);
  assert.ok(goMatch && (Number(goMatch[1]) > 1 || Number(goMatch[2]) >= 23), "Go >=1.23 required");
  await run(go, ["telemetry", "off"]);
  const gitVersion = (await gitRun(["--version"])).stdout.trim();
  const toolchain = JSON.parse((await run(go, ["env", "-json", "GOVERSION", "GOOS", "GOARCH", "GOROOT", "GOTOOLDIR"])).stdout);
  source = { commit: null, tree: null, dirty: null, runtimeFiles: {}, harnessFiles: {} };
  try {
    source.commit = (await gitRun(["rev-parse", "HEAD"], sourceRoot)).stdout.trim();
    source.tree = (await gitRun(["rev-parse", "HEAD^{tree}"], sourceRoot)).stdout.trim();
    source.dirty = Boolean((await gitRun(["status", "--porcelain", "--untracked-files=normal"], sourceRoot)).stdout);
  } catch { /* Archives retain explicit content digests, never an invented revision. */ }
  for (const directory of ["src", "bin"]) for (const name of fs.readdirSync(path.join(sourceRoot, directory)).sort()) {
    if (fs.statSync(path.join(sourceRoot, directory, name)).isFile()) source.runtimeFiles[`${directory}/${name}`] = hashFile(path.join(sourceRoot, directory, name));
  }
  source.runtimeFiles["package.json"] = hashFile(path.join(sourceRoot, "package.json"));
  for (const file of ["scripts/benchmark-overhead.mjs", "scripts/fixtures/benchmark-overhead.mjs"]) source.harnessFiles[file] = hashFile(path.join(sourceRoot, file));
  source.runtimeFingerprint = sha256(JSON.stringify(source.runtimeFiles));
  fs.mkdirSync(repository);
  for (const [name, content] of Object.entries(fixtureSources(options.functions))) fs.writeFileSync(path.join(repository, name), content);
  await gitRun(["init", "-q"], repository);
  await gitRun(["add", "."], repository);
  await run(git, ["-c", "user.name=Benchmark Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
    "-c", `core.hooksPath=${path.join(root, "empty-hooks")}`, "commit", "-qm", "Deterministic benchmark fixture"], repository,
  { ...env, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" });
  fixtureCommit = (await gitRun(["rev-parse", "HEAD"], repository)).stdout.trim();
  for (const cwd of worktrees) await gitRun(["worktree", "add", "--detach", cwd, "HEAD"], repository);
  const identities = [];
  for (const cwd of worktrees) {
    const common = (await gitRun(["rev-parse", "--git-common-dir"], cwd)).stdout.trim();
    identities.push({ cwd: relative(cwd), commonDir: relative(fs.realpathSync(path.resolve(cwd, common))),
      gitFile: fs.readFileSync(path.join(cwd, ".git"), "utf8").trim(), commit: (await gitRun(["rev-parse", "HEAD"], cwd)).stdout.trim() });
  }
  assert.equal(identities[0].commonDir, identities[1].commonDir);
  assert.notEqual(identities[0].gitFile, identities[1].gitFile);
  initialSourceHashes = Object.fromEntries(worktrees.map((cwd) => [cwd, Object.fromEntries(["main.go", "go.mod", ".clean-development.json", ".gitignore"].map((f) => [f, hashFile(path.join(cwd, f))]))]));
  prepareStorage("warm");
  const setupStart = performance.now();
  runtime = ensureRuntime(resolveConfig({ cwd: worktrees[0], env: { ...env, CLEAN_DEVELOPMENT_ROOT: path.join(root, "warm", "managed") } }));
  const setupMs = performance.now() - setupStart;
  const launcher = executable("shim");
  assert.ok(fs.readFileSync(launcher, "utf8").includes(process.execPath), "Installed launcher does not pin this Node");
  for (const [file, digest] of Object.entries(source.runtimeFiles)) assert.equal(hashFile(path.join(runtime.versionRoot, file)), digest, "Installed runtime differs from source");
  notify(`${version}; ${options.functions} functions; setup excluded from paired timing`);
  for (let i = 0; i < 5; i += 1) for (const mode of pairOrders(1, rng)[0]) await run(executable(mode), ["version"], worktrees[0], environment("warm", mode));
  await pairs("short", options.shortPairs, "warm", [worktrees[0]], ["version"], 0);
  for (let i = 0; i < options.coldPairs; i += 1) {
    const label = `cold-${i}`; prepareStorage(label); stamp(worktrees[0], 100 + i);
    const cold = { index: i, order: pairOrders(options.coldPairs, random(options.seed + 1))[i], before: systemLoad() };
    for (const mode of cold.order) {
      assert.equal(inventory(storage(label, mode)).size, 0, "Cold cache was not empty");
      cold[mode] = await timedArm(mode, label, [worktrees[0]], buildArgs, true);
    }
    cold.after = systemLoad(); assert.deepEqual(cold.direct.artifacts, cold.shim.artifacts); records.cold.push(cold);
    const hit = { index: i, order: [...cold.order].reverse(), before: systemLoad() };
    for (const mode of hit.order) hit[mode] = await timedArm(mode, label, [worktrees[0]], buildArgs, true);
    hit.after = systemLoad(); assert.deepEqual(hit.direct.artifacts, hit.shim.artifacts); records.cacheHit.push(hit);
    for (const mode of ["direct", "shim"]) await cacheProof(label, mode, worktrees[0], "identical-after-cold");
    notify(`cold/cache-hit: ${i + 1}/${options.coldPairs} pairs; cache reuse verified`);
  }
  if (options.buildPairs || options.concurrentPairs) {
    for (const cwd of worktrees) stamp(cwd, 0);
    for (const mode of pairOrders(1, rng)[0]) {
      warmup.push({ mode, ...(await timedArm(mode, "warm", [worktrees[0]], buildArgs, true)) });
      await cacheProof("warm", mode, worktrees[1], "cross-worktree-reuse");
    }
    await pairs("warmIncremental", options.buildPairs, "warm", [worktrees[0]], buildArgs, 1000);
    await pairs("concurrent", options.concurrentPairs, "warm", worktrees, buildArgs, 2000);
    for (const mode of ["direct", "shim"]) for (const cwd of worktrees) await cacheProof("warm", mode, cwd, "post-study-identical-rebuild");
  }
  for (const [file, digest] of Object.entries({ ...source.runtimeFiles, ...source.harnessFiles })) {
    assert.equal(hashFile(path.join(sourceRoot, file)), digest, "Benchmark source changed during measurement");
  }
  for (const fallback of [path.join(env.XDG_CACHE_HOME, "go-build"), path.join(env.HOME, ".cache", "go-build"), path.join(env.LOCALAPPDATA, "go-build")]) {
    assert.equal(fs.existsSync(fallback), false, "Unexpected fallback compiler cache");
  }
  for (const [cwd, hashes] of Object.entries(initialSourceHashes)) {
    for (const [file, digest] of Object.entries(hashes)) assert.equal(hashFile(path.join(cwd, file)), digest, "Source changed unexpectedly");
    const status = (await gitRun(["status", "--porcelain", "--untracked-files=all"], cwd)).stdout.trim();
    assert.ok(status === "M stamp.go" || status === "", `Unexpected worktree changes: ${status}`);
    assert.equal(fs.existsSync(path.join(cwd, "target")), false);
  }
  const fsInfo = fs.statfsSync(root);
  const summary = Object.fromEntries(Object.entries(records).map(([phase, pairs]) => [phase, summarize(pairs, options.seed + 7)]));
  for (const [phase, value] of Object.entries(summary)) {
    if (!["warmIncremental", "concurrent"].includes(phase)) {
      delete value.buildOverFiveSeconds; delete value.medianSlowdownAtMostTwoPercent;
    } else if (value.status === "measured" && !value.buildOverFiveSeconds) {
      value.medianSlowdownAtMostTwoPercent = "ineligible: one or more child builds at most five seconds";
    }
  }
  const report = { schemaVersion: 2, startedAt, finishedAt: new Date().toISOString(), options, source,
    machine: { platform: process.platform, arch: process.arch, release: os.release(), hostname: os.hostname(),
      cpuModel: os.cpus()[0]?.model, logicalCpus: os.cpus().length, availableParallelism: os.availableParallelism(),
      memoryBytes: os.totalmem(), cgroupCpuMax: readOptional("/sys/fs/cgroup/cpu.max"), cgroupMemoryMax: readOptional("/sys/fs/cgroup/memory.max"),
      filesystem: { type: `0x${fsInfo.type.toString(16)}`, blockSize: fsInfo.bsize, availableBytesAtEnd: fsInfo.bavail * fsInfo.bsize },
      loadBefore: initialLoad, loadAfter: systemLoad(), isolation: "single container; no CPU affinity, frequency lock or host-load control" },
    toolchain: { node: process.version, nodeExecutable: process.execPath, nodeExecutableSha256: hashFile(process.execPath),
      goExecutable: go, goExecutableSha256: hashFile(go), goVersion: version, gitVersion, ...toolchain },
    invocation: { argv: process.argv, sourceRoot, buildArgs, shortArgs: ["version"], environment: env, setupMs,
      shim: { executable: relative(launcher), sha256: hashFile(launcher), installedRuntime: relative(runtime.versionRoot) } },
    fixture: { root: relative(root), retained: options.keep, functions: options.functions, commit: fixtureCommit,
      sourceHashes: Object.fromEntries(Object.entries(initialSourceHashes).map(([cwd, hashes]) => [relative(cwd), hashes])), worktrees: identities, finalDeliverables: "$FIXTURE/worktree-{a,b}/dist/bench[.exe]",
      directCache: "$FIXTURE/<phase>/direct-cache/go/build", shimCache: "$FIXTURE/<phase>/managed/caches/go/build",
      unexpectedSourceChanges: false, projectLocalTargetPresent: false },
    methodology: { timing: "spawn through close; setup, source changes, output removal, hashes and inventories excluded",
      design: "seeded balanced AB/BA pairs; same cwd, argv and source per pair; separate direct/shim caches on same filesystem",
      quantiles: "nearest rank; paired added samples, never differences of independent percentiles",
      warmIncremental: "standard-library dependencies warm; stamp changes each pair to recompile real generated leaf package; no sleeps or -a",
      cold: "empty private Go cache; OS page cache NOT flushed; first arm can warm shared kernel/toolchain pages",
      cacheHit: "same source and args after cold; output removed in both arms to avoid executable-existence shortcut",
      concurrent: "two Git worktrees share one Go cache per mode; both builds overlap; no shared direct/shim cache",
      confidence: "5000 seeded paired bootstrap resamples of median percent; exploratory, no stationarity guarantee or multiplicity correction",
      downloads: { bytesDownloaded: null, policy: "No external modules; GOPROXY/GOSUMDB off, GOTOOLCHAIN local, GOTELEMETRY off", limitation: "No per-process network byte instrumentation" },
      limits: ["Not designated reference hardware; not a general speedup or release certification", "Go routing only; not Cargo ownership/lease overhead",
        "No cross-Node causal comparison: versions run at different times", "Long-build eligibility is per-child >5000 ms, not fabricated by batching short commands"] },
    summary, samples: records, warmup, cacheProofs: proofs };
  const json = JSON.stringify(report, (key, value) => typeof value === "string" ? relative(value) : value, 2) + "\n";
  if (outputFd !== null) fs.writeFileSync(outputFd, json); else process.stdout.write(json);
  completed = true; notify("complete: timing and artifact assertions passed");
  if (options.keep) notify(`retained fixture: ${root}`);
} catch (error) {
  console.error(`Benchmark failed; fixture retained at ${root}: ${error.stack || error.message}`);
  if (outputFd !== null) fs.writeFileSync(outputFd, JSON.stringify({ schemaVersion: 2, status: "failed", startedAt, source,
    fixture: root, error: error.message, samples: records }, null, 2) + "\n");
  process.exitCode = 1;
} finally {
  process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  if (outputFd !== null) fs.closeSync(outputFd);
  if (completed && !options.keep) {
    assert.equal(fs.realpathSync.native(root), root);
    assert.equal(fs.readFileSync(path.join(root, ".benchmark-owner"), "utf8"), owner);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
