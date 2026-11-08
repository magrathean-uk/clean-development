import test from "node:test";
import assert from "node:assert/strict";
import { VERSION, hookShimPath, hookShimText, runtimeRoot, shimRelease } from "../runtime/lib/conf.mjs";
import { hookCommandMatches } from "../runtime/lib/doctor.mjs";
import { managedHookCommand, managedTrustEntries } from "../runtime/lib/codex-trust.mjs";

const trustDoc = (commands) => ({ hooks: { Stop: [{ hooks: commands.map((command) => ({ type: "command", command })) }] } });

test("managed hook parser accepts shell-safe absolute and active HOME forms", () => {
  const spaced = "/Users/Alice Example/dev/machine/runtime/clean-development/active/bin/cd-hook";
  const versioned = "/Users/Alice Example/dev/machine/runtime/clean-development/0.6.7/bin/cd-hook";
  assert.deepEqual(managedHookCommand(`'${spaced}' stop codex`), {
    file: spaced, event: "Stop", harness: "codex", fromHome: false
  });
  assert.equal(managedHookCommand(`"${versioned}" stop codex`)?.file, versioned);
  assert.equal(managedHookCommand('"$HOME/dev/machine/runtime/clean-development/active/bin/cd-hook" stop codex')?.fromHome, true);
  assert.equal(managedHookCommand("'$HOME/dev/machine/runtime/clean-development/active/bin/cd-hook' stop codex"), null);
  assert.equal(managedHookCommand("$HOME/dev/machine/runtime/clean-development/active/bin/cd-hook stop codex"), null);
  assert.equal(managedHookCommand(`${versioned} stop codex`), null);

  const apostrophe = "/Users/O'Reilly/dev/machine/runtime/clean-development/active/bin/cd-hook";
  const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  assert.equal(managedHookCommand(`${shellQuote(apostrophe)} stop codex`)?.file, apostrophe);
  const unsafeHomes = ["/Users/Alice$(printf parser-probe)", "/Users/Alice`printf parser-probe`", "/Users/Alice$VAR", "/Users/Alice\\path", "/Users/Alice!path"];
  for (const home of unsafeHomes) {
    const shim = `${home}/dev/machine/runtime/clean-development/active/bin/cd-hook`;
    const command = `"${shim}" stop codex`, env = { HOME: home };
    assert.equal(managedHookCommand(command), null);
    assert.equal(managedTrustEntries("/Users/Alice/.codex/hooks.json", trustDoc([command]), env).length, 0);
  }
});

test("doctor and Codex trust use the same accepted active shim spellings", () => {
  const env = { HOME: "/Users/Alice Example" };
  const active = hookShimPath(env);
  const accepted = [`'${active}' stop codex`, `"${active}" stop codex`];
  for (const command of accepted) assert.equal(hookCommandMatches(env, "Stop", "codex", command), true);

  const noSpaceEnv = { HOME: "/Users/Alice" };
  const noSpaceShim = hookShimPath(noSpaceEnv);
  const simpleAccepted = [`'${noSpaceShim}' stop codex`, `"${noSpaceShim}" stop codex`, `${noSpaceShim} stop codex`];
  for (const command of simpleAccepted) assert.equal(hookCommandMatches(noSpaceEnv, "Stop", "codex", command), true);
  assert.equal(managedTrustEntries("/Users/Alice/.codex/hooks.json", trustDoc(simpleAccepted), noSpaceEnv).length, 3);
  const noncanonical = [
    noSpaceShim.replace("/dev/machine/", "//dev/machine/"),
    noSpaceShim.replace("/dev/machine/", "/./dev/machine/"),
    noSpaceShim.replace("/dev/machine/", "/../Alice/dev/machine/"),
  ];
  for (const file of noncanonical) {
    const command = `'${file}' stop codex`;
    assert.equal(managedHookCommand(command)?.file, file);
    assert.equal(hookCommandMatches(noSpaceEnv, "Stop", "codex", command), false);
    assert.equal(managedTrustEntries("/Users/Alice/.codex/hooks.json", trustDoc([command]), noSpaceEnv).length, 0);
  }
  const versioned = `${runtimeRoot(noSpaceEnv)}/0.6.7/bin/cd-hook`;
  assert.equal(managedTrustEntries("/Users/Alice/.codex/hooks.json", trustDoc([`'${versioned}' stop codex`]), noSpaceEnv).length, 1);
  const outside = "/tmp/evil/runtime/clean-development/active/bin/cd-hook";
  const traversal = `${runtimeRoot(noSpaceEnv)}/active/bin/../../../../../../tmp/evil/runtime/clean-development/active/bin/cd-hook`;
  assert.equal(managedTrustEntries("/Users/Alice/.codex/hooks.json", trustDoc([`'${outside}' stop codex`]), noSpaceEnv).length, 0);
  assert.equal(managedTrustEntries("/Users/Alice/.codex/hooks.json", trustDoc([`'${traversal}' stop codex`]), noSpaceEnv).length, 0);

  const apostropheEnv = { HOME: "/Users/O'Reilly" };
  const apostropheShim = hookShimPath(apostropheEnv);
  const escapedApostrophe = `'${apostropheShim.replaceAll("'", "'\\''")}' stop codex`;
  assert.equal(hookCommandMatches(apostropheEnv, "Stop", "codex", escapedApostrophe), true);
  assert.equal(managedTrustEntries("/Users/O'Reilly/.codex/hooks.json", trustDoc([escapedApostrophe]), apostropheEnv).length, 1);

  const literalHome = "'$HOME/dev/machine/runtime/clean-development/active/bin/cd-hook' stop codex";
  assert.equal(hookCommandMatches(noSpaceEnv, "Stop", "codex", literalHome), false);
  assert.equal(managedTrustEntries("/Users/Alice/.codex/hooks.json", trustDoc([literalHome]), noSpaceEnv).length, 0);
  assert.equal(shimRelease(hookShimText(apostropheEnv), apostropheEnv), VERSION);
});
