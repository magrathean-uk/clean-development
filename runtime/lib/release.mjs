// A release digest covers names, executable permissions and bytes; no symlink/special-file adoption.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const DIGEST_ALGORITHM = "sha256(sorted-relative-name,NUL,decimal-permissions,NUL,bytes)";
export function treeDigest(root) {
  const st = fs.lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`release root is not a real directory: ${root}`);
  const h = createHash("sha256");
  function walk(dir, rel = "") {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name), r = path.join(rel, name), st = fs.lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`release contains a symlink: ${p}`);
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) h.update(r).update("\0").update(String(st.mode & 0o777)).update("\0").update(fs.readFileSync(p));
      else throw new Error(`release contains a special file: ${p}`);
    }
  }
  walk(root); return h.digest("hex");
}
