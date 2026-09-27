import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { windowsBatchInvocation } from "../../src/windows-command.js";

export const HELP = `Usage: node scripts/benchmark-overhead.mjs [options]
  --short-pairs N       Paired real go version commands (default 100)
  --build-pairs N       Warm-cache incremental build pairs (default 8)
  --cold-pairs N        Independent empty-cache / identical-rebuild pairs (default 2)
  --concurrent-pairs N  Two simultaneous Git worktrees per arm (default 8)
  --functions N         Generated Go functions, no sleeps (default 12000)
  --seed N             Reproducible randomisation (default 20260927)
  --output FILE        Exclusive-create JSON report; default stdout
  --keep               Retain the disposable fixture on success
  --help
Run separately under each installed Node version; runtime setup pins that exact
process.execPath. Node >=20.12, Git and Go >=1.23 are required. No downloads.
Zero disables a phase, not evidence of a pass. Failures retain the fixture.
BENCHMARK_ITERATIONS remains an alias for the default short-pair count.`;

export function parseOptions(args, env = process.env) {
  const result = { shortPairs: Number(env.BENCHMARK_ITERATIONS || 100), buildPairs: 8,
    coldPairs: 2, concurrentPairs: 8, functions: 12000, seed: 20260927, keep: false, output: null };
  const names = { "--short-pairs": "shortPairs", "--build-pairs": "buildPairs", "--cold-pairs": "coldPairs",
    "--concurrent-pairs": "concurrentPairs", "--functions": "functions", "--seed": "seed" };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i];
    if (seen.has(name)) throw new Error(`Repeated option: ${name}`);
    seen.add(name);
    if (name === "--help") return { help: true };
    if (name === "--keep") { result.keep = true; continue; }
    if (name === "--output") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--output needs a filename");
      result.output = path.resolve(args[++i]); continue;
    }
    if (!Object.hasOwn(names, name) || !/^\d+$/.test(args[i + 1] || "")) throw new Error(HELP);
    result[names[name]] = Number(args[++i]);
  }
  for (const key of ["shortPairs", "buildPairs", "coldPairs", "concurrentPairs", "functions", "seed"]) {
    const min = key === "functions" ? 1 : 0;
    const max = key === "seed" ? 0xffffffff : key === "functions" ? 40000 : key === "shortPairs" ? 10000 : 100;
    if (!Number.isSafeInteger(result[key]) || result[key] < min || result[key] > max) throw new Error(`Invalid ${key}`);
  }
  if (!["shortPairs", "buildPairs", "coldPairs", "concurrentPairs"].some((key) => result[key])) throw new Error("Enable at least one phase");
  return result;
}

export function random(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}

export function pairOrders(count, rng) {
  const orders = Array.from({ length: count }, (_, i) => i % 2 === 0 ? ["direct", "shim"] : ["shim", "direct"]);
  for (let i = orders.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1)); [orders[i], orders[j]] = [orders[j], orders[i]];
  }
  return orders;
}

// Nearest-rank quantiles, including the lower median when n is even.
export function quantile(values, p) {
  if (!values.length || values.some((v) => !Number.isFinite(v)) || !(p > 0 && p <= 1)) throw new Error("Invalid quantile input");
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
}
const distribution = (values) => ({ n: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95),
  min: Math.min(...values), max: Math.max(...values) });

export function summarize(pairs, seed) {
  if (!pairs.length) return { status: "not-measured", n: 0 };
  const d = pairs.map((p) => p.direct.ms), s = pairs.map((p) => p.shim.ms);
  if ([...d, ...s].some((v) => !Number.isFinite(v) || v <= 0)) throw new Error("Invalid paired timings");
  const added = s.map((v, i) => v - d[i]), relative = s.map((v, i) => 100 * (v / d[i] - 1));
  const rng = random(seed), ci = [];
  if (pairs.length >= 6) for (let i = 0; i < 5000; i += 1) {
    ci.push(quantile(Array.from({ length: pairs.length }, () => relative[Math.floor(rng() * relative.length)]), 0.5));
  }
  const interval = ci.length ? [quantile(ci, 0.025), quantile(ci, 0.975)] : null;
  const median = quantile(added, 0.5), mad = quantile(added.map((v) => Math.abs(v - median)), 0.5);
  return { status: "measured", n: pairs.length, directMs: distribution(d), shimMs: distribution(s),
    pairedAddedMs: distribution(added), pairedPercent: distribution(relative), pairedAddedMadMs: mad,
    medianPercentBootstrap95: interval, bootstrapResamples: ci.length,
    varianceDominatesTypicalDifference: 1.4826 * mad > Math.abs(median),
    signResolved: interval !== null && (interval[0] > 0 || interval[1] < 0),
    orderStrata: Object.fromEntries(["direct", "shim"].map((first) => {
      const values = pairs.filter((p) => p.order[0] === first).map((p) => p.shim.ms - p.direct.ms);
      return [first, values.length ? distribution(values) : null];
    })),
    p95Precision: pairs.length < 100 ? "exploratory: fewer than 100 pairs" : "empirical; only approximately 5 observations in upper 5%",
    buildOverFiveSeconds: pairs.every((p) => [...(p.direct.children || [p.direct]), ...(p.shim.children || [p.shim])].every((c) => c.ms > 5000)),
    medianSlowdownAtMostTwoPercent: interval === null ? "unresolved: fewer than six pairs"
      : interval[1] <= 2 ? "within on this run only" : interval[0] > 2 ? "exceeds on this run" : "unresolved: interval crosses 2%" };
}

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const hashFile = (file) => sha256(fs.readFileSync(file));
export function readOptional(file) { try { return fs.readFileSync(file, "utf8").trim(); } catch { return null; } }
export function systemLoad() {
  const stat = readOptional("/sys/fs/cgroup/cpu.stat");
  const cpu = stat ? Object.fromEntries(stat.split("\n").map((line) => { const [k, v] = line.split(" "); return [k, Number(v)]; })) : null;
  return { at: new Date().toISOString(), loadavg: process.platform === "win32" ? null : os.loadavg(),
    freeMemoryBytes: os.freemem(), cgroupCpu: cpu,
    cgroupMemoryBytes: Number(readOptional("/sys/fs/cgroup/memory.current")) || null };
}

export function inventory(root) {
  const files = new Map();
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Unexpected link in benchmark storage");
      if (entry.isDirectory()) visit(file);
      else {
        assert.ok(entry.isFile(), "Unexpected non-file in benchmark storage");
        if (files.size >= 50000) throw new Error("Benchmark inventory limit exceeded");
        const stat = fs.statSync(file);
        files.set(path.relative(root, file), { size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  if (fs.existsSync(root)) visit(root);
  return files;
}
export function storageDelta(before, after) {
  const bytes = (entries) => [...entries.values()].reduce((sum, f) => sum + f.size, 0);
  return { files: after.size, logicalBytes: bytes(after), growthBytes: bytes(after) - bytes(before),
    addedFiles: [...after.keys()].filter((f) => !before.has(f)).length,
    unchangedFiles: [...after].filter(([f, v]) => before.get(f)?.size === v.size && before.get(f)?.mtimeMs === v.mtimeMs).length,
    allocation: "logical file sizes, not allocated blocks or deduplicated physical bytes" };
}

export function fixtureSources(count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 40000) throw new Error("Invalid function count");
  const source = ['package main\nimport "fmt"\n'];
  for (let i = 0; i < count; i += 1) {
    source.push(`//go:noinline\nfunc f${i}(v uint64) uint64 {\n`);
    for (let j = 0; j < 16; j += 1) source.push(`v = (v ^ ${i + j + 1}) * 6364136223846793005 + (v >> ${j % 13 + 1}) + stamp\n`);
    source.push("return v\n}\n");
  }
  source.push(`var functions = []func(uint64) uint64 {${Array.from({ length: count }, (_, i) => `f${i}`).join(",")}}\n`);
  source.push("func main() { var v uint64 = 42; for _, f := range functions { v = f(v) }; fmt.Println(v) }\n");
  return { "go.mod": "module example.invalid/paired-overhead\n\ngo 1.22\n", "main.go": source.join(""),
    "stamp.go": "package main\nconst stamp uint64 = 0\n", ".gitignore": "dist/\n",
    ".clean-development.json": '{"schemaVersion":1}\n' };
}

export function isolatedEnvironment(root, go, git, inherited = process.env) {
  // Deliberate allowlist: no tokens, tool wrappers, ambient routing, Git settings,
  // npm configuration or NODE_OPTIONS enter compiler/runtime children.
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"].includes(key.toUpperCase())));
  const home = path.join(root, "tool-home"), temp = path.join(root, "tmp");
  const dirs = [home, temp, path.join(root, "empty-hooks"), path.join(root, "empty-templates")];
  for (const directory of dirs) fs.mkdirSync(directory, { recursive: true });
  const system = process.platform === "win32" ? [path.join(inherited.SystemRoot || inherited.SYSTEMROOT || "C:\\Windows", "System32")] : ["/usr/bin", "/bin"];
  return { ...env, PATH: [path.dirname(go), path.dirname(git), path.dirname(process.execPath), ...system].join(path.delimiter),
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "localappdata"),
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"), XDG_DATA_HOME: path.join(home, "data"),
    TMPDIR: temp, TMP: temp, TEMP: temp, GOTMPDIR: temp,
    GOENV: "off", GOWORK: "off", GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off", GOTELEMETRY: "off",
    CGO_ENABLED: "0", GOMAXPROCS: "2", GOFLAGS: "", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, "absent-gitconfig"), GIT_TEMPLATE_DIR: path.join(root, "empty-templates"),
    CLEAN_DEVELOPMENT_HOME: path.join(root, "cd-home"), CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"), CLEAN_DEVELOPMENT_SESSION_MODE: "session-only" };
}

// Fixture-only process groups. Runtime process/cleanup code is not modified.
export function commandRunner() {
  const active = new Set();
  let interrupted = false;
  const kill = (child) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  return {
    interrupt() { interrupted = true; for (const child of active) kill(child); },
    async run(command, args, { cwd, env, timeoutMs = 180000 } = {}) {
      if (interrupted) throw new Error("Benchmark interrupted; fixture retained");
      const invocation = process.platform === "win32" && /\.(cmd|bat)$/i.test(command)
        ? windowsBatchInvocation(command, args, env) : { command, args };
      const start = performance.now();
      return new Promise((resolve, reject) => {
        let child;
        try { child = spawn(invocation.command, invocation.args, { cwd, env, stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32", windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments || false }); }
        catch (error) { reject(error); return; }
        active.add(child);
        let stdout = "", stderr = "", bytes = 0, failure = null;
        const fail = (error) => { failure ||= error; try { kill(child); } catch (e) { failure = e; } };
        const timer = setTimeout(() => fail(new Error(`Benchmark child exceeded ${timeoutMs} ms`)), timeoutMs);
        for (const [stream, output] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) {
          stream.setEncoding("utf8"); stream.on("data", (data) => {
            bytes += Buffer.byteLength(data);
            if (bytes > 8 * 1024 * 1024) { fail(new Error("Benchmark child exceeded output limit")); return; }
            if (output === "stdout") stdout += data; else stderr += data;
          });
        }
        child.on("error", (error) => { failure ||= error; });
        child.on("close", (code, signal) => {
          const end = performance.now(); clearTimeout(timer); active.delete(child);
          if (failure || code !== 0 || interrupted) {
            try { kill(child); } catch { /* Never delete a failed fixture. */ }
            reject(failure || new Error(`${path.basename(command)} exited ${code} (${signal || "no signal"}): ${stderr.slice(-2000)}`));
          } else resolve({ ms: end - start, start, end, stdout, stderr, exitCode: code });
        });
      });
    }
  };
}
