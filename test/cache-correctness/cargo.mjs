import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertInside, assertOutput, assertOverlap, executable, expected, readJson, sha256, until, write } from "./harness.mjs";

const manifest = (v) => `[package]\nname = "cache-probe"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nlab-dep = { path = "../dep-v${v}", version = "=${v}.0.0" }\n`;
const main = (lane) => `fn main() { println!("{}|{}|{}|{}", ${JSON.stringify(lane.name)}, ${JSON.stringify(lane.source)}, if cfg!(lab_flag) { "flag1" } else { "flag0" }, lab_dep::VALUE); }\n`;
const buildScript = `use std::{env,fs,path::Path,thread,time::{Duration,Instant}};\nfn main() {\n println!("cargo:rerun-if-changed=build.rs");\n if let (Ok(ready),Ok(release))=(env::var("CACHE_LAB_READY"),env::var("CACHE_LAB_RELEASE")) {\n  let partial=Path::new(&env::var("OUT_DIR").unwrap()).join("partial.txt");\n  fs::write(&partial,"real Cargo build-script intermediate\\n").unwrap();\n  fs::write(ready,partial.to_string_lossy().as_bytes()).unwrap();\n  let start=Instant::now(); while !Path::new(&release).exists() { assert!(start.elapsed()<Duration::from_secs(60),"lab barrier timed out"); thread::sleep(Duration::from_millis(10)); }\n }\n}\n`;

async function toolchain(lab) {
  const selected = executable("cargo");
  if (!selected || !executable("rustc")) throw Object.assign(new Error("Cargo/rustc unavailable; no toolchain was installed"), { code: "LAB_TOOL_UNAVAILABLE" });
  const rustup = executable("rustup");
  const tools = {};
  for (const name of ["cargo", "rustc", "rustdoc"]) {
    if (rustup) {
      // Inspect an installed toolchain only. No downloads or rustup setup. Use
      // physical tools thereafter so a disposable HOME cannot trigger bootstrap.
      const result = await lab.command(rustup, ["which", name], lab.root, {
        RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(os.homedir(), ".rustup"),
        ...(process.env.RUSTUP_TOOLCHAIN ? { RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN } : {})
      });
      tools[name] = result.stdout.trim();
    } else tools[name] = executable(name);
    assert.ok(tools[name] && path.isAbsolute(tools[name]), `missing installed ${name}`);
    const link = path.join(lab.root, "toolchain-bin", name);
    fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(tools[name], link);
  }
  lab.env.PATH = `${path.join(lab.root, "toolchain-bin")}${path.delimiter}${lab.env.PATH}`;
  lab.env.RUSTC = tools.rustc; lab.env.RUSTDOC = tools.rustdoc;
  await lab.version("cargo"); await lab.version("rustc"); await lab.version("git");
  return tools;
}

export async function cargoLab(lab) {
  const tools = await toolchain(lab);
  const lanes = await lab.checkouts(async (lane) => {
    write(path.join(lane.root, "Cargo.toml"), '[workspace]\nmembers = ["app"]\nexclude = ["dep-v1", "dep-v2"]\nresolver = "2"\n');
    write(path.join(lane.root, "app/Cargo.toml"), manifest(lane.version));
    write(path.join(lane.root, "app/src/main.rs"), main(lane));
    write(path.join(lane.root, "app/build.rs"), buildScript);
    for (const version of [1, 2]) {
      write(path.join(lane.root, `dep-v${version}/Cargo.toml`), `[package]\nname = "lab-dep"\nversion = "${version}.0.0"\nedition = "2021"\n`);
      write(path.join(lane.root, `dep-v${version}/src/lib.rs`), `pub const VALUE: &str = "dep${version}";\n`);
    }
    await lab.command(tools.cargo, ["generate-lockfile", "--offline"], lane.root);
  });
  for (const lane of lanes.slice(2)) write(path.join(lane.root, "app/src/main.rs"), main(lane));
  const flags = (lane) => ({ RUSTFLAGS: lane.flag === "flag1" ? "--cfg lab_flag -C opt-level=1" : "" });
  const control = (lane) => ({ CACHE_LAB_READY: path.join(lab.root, `control/${lane.name}-ready`), CACHE_LAB_RELEASE: path.join(lab.root, `control/${lane.name}-release`) });
  const buildArgs = ["build", "--offline", "--locked", "--message-format=json"];
  const expectedTarget = (lane) => path.join(lab.root, "managed/builds", `same-name-${sha256(fs.realpathSync(lane.root)).slice(0, 10)}`, "cargo/target");
  const target = (lane, direct = false) => direct ? path.join(lab.root, "direct-targets", lane.name) : expectedTarget(lane);
  const binary = (lane, direct = false) => path.join(target(lane, direct), "debug/cache-probe");
  const verify = async (lane, result = null, direct = false) => {
    const file = binary(lane, direct); assertInside(target(lane, direct), file);
    assertOutput((await lab.command(file, [])).stdout, expected(lane));
    if (result) {
      const artifacts = result.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
      const compiled = artifacts.find((entry) => entry.reason === "compiler-artifact" && entry.target?.name === "cache-probe" && entry.executable);
      assert.ok(compiled, "real Cargo must report a binary artifact");
      assert.equal(fs.realpathSync(compiled.executable), fs.realpathSync(file));
      const dependency = artifacts.find((entry) => entry.reason === "compiler-artifact" && entry.target?.name === "lab_dep");
      assert.ok(dependency?.package_id.includes(`${lane.version}.0.0`), "Cargo reported the wrong dependency version");
      lab.record("compiler-reported Cargo artifact", { lane: lane.name, direct, fresh: compiled.fresh, dependency: dependency.package_id, executable: compiled.executable });
    }
    lab.record("Cargo executable contents", { lane: lane.name, direct, expected: expected(lane), sha256: sha256(fs.readFileSync(file)) });
  };
  const start = (lane, direct = false) => direct ? lab.start(tools.cargo, buildArgs, lane.root, { ...flags(lane), ...control(lane), CARGO_TARGET_DIR: target(lane, true) }) : lab.routedStart("cargo", buildArgs, lane.root, { ...flags(lane), ...control(lane) });
  const complete = async (lane, child, direct = false) => {
    const result = await child.done; assert.equal(result.failure, null); assert.equal(result.code, 0, result.stderr);
    await verify(lane, result, direct); return result;
  };
  const build = (lane, direct = false) => complete(lane, start(lane, direct), direct);
  let before = lab.snapshot();
  assert.equal(fs.existsSync(path.join(lab.root, "managed/builds")), false);
  const cold = lanes.map((lane) => start(lane));
  await until(() => lanes.every((lane) => fs.existsSync(control(lane).CACHE_LAB_READY)), "all four real Cargo builds reach their build scripts");
  for (const lane of lanes) {
    const partial = fs.readFileSync(control(lane).CACHE_LAB_READY, "utf8"); assertInside(target(lane), partial);
    write(control(lane).CACHE_LAB_RELEASE, "release\n");
  }
  const results = await Promise.all(lanes.map((lane, i) => complete(lane, cold[i])));
  assertOverlap(results); assert.equal(new Set(lanes.map((lane) => target(lane))).size, 4); lab.unchanged(before);
  lab.report.scenarios.push("four overlapping cold Cargo builds; four separate checkout target roots");
  for (const lane of lanes) await build(lane, true);
  await Promise.all(lanes.map((lane) => build(lane))); lab.unchanged(before);
  lab.report.scenarios.push("warm rebuilds and separate-target direct controls");
  const others = lanes.slice(1).map((lane) => sha256(fs.readFileSync(binary(lane))));
  const verifyOthers = async () => { for (const [i, lane] of lanes.slice(1).entries()) { await verify(lane); assert.equal(sha256(fs.readFileSync(binary(lane))), others[i]); } };
  const a = lanes[0];
  for (const change of ["source", "compiler-flags", "dependency-version", "return-to-original-flags"]) {
    if (change === "source") { a.source = "source02"; write(path.join(a.root, "app/src/main.rs"), main(a)); }
    if (change === "compiler-flags") a.flag = "flag1";
    if (change === "dependency-version") { a.version = 2; write(path.join(a.root, "app/Cargo.toml"), manifest(2)); await lab.command(tools.cargo, ["generate-lockfile", "--offline"], a.root); }
    if (change === "return-to-original-flags") a.flag = "flag0";
    before = lab.snapshot(); await build(a); await build(a, true); await verifyOthers(); lab.unchanged(before); lab.report.scenarios.push(change);
  }
  a.source = "source03"; write(path.join(a.root, "app/src/main.rs"), main(a));
  write(path.join(a.root, "app/build.rs"), `${buildScript}\n// force the real build-script phase for the interruption case\n`);
  fs.unlinkSync(control(a).CACHE_LAB_READY); fs.unlinkSync(control(a).CACHE_LAB_RELEASE);
  const previous = sha256(fs.readFileSync(binary(a))); before = lab.snapshot();
  const interrupted = start(a);
  await until(() => fs.existsSync(control(a).CACHE_LAB_READY), "real Cargo build-script intermediate");
  const partial = fs.readFileSync(control(a).CACHE_LAB_READY, "utf8"); assertInside(target(a), partial);
  const bytes = fs.statSync(partial).size; interrupted.kill(); const failed = await interrupted.done;
  assert.equal(failed.failure, null); assert.notEqual(failed.code, 0);
  assert.equal(sha256(fs.readFileSync(binary(a))), previous); lab.unchanged(before);
  write(control(a).CACHE_LAB_RELEASE, "resume\n"); await build(a); await build(a, true); await verifyOthers(); lab.unchanged(before);
  lab.record("Cargo interrupted after a real build-script write and rebuilt correctly", { partial, bytes, signal: failed.signal, expected: expected(a) });
  lab.report.scenarios.push("SIGKILL after real Cargo build-script intermediate; correct restart");
  const driver = path.join(lab.root, "control/cargo-cwd.cjs"), jobFile = path.join(lab.root, "control/cargo-jobs.json");
  write(jobFile, JSON.stringify(lanes.map((lane) => ({ cwd: path.join(lane.root, "app"), args: buildArgs, binary: binary(lane), expected: expected(lane), env: { ...flags(lane), ...control(lane) } }))));
  write(driver, "const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');for(const j of JSON.parse(fs.readFileSync(process.argv[2]))) {process.chdir(j.cwd);cp.execFileSync('cargo',j.args,{env:{...process.env,...j.env},stdio:'pipe'});assert.equal(cp.execFileSync(j.binary,[],{encoding:'utf8'}),j.expected);}console.log('four correct Cargo cwd switches');\n");
  assertOutput((await lab.routed(process.execPath, [driver, jobFile], a.root)).stdout, "four correct Cargo cwd switches\n"); lab.unchanged(before);
  lab.report.scenarios.push("one session switches between workspace members in all checkouts");
  for (const lane of lanes) {
    const owned = path.dirname(path.dirname(target(lane)));
    // The ownership marker and external record are independently inspected;
    // deriving expected paths above does not call production workspace logic.
    const marker = readJson(path.join(owned, ".clean-development-owned.json"));
    assert.equal(marker.workspace, fs.realpathSync(lane.root));
    assert.ok(marker.ownershipId);
    const registry = path.join(lab.root, "data/state/workspaces");
    const records = fs.readdirSync(registry).filter((name) => name.endsWith(".json")).map((name) => readJson(path.join(registry, name)));
    const receipt = records.find((record) => record.workspace === fs.realpathSync(lane.root));
    assert.equal(records.length, 4); assert.ok(receipt);
    assert.equal(receipt.path, owned); assert.equal(receipt.ownershipId, marker.ownershipId);
    assert.equal(receipt.workspaceId, marker.workspaceId);
    lab.record("separate owned Cargo root", { lane: lane.name, path: owned, marker, receipt });
  }
}
