// Predefined offline child observer. Never record full env or arbitrary commands.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto"), { spawnSync } = require("node:child_process"), { pathToFileURL } = require("node:url");
function inside(root, file) {
  const relative = path.relative(root, path.resolve(file)); assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  let current = path.resolve(file);
  while (current !== root) {
    try { assert.equal(fs.lstatSync(current).isSymbolicLink(), false); } catch (error) { if (error.code !== "ENOENT") throw error; }
    current = path.dirname(current);
  }
}
async function main() {
  const [mode, name] = process.argv.slice(2); if (!mode) return;
  const root = fs.realpathSync(process.env.CD_CODEX_LAB), item = JSON.parse(fs.readFileSync(path.join(root, "lab.json"), "utf8"));
  assert.equal(item.root, root); inside(root, process.cwd());
  assert.equal(item.env.HOME, path.join(root, "native-home")); inside(root, item.env.HOME);
  const caseName = mode === "npm" ? process.env.CD_CODEX_CASE : name;
  assert.match(caseName || "", /^[a-z][a-z0-9-]*$/);
  const save = (layer, record) => fs.writeFileSync(path.join(item.evidence, `${caseName}-${layer}.json`), JSON.stringify(record), { flag: "wx", mode: 0o600 });
  if (mode === "npm") {
    assert.equal(item.backend, "fixture");
    assert.deepEqual(process.argv.slice(3), ["fixture-write", "space argument", "a&b", "unicode-é"]);
    const cache = process.env.npm_config_cache || path.join(process.cwd(), ".native-cache"), artifact = path.join(cache, "artifact", `${caseName}.txt`);
    inside(root, artifact); fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, process.env.CD_CODEX_NONCE);
    process.stdout.write(JSON.stringify({ cache, artifact, argv: process.argv.slice(3), mode: process.env.CLEAN_DEVELOPMENT_SESSION_MODE || null }));
    process.exitCode = Number(process.env.CD_CODEX_FIXTURE_STATUS || 0); return;
  }
  assert.equal(mode, "observe");
  const footprintModule = pathToFileURL(path.join(__dirname, "../../scripts/footprint-utils.mjs")).href;
  const { snapshotFootprint, compareFootprints } = await import(footprintModule);
  const nonce = randomUUID(), roots = [
    { name: "npm-home-cache", path: path.join(item.env.HOME, ".npm") }, { name: "native-home-cache", path: path.join(item.env.HOME, ".cache") },
    { name: "native-library-cache", path: path.join(item.env.HOME, "Library", "Caches") },
    { name: "managed", path: item.managed }, { name: "outputs", path: item.outputs }
  ];
  const metadataSnapshot = () => {
    // The scanner's whole-real-home guard stays intact. A separate metadata-only
    // process has its own unused disposable HOME and observes this explicitly
    // validated lab HOME; it receives no host credentials or startup hooks.
    const worker = spawnSync(process.execPath, ["--input-type=module", "-e",
      "const {snapshotFootprint}=await import(process.argv[1]);process.stdout.write(JSON.stringify(snapshotFootprint(JSON.parse(process.argv[2]))));",
      footprintModule, JSON.stringify([{ name: "disposable-home", path: item.env.HOME }, ...roots])], {
      cwd: root, env: { HOME: path.join(root, "footprint-observer-home"), USERPROFILE: path.join(root, "footprint-observer-home"),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024
    });
    assert.equal(worker.error, undefined); assert.equal(worker.status, 0); return JSON.parse(worker.stdout);
  };
  const before = metadataSnapshot();
  save("shell", { backend: item.backend, cwd: process.cwd(), nonce, loginShell: process.env.CD_CODEX_ACTUAL_LOGIN || "unknown",
    mode: process.env.CLEAN_DEVELOPMENT_SESSION_MODE || null });
  const env = { ...process.env, CD_CODEX_CASE: caseName, CD_CODEX_NONCE: nonce }, invoke = (args) => spawnSync("npm", args, { cwd: process.cwd(), env, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
  let result, artifact, cache, argv, actualMode;
  if (item.backend === "fixture") {
    argv = ["fixture-write", "space argument", "a&b", "unicode-é"]; result = invoke(argv);
    if (!result.error && result.stdout) { const observation = JSON.parse(result.stdout); ({ artifact, cache } = observation); actualMode = observation.mode; }
  } else {
    const selected = invoke(["config", "get", "cache"]);
    if (selected.error || selected.status !== 0) result = selected;
    else {
      cache = selected.stdout.trim(); inside(root, cache);
      const packed = invoke(["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", item.outputs]);
      if (packed.error || packed.status !== 0) result = packed;
      else {
        const { normalizeNpmPackReport } = await import(pathToFileURL(path.join(__dirname, "../../scripts/npm-pack-report.mjs")));
        const filename = normalizeNpmPackReport(JSON.parse(packed.stdout), "codex-acceptance-fixture").filename; assert.match(filename, /^[a-z0-9.-]+\.tgz$/);
        artifact = path.join(item.outputs, filename); inside(root, artifact);
        argv = ["cache", "add", artifact, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"]; result = invoke(argv);
      }
    }
    actualMode = process.env.CLEAN_DEVELOPMENT_SESSION_MODE || null;
  }
  const after = metadataSnapshot(), comparison = compareFootprints(before, after);
  const cacheObservation = cache ? snapshotFootprint([{ name: "actual-cache", path: cache }]) : null;
  save("tool", { backend: item.backend, cwd: process.cwd(), nonce, artifact: artifact || null, cache: cache || null,
    protocol: item.backend === "fixture" ? "synthetic-npm-artifact" : "real-offline-npm-cache",
    status: result.status, signal: result.signal, errorCode: result.error?.code || null, argv, mode: actualMode,
    footprintComplete: comparison.complete && Boolean(cacheObservation?.complete), homeCacheUnchanged: comparison.deltas.filter((delta) => delta.name.includes("cache")).every((delta) => !delta.changed),
    homeUnchanged: !comparison.deltas.find((delta) => delta.name === "disposable-home").changed,
    cacheFiles: cacheObservation?.roots[0].files || 0 });
  process.exitCode = result.status ?? 1;
}
if (require.main === module) main().catch(() => { console.error("Predefined Codex child observation failed"); process.exitCode = 1; });
