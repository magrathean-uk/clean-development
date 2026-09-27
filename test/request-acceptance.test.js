import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CANARY, HOOK_CANARY, ORDINARY, canonical, comparisonValue, differences, inspectPayload, redact, sha256, startCapture } from "../scripts/request-acceptance/capture.mjs";
import { CASES, TARGET_VERSION, evaluate, executeCase, isolatedEnvironment, nativeHookObserved, options, prepareDirectories, prepareMarketplace, runChild } from "../scripts/request-acceptance/run.mjs";

// These validate the measurement apparatus, NOT Claude or another host. All
// requests below are explicitly synthetic; no fixture success is host acceptance.
const body = "Exact management instructions.\nPreserve this Unicode: café 東京.";
const description = "Explicit management description";
const payload = (extra = {}) => ({ model: "fixture-model", messages: [{ role: "user", content: ORDINARY }], system: [{ type: "text", text: "Unmodified host instructions" }], tools: [{ name: "shell", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } }], ...extra });
const skill = { body, description };
const root = fileURLToPath(new URL("../", import.meta.url));

function disposable(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cd-request-unit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function matrix(repeats = 1) {
  return Array.from({ length: repeats }, (_, repeat) => CASES.map((name) => {
    const data = payload();
    if (name === "skill-explicit") data.messages.push({ role: "user", content: body });
    if (name === "description-control") data.system.push({ type: "text", text: CANARY });
    if (name === "hook-control") data.messages.push({ role: "user", content: HOOK_CANARY });
    return { name, repeat, status: "captured", requests: [{ endpoint: "/v1/messages", comparison: canonical(data), observation: inspectPayload(data, skill) }] };
  })).flat();
}

function change(item, mutate) {
  mutate(item.requests[0].comparison);
  item.requests[0].observation = inspectPayload(item.requests[0].comparison, skill);
}

async function post(capture, data, options = {}) {
  return fetch(`${capture.url}${options.endpoint || "/v1/messages"}`, { method: options.method || "POST", headers: { "content-type": "application/json", "x-api-key": capture.token, ...options.headers }, body: options.raw ?? JSON.stringify(data) });
}

test("exact CLI inputs; no default live run, implicit install or relative binary", () => {
  assert.equal(options(["--preflight"]).preflight, true);
  assert.equal(options(["--claude", "/tools/claude"]).expectedVersion, TARGET_VERSION);
  for (const args of [[], ["--claude", "claude"], ["--preflight", "--claude", "/a"], ["--preflight", "--repeats", "0"], ["--preflight", "--repeats", "NaN"], ["--preflight", "--expect-version", "latest"], ["--preflight", "--output", "relative"], ["--preflight", "--preflight"], ["--preflight", "--output", "/tmp/a\0b"]]) assert.throws(() => options(args));
});

test("environment allowlist excludes ambient credentials, instructions and routing", (t) => {
  const directory = disposable(t), lane = path.join(directory, "lane");
  const env = isolatedEnvironment(lane, "/fixture-bin");
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "NODE_OPTIONS", "BASH_ENV", "CLEAN_DEVELOPMENT_SESSION_MODE", "CARGO_TARGET_DIR", "npm_config_cache", "CLAUDE_CODE_SYSTEM_PROMPT"]) assert.equal(Object.hasOwn(env, key), false, key);
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(lane, "claude"));
  assert.equal(env.DISABLE_AUTOUPDATER, "1");
  assert.equal(env.PATH.split(path.delimiter).includes("/fixture-bin"), true);
  prepareDirectories(lane, env);
  assert.equal(fs.readFileSync(env.GIT_CONFIG_GLOBAL, "utf8"), "");
  if (process.platform !== "win32") assert.equal(fs.statSync(lane).mode & 0o777, 0o700);
  assert.throws(() => prepareDirectories(lane, env), { code: "EEXIST" });
});

test("comparison preserves system, message roles, tool schemas, unknown fields and order", () => {
  const baseline = payload({ metadata: { user_id: "id-a", other: "retained" } });
  const right = structuredClone(baseline); right.metadata.user_id = "id-b";
  assert.deepEqual(comparisonValue(baseline), comparisonValue(right));
  for (const mutate of [
    (x) => { x.tools[0].description += " automatic instruction"; },
    (x) => { x.tools[0].input_schema.properties.hidden = { type: "string", description: "hidden context" }; },
    (x) => { x.messages[0].role = "system"; },
    (x) => { x.system[0].text += " "; },
    (x) => { x.newHostField = "new text"; },
    (x) => { x.metadata.other = "changed"; },
    (x) => { x.messages.push({ role: "assistant", content: "prior conversation" }); }
  ]) {
    const copy = structuredClone(right); mutate(copy);
    const diff = differences(comparisonValue(baseline), comparisonValue(copy));
    assert.ok(diff.length > 0); assert.ok(diff.every((entry) => entry.pointer && Object.hasOwn(entry, "beforeSha256")));
    assert.equal(JSON.stringify(diff).includes("automatic instruction"), false);
  }
  assert.deepEqual(comparisonValue(payload({ system: "cwd /private/lane-a/project" }), "/private/lane-a"), comparisonValue(payload({ system: "cwd /private/lane-b/project" }), "/private/lane-b"));
  assert.equal(baseline.metadata.user_id, "id-a", "inputs are not modified");
});

test("exact Unicode body/description and UTF-8 bytes; no tokenizer or billing estimate", () => {
  const data = payload({ tools: [{ description, input_schema: { description: body } }] });
  const measured = inspectPayload(data, skill);
  assert.equal(measured.bodyPresent, true); assert.equal(measured.descriptionPresent, true);
  assert.ok(measured.observedStringUtf8Bytes > body.length);
  assert.equal(Object.hasOwn(measured, "tokens"), false);
  assert.equal(inspectPayload(data).bodyPresent, false, "empty needles must never pass");
  assert.throws(() => inspectPayload({ stdout: body, model: "fixture" }, skill));
  assert.throws(() => inspectPayload({ messages: [], model: "fixture" }, skill));
});

test("privacy redaction cannot erase an original measured difference", () => {
  const first = payload({ system: "/private/operator/name", metadata: { user_id: '{"account_uuid":"secret-account"}', email: "person@private.test" }, api_key: "private-key" });
  const second = payload({ system: "/private/other/name", metadata: first.metadata, api_key: "private-key" });
  const substitutions = [["/private/operator/name", "<PATH>"], ["/private/other/name", "<PATH>"]];
  assert.ok(differences(comparisonValue(first), comparisonValue(second)).length);
  const publication = redact(first, substitutions);
  assert.deepEqual(publication.value, redact(second, substitutions).value);
  for (const privateText of ["secret-account", "person@private.test", "private-key", "/private/operator"]) assert.equal(JSON.stringify(publication).includes(privateText), false);
  assert.ok(publication.edits.some((entry) => entry.pointer === "/metadata/user_id"));
  assert.ok(redact({ text: "Bearer ABCDEFGHIJKLMNOP sk-testsecret01234567890" }).value.text.includes("<CREDENTIAL>"));
  assert.equal(first.system, "/private/operator/name");
});

test("complete synthetic matrix only establishes comparison-apparatus behaviour", () => {
  const result = evaluate(matrix(2), 2);
  assert.equal(result.status, "observed-equal-in-tested-scope");
  assert.equal(result.billedTokenNeutrality, "unproven");
  assert.equal(result.productionInference, "not-tested");
  assert.equal(result.crossHostAcceptance, "unproven");
  assert.equal(result.comparisons.length, 10);
});

test("missing/duplicate/unknown/blocked cases and empty/count-only captures cannot pass", () => {
  assert.throws(() => evaluate([], 0));
  for (const mutate of [
    (cases) => { cases.pop(); },
    (cases) => { cases.push(cases[0]); },
    (cases) => { cases[0].name = "unknown"; },
    (cases) => { cases[0].name = cases[1].name; },
    (cases) => { cases[0].status = "blocked"; },
    (cases) => { cases[0].requests = []; },
    (cases) => { delete cases[0].requests[0].comparison; },
    (cases) => { for (const item of cases) item.requests[0].endpoint = "/v1/messages/count_tokens"; }
  ]) { const cases = matrix(); mutate(cases); assert.notEqual(evaluate(cases, 1).status, "observed-equal-in-tested-scope"); }
  assert.notEqual(evaluate([], 1).status, "observed-equal-in-tested-scope");
});

test("explicit-body and both injection positive controls are mandatory generation evidence", () => {
  for (const [name, key] of [["skill-explicit", "bodyPresent"], ["description-control", "descriptionCanaryPresent"], ["hook-control", "hookCanaryPresent"]]) {
    const cases = matrix(), item = cases.find((item) => item.name === name);
    item.requests[0].observation[key] = false;
    assert.notEqual(evaluate(cases, 1).status, "observed-equal-in-tested-scope");
  }
});

test("automatic descriptions, arbitrary text and schema changes fail comparison", () => {
  for (const [field, value] of [["system", "clean-development automatic description"], ["system", "unrelated hidden extra context"], ["tools", [{ name: "new-tool", description: "new tool text" }]], ["unknown", "new host field"]]) {
    const cases = matrix(); change(cases.find((item) => item.name === "skill-inactive"), (data) => { data[field] = value; });
    const result = evaluate(cases, 1);
    assert.equal(result.status, "inconclusive-or-difference");
    assert.ok(result.comparisons.find((item) => item.case === "skill-inactive").changedPointers.length);
  }
});

test("unstable absent controls and extra request sequences are not dismissed as noise", () => {
  const cases = matrix(); change(cases.find((item) => item.name === "absent-after"), (data) => { data.system[0].text += " time drift"; });
  assert.ok(evaluate(cases, 1).reasons.includes("absent-controls-differ"));
  const extra = matrix(), item = extra.find((item) => item.name === "native-inactive"); item.requests.push(structuredClone(item.requests[0]));
  assert.equal(evaluate(extra, 1).status, "inconclusive-or-difference");
  const contaminated = matrix(); change(contaminated[0], (data) => { data.system[0].text = "clean-development"; });
  assert.ok(evaluate(contaminated, 1).reasons.includes("absent-control-contaminated"));
});

test("CLI inventory or hook text alone is not a request capture", () => {
  assert.equal(nativeHookObserved('inventory: ~58 always-on tokens\n'), false);
  assert.equal(nativeHookObserved(JSON.stringify({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", exit_code: 0 })), true);
  assert.equal(nativeHookObserved(JSON.stringify({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", exit_code: 1 })), false);
  const cases = matrix(); cases[0].requests = []; cases[0].stdout = body; cases[0].metadata = { implicit: false, tokens: 0 };
  assert.notEqual(evaluate(cases, 1).status, "observed-equal-in-tested-scope");
});

test("real loopback receiver captures exact HTTP bytes from a separate synthetic client process", async (t) => {
  const capture = await startCapture(); t.after(() => capture.close());
  const data = payload({ stream: true, system: body, metadata: { user_id: "fixture-only" } });
  const raw = JSON.stringify(data);
  const script = `const response = await fetch(process.argv[1] + '/v1/messages', {method:'POST',headers:{'content-type':'application/json','x-api-key':process.argv[2]},body:process.argv[3]}); const text=await response.text(); if(!response.ok || !text.includes('message_stop')) process.exit(41);`;
  const result = await runChild(process.execPath, ["--input-type=module", "-e", script, capture.url, capture.token, raw], { env: { PATH: path.dirname(process.execPath) }, timeoutMs: 10000 });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.failure, null);
  assert.equal(capture.requests.length, 1); assert.deepEqual(capture.requests[0].payload, data);
  assert.equal(capture.requests[0].rawSha256, sha256(Buffer.from(raw)));
  assert.equal(capture.requests[0].rawBytes, Buffer.byteLength(raw));
  assert.equal(JSON.stringify(capture.requests).includes(capture.token), false, "auth headers are never stored");
  assert.deepEqual(capture.errors, []);
});

test("count endpoint is labelled separately and synthetic usage is never billed usage", async (t) => {
  const capture = await startCapture(); t.after(() => capture.close());
  const count = await post(capture, payload(), { endpoint: "/v1/messages/count_tokens" });
  assert.deepEqual(await count.json(), { input_tokens: 0 });
  const message = await post(capture, payload());
  assert.equal((await message.json()).content[0].text, "Request construction fixture complete.");
  assert.deepEqual(capture.requests.map((entry) => entry.endpoint), ["/v1/messages/count_tokens", "/v1/messages"]);
});

test("receiver rejects malformed bodies, unexpected credentials, endpoints and encodings", async (t) => {
  const capture = await startCapture({ maxBodyBytes: 512, maxRequests: 10 }); t.after(() => capture.close());
  for (const [options, expected] of [[{ raw: "{bad" }, 400], [{ raw: '{}' }, 400], [{ headers: { 'x-api-key': 'actual-secret-not-logged' } }, 401], [{ endpoint: '/v1/unknown' }, 404], [{ headers: { 'content-encoding': 'gzip' } }, 415], [{ headers: { 'content-type': 'text/plain' } }, 415], [{ raw: 'x'.repeat(1024) }, 413]]) {
    const response = await post(capture, payload(), options); await response.text(); assert.equal(response.status, expected);
  }
  assert.equal(capture.requests.length, 0);
  assert.equal(JSON.stringify(capture.errors).includes("actual-secret"), false);
  const limited = await startCapture({ maxRequests: 1 }); t.after(() => limited.close());
  await (await post(limited, payload())).text();
  const response = await post(limited, payload()); await response.text(); assert.equal(response.status, 429);
  await assert.rejects(startCapture({ maxRequests: 0 }));
});

test("bounded real child failures, Unicode output and timeouts", async () => {
  const unicode = await runChild(process.execPath, ["-e", "for (const byte of Buffer.from('café 東京')) process.stdout.write(Buffer.from([byte])); process.exitCode=23;"], { timeoutMs: 10000 });
  assert.equal(unicode.stdout, "café 東京"); assert.equal(unicode.code, 23);
  const limited = await runChild(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000)); setInterval(()=>{},1000)"], { timeoutMs: 10000, maxBytes: 50 });
  assert.match(limited.failure, /^output-limit/); assert.notEqual(limited.code, 0);
  const timed = await runChild(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 200 });
  assert.match(timed.failure, /^timeout/); assert.notEqual(timed.code, 0);
});

test("missing explicitly requested host writes blocked evidence, null version and zero sessions", { skip: process.platform === "win32" && "POSIX host driver" }, async (t) => {
  const directory = disposable(t), output = path.join(directory, "evidence");
  const result = await runChild(process.execPath, [path.join(root, "scripts/request-acceptance/run.mjs"), "--claude", path.join(directory, "missing-host"), "--output", output], { cwd: root, env: { PATH: path.dirname(process.execPath) }, timeoutMs: 10000 });
  assert.equal(result.code, 2, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(output, "report.json"), "utf8"));
  assert.equal(report.observedHostVersion, null); assert.equal(report.hostCasesExecuted, 0);
  assert.equal(report.blocker, "host-binary-unavailable"); assert.equal(report.claims.requestText, "unproven"); assert.equal(report.claims.billedTokens, "unproven");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(output, "report.json")).mode & 0o777, 0o600);
  const again = await runChild(process.execPath, [path.join(root, "scripts/request-acceptance/run.mjs"), "--claude", path.join(directory, "missing-host"), "--output", output], { cwd: root, timeoutMs: 10000 });
  assert.equal(again.code, 2); assert.equal(fs.readFileSync(path.join(output, "report.json"), "utf8"), `${JSON.stringify(report, null, 2)}\n`, "evidence cannot be overwritten");
});


test("disposable marketplace uses shipped manual-only bundle; canary edits only a separate copy", (t) => {
  const directory = disposable(t), bundle = path.join(root, "marketplace/claude");
  const original = fs.readFileSync(path.join(bundle, "skills/clean-development/SKILL.md"), "utf8");
  const normal = path.join(directory, "normal"), control = path.join(directory, "control");
  fs.mkdirSync(normal); fs.mkdirSync(control);
  const catalog = prepareMarketplace(normal, bundle), canaryCatalog = prepareMarketplace(control, bundle, true);
  const copy = fs.readFileSync(path.join(catalog, "clean-development/skills/clean-development/SKILL.md"), "utf8");
  assert.equal(copy, original); assert.match(copy, /disable-model-invocation: true/);
  const changed = fs.readFileSync(path.join(canaryCatalog, "clean-development/skills/clean-development/SKILL.md"), "utf8");
  assert.ok(changed.includes(CANARY)); assert.equal(changed.includes("disable-model-invocation:"), false);
  assert.equal(fs.readFileSync(path.join(bundle, "skills/clean-development/SKILL.md"), "utf8"), original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(catalog, ".claude-plugin/marketplace.json"))).plugins[0].source, "./clean-development");
});

test("real isolated product setup does not substitute for a host request", { skip: process.platform === "win32" && "POSIX host driver" }, async (t) => {
  const directory = disposable(t);
  // Node intentionally rejects Claude-only flags. This is a setup/blocked-path
  // control, not a fake Claude acceptance run or a model request.
  const result = await executeCase({ name: "native-inactive", repeat: 0, lab: directory, binary: process.execPath, bundle: path.join(root, "marketplace/claude"), skill });
  assert.equal(result.nativeSetup, "receipt-verified");
  assert.equal(result.status, "blocked"); assert.equal(result.reason, "host-execution-failed");
  assert.equal(result.requests.length, 0); assert.equal(result.nativeHookObserved, false);
  assert.equal(result.projectUnchanged, true); assert.equal(result.settingsUnchanged, true);
});
