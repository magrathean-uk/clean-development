import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertInside, assertOutput, assertOverlap, expected, readJson, sha256, until, write } from "./harness.mjs";

const moduleName = "example.invalid/cache-probe";
const dependency = "example.invalid/cache-dep";
const mod = (version) => `module ${moduleName}\n\ngo 1.22\n\nrequire ${dependency} v1.${version}.0\n`;
const main = (lane) => `package main\nimport ("fmt"; dep "${dependency}")\nfunc main() { fmt.Printf("%s|%s|%s|%s\\n", ${JSON.stringify(lane.name)}, ${JSON.stringify(lane.source)}, flag, dep.Value) }\n`;

export async function goLab(lab) {
  const go = await lab.version("go", ["version"]);
  await lab.version("git"); await lab.version("python3");
  const proxy = path.join(lab.root, "proxy");
  lab.env.GOPROXY = pathToFileURL(proxy).href;
  const versions = [];
  for (const version of [1, 2]) {
    const v = `v1.${version}.0`;
    const base = path.join(proxy, dependency, "@v", v);
    const depMod = `module ${dependency}\n\ngo 1.22\n`;
    write(`${base}.mod`, depMod);
    write(`${base}.info`, JSON.stringify({ Version: v, Time: "2024-01-01T00:00:00Z" }));
    await lab.zip(`${base}.zip`, { [`${dependency}@${v}/go.mod`]: depMod, [`${dependency}@${v}/dep.go`]: `package dep\nconst Value = "dep${version}"\n` });
    const prep = path.join(lab.root, `prepare-${version}`); write(path.join(prep, "go.mod"), mod(version));
    const info = JSON.parse((await lab.command(go, ["mod", "download", "-json", `${dependency}@${v}`], prep, { GOMODCACHE: path.join(lab.root, "prepare-modules") })).stdout);
    assert.ok(info.Sum && info.GoModSum, "real Go must authenticate the fixture module zip");
    versions.push(`${dependency} ${v} ${info.Sum}\n${dependency} ${v}/go.mod ${info.GoModSum}\n`);
  }
  write(path.join(proxy, dependency, "@v/list"), "v1.1.0\nv1.2.0\n");
  const lanes = await lab.checkouts(async (lane) => {
    write(path.join(lane.root, "go.mod"), mod(lane.version));
    write(path.join(lane.root, "go.sum"), versions.join(""));
    write(path.join(lane.root, "main.go"), main(lane));
    write(path.join(lane.root, "flag_off.go"), '//go:build !labflag\n\npackage main\nconst flag = "flag0"\n');
    write(path.join(lane.root, "flag_on.go"), '//go:build labflag\n\npackage main\nconst flag = "flag1"\n');
  });
  for (const lane of lanes.slice(2)) write(path.join(lane.root, "main.go"), main(lane));

  // The wrapper always runs the REAL compiler first. Its barrier is after a
  // non-empty package archive exists, before Go receives successful completion.
  const wrapper = path.join(lab.root, "control/compiler.cjs");
  write(wrapper, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');\nconst [tool,...args]=process.argv.slice(2);\nconst result=cp.spawnSync(tool,args,{stdio:'inherit'});\nif(result.error) throw result.error;\nif(result.status!==0) process.exit(result.status||1);\nif(process.env.CACHE_LAB_HOLD==='1' && process.env.TOOLEXEC_IMPORTPATH===${JSON.stringify(moduleName)} && path.basename(tool)==='compile' && !args.includes('-V=full')) {\n const output=args[args.indexOf('-o')+1]; const bytes=fs.statSync(output).size; if(!bytes) throw Error('compiler produced empty archive');\n fs.writeFileSync(process.env.CACHE_LAB_READY,JSON.stringify({tool,output,bytes}));\n const end=Date.now()+60000; while(!fs.existsSync(process.env.CACHE_LAB_RELEASE)) { if(Date.now()>end) process.exit(92); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); }\n}\n`);
  fs.chmodSync(wrapper, 0o755);
  const target = (lane, direct = false) => path.join(lab.root, "artifacts", direct ? "direct" : "routed", lane.name, "probe");
  const args = (lane, direct = false) => ["build", "-p=2", "-trimpath", "-buildvcs=false", "-mod=readonly", `-toolexec=${JSON.stringify(wrapper)}`,
    ...(lane.flag === "flag1" ? ["-tags=labflag", `-gcflags=${moduleName}=-N -l`] : []), "-o", target(lane, direct), "."];
  const directEnv = { GOCACHE: path.join(lab.root, "direct-cache/build"), GOMODCACHE: path.join(lab.root, "direct-cache/modules") };
  for (const lane of lanes) for (const direct of [true, false]) fs.mkdirSync(path.dirname(target(lane, direct)), { recursive: true });
  const verify = async (lane, direct = false) => {
    const file = target(lane, direct); assertInside(path.join(lab.root, "artifacts"), file);
    assertOutput((await lab.command(file, [])).stdout, expected(lane));
    const info = (await lab.command(go, ["version", "-m", file])).stdout;
    assert.ok(info.includes(`\tdep\t${dependency}\tv1.${lane.version}.0`), "binary contains wrong dependency version");
    if (lane.flag === "flag1") assert.ok(info.includes("-gcflags") && info.includes("-N -l"), "changed compiler flags missing from binary metadata");
    lab.record("Go binary content, dependency and compiler metadata", { lane: lane.name, direct, expected: expected(lane), sha256: sha256(fs.readFileSync(file)), bytes: fs.statSync(file).size });
  };
  const build = async (lane, direct = false) => {
    const result = direct ? await lab.command(go, args(lane, true), lane.root, directEnv) : await lab.routed("go", args(lane), lane.root);
    await verify(lane, direct); return result;
  };
  let before = lab.snapshot();
  assert.equal(fs.existsSync(path.join(lab.root, "managed/caches/go")), false);
  const cold = await Promise.all(lanes.map((lane) => build(lane)));
  assertOverlap(cold); lab.unchanged(before); lab.report.scenarios.push("four concurrent cold builds / one shared build and module cache");
  for (const lane of lanes) {
    const env = JSON.parse((await lab.routed("go", ["env", "-json", "GOCACHE", "GOMODCACHE"], lane.root)).stdout);
    assert.equal(env.GOCACHE, path.join(lab.root, "managed/caches/go/build"));
    assert.equal(env.GOMODCACHE, path.join(lab.root, "managed/caches/go/modules"));
    await build(lane, true);
  }
  lab.unchanged(before); lab.record("all four Go invocations observe the selected shared caches");
  await Promise.all(lanes.map((lane) => build(lane))); lab.unchanged(before); lab.report.scenarios.push("warm rebuilds and independent-cache direct controls");
  const otherHashes = lanes.slice(1).map((lane) => sha256(fs.readFileSync(target(lane))));
  const a = lanes[0];
  const verifyOthers = async () => {
    for (const [i, lane] of lanes.slice(1).entries()) { await verify(lane); assert.equal(sha256(fs.readFileSync(target(lane))), otherHashes[i]); }
  };
  for (const change of ["source", "compiler-flags", "dependency-version", "return-to-original-flags"]) {
    if (change === "source") { a.source = "source02"; write(path.join(a.root, "main.go"), main(a)); }
    if (change === "compiler-flags") a.flag = "flag1";
    if (change === "dependency-version") { a.version = 2; write(path.join(a.root, "go.mod"), mod(2)); }
    if (change === "return-to-original-flags") a.flag = "flag0";
    before = lab.snapshot(); await build(a); await build(a, true); lab.unchanged(before); await verifyOthers(); lab.report.scenarios.push(change);
  }
  a.source = "source03"; write(path.join(a.root, "main.go"), main(a));
  const ready = path.join(lab.root, "control/compiled.json"), release = path.join(lab.root, "control/release");
  before = lab.snapshot(); const oldBinary = sha256(fs.readFileSync(target(a)));
  const interrupted = lab.routedStart("go", args(a), a.root, { CACHE_LAB_HOLD: "1", CACHE_LAB_READY: ready, CACHE_LAB_RELEASE: release });
  await until(() => fs.existsSync(ready), "real Go compiler to finish its partial archive");
  const partial = readJson(ready); assertInside(path.join(lab.root, "tmp"), partial.output); assert.ok(partial.bytes > 0);
  interrupted.kill("SIGKILL"); const failed = await interrupted.done;
  assert.equal(failed.failure, null); assert.notEqual(failed.code, 0);
  assert.equal(sha256(fs.readFileSync(target(a))), oldBinary, "interruption replaced the last complete deliverable");
  lab.unchanged(before); write(release, "resume\n");
  await build(a); await build(a, true); await verifyOthers(); lab.unchanged(before);
  lab.record("real compiler interruption and corrected restart", { partialBytes: partial.bytes, signal: failed.signal, partialLocation: partial.output, expectedAfterRestart: expected(a) });
  lab.report.scenarios.push("SIGKILL after real compilation; warm-cache restart verifies new content");

  const jobs = lanes.map((lane) => ({ tool: "go", args: args(lane), cwd: lane.root, binary: target(lane), expected: expected(lane) }));
  const jobFile = path.join(lab.root, "control/jobs.json"), driver = path.join(lab.root, "control/cwd.cjs");
  write(jobFile, JSON.stringify(jobs));
  write(driver, "const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');for(const j of JSON.parse(fs.readFileSync(process.argv[2]))) {process.chdir(j.cwd);cp.execFileSync(j.tool,j.args,{stdio:'pipe'});assert.equal(cp.execFileSync(j.binary,[],{encoding:'utf8'}),j.expected);}console.log('four correct cwd switches');\n");
  assertOutput((await lab.routed(process.execPath, [driver, jobFile], a.root)).stdout, "four correct cwd switches\n");
  lab.unchanged(before); lab.report.scenarios.push("one routed parent session changes cwd across all four checkouts");
  for (const version of [1, 2]) {
    const file = path.join(lab.root, `managed/caches/go/modules/${dependency}@v1.${version}.0/dep.go`);
    assertInside(path.join(lab.root, "managed/caches"), file);
    assert.equal(fs.readFileSync(file, "utf8"), `package dep\nconst Value = "dep${version}"\n`);
  }
  lab.record("both immutable dependency versions have correct module-cache content");
}
