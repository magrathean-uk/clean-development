import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertInside, assertOutput, assertOverlap, expected, inventory, sha256, write } from "./harness.mjs";

const input = (lane) => JSON.stringify({ name: lane.name, source: lane.source });
const pythonSource = 'import json,sys,lab_dep\nx=json.load(open(sys.argv[1],encoding="utf8"))\nprint(x["name"]+"|"+x["source"]+"|"+sys.argv[2]+"|"+lab_dep.VALUE)\n';

// These lanes execute code from REAL installed/cached packages. They do not
// pretend that npm or pure-Python wheel installation is compiler execution.
async function packageMatrix(lab, definition) {
  const lanes = await lab.checkouts(async (lane) => {
    write(path.join(lane.root, "input.json"), input(lane));
    write(path.join(lane.root, definition.manifest), definition.manifestText);
    if (lab.tool === "uv") write(path.join(lane.root, "probe.py"), pythonSource);
  });
  for (const lane of lanes.slice(2)) write(path.join(lane.root, "input.json"), input(lane));
  const run = async (lane, direct = false) => {
    const args = definition.args(lane);
    const result = direct ? await lab.command(definition.tool, args, lane.root, definition.directEnv) : await lab.routed(lab.tool, args, lane.root);
    assertOutput(result.stdout, expected(lane));
    lab.record("real package program content", { lane: lane.name, direct, expected: expected(lane), outputSha256: sha256(result.stdout) });
    return result;
  };
  let before = lab.snapshot();
  assert.equal(fs.existsSync(definition.cache), false);
  const cold = await Promise.all(lanes.map((lane) => run(lane))); assertOverlap(cold); lab.unchanged(before);
  lab.report.scenarios.push("four concurrent cold dependency installs/executions in one shared cache");
  for (const lane of lanes) await run(lane, true);
  await Promise.all(lanes.map((lane) => run(lane))); lab.unchanged(before);
  lab.report.scenarios.push("warm executions and separate-cache direct controls");
  const a = lanes[0];
  for (const change of ["source", "runtime-argument", "dependency-version", "return-to-original-argument"]) {
    if (change === "source") { a.source = "source02"; write(path.join(a.root, "input.json"), input(a)); }
    if (change === "runtime-argument") a.flag = "flag1";
    if (change === "dependency-version") a.version = 2;
    if (change === "return-to-original-argument") a.flag = "flag0";
    before = lab.snapshot(); await run(a); await run(a, true);
    for (const lane of lanes.slice(1)) await run(lane);
    lab.unchanged(before); lab.report.scenarios.push(change);
  }
  await definition.verifyCache(); lab.unchanged(before);
  assert.equal(fs.existsSync(path.join(lab.root, "data/state/workspaces")), false, "cache-only tools must not claim workspace builds");
  lab.record("cache-only routing created no owned workspace build records");
  // A single routed session must continue using its shims as cwd changes.
  const driver = path.join(lab.root, "control/package-cwd.cjs"), jobs = path.join(lab.root, "control/package-jobs.json");
  write(jobs, JSON.stringify(lanes.map((lane) => ({ tool: lab.tool, cwd: lane.root, args: definition.args(lane), expected: expected(lane) }))));
  write(driver, "const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');for(const j of JSON.parse(fs.readFileSync(process.argv[2]))) {process.chdir(j.cwd);assert.equal(cp.execFileSync(j.tool,j.args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}),j.expected);}console.log('four correct package cwd switches');\n");
  assertOutput((await lab.routed(process.execPath, [driver, jobs], a.root)).stdout, "four correct package cwd switches\n");
  lab.unchanged(before); lab.report.scenarios.push("one session changes cwd through all four checkouts");
}

export async function npmLab(lab) {
  const npm = await lab.version("npm"); await lab.version("git");
  const archives = {};
  for (const version of [1, 2]) {
    const root = path.join(lab.root, `package-${version}`);
    write(path.join(root, "package.json"), JSON.stringify({ name: "cache-lab-dep", version: `1.${version}.0`, bin: { "cache-lab-probe": "probe.cjs" }, files: ["probe.cjs"] }));
    write(path.join(root, "probe.cjs"), `#!/usr/bin/env node\nconst fs=require('node:fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));console.log(x.name+'|'+x.source+'|'+process.argv[3]+'|dep${version}');\n`);
    fs.chmodSync(path.join(root, "probe.cjs"), 0o755);
    fs.mkdirSync(path.join(lab.root, "archives"), { recursive: true });
    const packed = JSON.parse((await lab.command(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", path.join(lab.root, "archives")], root, { npm_config_cache: path.join(lab.root, "preparation-cache") })).stdout);
    assert.equal(packed.length, 1); archives[version] = path.join(lab.root, "archives", packed[0].filename);
  }
  const cache = path.join(lab.root, "managed/caches/node/npm");
  await packageMatrix(lab, {
    tool: npm, manifest: "package.json", manifestText: '{"name":"cache-lab-consumer","version":"1.0.0","private":true}\n', cache,
    directEnv: { npm_config_cache: path.join(lab.root, "direct-cache") },
    args: (lane) => ["exec", "--offline", "--yes", `--package=${archives[lane.version]}`, "--", "cache-lab-probe", path.join(lane.root, "input.json"), lane.flag],
    verifyCache: async () => {
      const found = (await lab.routed("npm", ["config", "get", "cache"], lab.lanes[0].root)).stdout.trim(); assert.equal(found, cache);
      for (const version of [1, 2]) {
        const bytes = fs.readFileSync(archives[version]); const hash = crypto.createHash("sha512").update(bytes).digest("hex");
        const content = path.join(cache, "_cacache/content-v2/sha512", hash.slice(0, 2), hash.slice(2, 4), hash.slice(4));
        assertInside(cache, content); assert.deepEqual(fs.readFileSync(content), bytes, "npm cached a different tarball");
        lab.record("npm content-addressed cache matches exact packed bytes", { version: `1.${version}.0`, sha512: hash, bytes: bytes.length });
      }
    }
  });
}

export async function uvLab(lab) {
  const uv = await lab.version("uv"); await lab.version("git"); const python = await lab.version("python3");
  const wheels = {};
  for (const version of [1, 2]) {
    const v = `1.${version}.0`, dist = `lab_dep-${v}.dist-info`;
    const entries = {
      "lab_dep/__init__.py": `VALUE = "dep${version}"\n`,
      [`${dist}/METADATA`]: `Metadata-Version: 2.1\nName: lab-dep\nVersion: ${v}\n`,
      [`${dist}/WHEEL`]: "Wheel-Version: 1.0\nGenerator: clean-development-cache-lab\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
    };
    entries[`${dist}/RECORD`] = Object.entries(entries).map(([name, value]) => `${name},sha256=${crypto.createHash("sha256").update(value).digest("base64url")},${Buffer.byteLength(value)}\n`).join("") + `${dist}/RECORD,,\n`;
    wheels[version] = path.join(lab.root, `lab_dep-${v}-py3-none-any.whl`); await lab.zip(wheels[version], entries);
  }
  const cache = path.join(lab.root, "managed/caches/python/uv");
  await packageMatrix(lab, {
    tool: uv, manifest: "pyproject.toml", manifestText: '[project]\nname = "cache-lab-consumer"\nversion = "1.0.0"\n', cache,
    directEnv: { UV_CACHE_DIR: path.join(lab.root, "direct-cache") },
    args: (lane) => ["run", "--no-project", "--no-config", "--offline", "--no-index", "--no-python-downloads", "--no-managed-python", "--python", python,
      "--with", wheels[lane.version], "--", "python", "-I", "-B", path.join(lane.root, "probe.py"), path.join(lane.root, "input.json"), lane.flag],
    verifyCache: async () => {
      const found = (await lab.routed("uv", ["cache", "dir"], lab.lanes[0].root)).stdout.trim(); assert.equal(found, cache);
      const tree = inventory(cache);
      for (const version of [1, 2]) {
        const wanted = sha256(`VALUE = "dep${version}"\n`);
        const names = Object.keys(tree).filter((name) => name.endsWith("/lab_dep/__init__.py") && tree[name].sha256 === wanted);
        assert.ok(names.length, `uv cache is missing dependency ${version} bytes`);
        lab.record("uv cached immutable wheel code has expected bytes", { version: `1.${version}.0`, files: names, sha256: wanted });
      }
    }
  });
}
