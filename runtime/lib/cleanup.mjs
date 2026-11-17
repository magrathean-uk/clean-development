// Read-only selection; explicit apply moves approved items to their own volume's Trash.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { context, inside, realPath, walk } from "./report.mjs";
import { freeBytes } from "./storage.mjs";

const DAY = 86400000;
const overlaps = (a, b) => inside(a, b) || inside(b, a);

function directories(parent, errors) {
  try {
    return fs.readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory())
      .map((d) => path.join(parent, d.name)).sort();
  } catch (e) {
    if (e.code !== "ENOENT") errors?.push(parent);
    return [];
  }
}

function git(dir, args) {
  const r = spawnSync("git", ["--no-optional-locks", "-C", dir, ...args], {
    encoding: "utf8", timeout: 10000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

function mergedCleanWorktree(dir) {
  try { if (!fs.lstatSync(path.join(dir, ".git")).isFile()) return false; } catch { return false; }
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top || realPath(top) !== realPath(dir) || git(dir, ["status", "--porcelain", "--untracked-files=all"]) !== "") return false;
  let base = git(dir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (!base) {
    // Without a recorded remote default, accept only an unambiguous conventional local default.
    const defaults = ["refs/heads/main", "refs/heads/master"].filter((ref) => git(dir, ["show-ref", "--verify", ref]) !== null);
    if (defaults.length !== 1) return false;
    [base] = defaults;
  }
  return git(dir, ["merge-base", "--is-ancestor", "HEAD", base]) !== null;
}

function claims(projects, errors) {
  const all = [], byProject = new Map();
  for (const project of new Set(projects)) {
    const file = path.join(project, ".clean-development.json");
    try {
      try { fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("not an object");
      const paths = [];
      for (const key of ["buildDirs", "depDirs"]) {
        const values = config[key] ?? [];
        if (!Array.isArray(values) || values.some((v) => typeof v !== "string" || !v || /[\x00-\x1f\x7f]/.test(v))) throw new Error("invalid claim paths");
        for (const value of values) paths.push(realPath(path.resolve(project, value)));
      }
      all.push(...paths);
      byProject.set(realPath(project), paths);
    } catch { errors.push(file); }
  }
  return { all, byProject };
}

// Reject redirected ancestors, while still permitting real paths obtained from project claims.
function plainDirectory(item) {
  let p = item;
  while (true) {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) return false;
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  return fs.lstatSync(item).isDirectory();
}

export function cleanup(env = process.env, { project, now = Date.now() } = {}) {
  const c = context(env), errors = [], skipped = [], items = [];
  if (!c.conf.valid) throw new Error(`invalid storage policy: ${c.conf.errors.join("; ")}`);
  const roots = [c.conf.internalRoot, c.conf.externalCache].map(realPath);
  const active = realPath(c.root), work = realPath(c.work);
  const worktrees = directories(path.join(work, "worktrees"), errors).flatMap((repo) => directories(repo, errors));
  const projects = [...directories(path.join(c.home, "dev", "source"), errors), ...worktrees];
  if (project) projects.push(realPath(project));
  const claimed = claims(projects, errors);
  const own = [env.CLEAN_DEV_BUILDS, env.CLEAN_DEV_SCRATCH, env.CLEAN_DEVELOPMENT_SCRATCH_ROOT,
    env.TMPDIR && (env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID) ? path.dirname(env.TMPDIR) : null]
    .filter(Boolean).map(realPath);
  function add(item, kind, reason, minAge = DAY) {
    try {
      if (!plainDirectory(item) || own.some((p) => overlaps(p, item))) return;
      // No root or aggregate, even if a project claims it or a work root is misconfigured.
      if (roots.some((root) => inside(item, root) || path.dirname(item) === root)) return;
      if (kind !== "c" && roots.some((root) => inside(path.join(root, "deps"), item))) return;
      const fingerprint = walk(item);
      if (now - fingerprint.newest < minAge) return;
      items.push({ path: item, kind, reason, ...fingerprint });
    } catch (e) { skipped.push(`skipped: ${item} (${e.code || e.message})`); }
  }
  for (const dir of worktrees) if (mergedCleanWorktree(dir)) add(dir, "a", "merged clean worktree");
  for (const group of directories(path.join(work, "jobs"))) {
    for (const dir of [group, ...directories(group)]) {
      try { if (fs.lstatSync(path.join(dir, ".done")).isFile()) add(dir, "b", "completed job (.done)"); } catch { /* unfinished */ }
    }
  }
  if (project) for (const dir of claimed.byProject.get(realPath(project)) || []) {
    if (roots.some((root) => inside(root, dir))) add(dir, "c", "project claim");
  }
  if (errors.length) {
    for (const file of [...new Set(errors)].sort()) skipped.push(`unknown-owner: skipped (unreadable claim ${file})`);
  } else {
    for (const [root, kind] of [[active, "d"], ...(c.mode === "external" ? [[roots[0], "e"]] : [])]) {
      for (const category of ["builds", "scratch"]) for (const dir of directories(path.join(root, category))) {
        if (!claimed.all.some((p) => overlaps(p, dir))) add(dir, kind, kind === "d" ? "unknown owner; quiet for 7 days" : "internal fallback; unknown owner; quiet for 7 days", 7 * DAY);
      }
    }
  }
  // One row per path and no ancestor/descendant pairs in the same list.
  const unique = [...new Map(items.map((item) => [item.path, item])).values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const selected = unique.filter((item) => !unique.some((other) => other !== item && inside(other.path, item.path)));
  const lines = selected.map((r) => `${r.path}\t${r.bytes}\t${r.count}\t${r.newest}`);
  const id = createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
  return { mode: c.mode, root: c.root, items: selected, skipped, id };
}

export function cleanupText(result) {
  return [...result.items.map((r, i) => `${i + 1}. (${r.kind}) ${r.path}\t${r.bytes} bytes\t${r.reason}`),
    ...result.skipped, `list: ${result.id}`].join("\n");
}

function trashFor(item, c) {
  const home = realPath(c.home);
  if (inside(home, item)) return { volume: home, trash: path.join(home, ".Trash") };
  const external = c.conf.mountPoint && realPath(c.conf.mountPoint);
  const volume = external && inside(external, item) ? external : item.match(/^\/Volumes\/[^/]+(?=\/)/)?.[0];
  if (volume) {
    if (volume === external && context(c.env).mode !== "external") throw new Error("external volume is not mounted and writable");
    return { volume, trash: path.join(volume, ".Trashes", String(process.getuid())) };
  }
  return { volume: home, trash: path.join(home, ".Trash") };
}

// Create each component separately, refusing symlinks and a different device at every step.
function ensureTrash(volume, trash, device) {
  if (!plainDirectory(volume) || fs.statSync(volume).dev !== device) throw new Error("Trash is on a different volume");
  let current = volume;
  for (const part of path.relative(volume, trash).split(path.sep)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
    if (!plainDirectory(current) || fs.statSync(current).dev !== device) throw new Error(`unsafe Trash directory: ${current}`);
  }
}

export function applyCleanup(env = process.env, { id, skip, project, now = Date.now() } = {}) {
  // No writes, including creating the Trash, until the complete list matches.
  const result = cleanup(env, { project, now });
  if (id !== result.id) return { status: 3, error: `cleanup refused: list changed or id does not match; list: ${result.id}` };
  const excluded = new Set();
  if (skip !== undefined) {
    if (typeof skip !== "string" || !/^[1-9]\d*(?:,[1-9]\d*)*$/.test(skip)) throw new Error("--skip needs comma-separated row numbers");
    for (const value of skip.split(",")) {
      const row = Number(value);
      if (!Number.isSafeInteger(row) || row > result.items.length || excluded.has(row)) throw new Error(`invalid --skip row: ${value}`);
      excluded.add(row);
    }
  }
  const c = { ...context(env), env }, groups = new Map(), moved = [], failed = [];
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "");
  try {
    for (const [index, item] of result.items.entries()) {
      if (excluded.has(index + 1)) continue;
      let group, offset;
      try {
        if (!plainDirectory(item.path)) throw new Error("candidate is no longer a plain directory");
        const source = fs.statSync(item.path), target = trashFor(item.path, c);
        let repository;
        if (item.kind === "a") {
          const common = git(item.path, ["rev-parse", "--git-common-dir"]);
          if (!common) throw new Error("cannot identify worktree repository");
          const absolute = path.resolve(item.path, common);
          repository = path.basename(absolute) === ".git" ? path.dirname(absolute) : absolute;
        }
        group = groups.get(target.trash);
        if (!group) {
          ensureTrash(target.volume, target.trash, source.dev);
          const dir = fs.mkdtempSync(path.join(target.trash, `clean-development-${stamp}-`));
          fs.chmodSync(dir, 0o700);
          const manifest = path.join(dir, "MANIFEST.txt");
          const fd = fs.openSync(manifest, "wx", 0o600);
          group = { ...target, dir, manifest, fd, moved: 0, bytes: 0 };
          groups.set(target.trash, group);
        }
        if (!plainDirectory(group.dir) || fs.statSync(group.dir).dev !== source.dev) throw new Error("Trash is on a different volume");
        const destination = path.join(group.dir, `${index + 1}-${path.basename(item.path)}`);
        // Durably record the move before rename. A failed rename truncates only its uncommitted line.
        offset = fs.fstatSync(group.fd).size;
        const line = Buffer.from(`${JSON.stringify(item.path)}\t${item.bytes}\t${item.reason}\n`);
        if (fs.writeSync(group.fd, line, 0, line.length, offset) !== line.length) throw new Error("incomplete manifest write");
        fs.fsyncSync(group.fd);
        fs.renameSync(item.path, destination); // EXDEV is an item failure; there is no copy fallback.
        offset = undefined;
        moved.push({ ...item, destination, manifest: group.manifest });
        group.moved++; group.bytes += item.bytes;
        if (item.kind === "a" && context(env).mode === "external") {
          if (git(repository, ["worktree", "prune", "--expire", "now"]) === null) {
            failed.push({ path: item.path, error: "moved, but git worktree prune failed" });
          }
        }
      } catch (e) {
        if (group && offset !== undefined) {
          try { fs.ftruncateSync(group.fd, offset); fs.fsyncSync(group.fd); }
          catch (error) { failed.push({ path: group.manifest, error: `manifest repair failed: ${error.code || error.message}` }); }
        }
        failed.push({ path: item.path, error: e.code || e.message });
      }
    }
  } finally {
    for (const group of groups.values()) fs.closeSync(group.fd);
  }
  return { status: failed.length ? 1 : 0, moved, bytes: moved.reduce((sum, item) => sum + item.bytes, 0), failed,
    volumes: [...groups.values()].filter((g) => g.moved).map((g) => ({ path: g.volume, bytes: g.bytes, free: freeBytes(g.volume) })) };
}

export function applyText(result) {
  if (result.error) return result.error;
  return [`moved: ${result.moved.length} items, ${result.bytes} bytes`,
    ...result.volumes.flatMap((v) => [`volume: ${v.path}; moved: ${v.bytes} bytes`, `free: ${v.path}; ${v.free ?? "unavailable"} bytes`]),
    "Space returns when the Trash is emptied; you empty the Trash.",
    ...result.failed.map((f) => `failed: ${f.path} (${f.error})`)].join("\n");
}
