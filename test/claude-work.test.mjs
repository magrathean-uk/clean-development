// Existing seat/authentication tests use fake CLIs and mocked VPS fetches. Give their parent process
// a fabricated HOME too, so nested zsh cannot run the real user's startup/configuration hooks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { plugin, sim } from "./helpers.mjs";

const root = path.dirname(plugin), suite = path.join(root, "runbook", "claude-work");
test("numbered Claude profile regression suite remains offline and isolated under an aliased temporary directory", { skip: !fs.existsSync(suite), timeout: 60000 }, (t) => {
  const s = sim({ mounted: false }), imports = path.join(s.home, "dev", "source");
  fs.mkdirSync(imports, { recursive: true }); fs.symlinkSync(root, path.join(imports, "bolyki-dev"));
  const tmp = path.join(s.root, "tmp"), alias = path.join(s.root, "tmp-alias");
  fs.mkdirSync(tmp); fs.symlinkSync(tmp, alias);
  const python = process.env.CLEAN_DEV_TEST_PYTHON || "/opt/homebrew/bin/python3";
  const r = spawnSync(python, ["-I", "-B", "-m", "unittest", "discover", "-s", suite, "-p", "test_*.py"], {
    cwd: s.root, env: { ...s.env, TMPDIR: alias, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8", timeout: 55000 });
  assert.equal(r.status, 0, r.stderr);
  const count = r.stderr.match(/Ran (\d+) tests/);
  assert.ok(count, r.stderr);
  t.diagnostic(`${count[1]} existing profile tests passed using fabricated HOME, CLI, logins and mocked VPS responses`);
});
