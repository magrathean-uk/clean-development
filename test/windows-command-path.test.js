import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { resolveExecutable, spawnInherited, windowsBatchInvocation } from "../src/runtime.js";
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


for (const variant of ["tools with spaces", "semi;colon", "comma,only", "equal=only", "plus+only", "semi;comma,equal=plus+"]) {
  test(`quoted Windows PATH preserves tool selection, cwd and batch argv: ${variant}`, { skip: process.platform !== "win32" }, (t) => {
    const item = fixture(t), cwd = path.join(item.root, "child;cwd,=+");
    const directory = path.join(cwd, variant), fallback = path.join(item.root, "fallback");
    fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(fallback);
    const script = path.join(item.root, "path-capture.cjs");
    fs.writeFileSync(script, "require('node:fs').writeFileSync(process.env.CD_COMMAND_CAPTURE,JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2)}));process.exit(29);\n");
    const unintended = path.join(item.root, "wrong-tool.txt");
    const input = Object.freeze([...args, "semi;colon", "a,b", "key=value", "plus+"]);
    for (const extension of ["cmd", "bat"]) {
      const command = path.join(directory, `capture.${extension}`);
      fs.writeFileSync(command, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath}" "${script}" %*\r\nexit /b %errorlevel%\r\n`);
      // Neither an empty PATH entry nor a lost quoted entry may select these.
      for (const location of [cwd, fallback]) {
        fs.writeFileSync(path.join(location, `capture.${extension}`), '@echo wrong>"%CD_WRONG_TOOL%"\r\nexit /b 77\r\n');
      }
      for (const entry of [directory, path.relative(cwd, directory)]) {
        const env = { ...item.env };
        setEnvironmentValue(env, "PATH", `;"";"${entry}";${fallback};`);
        setEnvironmentValue(env, "PATHEXT", `.${extension.toUpperCase()}`);
        setEnvironmentValue(env, "CD_WRONG_TOOL", unintended);
        Object.freeze(env);
        const before = JSON.stringify(env);
        const selected = resolveExecutable("capture", env, null, cwd);
        assert.equal(selected, command, "The first quoted PATH entry must win over the fallback");
        assert.equal(resolveExecutable(path.join(variant, `capture.${extension}`), env, null, cwd), command);
        const invocation = windowsBatchInvocation(selected, input, env);
        fs.rmSync(env.CD_COMMAND_CAPTURE, { force: true });
        const result = spawnSync(invocation.command, invocation.args, {
          cwd, env, windowsVerbatimArguments: invocation.windowsVerbatimArguments,
          encoding: "utf8", timeout: 10000
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 29, result.stderr);
        assert.deepEqual(JSON.parse(fs.readFileSync(env.CD_COMMAND_CAPTURE, "utf8")), { cwd, argv: input });
        assert.equal(fs.existsSync(unintended), false);
        assert.equal(fs.existsSync(path.join(cwd, "command-path-side-effect.txt")), false);
        assert.equal(JSON.stringify(env), before);
      }
    }
  });
}
