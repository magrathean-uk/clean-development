import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatExplanation } from "../src/explain.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";
import { setEnvironmentValue } from "../src/platform.js";

const unsafe = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
function report(value = "ordinary") {
  return {
    schemaVersion: 1, kind: "prediction", command: value,
    executable: { path: value, found: true },
    session: { mode: value, source: value }, workspace: { root: value, authority: value },
    routing: { status: value, reason: value, commandLineTarget: value,
      variables: [{ name: value, value, action: "preserve", source: value, reason: value }] },
    limitations: [value]
  };
}
function frozen(value) {
  if (value && typeof value === "object") { for (const item of Object.values(value)) frozen(item); Object.freeze(value); }
  return value;
}
function decodedLines(text) {
  return text.split("\n").map((line) => JSON.parse(`"${line}"`));
}
function snapshot(root) {
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    const file = path.join(root, entry.name);
    return [entry.name, entry.isDirectory() ? snapshot(file) : fs.readFileSync(file, "base64")];
  });
}

test("explanations display terminal escape sequences instead of emitting them", () => {
  const value = "before\u001b[2J\u001b]8;;https://example.invalid/\u0007label\u001b]8;;\u0007after";
  const text = formatExplanation(report(value));
  assert.doesNotMatch(text, unsafe);
  assert.match(text, /\\u001b\[2J/);
  assert.match(text, /\\u0007/);
  assert.equal(decodedLines(text)[1], `Command: ${value}`);
});

test("untrusted newlines, carriage returns, backspaces and tabs cannot add report lines", () => {
  const value = "first\nRouting: forged\rrewritten\b\tend";
  const baseline = formatExplanation(report()).split("\n").length;
  const text = formatExplanation(report(value));
  assert.equal(text.split("\n").length, baseline);
  assert.equal(text.split("\n").includes("Routing: forged"), false);
  assert.doesNotMatch(text, unsafe);
  assert.match(text, /first\\nRouting: forged\\rrewritten\\b\\tend/);
});

test("all C0 and C1 controls are literal data in every rendered field", () => {
  const controls = [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => i + 127)]
    .map((value) => String.fromCharCode(value)).join("");
  const text = formatExplanation(report(controls));
  assert.doesNotMatch(text, unsafe);
  assert.equal(text.split("\n").length, formatExplanation(report()).split("\n").length);
  for (const line of decodedLines(text).filter((line) => line && !line.startsWith("Clean Development"))) {
    assert.ok(line.includes(controls), "each dynamic line preserves the complete value after decoding");
  }
});

test("direction controls and Unicode line separators are visible without mangling ordinary Unicode", () => {
  const controls = "\u061c\u200e\u200f\u2028\u2029\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
  const ordinary = "árvíztűrő tükörfúrógép 日本語 🙂 مرحبا שלום";
  const text = formatExplanation(report(ordinary + controls));
  assert.doesNotMatch(text, unsafe);
  assert.ok(text.includes(ordinary));
  for (const character of controls) assert.ok(text.includes(`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`));
  assert.equal(decodedLines(text)[1], `Command: ${ordinary + controls}`);
});

test("literal backslashes and quotes are distinguishable from escaped controls", () => {
  const value = 'C:\\source\\literal\\n\\u001b "quoted"\nactual newline';
  const text = formatExplanation(report(value));
  assert.equal(decodedLines(text)[1], `Command: ${value}`);
  assert.ok(text.includes('literal\\\\n\\\\u001b'));
  assert.doesNotMatch(text, unsafe);
});

test("human formatting leaves the raw report and JSON data contract unchanged", () => {
  const value = "raw\u001b[0m\n\u202e\u009b";
  const source = frozen(report(value)), before = JSON.stringify(source);
  formatExplanation(source);
  assert.equal(JSON.stringify(source), before);
  const decoded = JSON.parse(before);
  assert.equal(decoded.command, value);
  assert.equal(decoded.routing.variables[0].value, value);
  assert.equal(decoded.schemaVersion, 1);
});

test("public CLI escapes preserved override text while JSON retains the exact value and inspection stays read-only", (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd rendering contract ")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project"); fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, "package.json"), "{}\n");
  const env = isolatedEnvironment(root);
  setEnvironmentValue(env, "PATH", "");
  const value = "explicit-cache\u001b[2J\nRouting: forged\r\u202e\u009b";
  setEnvironmentValue(env, "npm_config_cache", value);
  const cli = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));
  const run = (json) => spawnSync(process.execPath, [cli, "explain", ...(json ? ["--json"] : []), "--", "npm", "test"], {
    cwd, env, encoding: "utf8", timeout: 10000, maxBuffer: 128 * 1024
  });
  const before = snapshot(root);
  const text = run(false); assert.equal(text.status, 0, text.stderr);
  assert.doesNotMatch(text.stdout, unsafe); assert.match(text.stdout, /\\u001b\[2J/);
  assert.equal(text.stdout.split("\n").includes("Routing: forged"), false);
  const json = run(true); assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  const preserved = parsed.routing.variables.find((entry) => entry.name.toLowerCase() === "npm_config_cache");
  assert.equal(preserved.value, value); assert.equal(preserved.action, "preserve");
  assert.deepEqual(snapshot(root), before);
});
