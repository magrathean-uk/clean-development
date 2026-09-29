import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnInherited, windowsBatchInvocation } from "../src/runtime.js";
import { setEnvironmentValue } from "../src/platform.js";
import { withoutCleanDevelopmentEnvironment } from "../scripts/harness-utils.mjs";

const argumentsToPreserve = [
  "", "plain", "two words", " leading", "trailing ", "  ", "\t", "line\ttab",
  "x&y", "x|y", "<input", ">output", "(group)", "[array]", "semi;colon", "a,b", "a=b",
  "%PATH%", "%CD%", "%NOT_DEFINED_BY_THIS_TEST%", "50%", "!PATH!", "a!b", "a^b", "^^",
  'a"b', '"', '"quoted"', 'before"&after', 'before"|after', 'a\\"b', 'a\\\\"b',
  "a\\", "a\\\\", "space and trailing\\", "C:\\folder\\", "*?", "`backtick`",
  "árvíztűrő tükörfúrógép", "日本語", "emoji-🙂", "& echo BAD > argument-side-effect.txt"
];

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd argv & contract ")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "capture.cjs");
  const capture = path.join(root, "arguments.json");
  fs.writeFileSync(script, "require('node:fs').writeFileSync(process.env.CD_ARGV_CAPTURE,JSON.stringify(process.argv.slice(2)));process.exit(Number(process.env.CD_ARGV_EXIT||0));\n");
  const env = withoutCleanDevelopmentEnvironment();
  for (const name of ["NODE_OPTIONS", "NODE_PATH"]) {
    for (const key of Object.keys(env)) if (key.toUpperCase() === name) delete env[key];
  }
  setEnvironmentValue(env, "CD_ARGV_CAPTURE", capture);
  return { root, script, capture, env };
}

test("batch argument protection does not depend on a node_modules filename", () => {
  const ordinary = windowsBatchInvocation("C:\\tools\\capture.cmd", argumentsToPreserve, {});
  const npmShim = windowsBatchInvocation("C:\\repo\\node_modules\\.bin\\capture.cmd", argumentsToPreserve, {});
  // The argument tail must use the same two-stage protection in both locations.
  assert.equal(ordinary.args[4].slice(ordinary.args[4].indexOf(" ")),
    npmShim.args[4].slice(npmShim.args[4].indexOf(" ")));
  assert.match(ordinary.args[4], /x\^\^\^&y/);
  assert.deepEqual(ordinary.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
});

for (const extension of ["cmd", "bat"]) {
  for (const location of ["plain", "node_modules/.bin"]) {
    test(`native ${extension} argv survives percent-star forwarding from ${location}`, { skip: process.platform !== "win32" }, async (t) => {
      const item = fixture(t);
      const directory = path.join(item.root, location); fs.mkdirSync(directory, { recursive: true });
      const command = path.join(directory, `capture tool.${extension}`);
      fs.writeFileSync(command, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath}" "${item.script}" %*\r\nexit /b %errorlevel%\r\n`);
      assert.equal(await spawnInherited(command, argumentsToPreserve, { cwd: item.root, env: item.env }), 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(item.capture, "utf8")), argumentsToPreserve);
      assert.equal(fs.existsSync(path.join(item.root, "argument-side-effect.txt")), false);
      setEnvironmentValue(item.env, "CD_ARGV_EXIT", "37");
      assert.equal(await spawnInherited(command, ["exit status"], { cwd: item.root, env: item.env }), 37);
    });
  }
}

test("native executables receive argv directly, without batch escaping", async (t) => {
  const item = fixture(t);
  assert.equal(await spawnInherited(process.execPath, [item.script, ...argumentsToPreserve], { cwd: item.root, env: item.env }), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(item.capture, "utf8")), argumentsToPreserve);
});

test("batch command and argument control characters are rejected before execution", () => {
  for (const bad of ["a\nb", "a\rb", "a\0b"]) {
    assert.throws(() => windowsBatchInvocation(`C:\\${bad}.cmd`, [], {}), /newlines or NUL/);
    assert.throws(() => windowsBatchInvocation("C:\\safe.cmd", [bad], {}), /newlines or NUL/);
  }
});
