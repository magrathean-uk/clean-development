// Every fixture, including its simulated external volume, stays under explicit session scratch.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const plugin = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const runtime = path.join(plugin, "runtime");
const privateMarker = path.join(path.dirname(plugin), "machine", "env.private.zsh");
export const privateSourceEnabled = process.env.CLEAN_DEV_TEST_PRIVATE_SOURCE === "1" && (() => {
  try { const stat = fs.lstatSync(privateMarker); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
})();
function privateTestMap() {
  if (!privateSourceEnabled) return null;
  const root = path.dirname(plugin), mapFile = path.join(root, "machine", "clean-development", "private-test-sources.json");
  try {
    const map = JSON.parse(fs.readFileSync(mapFile, "utf8"));
    return map && typeof map === "object" && !Array.isArray(map) ? map : null;
  } catch { return null; }
}
export function privateTestValue(name) {
  const value = privateTestMap()?.[name];
  return typeof value === "string" ? value : null;
}
export function privateTestSource(name) {
  const relative = privateTestValue(name);
  if (relative === null || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) return null;
  return path.join(path.dirname(plugin), relative);
}
export function sim({ mounted = true } = {}) {
  const base = process.env.CLEAN_DEV_TEST_DIR;
  if (!base || !path.isAbsolute(base)) throw new Error("CLEAN_DEV_TEST_DIR must be absolute scratch");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, "safety-")));
  const home = path.join(root, "home");
  const vol = path.join(root, "Volumes", "External");
  fs.mkdirSync(path.join(home, "dev", "machine"), { recursive: true });
  if (mounted) fs.mkdirSync(path.join(vol, "dev", "cache"), { recursive: true });
  const config = path.join(home, "dev", "machine", "storage.conf");
  fs.writeFileSync(config, fs.readFileSync(path.join(plugin, "machine", "storage.conf"), "utf8")
    .replace(/^EXTERNAL_ROOT=.*$/m, `EXTERNAL_ROOT=${vol}/dev`)
    .replace(/^LAB_ROOT=.*$/m, `LAB_ROOT=${vol}/dev/lab`)
    .replace(/^MODELS_ROOT=.*$/m, `MODELS_ROOT=${vol}/models`));
  return { root, home, vol, config, env: { HOME: home, PATH: "/usr/bin:/bin", DEV_STORAGE_VOLUME_TEST: mounted ? "mounted" : "absent" },
    ext: path.join(vol, "dev", "cache"), int: path.join(home, "dev", "machine", "cache") };
}
export function hook(s, event, harness, input = {}) {
  return spawnSync(process.execPath, [path.join(runtime, "bin", "cd-hook.mjs"), event, harness], {
    input: JSON.stringify(input), cwd: s.root, env: s.env, encoding: "utf8", timeout: 15000 });
}
export function cli(s, args) {
  return spawnSync(process.execPath, [path.join(runtime, "bin", "clean-development.mjs"), ...args], {
    cwd: s.root, env: s.env, encoding: "utf8", timeout: 15000 });
}
export function mk(p, text = "sentinel") { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; }

// Include metadata as well as bytes: rewriting identical content is still a side effect.
export function snapshot(root) {
  const rows = [];
  function visit(item) {
    const st = fs.lstatSync(item);
    rows.push([path.relative(root, item), st.mode, st.ino, st.mtimeMs, st.ctimeMs,
      st.isSymbolicLink() ? fs.readlinkSync(item) : st.isFile() ? fs.readFileSync(item).toString("base64") : null]);
    if (st.isDirectory()) for (const name of fs.readdirSync(item).sort()) visit(path.join(item, name));
  }
  visit(root); return rows;
}
