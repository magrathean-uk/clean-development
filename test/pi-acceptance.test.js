import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CASES, PI_VERSION, PiRpc, cacheContains, commandBody, createLab, isolatedEnvironment,
  makePayload, quote, redact, run, runAcceptance, snapshot, startProvider, verifyArtifacts
} from "./pi-acceptance/acceptance.mjs";

const linuxOnly = { skip: process.platform !== "linux" ? "Linux /proc fixture; not native host acceptance" : false };
const repo = fileURLToPath(new URL("..", import.meta.url));
const driver = path.join(repo, "test", "pi-acceptance", "acceptance.mjs");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-protocol-unit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// These tests deliberately validate fixture mechanics, NOT Pi acceptance. Only
// the opt-in driver may report host passes, after launching the installed Pi CLI.
test("Pi fixture environment does not inherit credentials, agent config or routing", () => {
  const before = { ...process.env };
  const root = path.join(os.tmpdir(), "pi-environment-unit");
  const env = isolatedEnvironment(root);
  assert.equal(env.HOME, path.join(root, "home"));
  assert.equal(env.PI_CODING_AGENT_DIR, path.join(root, "pi-agent"));
  assert.equal(env.PI_OFFLINE, "1");
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NODE_OPTIONS", "BASH_ENV", "ENV", "NPM_TOKEN",
    "CLEAN_DEVELOPMENT_SESSION_MODE", "npm_config_cache", "NPM_CONFIG_CACHE", "CLEAN_DEVELOPMENT_SESSION_ENV"]) {
    assert(!Object.hasOwn(env, key), `Inherited ${key}`);
  }
  assert.equal(Object.keys(process.env).length, Object.keys(before).length);
  assert(Object.entries(before).every(([key, value]) => process.env[key] === value), "Caller environment changed");
});

test("Pi fixture snapshots detect empty directories, changed bytes and symlinks", t => {
  const root = temporary(t);
  const before = snapshot(root);
  fs.mkdirSync(path.join(root, "unexpected"));
  assert.notDeepEqual(snapshot(root), before);
  fs.writeFileSync(path.join(root, "file"), "before");
  const first = snapshot(root);
  fs.writeFileSync(path.join(root, "file"), "after");
  assert.notDeepEqual(snapshot(root), first);
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(root, "file"), path.join(root, "link"));
    assert.throws(() => snapshot(root), /Not a regular fixture file/);
  }
});

test("missing Pi is blocked, never a passed or skipped host acceptance", linuxOnly, async t => {
  const result = await runAcceptance();
  assert.equal(result.targetPiVersion, PI_VERSION);
  assert.equal(result.observedPiVersion, null);
  assert.equal(result.acceptance, "blocked");
  assert.match(result.error, /Pi is not supplied/);
  assert.deepEqual(result.cases.map(c => [c.name, c.status]), CASES.map(name => [name, "blocked"]));
  assert(!result.fixtureRoot);
  assert(!result.invocations);
  const root = temporary(t);
  const reportFile = path.join(root, "blocked.json");
  const child = await run(process.execPath, [driver, "--live", "--report", reportFile], { cwd: repo, env: isolatedEnvironment(root) });
  assert.equal(child.code, 2, child.stderr);
  assert.equal(JSON.parse(child.stdout).acceptance, "blocked");
  assert.deepEqual(JSON.parse(child.stdout), JSON.parse(fs.readFileSync(reportFile)));
  const again = await run(process.execPath, [driver, "--live", "--report", reportFile], { cwd: repo, env: isolatedEnvironment(root) });
  assert.equal(again.code, 1); assert.match(again.stderr, /refusing overwrite/);
});

test("wrong Pi package version cannot launch a process or claim acceptance", linuxOnly, async t => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.0" }));
  const result = await runAcceptance({ piPackage: root });
  assert.equal(result.acceptance, "blocked");
  assert.equal(result.observedPiVersion, null);
  assert(result.cases.every(c => c.status === "blocked"));
  assert(!result.fixtureRoot); assert(!result.invocations);
});

test("loopback provider emits exactly one known Bash call and validates completion", async t => {
  const provider = await startProvider(); t.after(() => provider.close());
  provider.cases.set("unit", { command: "printf fixture-only", calls: 0 });
  const body = { model: "fixed-script", stream: true,
    messages: [{ role: "user", content: "CD_PI_ACCEPTANCE:unit" }], tools: [{ type: "function", function: { name: "bash" } }] };
  const post = value => fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value)
  });
  const initial = await post(body); assert.equal(initial.status, 200);
  const chunks = (await initial.text()).split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  const call = chunks[0].choices[0].delta.tool_calls[0];
  assert.equal(call.function.name, "bash");
  assert.deepEqual(JSON.parse(call.function.arguments), { command: "printf fixture-only", timeout: 15 });
  assert.equal(chunks[1].choices[0].finish_reason, "tool_calls");
  const completion = await post({ ...body, messages: [...body.messages, { role: "tool", content: "fixture-only", tool_call_id: "call-unit" }] });
  assert.equal(completion.status, 200); assert.match(await completion.text(), /Fixture complete/);
  const extra = await post(body); assert.equal(extra.status, 400); await extra.text();
  const unknown = await post({ ...body, messages: [{ role: "user", content: "CD_PI_ACCEPTANCE:unknown" }] });
  assert.equal(unknown.status, 400); await unknown.text();
  assert.equal(provider.requests.filter(r => !r.error).length, 2);
  assert.equal(provider.requests.filter(r => r.error).length, 2);
});

test("RPC protocol unit rejects malformed output and loader-only success", linuxOnly, async t => {
  const root = temporary(t);
  // This subprocess is a protocol negative control, never passed to runAcceptance.
  const rpc = new PiRpc(process.execPath, ["-e", "process.stdin.once('data',()=>console.log('not json'))"], {
    cwd: root, env: isolatedEnvironment(root)
  });
  try { await assert.rejects(rpc.request("get_state"), /JSON|Unexpected token/); }
  finally { await rpc.close(); }
  await rpc.close(); // Idempotent shutdown.
  const loader = new PiRpc(process.execPath, ["-e", `
    process.stdin.once("data", data => {
      const request = JSON.parse(data);
      console.log(JSON.stringify({ type: "response", id: request.id, success: true }));
      console.log(JSON.stringify({ type: "agent_settled" }));
    });
  `], { cwd: root, env: isolatedEnvironment(root) });
  try { await assert.rejects(loader.execute("unit", "printf never-run"), /exactly one actual Pi tool execution/); }
  finally { await loader.close(); }
});

test("Pi fixture shell quoting preserves punctuation and Unicode without execution", linuxOnly, async t => {
  const root = temporary(t);
  const literal = "a' ; $(touch must-not-exist) & Gyöngyös\nsecond line";
  const result = await run("/bin/bash", ["-c", `printf '%s' ${quote(literal)}`], { cwd: root, env: isolatedEnvironment(root) });
  assert.equal(result.code, 0); assert.equal(result.stdout, literal);
  assert(!fs.existsSync(path.join(root, "must-not-exist")));
});

test("process fixture enforces a bounded deadline for a real disposable child", linuxOnly, async t => {
  const root = temporary(t);
  await assert.rejects(run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    cwd: root, env: isolatedEnvironment(root), timeout: 50
  }), /deadline exceeded/);
});

test("CLI-only control proves npm artifact oracles, not Pi host acceptance", linuxOnly, async t => {
  const lab = await createLab();
  // Only a completed control removes its own directory. Failures retain evidence.
  let completed = false;
  t.after(() => {
    if (completed) fs.rmSync(lab.root, { recursive: true, force: true });
    else t.diagnostic(`Control fixture retained at ${lab.root}`);
  });
  const env = { ...lab.env, CLEAN_DEVELOPMENT_SESSION_MODE: "skip" };
  const execute = async (name, { routed = false, exposed = false, wrap = body => body, shellEnv = env } = {}) => {
    const payload = await makePayload(lab, name);
    const command = wrap(commandBody(lab, name, payload));
    const result = await run(process.execPath, ["--require", path.join(lab.root, "observe-spawns.cjs"), "-e", `
      const child = require("node:child_process").spawn("/bin/bash", ["-c", process.argv[1]], { stdio: "inherit" });
      child.on("error", error => { console.error(error.message); process.exitCode = 1; });
      child.on("exit", code => { process.exitCode = code ?? 1; });
    `, command], { cwd: lab.project, env: shellEnv });
    assert.equal(result.code, 0, result.stderr);
    const launches = fs.readFileSync(lab.env.CD_PI_TRACE, "utf8").trim().split("\n").map(JSON.parse)
      .filter(record => record.file === "/bin/bash" && record.args?.[1] === command);
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0].args, ["-c", command]);
    assert.equal(launches[0].cwd, lab.project);
    assert.equal(launches[0].env.PATH, shellEnv.PATH);
    verifyArtifacts(lab, name, payload, { routed, exposed });
    return payload;
  };
  const beforePayload = await execute("before");
  assert(!fs.existsSync(path.join(lab.root, "data")));
  assert(!fs.existsSync(path.join(lab.root, "managed")));
  const setup = await run(process.execPath, [lab.cli, "setup", "--agents", "pi", "--json"], { cwd: lab.project, env: lab.env });
  assert.equal(setup.code, 0, setup.stderr);
  const receipt = JSON.parse(fs.readFileSync(lab.receipt));
  assert.equal(receipt.status, "installed");
  const nativeEnv = { ...env, PATH: `${lab.bin}${path.delimiter}${env.PATH}` };
  await execute("default-skip", { exposed: true, shellEnv: nativeEnv });
  const routedPayload = await execute("routed", { routed: true, exposed: true, shellEnv: nativeEnv,
    wrap: body => `clean-development run --session session-only -- /bin/bash -c ${quote(body)}` });
  await execute("nested-skip", { shellEnv: nativeEnv,
    wrap: body => `clean-development run --session session-only -- /bin/bash -c ${quote(`clean-development run --session skip -- /bin/bash -c ${quote(body)}`)}` });
  assert(cacheContains(lab.managedCache, routedPayload));
  assert(!cacheContains(lab.nativeCache, routedPayload));
  assert(cacheContains(lab.nativeCache, beforePayload));
  assert.throws(() => verifyArtifacts(lab, "routed", routedPayload, { routed: false, exposed: false }));
  assert.throws(() => verifyArtifacts(lab, "never-executed", routedPayload, { routed: true, exposed: true }), /must actually run/);
  const keep = path.join(lab.bin, "unrelated.txt"); fs.writeFileSync(keep, "keep");
  const cache = snapshot(path.join(lab.root, "managed"));
  const uninstall = await run(process.execPath, [lab.cli, "uninstall", "--json"], { cwd: lab.project, env: lab.env });
  assert.equal(uninstall.code, 0, uninstall.stderr);
  assert.equal(fs.readFileSync(keep, "utf8"), "keep");
  assert.deepEqual(snapshot(path.join(lab.root, "managed")), cache);
  for (const file of receipt.ownedFiles) assert(!fs.existsSync(file.path));
  await execute("uninstalled");
  lab.checkUnchanged(); completed = true;
});

test("portable evidence redacts only known disposable path prefixes", () => {
  assert.deepEqual(redact({ file: "/tmp/lab/a", host: "/opt/pi/b", repo: "/work/repo/c", command: "npm run nested" },
    "/tmp/lab", "/opt/pi", "/work/repo"),
  { file: "$FIXTURE/a", host: "$PI_PACKAGE/b", repo: "$SOURCE/c", command: "npm run nested" });
});
