import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadConf } from "../runtime/lib/conf.mjs";
import { sim } from "./helpers.mjs";

test("traversing external roots and overlapping disposable anchors are invalid", () => {
  const s = sim();
  fs.appendFileSync(s.config, "EXTERNAL_CACHE=${EXTERNAL_ROOT}/../../escape\n");
  assert.equal(loadConf(s.env).valid, false);
  const t = sim();
  fs.appendFileSync(t.config, `INTERNAL_ROOT=${t.home}/dev/machine\n`);
  assert.equal(loadConf(t.env).valid, false);
});
