import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCENARIOS, isolatedEnvironment, verifyLabRoot } from "./case.mjs";

const WORKER = new URL("./case.mjs", import.meta.url).href;
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const MARKER = ".fault-lab-owner.json";
const MAX_REPORT = 256 * 1024;

function sourceDigest() {
  const hash = crypto.createHash("sha256");
  for (const directory of ["src", "bin"]) {
    for (const file of fs.readdirSync(path.join(REPO, directory)).sort()) {
      const target = path.join(REPO, directory, file);
      const stat = fs.lstatSync(target);
      assert.ok(stat.isFile(), `unexpected source entry ${target}`);
      hash.update(`${directory}/${file}\0${stat.mode & 0o777}\0`).update(fs.readFileSync(target));
    }
  }
  return hash.digest("hex");
}

export function sanitise(value, root) {
  const ids = new Map();
  function visit(item) {
    if (typeof item === "string") return item.replaceAll(root, "<lab>")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, (id) => {
        if (!ids.has(id)) ids.set(id, `<uuid-${ids.size + 1}>`);
        return ids.get(id);
      });
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    return item;
  }
  return visit(value);
}

export function runLab() {
  if (process.platform === "win32") throw new Error("The executable fixture is POSIX-only; native Windows evidence is not implemented.");
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-fault-lab-")));
  const stat = fs.lstatSync(root, { bigint: true });
  const identity = { dev: String(stat.dev), ino: String(stat.ino) };
  const marker = { owner: "clean-development-fault-lab", root, token: crypto.randomUUID() };
  fs.writeFileSync(path.join(root, MARKER), JSON.stringify(marker), { flag: "wx", mode: 0o600 });
  fs.mkdirSync(path.join(root, "tmp"));
  const sourceBefore = sourceDigest();
  const cases = [];
  const infrastructureErrors = [];
  // A hard worker timeout/output bound makes a missed hook or stuck lock visible.
  // Workers/tools never fork background processes. Incomplete trees are retained.
  for (const scenario of SCENARIOS) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval",
      "const {runCase}=await import(process.argv[1]); console.log(JSON.stringify(await runCase(process.argv[2],process.argv[3])));",
      WORKER, root, scenario], {
      cwd: root, env: isolatedEnvironment(root), encoding: "utf8",
      timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024
    });
    if (result.error || result.signal || result.status !== 0) {
      infrastructureErrors.push({ scenario, code: result.error?.code ?? null, signal: result.signal,
        status: result.status, stderr: (result.stderr || "").slice(0, 4096) });
      continue;
    }
    try { cases.push(JSON.parse(result.stdout)); }
    catch (error) { infrastructureErrors.push({ scenario, message: `Invalid worker evidence: ${error.message}` }); }
  }
  const sourceAfter = sourceDigest();
  if (sourceBefore !== sourceAfter) infrastructureErrors.push({ message: "Checked-out product source changed during the lab" });
  const violations = cases.flatMap((item) => item.checks.filter((check) => !check.passed).map((check) => `${item.scenario}/${check.id}`));
  const report = sanitise({ schemaVersion: 1, platform: process.platform, arch: process.arch, node: process.version,
    packageVersion: JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version,
    productSource: { before: sourceBefore, after: sourceAfter },
    scenarios: cases.length, checks: cases.reduce((sum, item) => sum + item.checks.length, 0),
    violations, infrastructureErrors, cases }, root);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  assert.ok(Buffer.byteLength(text) <= MAX_REPORT, `Report bound exceeded; retain evidence at ${root}`);
  fs.writeFileSync(path.join(root, "report.json"), text, { flag: "wx", mode: 0o600 });
  return { root, token: marker.token, identity, report };
}

// Test teardown only: refuse to delete a substituted tree or an incomplete run.
// Explicit CLI runs always retain evidence, including successful controls.
export function removeCompletedLab(result) {
  assert.equal(result.report.infrastructureErrors.length, 0, "retain incomplete lab");
  const marker = verifyLabRoot(result.root);
  assert.equal(marker.token, result.token, "lab root ownership changed");
  const stat = fs.lstatSync(result.root, { bigint: true });
  assert.deepEqual({ dev: String(stat.dev), ino: String(stat.ino) }, result.identity, "lab directory identity changed");
  fs.rmSync(result.root, { recursive: true, force: false });
}

// --run is deliberate: `node --test` discovers .mjs files below test/, so merely
// importing or discovering the lab must not execute it or create directories.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--run")) {
  try {
    assert.deepEqual(process.argv.slice(2), ["--run"], "Only --run is supported; the lab always allocates a fresh temporary root");
    const result = runLab();
    console.log(JSON.stringify({ report: path.join(result.root, "report.json"), scenarios: result.report.scenarios,
      checks: result.report.checks, violations: result.report.violations, infrastructureErrors: result.report.infrastructureErrors }, null, 2));
    process.exitCode = result.report.infrastructureErrors.length ? 2 : result.report.violations.length ? 1 : 0;
  } catch (error) {
    console.error(`fault-lab: ${error.message}`);
    process.exitCode = 2;
  }
}
