import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnInherited, windowsBatchInvocation } from "../src/runtime.js";
import { setEnvironmentValue } from "../src/platform.js";

const variants = [
  "spaces and & ampersand", "round (brackets) and [square]", "caret ^ and bang !",
  "percent-%CD_LITERAL_TOKEN%-path", "bang-!CD_LITERAL_TOKEN!-path", "unmatched-50%-path",
  "semi;comma,equal=plus+", "apostrophe's directory", "Gyöngyös 日本語"
];
const args = ["", "literal & | < > ( )", "%CD_LITERAL_TOKEN%", "!CD_LITERAL_TOKEN!", "^^", 'a"&b',
  "a\\\\", "trailing space ", "🙂", "& echo BAD > command-path-side-effect.txt"];

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd command-path contract ")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (["NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase())) delete env[key];
  setEnvironmentValue(env, "CD_LITERAL_TOKEN", "SHOULD_NOT_EXPAND");
  setEnvironmentValue(env, "CD_COMMAND_CAPTURE", path.join(root, "capture.json"));
  const script = path.join(root, "capture.cjs");
  fs.writeFileSync(script, "require('node:fs').writeFileSync(process.env.CD_COMMAND_CAPTURE,JSON.stringify(process.argv.slice(2)));process.exit(Number(process.env.CD_COMMAND_EXIT||0));\n");
  return { root, env, script };
}

for (const variant of variants) {
  test(`native batch command path remains literal: ${variant}`, { skip: process.platform !== "win32" }, async (t) => {
    const item = fixture(t), directory = path.join(item.root, variant); fs.mkdirSync(directory);
    for (const extension of ["cmd", "bat"]) {
      const command = path.join(directory, `capture tool.${extension}`);
      fs.writeFileSync(command, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath}" "${item.script}" %*\r\nexit /b %errorlevel%\r\n`);
      assert.equal(await spawnInherited(command, args, { cwd: item.root, env: item.env }), 0, `${variant}.${extension}`);
      assert.deepEqual(JSON.parse(fs.readFileSync(item.env.CD_COMMAND_CAPTURE, "utf8")), args);
      assert.equal(fs.existsSync(path.join(item.root, "command-path-side-effect.txt")), false);
      setEnvironmentValue(item.env, "CD_COMMAND_EXIT", "23");
      assert.equal(await spawnInherited(command, ["status"], { cwd: item.root, env: item.env }), 23);
      setEnvironmentValue(item.env, "CD_COMMAND_EXIT", "0");
    }
  });
}

test("batch invocation construction does not mutate the provided environment or arguments", () => {
  const env = Object.freeze({ ComSpec: "C:\\Windows\\System32\\cmd.exe", CD_LITERAL_TOKEN: "SHOULD_NOT_EXPAND" });
  const input = Object.freeze([...args]), before = JSON.stringify({ env, input });
  for (const variant of variants) {
    const value = windowsBatchInvocation(`C:\\tools\\${variant}\\capture.cmd`, input, env);
    assert.equal(value.command, env.ComSpec);
    assert.deepEqual(value.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
    assert.equal(value.windowsVerbatimArguments, true);
    assert.doesNotMatch(value.args[4], /SHOULD_NOT_EXPAND/);
  }
  assert.equal(JSON.stringify({ env, input }), before);
});
