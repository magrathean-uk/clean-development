import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HELP, parseOptions, random, pairOrders, quantile, summarize, fixtureSources,
  isolatedEnvironment, inventory, storageDelta, commandRunner } from "./benchmark-overhead.mjs";

function directory(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-benchmark-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("benchmark options are bounded and disabled phases are explicit", () => {
  assert.equal(parseOptions([], {}).shortPairs, 100);
  assert.equal(parseOptions([], { BENCHMARK_ITERATIONS: "33" }).shortPairs, 33);
  assert.equal(parseOptions(["--build-pairs", "0", "--keep"], {}).keep, true);
  assert.equal(parseOptions(["--help"], {}).help, true);
  assert.match(HELP, /No downloads/);
  for (const args of [["--functions", "0"], ["--functions", "40001"], ["--seed", "4294967296"],
    ["--build-pairs", "-1"], ["--short-pairs", "2.5"], ["--short-pairs", "1", "--short-pairs", "2"],
    ["--output"], ["--keep", "--keep"], ["--unrecognised"],
    ["--short-pairs", "0", "--build-pairs", "0", "--cold-pairs", "0", "--concurrent-pairs", "0"]]) {
    assert.throws(() => parseOptions(args, {}));
  }
  assert.throws(() => parseOptions([], { BENCHMARK_ITERATIONS: "Infinity" }));
});

test("pair order is seeded, balanced, reproducible and not fixed direct-first", () => {
  const orders = pairOrders(100, random(20260927));
  assert.deepEqual(orders, pairOrders(100, random(20260927)));
  assert.notDeepEqual(orders, pairOrders(100, random(20260928)));
  assert.equal(orders.filter((o) => o[0] === "direct").length, 50);
  for (const order of orders) assert.deepEqual([...order].sort(), ["direct", "shim"]);
});

test("quantiles and overhead are paired rather than subtracting independent percentiles", () => {
  const pairs = [{ direct: { ms: 1 }, shim: { ms: 101 }, order: ["direct", "shim"] },
    { direct: { ms: 100 }, shim: { ms: 101 }, order: ["shim", "direct"] }];
  const result = summarize(pairs, 42);
  assert.equal(result.pairedAddedMs.p50, 1);
  assert.equal(result.pairedAddedMs.p95, 100);
  assert.notEqual(result.pairedAddedMs.p95, result.shimMs.p95 - result.directMs.p95);
  assert.equal(result.medianPercentBootstrap95, null);
  assert.equal(result.signResolved, false);
  assert.equal(quantile([3, 1, 4, 2], 0.5), 2);
  assert.throws(() => quantile([], 0.5));
  assert.throws(() => summarize([{ direct: { ms: 0 }, shim: { ms: 1 } }], 1));
  assert.deepEqual(summarize([], 1), { status: "not-measured", n: 0 });
});

test("bootstrap does not claim a resolved sign or two-percent gate from noisy differences", () => {
  const pairs = [-400, 200, -300, 350, -200, 250, -100, 100].map((delta, i) => ({
    direct: { ms: 6000 }, shim: { ms: 6000 + delta }, order: i % 2 ? ["direct", "shim"] : ["shim", "direct"] }));
  const result = summarize(pairs, 5);
  assert.deepEqual(result, summarize(pairs, 5));
  assert.equal(result.signResolved, false);
  assert.equal(result.varianceDominatesTypicalDifference, true);
  assert.equal(result.medianSlowdownAtMostTwoPercent, "unresolved: interval crosses 2%");
  assert.equal(result.buildOverFiveSeconds, true);
  assert.equal(result.orderStrata.direct.n, 4);
});

test("concurrent eligibility checks each child, not an artificially long batch", () => {
  const pairs = Array.from({ length: 6 }, () => ({ order: ["direct", "shim"],
    direct: { ms: 7000, children: [{ ms: 3500 }, { ms: 3500 }] },
    shim: { ms: 7050, children: [{ ms: 3550 }, { ms: 3550 }] } }));
  assert.equal(summarize(pairs, 4).buildOverFiveSeconds, false);
});

test("generated workload is deterministic real Go compilation, without sleeps or downloads", () => {
  const files = fixtureSources(2);
  assert.deepEqual(files, fixtureSources(2));
  assert.equal((files["main.go"].match(/func f\d+\(/g) || []).length, 2);
  assert.match(files["main.go"], /\+ stamp/);
  assert.doesNotMatch(files["main.go"], /Sleep|time\.|net\/|os\/exec/);
  assert.doesNotMatch(files["go.mod"], /require/);
  assert.throws(() => fixtureSources(0));
});

test("fixture environment removes credentials, cache overrides and executable wrappers", (t) => {
  const root = directory(t), inherited = Object.freeze({ API_TOKEN: "secret", NODE_OPTIONS: "--bad-option",
    GOFLAGS: "-a", GOCACHE: "/user/cache", GOCACHEPROG: "external", GIT_DIR: "/user/repo", CLEAN_DEVELOPMENT_ROOT: "/user/build",
    PATH: "/bad-bin", LANG: "C.UTF-8" });
  const env = isolatedEnvironment(root, process.execPath, process.execPath, inherited);
  for (const key of ["API_TOKEN", "NODE_OPTIONS", "GOCACHE", "GOCACHEPROG", "GIT_DIR", "CLEAN_DEVELOPMENT_ROOT"]) assert.equal(env[key], undefined);
  assert.equal(env.GOFLAGS, ""); assert.equal(env.GOPROXY, "off"); assert.equal(env.GOTOOLCHAIN, "local");
  assert.equal(env.HOME, path.join(root, "tool-home")); assert.ok(!env.PATH.includes("/bad-bin"));
  assert.equal(inherited.API_TOKEN, "secret");
});

test("storage evidence measures additions and reuse without touching outside files", (t) => {
  const root = directory(t); fs.writeFileSync(path.join(root, "old"), "abc");
  const before = inventory(root); fs.writeFileSync(path.join(root, "new"), "12345");
  const delta = storageDelta(before, inventory(root));
  assert.equal(delta.growthBytes, 5); assert.equal(delta.logicalBytes, 8);
  assert.equal(delta.addedFiles, 1); assert.equal(delta.unchangedFiles, 1);
});

test("fixture runner reports actual status, captures bounded output and preserves argv/cwd", async (t) => {
  const root = directory(t), runner = commandRunner();
  const result = await runner.run(process.execPath, ["-e", "console.log(JSON.stringify([process.cwd(),process.argv.slice(1)]))", "a b", "&literal"], { cwd: root, env: {} });
  assert.deepEqual(JSON.parse(result.stdout), [root, ["a b", "&literal"]]);
  assert.equal(result.exitCode, 0); assert.ok(result.ms > 0);
  await assert.rejects(runner.run(process.execPath, ["-e", "process.exit(17)"], { cwd: root, env: {} }), /exited 17/);
  await assert.rejects(runner.run(path.join(root, "absent"), [], { cwd: root, env: {} }), { code: "ENOENT" });
});

test("fixture runner timeout and interruption cannot count as successful samples", async (t) => {
  const root = directory(t), runner = commandRunner();
  await assert.rejects(runner.run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: root, env: {}, timeoutMs: 100 }), /exceeded/);
  runner.interrupt();
  await assert.rejects(runner.run(process.execPath, ["-e", ""], { cwd: root, env: {} }), /interrupted/);
});
