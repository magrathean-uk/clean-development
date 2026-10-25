// Every fixture, including its simulated external volume, stays under explicit session scratch.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const plugin = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const runtime = path.join(plugin, "runtime");
export function sim({ mounted = true } = {}) {
  const base = process.env.CLEAN_DEV_TEST_DIR;
  if (!base || !path.isAbsolute(base)) throw new Error("CLEAN_DEV_TEST_DIR must be absolute scratch");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "safety-"));
  const home = path.join(root, "home");
  const vol = path.join(root, "Volumes", "4TB");
  fs.mkdirSync(path.join(home, "dev", "machine"), { recursive: true });
  if (mounted) fs.mkdirSync(path.join(vol, "machine", "cache"), { recursive: true });
  const config = path.join(home, "dev", "machine", "storage.conf");
  fs.writeFileSync(config, fs.readFileSync(path.join(plugin, "machine", "storage.conf"), "utf8")
    .replace(/^EXTERNAL_ROOT=.*$/m, `EXTERNAL_ROOT=${vol}/machine`)
    .replace(/^LAB_ROOT=.*$/m, `LAB_ROOT=${vol}/dev/lab`)
    .replace(/^MODELS_ROOT=.*$/m, `MODELS_ROOT=${vol}/models`));
  return { root, home, vol, config, env: { HOME: home, PATH: "/usr/bin:/bin", DEV_STORAGE_VOLUME_TEST: mounted ? "mounted" : "absent" },
    ext: path.join(vol, "machine", "cache"), int: path.join(home, "dev", "machine", "cache"),
    sessions: path.join(home, "dev", "machine", "state", "clean-development", "sessions") };
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
export function repo(s) {
  const p = path.join(s.home, "dev", "source", "project");
  fs.mkdirSync(p, { recursive: true });
  const r = spawnSync("/usr/bin/git", ["init", "-q", p], { env: { ...s.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error("fixture git init failed");
  mk(path.join(p, ".gitignore"), ".build/\n");
  mk(path.join(p, ".clean-development.json"), JSON.stringify({ schemaVersion: 2, buildDirs: [".build"] }));
  return p;
}
export async function gone(p) {
  const end = Date.now() + 4000;
  while (fs.existsSync(p) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return !fs.existsSync(p);
}
export async function waitFor(predicate, ms = 4000) {
  const end = Date.now() + ms;
  do { if (predicate()) return true; await new Promise((r) => setTimeout(r, 25)); } while (Date.now() < end);
  return false;
}
