import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { windowsBatchInvocation } from "../src/windows-command.js";

const variants = ["equal=only", "many===equals", "caret^=equal", "space = equals", "semi;comma,equal=plus+"];

test("the command token protects equals without changing the argument encoding", () => {
  const args = Object.freeze(["key=value", "==", "", "caret^=value"]);
  for (const variant of variants) {
    const invocation = windowsBatchInvocation(`C:\\tools\\${variant}\\capture.cmd`, args, {});
    const expected = {
      "equal=only": "equal^=only", "many===equals": "many^=^=^=equals",
      "caret^=equal": "caret^^^=equal", "space = equals": "space^ ^=^ equals",
      "semi;comma,equal=plus+": "semi^;comma^,equal^=plus+"
    }[variant];
    const token = windowsBatchInvocation(`C:\\tools\\${variant}\\capture.cmd`, [], {});
    assert.equal(token.args[4], `"C:\\tools\\${expected}\\capture.cmd"`);
    assert.ok(invocation.args[4].endsWith(' ^^^"key=value^^^" ^^^"==^^^" ^^^"^^^" ^^^"caret^^^^=value^^^""'));
  }
});

for (const variant of variants) {
  test(`Windows command token does not execute an equals-prefix impostor: ${variant}`, { skip: process.platform !== "win32" }, (t) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-equals-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, variant);
    fs.mkdirSync(directory);
    const capture = path.join(root, "capture.json");
    const unintended = path.join(root, "unintended.txt");
    const script = path.join(root, "capture.cjs");
    fs.writeFileSync(script, "require('node:fs').writeFileSync(process.env.CD_TOKEN_CAPTURE,JSON.stringify(process.argv.slice(2)));process.exit(23);\n");
    const prefix = path.join(root, `${variant.split("=")[0]}.cmd`);
    fs.writeFileSync(prefix, '@echo wrong>"%CD_TOKEN_UNINTENDED%"\r\nexit /b 77\r\n');
    const env = { ...process.env, CD_TOKEN_CAPTURE: capture, CD_TOKEN_UNINTENDED: unintended };
    for (const key of Object.keys(env)) if (["NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase())) delete env[key];
    const args = ["key=value", "==", "", "caret^=value", "& echo BAD > unintended.txt"];
    for (const ext of ["cmd", "bat"]) {
      fs.rmSync(capture, { force: true });
      const command = path.join(directory, `capture.${ext}`);
      fs.writeFileSync(command, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath}" "${script}" %*\r\nexit /b %errorlevel%\r\n`);
      const invocation = windowsBatchInvocation(command, args, env);
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: root, env, windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        encoding: "utf8", timeout: 10000
      });
      assert.equal(fs.existsSync(unintended), false, "The prefix executable must not run");
      assert.equal(result.status, 23, result.stderr || result.error?.message);
      assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), args);
    }
  });
}
