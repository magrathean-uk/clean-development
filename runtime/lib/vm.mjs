// VM migration preserves file data, modes and times; not xattrs, ACLs, BSD flags or hard links.
// SHA256 verification covers file data only.
// Darwin uses system Perl's fcntl bridge to reclaim APFS speculative hole allocation.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homeDir } from "./conf.mjs";
import { safeDirectory, strictlyBelow, syncDirectory, writeFileAtomic } from "./fsutil.mjs";

export const VM_TOOLS = {
  colima: { env: "COLIMA_HOME", home: "colima-home", legacy: ["~/.colima"] },
  lima: { env: "LIMA_HOME", home: "lima-home", legacy: ["~/.lima"] },
  tart: { env: "TART_HOME", home: "tart-home", legacy: ["~/.tart"] }
};
const toolInfo = (tool) => {
  if (!Object.hasOwn(VM_TOOLS, tool)) throw new Error(`unknown VM tool: ${tool}`);
  return VM_TOOLS[tool];
};
const expand = (p, env) => path.resolve(p.startsWith("~/") ? path.join(homeDir(env), p.slice(2)) : p);
const stat = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
export function vmHome(conf, tool) { return path.join(conf.labRoot, "VM", toolInfo(tool).home); }

export function sparseCopyFile(src, dst, { blockSize = 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(blockSize) || blockSize < 1) throw new Error("blockSize must be a positive integer");
  const input = fs.openSync(src, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let output, created = false;
  try {
    const st = fs.fstatSync(input);
    if (!st.isFile()) throw new Error("sparse copy source must be a regular file");
    output = fs.openSync(dst, "wx", 0o600); created = true;
    // APFS can allocate skipped gaps when a positional write extends EOF.
    fs.ftruncateSync(output, st.size);
    const buf = Buffer.alloc(blockSize), zero = Buffer.alloc(4096), holes = [];
    const hole = (start, end) => {
      if (process.platform !== "darwin") return;
      const last = holes.at(-1);
      if (last && last[1] === start) last[1] = end; else holes.push([start, end]);
      // Bounded memory: an alternating data/zero image would otherwise queue one record per 4 KiB.
      if (holes.length >= 65536) punch(holes.splice(0, holes.length - 1));
    };
    const punch = (list) => {
      const ranges = list.map(([start, end]) => [Math.ceil(start / 4096) * 4096, Math.floor(end / 4096) * 4096])
        .filter(([start, end]) => end > start).map(([start, end]) => `${start} ${end - start}\n`).join("");
      if (!ranges) return;
      fs.fsyncSync(output);
      const r = spawnSync("/usr/bin/perl", ["-e", 'open(my $f, ">&=3") or die $!; while (<STDIN>) { my ($off, $len) = split; my $hole = pack("LLqq", 0, 0, $off, $len); defined fcntl($f, 99, $hole) or die "punch hole: $!"; }'], {
        stdio: ["pipe", "pipe", "pipe", output], input: ranges, encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 30000, maxBuffer: 65536
      });
      if (r.error || r.status !== 0) throw new Error(`cannot reclaim sparse holes: ${r.error?.message || r.stderr || r.status}`);
    };
    for (let pos = 0; pos < st.size;) {
      const length = Math.min(blockSize, st.size - pos);
      let n = 0;
      while (n < length) {
        const read = fs.readSync(input, buf, n, length - n, pos + n);
        if (!read) throw new Error("source shortened during sparse copy");
        n += read;
      }
      for (let start = 0; start < n;) {
        const end = Math.min(start + 4096, n);
        if (buf.subarray(start, end).equals(zero.subarray(0, end - start))) { hole(pos + start, pos + end); start = end; continue; }
        let runEnd = end;
        while (runEnd < n) {
          const next = Math.min(runEnd + 4096, n);
          if (buf.subarray(runEnd, next).equals(zero.subarray(0, next - runEnd))) break;
          runEnd = next;
        }
        for (let written = start; written < runEnd;) {
          const count = fs.writeSync(output, buf, written, runEnd - written, pos + written);
          if (!count) throw new Error("short write during sparse copy");
          written += count;
        }
        start = runEnd;
      }
      pos += n;
    }
    fs.ftruncateSync(output, st.size);
    if (holes.length) punch(holes.splice(0));
    fs.fchmodSync(output, st.mode & 0o7777);
    fs.futimesSync(output, st.atimeMs / 1000, st.mtimeMs / 1000);
    fs.fsyncSync(output);
    return { bytes: st.size, allocatedBytes: fs.fstatSync(output).blocks * 512 };
  } catch (e) {
    if (created) { try { fs.unlinkSync(dst); } catch { /* retain the original error */ } }
    throw e;
  } finally { if (output !== undefined) fs.closeSync(output); fs.closeSync(input); }
}

const ps = (args, env) => spawnSync("/bin/ps", args, {
  env: { ...env, LC_ALL: "C", TZ: "UTC" }, encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === "ESRCH") return false; throw e; } };
export function vmRunning(tool, home, env = process.env, { maxDepth = 3, maxEntries = 10000, deadline = Date.now() + 5000 } = {}) {
  toolInfo(tool);
  const evidence = [];
  let running = false, unknown = false, inspected = 0;
  const failed = (p, reason) => { unknown = true; evidence.push({ path: p, status: "unknown", reason }); };
  const expired = (p) => { if (Date.now() < deadline) return false; failed(p, "inspection deadline exceeded"); return true; };
  const walk = (dir, depth) => {
    if (expired(dir)) return;
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { failed(dir, e.code || e.message); return; }
    if (names.length > maxEntries - inspected) { failed(dir, "inspection entry cap exceeded"); return; }
    names.sort();
    for (const name of names) {
      const p = path.join(dir, name);
      if (expired(p)) return;
      if (++inspected > maxEntries) { failed(p, "inspection entry cap exceeded"); return; }
      try {
        const st = fs.lstatSync(p);
        if (st.isDirectory()) {
          if (depth < maxDepth) walk(p, depth + 1); else failed(p, "inspection depth limit exceeded");
          continue;
        }
        if (!name.endsWith(".pid")) continue;
        if (!st.isFile()) { failed(p, "pid file is not a regular file"); continue; }
        if (st.size > 64) { failed(p, "invalid pid file"); continue; }
        const text = fs.readFileSync(p, "utf8").trim(), pid = Number(text);
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(pid) || pid <= 1) { failed(p, "invalid pid file"); continue; }
        if (!alive(pid)) { evidence.push({ path: p, pid, status: "dead" }); continue; }
        const r = ps(["-o", "lstart=", "-p", String(pid)], env);
        const started = Date.parse(`${String(r.stdout || "").trim()} UTC`);
        if (r.error || r.status !== 0 || !Number.isFinite(started)) {
          if (!alive(pid)) evidence.push({ path: p, pid, status: "dead" });
          else failed(p, "process start time unavailable");
        } else {
          const matches = started <= st.mtimeMs + 5000;
          evidence.push({ path: p, pid, started, status: matches ? "running" : "reused-pid" });
          if (matches) running = true;
        }
      } catch (e) { failed(p, e.code || e.message); }
    }
  };
  try { if (!fs.lstatSync(home).isDirectory()) throw new Error("VM home is not a real directory"); walk(home, 0); }
  catch (e) { failed(home, e.code || e.message); }
  if (tool === "tart" && !expired(home)) {
    const r = ps(["-axo", "pid=,command="], env);
    if (r.error || r.status !== 0) failed(home, "tart process inspection failed");
    else for (const line of r.stdout.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+((?:\S*\/)?tart\s+run(?:\s.*)?)$/);
      if (m && Number(m[1]) > 1) {
        try { if (alive(Number(m[1]))) { running = true; evidence.push({ pid: Number(m[1]), status: "running", command: m[2] }); } }
        catch (e) { failed(home, e.code || e.message); }
      }
    }
  }
  expired(home);
  return { running: unknown ? null : running, evidence };
}

function inventory(root) {
  const entries = [];
  const walk = (rel) => {
    const p = path.join(root, rel), st = fs.lstatSync(p);
    const type = st.isDirectory() ? "directory" : st.isFile() ? "file" : st.isSymbolicLink() ? "link" : st.isSocket() ? "socket" : "special";
    if (type === "special") throw new Error(`unsupported special file: ${p}`);
    entries.push({ rel, st, type, ...(type === "link" ? { target: fs.readlinkSync(p) } : {}) });
    if (type === "directory") for (const name of fs.readdirSync(p).sort()) walk(path.join(rel, name));
  };
  walk("");
  return entries;
}
const signature = (entries) => JSON.stringify(entries.map(({ rel, type, target, st }) => [rel, type, target, st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs]));
function digest(p) {
  const hash = createHash("sha256"), buf = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`not a regular file: ${p}`);
    let n, pos = 0;
    while ((n = fs.readSync(fd, buf, 0, buf.length, pos))) { hash.update(buf.subarray(0, n)); pos += n; }
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}
function existingParent(p) {
  while (!stat(p)) { const parent = path.dirname(p); if (parent === p) throw new Error("destination parent unavailable"); p = parent; }
  return p;
}
function sourceAllowed(source, realSource, conf, env) {
  const home = path.resolve(homeDir(env)), realHome = fs.realpathSync(home);
  const inside = (root, p) => root === p || strictlyBelow(root, p);
  if (realSource === realHome || source === home || realSource === path.parse(realSource).root
    || fs.statSync(realSource).dev !== fs.statSync(path.dirname(realSource)).dev) throw new Error("protected VM source: HOME or filesystem root");
  const lab = existingParent(conf.labRoot), realLab = path.join(fs.realpathSync(lab), path.relative(lab, conf.labRoot));
  const protectedRoots = [...conf.DEV_TOP_ALLOW].filter((name) => name !== "machine").concat("machine/state");
  for (const rel of protectedRoots) {
    const protectedPath = path.join(home, "dev", rel), parent = existingParent(protectedPath);
    const realProtected = path.join(fs.realpathSync(parent), path.relative(parent, protectedPath));
    // Neither inside a protected tree nor an ancestor of one (a `~/dev` holding a vms/ dir must not move with source/).
    if (inside(realProtected, realSource) || strictlyBelow(realSource, realProtected) || (inside(protectedPath, source) && !strictlyBelow(realLab, realSource)))
      throw new Error(`protected VM source: ${protectedPath}`);
  }
}
function toolMarkers(source, tool) {
  const directory = (p) => stat(p)?.isDirectory();
  if (tool === "tart") return directory(path.join(source, "vms"));
  if (directory(path.join(source, tool === "lima" ? "_config" : "_lima"))) return true;
  return fs.readdirSync(source).some((name) => {
    const child = path.join(source, name);
    return directory(child) && stat(path.join(child, `${tool}.yaml`))?.isFile();
  });
}
function destinationEmpty(destination) {
  const st = stat(destination);
  if (st && (!st.isDirectory() || fs.readdirSync(destination).length)) throw new Error("VM destination exists and is not an empty real directory");
}
function mountedLab(conf, env, destination) {
  const mp = conf.mountPoint;
  if (!mp || !strictlyBelow(mp, destination) || !safeDirectory(mp, destination)) throw new Error("labRoot volume not mounted or redirected");
  if (env.DEV_STORAGE_VOLUME_TEST === "absent") throw new Error("labRoot volume not mounted");
  // The test switch never vouches for a real volume: /Volumes/<name> is always checked by device.
  const fixture = !/^\/Volumes\/[^/]+$/.test(path.resolve(mp));
  if (!(fixture && ["mounted", "present"].includes(env.DEV_STORAGE_VOLUME_TEST))
    && fs.statSync(mp).dev === fs.statSync(path.dirname(mp)).dev) throw new Error("labRoot volume not mounted");
}
function removePartial(p) {
  const st = stat(p);
  if (!st) return;
  if (st.isDirectory()) {
    fs.chmodSync(p, (st.mode & 0o7777) | 0o700);
    for (const name of fs.readdirSync(p)) removePartial(path.join(p, name));
    fs.rmdirSync(p);
  } else fs.unlinkSync(p);
}

export function vmMove(conf, env, tool, { from, apply = false, experimental = false } = {}) {
  const info = toolInfo(tool);
  if (apply && !experimental) throw new Error("vm move is experimental; pass --experimental --apply");
  if (!conf.valid) throw new Error("invalid storage configuration");
  const source = from ? expand(from, env) : info.legacy.map((p) => expand(p, env)).find((p) => stat(p)?.isDirectory());
  if (!source || !stat(source)?.isDirectory()) throw new Error("VM source must be an existing real directory, not a link");
  const destination = vmHome(conf, tool);
  mountedLab(conf, env, destination);
  const realSource = fs.realpathSync(source), ancestor = existingParent(destination);
  sourceAllowed(source, realSource, conf, env);
  const realDestination = path.join(fs.realpathSync(ancestor), path.relative(ancestor, destination));
  if (realSource === realDestination || strictlyBelow(realSource, realDestination) || strictlyBelow(realDestination, realSource))
    throw new Error("VM source and destination must not overlap");
  const trashRoot = path.join(homeDir(env), ".Trash");
  if (!safeDirectory(homeDir(env), trashRoot) || realSource === homeDir(env) || strictlyBelow(realSource, trashRoot))
    throw new Error("unsafe VM Trash location");
  if (!toolMarkers(source, tool)) throw new Error(`VM source lacks ${tool} tool markers`);
  destinationEmpty(destination);
  const liveness = vmRunning(tool, source, env);
  if (liveness.running !== false) throw new Error(`VM is running or its state is unknown: ${JSON.stringify(liveness.evidence)}`);
  const entries = inventory(source), files = entries.filter((e) => e.type === "file");
  const allocatedBytes = files.reduce((n, e) => n + e.st.blocks * 512, 0);
  const space = fs.statfsSync(ancestor), free = Number(space.bavail) * Number(space.bsize);
  if (!Number.isFinite(free) || free < allocatedBytes) throw new Error("insufficient free space for VM allocated bytes");
  const plan = { tool, source, destination, fileCount: files.length, apparentBytes: files.reduce((n, e) => n + e.st.size, 0), allocatedBytes,
    skippedSockets: entries.filter((e) => e.type === "socket").map((e) => e.rel),
    actions: ["sparse copy to a partial directory", "verify every regular file with sha256", "rename the copy to destination",
      "park the original in ~/.Trash with MANIFEST.txt (retain it in place on EXDEV)", "link the source path to destination after parking"] };
  if (!apply) return { ...plan, status: "preview" };
  const partial = `${destination}.partial-${randomUUID()}`;
  let created = false, promoted = false, restored = false, original = source, trash;
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.mkdirSync(partial, { mode: 0o700 }); created = true;
    for (const e of entries.slice(1)) {
      const src = path.join(source, e.rel), dst = path.join(partial, e.rel);
      if (e.type === "directory") fs.mkdirSync(dst, { mode: 0o700 });
      else if (e.type === "file") sparseCopyFile(src, dst);
      else if (e.type === "link") fs.symlinkSync(e.target, dst);
    }
    const manifest = files.map((e) => {
      const sha256 = digest(path.join(source, e.rel));
      if (sha256 !== digest(path.join(partial, e.rel))) throw new Error(`sha256 mismatch: ${e.rel}`);
      return `${JSON.stringify(e.rel)}\t${e.st.size}\t${sha256}\n`;
    }).join("");
    if (signature(entries) !== signature(inventory(source))) throw new Error("VM source changed during copy; original retained");
    if (vmRunning(tool, source, env).running !== false) throw new Error("VM started during copy or its state is unknown");
    for (const e of entries.filter((e) => e.type === "directory").reverse()) {
      const dst = path.join(partial, e.rel);
      fs.chmodSync(dst, e.st.mode & 0o7777); fs.utimesSync(dst, e.st.atimeMs / 1000, e.st.mtimeMs / 1000); syncDirectory(dst);
    }
    destinationEmpty(destination);
    fs.renameSync(partial, destination); promoted = true;
    syncDirectory(path.dirname(destination));
    fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    trash = path.join(trashRoot, `${tool}-home-${stamp}`);
    fs.mkdirSync(trash, { mode: 0o700 });
    const fd = fs.openSync(path.join(trash, "MANIFEST.txt"), "wx", 0o600);
    try { fs.writeFileSync(fd, manifest); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(trash);
    const parked = path.join(trash, path.basename(source) === "MANIFEST.txt" ? "original" : path.basename(source));
    if (signature(entries) !== signature(inventory(source))) throw new Error("VM source changed after verification; original retained");
    try { fs.renameSync(source, parked); } catch (e) {
      if (e.code !== "EXDEV") throw e;
      return { ...plan, status: "original-retained", originalRetained: true, linked: false, trash, original,
        message: "original retained; move it to Trash yourself" };
    }
    original = parked;
    syncDirectory(trash); syncDirectory(path.dirname(source));
    try { fs.symlinkSync(destination, source); } catch (e) {
      try {
        if (stat(source)) throw new Error("source path is occupied");
        fs.renameSync(parked, source); original = source; restored = true;
      } catch (restore) { throw new Error(`${e.message}; original restoration failed: ${restore.message}`); }
      syncDirectory(trash); syncDirectory(path.dirname(source));
      throw e;
    }
    syncDirectory(path.dirname(source));
    return { ...plan, status: "moved", originalRetained: true, linked: true, trash, original };
  } catch (e) {
    if (restored) throw new Error(`${e.message}; original restored; destination copy kept at ${destination}`);
    if (!promoted && created) {
      try { removePartial(partial); } catch (cleanup) { throw new Error(`${e.message}; partial cleanup failed: ${partial} (${cleanup.message}); original retained at ${source}`); }
    }
    throw new Error(`${e.message}; original retained at ${original}${promoted ? `; verified destination at ${destination}` : ""}`);
  }
}

// ---- Colima home (0.6.2). Colima may inherit LIMA_HOME, while its own layout uses $COLIMA_HOME/_lima. The optional
// clean-development shim pins that relationship; colimaRehome moves instances previously created under lima-home there:
// stopped instances only, same-volume renames (no copy, no data rewrite), refusing anything uncertain. A fence file that
// the optional shim honours ($COLIMA_HOME/.cd-rehome.lock) stops shim-launched starts while it runs (limactl invoked
// directly is not fenced); liveness is re-inspected under the fence just before the renames. A durable manifest in
// ~/dev/machine/records/clean-development records each completed rename, so an interrupted move or rollback resumes.
// Keys: each Lima home has its own _config/user; Lima writes cloud-init with a new instance id on every boot, so the first
// start under the new home authorises that home's key (the old key stays authorised in the guest). Generated files that
// embed the old home (ssh.config) are rewritten on start.
const COLIMA_INSTANCE = /^colima(?:-([A-Za-z0-9][A-Za-z0-9._-]*))?$/;
const DISK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const recordsDir = (env) => path.join(homeDir(env), "dev", "machine", "records", "clean-development");
// Manifests live directly in the records dir, reached through real directories only.
function manifestProblem(env, file) {
  const dir = recordsDir(env);
  if (!safeDirectory(homeDir(env), dir)) return `records directory is not a real directory under HOME: ${dir}`;
  if (path.dirname(path.resolve(file)) !== dir || !/^colima-rehome-[0-9TZ-]+\.json$/.test(path.basename(file))) return `manifest must be a colima-rehome-*.json file directly in ${dir}`;
  const st = stat(file);
  return st && (!st.isFile() || st.isSymbolicLink()) ? `manifest is not a regular file: ${file}` : null;
}
const rehomeFence = (colimaHome) => path.join(colimaHome, ".cd-rehome.lock");
function keyOf(home) { try { return fs.readFileSync(path.join(home, "_config", "user.pub"), "utf8").trim().split(/\s+/).slice(0, 2).join(" "); } catch { return null; } }
function keyFingerprint(key) { return key ? `SHA256:${createHash("sha256").update(Buffer.from(key.split(" ")[1] || "", "base64")).digest("base64").replace(/=+$/, "")}` : null; }
// A plain (unquoted) name must decode as a string: it starts with a letter and is not a YAML 1.1 bool/null word (0x10,
// 1e3, yes, ~ would be typed by Lima's decoder). Quoted names may not contain escapes (DISK_NAME has no backslash).
const YAML_WORDS = /^(?:true|false|yes|no|on|off|y|n|null|nan|inf)$/i;
const unquote = (v) => {
  const s = String(v).trim(), q = s.match(/^(["'])(.*)\1$/);
  if (q) return DISK_NAME.test(q[2]) ? q[2] : null;
  return /^[A-Za-z][A-Za-z0-9._-]*$/.test(s) && !YAML_WORDS.test(s) ? s : null;
};

// Lima additionalDisks names, or null for any form this conservative block-YAML reader does not fully understand (flow
// mappings or lists, anchors, tabs, an item without a name): the caller refuses rather than leave a data disk behind.
export function limaDiskNames(yaml) {
  // LF-only, unindented-root documents: a CR line break or an indented root would hide keys from this line reader.
  if (/[\r\u0085\u2028\u2029\ufeff]/.test(String(yaml))) return null;
  const lines = String(yaml).split("\n");
  const first = lines.find((l) => l.trim() && !/^\s*#/.test(l));
  if (first !== undefined && /^\s/.test(first)) return null;
  // Block documents only: one unquoted top-level key and no other mention, no flow document, explicit keys or merges.
  const content = lines.map((l) => l.replace(/(^|\s)#.*$/, ""));
  const mentions = content.filter((l) => /additionalDisks/.test(l));
  if (mentions.length > 1 || (mentions.length === 1 && !/^additionalDisks\s*:/.test(mentions[0]))) return null;
  // Every top-level line must be a plain key (no quotes, escapes, tags, aliases, explicit or flow forms), so no spelling
  // of additionalDisks can hide from the mention check.
  // A column-0 `-` is an unindented item of the key above it, never a top-level sequence.
  let seenKey = false;
  for (const [i, l] of content.entries()) {
    if (!/^\S/.test(l) || (i === 0 && /^---\s*$/.test(l))) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*:(\s|$)/.test(l)) seenKey = true;
    else if (!(seenKey && /^-(\s|$)/.test(l))) return null;
  }
  if (content.some((l) => /^\s*<<\s*:/.test(l))) return null;
  const start = lines.findIndex((l) => /^additionalDisks\s*:/.test(l));
  if (start < 0) return [];
  const head = lines[start].replace(/^additionalDisks\s*:/, "").replace(/\s+#.*$/, "").trim();
  if (head === "[]") return [];
  if (head !== "") return null;
  const items = [];
  let dashIndent = null;
  for (const raw of lines.slice(start + 1)) {
    if (/\t/.test(raw)) return null;
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const line = raw.replace(/\s+#.*$/, ""), indent = line.match(/^ */)[0].length;
    if (indent > 0 && /(^|[\s:\-,\[{])[&*][A-Za-z0-9_]/.test(line)) return null;
    const dash = line.match(/^( *)-(?:\s+(.*))?$/);
    if (indent === 0 && !dash) break;
    // A dash at the item column starts an item; a deeper one is nested content of the current item (fsArgs and similar).
    if (dash && (dashIndent === null || dash[1].length <= dashIndent)) {
      dashIndent ??= dash[1].length;
      if (dash[1].length !== dashIndent) return null;
      const rest = (dash[2] || "").trim();
      if (!rest || /^[{\[&*!|>]/.test(rest)) return null;
      const kv = rest.match(/^([A-Za-z]+)\s*:\s*(.*)$/);
      if (kv) items.push({ name: kv[1] === "name" ? unquote(kv[2]) : undefined });
      else { const n = unquote(rest); if (!n) return null; items.push({ name: n, scalar: true }); }
      continue;
    }
    if (!items.length || indent <= dashIndent) return null;
    const item = items[items.length - 1];
    if (item.scalar) return null;
    const kv = line.match(/^ *name\s*:\s*(.*)$/);
    if (kv && indent === dashIndent + 2) { if (item.name !== undefined) return null; item.name = unquote(kv[1]); }
  }
  const names = items.map((i) => i.name);
  if (names.some((n) => !n) || new Set(names).size !== names.length) return null;
  return names;
}
// Lima's own reading of an instance (`limactl list --json`): its additionalDisks and status. The line reader above must
// agree with it, so a YAML form either one misreads refuses instead of leaving a disk behind. limactl list can tidy
// (stale pid files, network config), so it runs under sandbox-exec with every filesystem write denied. null: unknown.
export const READ_ONLY_PROFILE = '(version 1)(allow default)(deny file-write* (subpath "/"))';
const executable = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };
export function parseLimaList(stdout, name) {
  try {
    const rows = String(stdout).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x?.name === name);
    const config = rows.length === 1 ? rows[0].config : null;
    if (!config || typeof config !== "object" || Array.isArray(config)) return null;
    const disks = config.additionalDisks ?? [];
    if (!Array.isArray(disks)) return null;
    const names = disks.map((d) => typeof d === "string" ? d : d?.name);
    return names.every((n) => typeof n === "string") && typeof rows[0].status === "string" ? { status: rows[0].status, disks: names } : null;
  } catch { return null; }
}
function readLima(name, limaHome, env) {
  const bin = ["/opt/homebrew/bin/limactl", "/usr/local/bin/limactl"].find(executable);
  if (!bin || !executable("/usr/bin/sandbox-exec")) return null;
  const r = spawnSync("/usr/bin/sandbox-exec", ["-p", READ_ONLY_PROFILE, bin, "list", "--json", name], {
    env: { ...env, LIMA_HOME: limaHome }, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
  return r.error || r.status !== 0 ? null : parseLimaList(r.stdout, name);
}
// Tests replace the reader in-process; no environment variable can.
let limaView = readLima;
export function setLimaReaderForTests(fn) { limaView = fn || readLima; }
function instanceProcesses(dirs, env) {
  const r = ps(["-axo", "pid=,args="], env);
  if (r.error || r.status !== 0) return null;
  return r.stdout.split("\n").filter((l) => dirs.some((d) => l.includes(d))).map((l) => l.trim().slice(0, 200));
}
// Nearest existing ancestor's device: a missing destination parent is created on the same volume as its ancestor.
function deviceOf(p) { for (let d = p; ; d = path.dirname(d)) { const s = stat(d); if (s) return s.dev; if (d === path.dirname(d)) return null; } }
// Every move stays in the VM lab through real directories (no link anywhere in either parent chain) on one volume.
function moveProblem(conf, m) {
  for (const p of [m.from, m.to]) if (!strictlyBelow(path.join(conf.labRoot, "VM"), p) || !safeDirectory(conf.labRoot, path.dirname(p))) return `path leaves the VM lab or crosses a link: ${p}`;
  if (deviceOf(m.from) !== deviceOf(path.dirname(m.to))) return `different volumes: ${m.from} -> ${m.to}; rename only, refusing to copy`;
  return null;
}
function inspectInstance(conf, name, from, to, env) {
  const inst = path.join(from, name), refuse = (reason) => ({ instance: name, refused: reason });
  const st = stat(inst);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) return refuse("not a real directory");
  let yaml;
  try { yaml = fs.readFileSync(path.join(inst, "lima.yaml"), "utf8"); } catch (e) { return refuse(`lima.yaml unreadable (${e.code || e.message})`); }
  const disks = limaDiskNames(yaml);
  if (disks === null) return refuse("additionalDisks not understood; move by hand");
  if (stat(path.join(from, "_disks", name)) && !disks.includes(name)) return refuse(`_disks/${name} exists but lima.yaml does not reference it`);
  for (const d of disks) if (!stat(path.join(from, "_disks", d))) return refuse(`referenced disk ${d} is not in ${from}/_disks`);
  const moves = disks.map((d) => ({ from: path.join(from, "_disks", d), to: path.join(to, "_disks", d) }));
  moves.push({ from: inst, to: path.join(to, name) });
  for (const m of moves) {
    const problem = moveProblem(conf, m);
    if (problem) return refuse(problem);
    const s = stat(m.from);
    if (!s.isDirectory() || s.isSymbolicLink()) return refuse(`${m.from} is not a real directory`);
    if (stat(m.to)) return refuse(`destination exists: ${m.to}`);
    if (stat(path.join(m.from, "in_use_by"))) return refuse(`disk locked by a running instance: ${m.from}/in_use_by`);
  }
  for (const f of ["ha.sock", "ssh.sock"]) if (stat(path.join(inst, f))) return refuse(`${f} present; stop it with colima stop first`);
  const running = vmRunning("lima", inst, env, { maxDepth: 1, maxEntries: 200 });
  if (running.running !== false) return refuse(running.running ? "instance running" : "instance state unknown");
  const procs = instanceProcesses(moves.map((m) => m.from), env);
  if (procs === null) return refuse("process table unreadable");
  if (procs.length) return refuse(`process uses it: ${procs[0]}`);
  const lima = limaView(name, from, env);
  if (!lima) return refuse("limactl cannot confirm the instance's disks and state");
  if (lima.status !== "Stopped") return refuse(`limactl reports ${lima.status || "an unknown state"}`);
  const ours = [...disks].sort().join(" "), theirs = [...lima.disks].sort().join(" ");
  if (ours !== theirs) return refuse(`lima.yaml reads as disks [${ours}] but limactl reports [${theirs}]`);
  return { instance: name, profile: COLIMA_INSTANCE.exec(name)[1] || "default", moves };
}
// A Lima additional disk is shared by pathname, not copied into an instance directory. Each migration plan moves
// one profile's disks without consolidating duplicate paths, so inspect every Colima profile and refuse shared disks.
function diskReferences(from) {
  const references = new Map(), problems = [];
  let names;
  try { names = fs.readdirSync(from).filter((name) => COLIMA_INSTANCE.test(name)).sort(); }
  catch (e) { return { references, problems: [e.code || e.message] }; }
  for (const name of names) {
    const instance = path.join(from, name), instanceStat = stat(instance);
    if (!instanceStat?.isDirectory() || instanceStat.isSymbolicLink()) { problems.push(`${name}: not a real directory`); continue; }
    const yamlFile = path.join(instance, "lima.yaml"), yamlStat = stat(yamlFile);
    if (!yamlStat?.isFile() || yamlStat.isSymbolicLink()) { problems.push(`${name}: lima.yaml unavailable or linked`); continue; }
    let yaml;
    try { yaml = fs.readFileSync(yamlFile, "utf8"); } catch (e) { problems.push(`${name}: lima.yaml unreadable (${e.code || e.message})`); continue; }
    const disks = limaDiskNames(yaml);
    if (disks === null) { problems.push(`${name}: additionalDisks not understood`); continue; }
    for (const disk of disks) {
      if (!references.has(disk)) references.set(disk, new Set());
      references.get(disk).add(name);
    }
  }
  return { references, problems };
}
function excludeUnsafeDiskMoves(plan, from) {
  const { references, problems } = diskReferences(from), safe = [];
  for (const instance of plan.instances) {
    const disks = instance.moves.slice(0, -1).map((move) => path.basename(move.from));
    let reason = disks.length && problems.length ? `cannot verify shared disk references (${problems[0]})` : "";
    if (!reason) for (const disk of disks) {
      const otherUsers = [...(references.get(disk) || [])].filter((name) => name !== instance.instance);
      if (otherUsers.length) { reason = `additional disk ${disk} is also referenced by ${otherUsers.join(", ")}`; break; }
    }
    if (reason) plan.refused.push({ instance: instance.instance, refused: reason });
    else safe.push(instance);
  }
  plan.instances = safe;
}
// Two-flag mutual exclusion with the colima shim: take the fence, then look for live shim runs
// ($COLIMA_HOME/.cd-colima-run.<pid>, written before the shim checks the fence and kept for the whole colima command).
function liveColimaRuns(colimaHome) {
  return fs.readdirSync(colimaHome).filter((n) => /^\.cd-colima-run\.\d+$/.test(n)).map((n) => Number(n.split(".").pop()))
    .filter((pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } });
}
// Any colima or limactl process (a colima child that outlived a killed shim, a host agent, a direct limactl start).
const VM_PROCESS = /(?:^|\/)(?:colima|limactl)(?:\s|$)/;
function vmProcesses(env) {
  const r = ps(["-axo", "pid=,args="], env);
  if (r.error || r.status !== 0) return null;
  return r.stdout.split("\n").map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter((m) => m && Number(m[1]) !== process.pid && VM_PROCESS.test(m[2])).map((m) => `${m[1]} ${m[2].slice(0, 160)}`);
}
function withFence(colimaHome, env, fn) {
  const fence = rehomeFence(colimaHome);
  let fd;
  try { fd = fs.openSync(fence, "wx", 0o600); }
  catch (e) { if (e.code === "EEXIST") throw new Error(`${fence} exists: another colima-rehome runs or one was interrupted; inspect it, then remove it by hand`); throw e; }
  try { fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    syncDirectory(colimaHome);
    const runs = liveColimaRuns(colimaHome);
    if (runs.length) throw new Error(`colima commands are running (pid ${runs.join(", ")}); nothing moved`);
    const procs = vmProcesses(env);
    if (procs === null) throw new Error("process table unreadable; nothing moved");
    if (procs.length) throw new Error(`Colima/Lima processes are running (${procs[0]}${procs.length > 1 ? ` and ${procs.length - 1} more` : ""}); stop every Colima and Lima VM first; nothing moved`);
    return fn();
  } finally { fs.unlinkSync(fence); }
}
// Immediately before a rename: the move is still admissible and nothing has started using it.
function renameCheck(conf, m, env) {
  const problem = moveProblem(conf, m);
  if (problem) return problem;
  const src = stat(m.from);
  if (!src || !src.isDirectory() || src.isSymbolicLink()) return `not a real directory: ${m.from}`;
  if (stat(m.to)) return `destination exists: ${m.to}`;
  for (const f of ["in_use_by", "ha.sock", "ssh.sock"]) if (stat(path.join(m.from, f))) return `in use: ${path.join(m.from, f)}`;
  if (stat(path.join(m.from, "lima.yaml")) && vmRunning("lima", m.from, env, { maxDepth: 1, maxEntries: 200 }).running !== false) return `instance running or unknown: ${m.from}`;
  // Again right before the rename: a direct limactl start bypasses the shim's fence (Lima has no instance lock to share).
  const procs = vmProcesses(env);
  if (procs === null || procs.length) return procs === null ? "process table unreadable" : `Colima/Lima process appeared: ${procs[0]}`;
  return null;
}
// Where each planned move is now, by filesystem truth (a crash may have renamed without journalling).
function locate(m) {
  const atTo = stat(m.to), atFrom = stat(m.from);
  return atTo && !atFrom ? "moved" : !atTo && atFrom ? "home" : atTo ? "both" : "missing";
}
const journal = (file, body) => writeFileAtomic(file, JSON.stringify(body, null, 2) + "\n", 0o600, { durable: true });

export function colimaRehome(conf, env, { profile = null, apply = false, now = new Date() } = {}) {
  const from = vmHome(conf, "lima"), colima = vmHome(conf, "colima"), to = path.join(colima, "_lima");
  mountedLab(conf, env, colima);
  for (const d of [from, colima]) if (!safeDirectory(conf.labRoot, d)) throw new Error(`not a real lab directory: ${d}`);
  if (!safeDirectory(conf.labRoot, path.join(to, "_disks"))) throw new Error(`not a real lab directory: ${to}`);
  const keys = { from: keyFingerprint(keyOf(from)), to: keyFingerprint(keyOf(to)) };
  const survey = () => {
    const plan = { from, to, keys, instances: [], refused: [] };
    if (!stat(from)) return plan;
    for (const name of fs.readdirSync(from).filter((n) => COLIMA_INSTANCE.test(n)).sort()) {
      if (profile && (COLIMA_INSTANCE.exec(name)[1] || "default") !== profile) continue;
      const r = inspectInstance(conf, name, from, to, env);
      (r.refused ? plan.refused : plan.instances).push(r);
    }
    excludeUnsafeDiskMoves(plan, from);
    plan.next = plan.instances.map((i) => { const p = i.profile === "default" ? "" : ` -p ${i.profile}`; return `colima start${p} && colima ssh${p} -- true`; });
    if (keys.from !== keys.to) plan.keyNote = "the homes have different _config/user keys: the first start under the new home authorises its key (Lima regenerates cloud-init with a new instance id every boot); the old key stays authorised in the guest";
    return plan;
  };
  const preview = survey();
  if (!apply || !preview.instances.length) return { ...preview, status: preview.instances.length ? "preview" : "nothing to move" };
  if (!stat(colima)) {
    fs.mkdirSync(colima, { mode: 0o700 });
    syncDirectory(path.dirname(colima));
  }
  return withFence(colima, env, () => {
    // Re-inspect under the fence: only what is still stopped, unlocked and unchanged moves.
    const plan = survey();
    if (JSON.stringify(plan.instances) !== JSON.stringify(preview.instances)) throw new Error("instances changed between preview and fence; nothing moved, rerun");
    const moves = plan.instances.flatMap((i) => i.moves), done = [];
    const manifest = path.join(recordsDir(env), `colima-rehome-${now.toISOString().replace(/[:.]/g, "-")}.json`);
    const instances = plan.instances.map((i) => ({ instance: i.instance, to: i.moves[i.moves.length - 1].to, disks: i.moves.slice(0, -1).map((m) => path.basename(m.to)) }));
    const record = (status, extra = {}) => journal(manifest, { kind: "colima-rehome", createdAt: now.toISOString(), status, instances, moves, done, ...extra });
    if (!safeDirectory(homeDir(env), recordsDir(env))) throw new Error(`records directory is not a real directory under HOME: ${recordsDir(env)}`);
    fs.mkdirSync(recordsDir(env), { recursive: true, mode: 0o700 });
    const mp = manifestProblem(env, manifest);
    if (mp) throw new Error(mp);
    if (stat(manifest)) throw new Error(`manifest exists: ${manifest}`);
    record("moving");
    for (const d of [to, path.join(to, "_disks")]) if (!stat(d)) { fs.mkdirSync(d, { mode: 0o700 }); syncDirectory(path.dirname(d)); }
    try {
      for (const m of moves) {
        const problem = renameCheck(conf, m, env);
        if (problem) throw new Error(problem);
        fs.renameSync(m.from, m.to);
        done.push(m);
        record("moving");
        syncDirectory(path.dirname(m.from)); syncDirectory(path.dirname(m.to));
      }
    } catch (e) {
      // Revert every planned move that is at its destination now, whatever the journal managed to record.
      const undo = [];
      for (const m of [...moves].reverse()) {
        if (locate(m) !== "moved") continue;
        const back = { from: m.to, to: m.from }, problem = renameCheck(conf, back, env);
        if (problem) { undo.push(`${m.to}: ${problem}`); continue; }
        try { fs.renameSync(back.from, back.to); syncDirectory(path.dirname(back.from)); syncDirectory(path.dirname(back.to)); }
        catch (u) { undo.push(`${m.to} -> ${m.from}: ${u.code || u.message}`); }
      }
      done.splice(0, done.length, ...moves.filter((m) => locate(m) === "moved"));
      try { record(undo.length ? "partial" : "reverted", { error: e.message, undo }); } catch { /* rollback reconciles planned moves by filesystem truth */ }
      throw new Error(`${e.message}; ${undo.length ? `revert incomplete (${undo.join("; ")}); resume with --rollback ${manifest}` : "every completed rename reverted"}`);
    }
    record("moved");
    return { ...plan, status: "moved", manifest, rollback: `clean-development vm colima-rehome --rollback ${manifest} --apply` };
  });
}

// Reverses a colima-rehome manifest, resuming an interrupted move or rollback. Every planned move is reconciled by
// filesystem truth (a crash may have renamed without journalling): at its destination it is reversed, back at its
// source it is skipped, anything else refuses. Apply re-surveys under the fence and rechecks before every rename.
export function colimaRehomeRollback(conf, env, manifest, { apply = false } = {}) {
  manifest = path.resolve(manifest);
  const mp = manifestProblem(env, manifest);
  if (mp) throw new Error(mp);
  const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (m?.kind !== "colima-rehome" || !Array.isArray(m.moves) || !Array.isArray(m.instances) || !["moving", "moved", "partial", "reverted", "rolling back"].includes(m.status)) throw new Error("not a resumable colima-rehome manifest");
  if (!m.moves.every((x) => typeof x?.from === "string" && typeof x?.to === "string")) throw new Error("malformed manifest move");
  // A disk attached after the move would be stranded by moving the instance back without it: refuse any change.
  const diskChange = () => {
    for (const i of m.instances) {
      if (typeof i?.instance !== "string" || typeof i?.to !== "string" || !Array.isArray(i.disks)) throw new Error("malformed manifest instance");
      const mv = m.moves.find((x) => x.to === i.to);
      if (!mv || locate(mv) !== "moved") continue; // back home, or ambiguous: the per-move survey decides
      let yaml;
      try { yaml = fs.readFileSync(path.join(i.to, "lima.yaml"), "utf8"); } catch (e) { throw new Error(`${i.instance}: lima.yaml unreadable (${e.code || e.message})`); }
      const ours = limaDiskNames(yaml), lima = limaView(i.instance, path.dirname(i.to), env), want = [...i.disks].sort().join(" ");
      if (ours === null || !lima) throw new Error(`${i.instance}: cannot confirm its disks (line reader or limactl)`);
      if ([...ours].sort().join(" ") !== want || [...lima.disks].sort().join(" ") !== want) throw new Error(`${i.instance}: disks changed since the move (now [${[...ours].sort().join(" ")}], moved [${want}]); move them by hand`);
      if (lima.status !== "Stopped") throw new Error(`${i.instance}: limactl reports ${lima.status}`);
    }
  };
  const colima = vmHome(conf, "colima");
  mountedLab(conf, env, colima);
  const survey = () => {
    diskChange();
    const steps = [];
    for (const x of [...m.moves].reverse()) {
      const where = locate(x);
      if (where === "home") continue;
      if (where !== "moved") throw new Error(`cannot tell where ${x.from} is: ${where === "both" ? "both locations exist" : "neither location exists"}`);
      const back = { from: x.to, to: x.from }, problem = renameCheck(conf, back, env);
      if (problem) throw new Error(problem);
      steps.push(back);
    }
    const procs = instanceProcesses(steps.map((x) => x.from), env);
    if (procs === null || procs.length) throw new Error(procs === null ? "process table unreadable" : `process uses it: ${procs[0]}`);
    return steps;
  };
  const record = (status) => journal(manifest, { ...m, status, done: m.moves.filter((x) => locate(x) === "moved"), rolledBackAt: new Date().toISOString() });
  if (!apply) return { manifest, moves: survey(), status: "preview" };
  return withFence(colima, env, () => {
    const steps = survey();
    for (const x of steps) {
      const problem = renameCheck(conf, x, env);
      if (problem) { record("rolling back"); throw new Error(`${problem}; rerun --rollback to resume`); }
      fs.renameSync(x.from, x.to);
      record("rolling back");
      syncDirectory(path.dirname(x.from)); syncDirectory(path.dirname(x.to));
    }
    record("rolled back");
    return { manifest, moves: steps, status: "rolled back" };
  });
}
