import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { planStrict, runStrict } from "../src/strict.js";

const CLI = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));
const linux = process.platform === "linux";
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cd-strict-policy-")));
  for (const dir of ["source", "managed", "artifacts", "tools"]) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, "source", "input"), "source sentinel");
  const policy = { version: 1, sources: [path.join(root, "source")], managed: path.join(root, "managed"), artifacts: [path.join(root, "artifacts")], toolchains: [path.join(root, "tools")] };
  const file = path.join(root, "policy.json"); fs.writeFileSync(file, JSON.stringify(policy));
  return { root, policy, file, cwd: policy.sources[0] };
}
function inventory(root) {
  return fs.readdirSync(root).sort().flatMap((name) => {
    const file = path.join(root, name), stat = fs.lstatSync(file);
    return [[name, stat.mode, stat.isFile() ? fs.readFileSync(file).toString("hex") : stat.isSymbolicLink() ? fs.readlinkSync(file) : null],
      ...(stat.isDirectory() ? inventory(file).map(([child, ...rest]) => [`${name}/${child}`, ...rest]) : [])];
  });
}

test("strict refuses every unsupported platform before inspecting paths", () => {
  for (const platform of ["darwin", "win32", "freebsd"]) assert.throws(() => planStrict({}, { platform }), /Linux is required/);
});
test("strict opt-in is per invocation; inherited values cannot enable it", async () => {
  await assert.rejects(runStrict({}, ["true"]), /--experimental is required/);
  await assert.rejects(runStrict({ experimental: "true" }, ["true"]), /--experimental is required/);
});
test("strict literal argv requires a command and rejects NUL before any storage", async () => {
  for (const command of [[], [""], ["true", "\0"]]) await assert.rejects(runStrict({ experimental: true }, command), /literal command argv/);
});

test("strict planning is read-only and keeps environment inputs independent", { skip: !linux }, () => {
  const item = fixture(), before = inventory(item.root);
  item.policy.env = { PATH: "/usr/bin:/bin", TOKEN: "explicit-only" };
  const plan = planStrict(item.policy, item);
  assert.equal(plan.cwd, item.cwd); assert.equal(plan.managed, item.policy.managed);
  plan.env.TOKEN = "different"; assert.equal(item.policy.env.TOKEN, "explicit-only");
  assert.deepEqual(inventory(item.root), before);
});
test("strict rejects malformed, ambiguous and overlapping policy declarations", { skip: !linux }, async (t) => {
  for (const [label, change, pattern] of [
    ["version", (p) => { p.version = 2; }, /version/],
    ["unknown", (p) => { p.network = true; }, /unknown/],
    ["empty sources", (p) => { p.sources = []; }, /sources/],
    ["relative", (p) => { p.managed = "relative"; }, /absolute/],
    ["normalisation", (p) => { p.managed += "/../managed"; }, /normalised/],
    ["duplicate", (p) => { p.sources.push(p.sources[0]); }, /overlap/],
    ["source writable", (p) => { p.managed = p.sources[0]; }, /overlap/],
    ["artifact in source", (p) => { p.artifacts = p.sources; }, /overlap/],
    ["managed artifact", (p) => { p.artifacts = [p.managed]; }, /overlap/],
    ["system root", (p) => { p.sources = ["/usr"]; }, /reserved root/],
    ["invalid env", (p) => { p.env = { TOKEN: 3 }; }, /environment/],
    ["env NUL", (p) => { p.env = { TOKEN: "a\0b" }; }, /environment/],
    ["env name", (p) => { p.env = { "BAD=KEY": "value" }; }, /environment/],
    ["reserved env", (p) => { p.env = { CLEAN_DEVELOPMENT_STRICT_WORK: "/tmp" }; }, /reserved/]
  ]) await t.test(label, () => { const item = fixture(); change(item.policy); assert.throws(() => planStrict(item.policy, item), pattern); });
});
test("strict refuses alias roots, wrong cwd, existing artifacts and writable permission ambiguity", { skip: !linux }, () => {
  const item = fixture();
  const alias = path.join(item.root, "alias"); fs.symlinkSync(item.policy.managed, alias);
  assert.throws(() => planStrict({ ...item.policy, managed: alias }, item), /canonical/);
  assert.throws(() => planStrict(item.policy, { cwd: item.root }), /cwd/);
  fs.writeFileSync(path.join(item.policy.artifacts[0], "existing"), "deliverable");
  assert.throws(() => planStrict(item.policy, item), /empty dedicated/);
  const other = fixture(); fs.chmodSync(other.policy.managed, 0o777);
  assert.throws(() => planStrict(other.policy, other), /group\/world-writable/);
});
test("normally prunable ancestors cannot contain strict storage or deliverables", { skip: !linux }, () => {
  const item = fixture(); fs.writeFileSync(path.join(item.root, ".clean-development-owned.json"), "not even a valid receipt");
  assert.throws(() => planStrict(item.policy, item), /normally prunable/);
});
test("source symlinks do not become host mounts and source FIFOs fail closed", { skip: !linux }, () => {
  const item = fixture(); fs.symlinkSync("/outside-secret", path.join(item.cwd, "link"));
  assert.equal(planStrict(item.policy, item).sources[0], item.cwd);
  const made = childProcess.spawnSync("/usr/bin/mkfifo", [path.join(item.cwd, "channel")]);
  assert.equal(made.status, 0); assert.throws(() => planStrict(item.policy, item), /socket, device or FIFO/);
});
test("CLI strict requires --, never reads normal configuration and redacts dry-run values", { skip: !linux }, () => {
  const item = fixture(); fs.writeFileSync(path.join(item.cwd, ".clean-development.json"), "invalid and intentionally ignored");
  item.policy.env = { SECRET: "do-not-print-this" }; fs.writeFileSync(item.file, JSON.stringify(item.policy));
  const before = inventory(item.root);
  const run = (args) => childProcess.spawnSync(process.execPath, [CLI, ...args], { cwd: item.cwd, encoding: "utf8", env: {
    ...process.env, CLEAN_DEVELOPMENT_SESSION_MODE: "invalid-and-ignored" } });
  const result = run(["strict", "--experimental", "--policy", item.file, "--dry-run", "--", "echo", "command-body-private"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).execution, "not-tested");
  assert.ok(!result.stdout.includes("do-not-print-this") && !result.stdout.includes("command-body-private"));
  assert.deepEqual(inventory(item.root), before);
  assert.notEqual(run(["strict", "--experimental", "--policy", item.file, "echo"]).status, 0);
});
test("root execution is refused without creating run storage", { skip: !linux || process.getuid() !== 0 }, async () => {
  const item = fixture(), before = inventory(item.root);
  const result = childProcess.spawnSync(process.execPath, [CLI, "strict", "--experimental", "--policy", item.file, "--", "true"], { cwd: item.cwd, encoding: "utf8" });
  assert.equal(result.status, 1); assert.match(result.stderr, /ordinary non-root/); assert.deepEqual(inventory(item.root), before);
});
test("missing required isolation utility never starts an unsandboxed child", { skip: !linux }, async (t) => {
  const item = fixture(), before = inventory(item.root), stat = fs.statSync;
  t.mock.method(process, "getuid", () => 1000); t.mock.method(process, "geteuid", () => 1000);
  t.mock.method(fs, "statSync", (file, ...args) => {
    if (file === "/usr/bin/tini") throw Object.assign(new Error("required tini missing"), { code: "ENOENT" });
    const result = stat(file, ...args);
    if ([item.policy.managed, ...item.policy.artifacts].includes(file)) result.uid = 1000;
    return result;
  });
  t.mock.method(process, "cwd", () => item.cwd);
  t.mock.method(childProcess, "spawn", () => assert.fail("must not launch a child"));
  await assert.rejects(runStrict({ experimental: true, policy: item.file }, ["true"]), /required tini missing/);
  assert.deepEqual(inventory(item.root), before);
});
