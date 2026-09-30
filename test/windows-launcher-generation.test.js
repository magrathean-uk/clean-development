import assert from "node:assert/strict";
import test from "node:test";
import { windowsLauncherContents } from "../src/runtime.js";

test("Windows generated launchers store percent paths literally and disable inherited delayed expansion", () => {
  const node = String.raw`C:\node-%CD_LITERAL_TOKEN%-!CD_LITERAL_TOKEN!\node.exe`;
  const entrypoint = String.raw`D:\runtime;root & tools\50%\clean-development.js`;
  const contents = windowsLauncherContents(node, entrypoint, ["agent", "codex", "--"]);
  assert.deepEqual(contents.split("\r\n"), [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    '"C:\\node-%%CD_LITERAL_TOKEN%%-!CD_LITERAL_TOKEN!\\node.exe" "D:\\runtime;root & tools\\50%%\\clean-development.js" "agent" "codex" "--" %*',
    ""
  ]);
  assert.equal(contents.match(/%\*/g).length, 1);
});

test("Windows launcher generation rejects ambiguous fixed values before writing a file", () => {
  for (const bad of ["a\nb", "a\rb", "a\0b", 'a"b']) {
    assert.throws(() => windowsLauncherContents(bad, "safe.js"), /literal single-line/);
    assert.throws(() => windowsLauncherContents("node.exe", bad), /literal single-line/);
    assert.throws(() => windowsLauncherContents("node.exe", "safe.js", [bad]), /literal single-line/);
  }
});
