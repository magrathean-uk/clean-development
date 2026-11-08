import test from "node:test";
import assert from "node:assert/strict";
import { hookShimPath } from "../runtime/lib/conf.mjs";
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
  assert.equal(managedTrustEntries("/Users/Alice/.codex/hooks.json", trustDoc(simpleAccepted)).length, 3);

  const literalHome = "'$HOME/dev/machine/runtime/clean-development/active/bin/cd-hook' stop codex";
  assert.equal(hookCommandMatches(noSpaceEnv, "Stop", "codex", literalHome), false);
  assert.equal(managedTrustEntries("/Users/Alice/.codex/hooks.json", trustDoc([literalHome])).length, 0);
});
