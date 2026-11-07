// clean-development 0.6.2: activity evidence for session liveness. A pid alone is never proof: a pid is the same
// process only while its start time matches the record (or predates the pid file that named it). Unknown is live.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { lstatOrNull, timeLeft } from "./fsutil.mjs";

// Launchers between a harness and its hook process (cd-hook, the shim and `sh -c` exec into each other).
const WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "env", "cd-hook", "perl", "timeout"]);
const START_SLACK_MS = 2000, PIDFILE_SLACK_MS = 5000, TABLE_TTL_MS = 10000;
// An observation that could not complete (tree too large or deep, too many pid files, unreadable, deadline, ps unreadable)
// retains for at most this many days of shallow idleness: longer than the 7-day weak window because a
// miss deletes live work, bounded because a crashed session with a huge tree must not be immortal.
export const UNOBSERVED_DAYS = 30;

// One `ps` per invocation (cached 10 s), not one per pid: a Stop over ~450 pins must not spawn hundreds of processes.
// Map pid -> { pid, ppid, startedAt, command }, or null when ps cannot be read (every answer is then unknown).
let table = null, tableAt = 0;
function processTable(deadline = Infinity) {
  if (process.env.DEV_STORAGE_VOLUME_TEST && process.env.CLEAN_DEV_TEST_PS_FAIL === "1") return null; // test mode only
  if (table !== null && Date.now() - tableAt < TABLE_TTL_MS) return table;
  const timeout = Math.max(1, timeLeft(deadline, 2000));
  const r = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,lstart=,comm="], { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", ...(process.env.TZ ? { TZ: process.env.TZ } : {}) } });
  tableAt = Date.now();
  if (r.error || r.status !== 0) { table = null; tableAt = 0; return null; }
  table = new Map();
  for (const line of String(r.stdout).split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/);
    if (!m) continue;
    const startedAt = Date.parse(m[3]);
    table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), startedAt: Number.isFinite(startedAt) ? startedAt : null, command: path.basename(m[4].trim()) });
  }
  return table;
}
export function resetProcessTable() { table = null; tableAt = 0; }

// { pid, ppid, startedAt, command } for a live process, null when it does not exist, undefined when unknown.
export function processInfo(pid, { deadline = Infinity } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const t = processTable(deadline);
  if (!t) return undefined;
  return t.get(pid) || null;
}

// The harness that launched this hook: the first ancestor that is not a shell or launcher wrapper (at most 4 hops).
// Test mode only (DEV_STORAGE_VOLUME_TEST set): CLEAN_DEV_TEST_HARNESS_PID names the harness; 0 records none.
export function harnessProcess(startPid = process.ppid, env = process.env) {
  if (env.DEV_STORAGE_VOLUME_TEST && /^\d+$/.test(env.CLEAN_DEV_TEST_HARNESS_PID || "")) {
    const info = processInfo(Number(env.CLEAN_DEV_TEST_HARNESS_PID));
    return info?.startedAt ? { pid: info.pid, startedAt: info.startedAt, command: info.command } : null;
  }
  let pid = startPid;
  for (let hop = 0; hop < 4 && pid > 1; hop++) {
    const info = processInfo(pid);
    if (!info) return null;
    if (!WRAPPERS.has(info.command) && info.startedAt) return { pid: info.pid, startedAt: info.startedAt, command: info.command };
    pid = info.ppid;
  }
  return null;
}

// true: the recorded process still runs; false: gone or pid reused; null: cannot tell.
export function processAlive(rec, { notAfter = null, deadline = Infinity } = {}) {
  if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 1) return false;
  try { process.kill(rec.pid, 0); } catch (e) { if (e.code === "ESRCH") return false; if (e.code !== "EPERM") return null; }
  const info = processInfo(rec.pid, { deadline });
  if (info === null) {
    // kill(0) saw it; a table snapshot may predate a just-started process. Refresh once before calling it gone.
    resetProcessTable();
    const again = processInfo(rec.pid, { deadline });
    if (again === null) return false;
    if (!again?.startedAt) return null;
    return matches(rec, again, notAfter);
  }
  if (!info?.startedAt) return null;
  return matches(rec, info, notAfter);
}
function matches(rec, info, notAfter) {
  if (Number.isFinite(rec.startedAt)) return Math.abs(info.startedAt - rec.startedAt) <= START_SLACK_MS;
  if (Number.isFinite(notAfter)) return info.startedAt <= notAfter + PIDFILE_SLACK_MS;
  return true;
}

// Bounded breadth-first walk; deadline checked per entry. visit(fullPath, dirent) may return false to stop.
// Returns { complete, timedOut, truncated, unreadable, stopped }: anything but complete is an incomplete observation.
function walk(root, visit, { deadline = Infinity, maxEntries = 20000, maxDepth = 5 } = {}) {
  let queue = [[root, 0]], seen = 0;
  while (queue.length) {
    const next = [];
    for (const [dir, depth] of queue) {
      if (!timeLeft(deadline)) return { complete: false, timedOut: true };
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT") continue; return { complete: false, unreadable: e.code || e.message }; }
      for (const d of entries) {
        if (!timeLeft(deadline)) return { complete: false, timedOut: true };
        if (++seen > maxEntries) return { complete: false, truncated: "entries" };
        const p = path.join(dir, d.name);
        if (visit(p, d) === false) return { complete: false, stopped: true };
        if (d.isDirectory()) {
          if (depth + 1 >= maxDepth) return { complete: false, truncated: "depth" };
          next.push([p, depth + 1]);
        }
      }
    }
    queue = next;
  }
  return { complete: true };
}

// Newest mtime anywhere below p (files and directories, links not followed). Infinity when the observation is
// incomplete: an append deep inside tmp/<job>/ changes no directory mtime, which is how 0.6.0 trashed live scratch.
export function deepLastUsedMs(p, { ignore = null, ...options } = {}) {
  const st = lstatOrNull(p);
  if (!st) return 0;
  let newest = st.mtimeMs;
  if (!st.isDirectory()) return newest;
  const r = walk(p, (full, d) => { if (ignore?.has(d.name)) return; const c = lstatOrNull(full); if (c && c.mtimeMs > newest) newest = c.mtimeMs; }, { maxDepth: 8, ...options });
  return r.complete ? newest : Infinity;
}

// Jobs that announced themselves with a *.pid file below dir and still run (start time not after the file was written).
// { jobs: [{ file, pid, unknown? }], complete, reason }. Stops at the first running job. Any incomplete observation
// (deadline, too many entries or pid files, too deep, unreadable) is reported, and callers retain the directory.
export function pidFileJobs(dir, { deadline = Infinity, maxEntries = 20000, maxDepth = 8, maxChecks = 64 } = {}) {
  const jobs = [];
  let checks = 0, overChecks = false;
  if (!lstatOrNull(dir)?.isDirectory()) return { jobs, complete: true };
  const r = walk(dir, (full, d) => {
    if (!d.isFile() || !/\.pid$/.test(d.name)) return;
    if (++checks > maxChecks) { overChecks = true; return false; }
    const st = lstatOrNull(full);
    if (!st || st.size > 64) return;
    let pid;
    try { pid = Number.parseInt(fs.readFileSync(full, "utf8").trim(), 10); } catch { return; }
    if (!Number.isInteger(pid) || pid <= 1) return;
    const alive = processAlive({ pid }, { notAfter: st.mtimeMs, deadline });
    if (alive !== false) { jobs.push({ file: full, pid, ...(alive === null ? { unknown: true } : {}) }); return false; }
  }, { deadline, maxEntries, maxDepth });
  const complete = r.complete === true || (r.stopped === true && jobs.length > 0);
  const reason = complete ? null : overChecks ? "more than 64 pid files" : r.timedOut ? "deadline" : r.truncated ? `tree too ${r.truncated === "depth" ? "deep" : "large"}` : r.unreadable ? `unreadable (${r.unreadable})` : "incomplete";
  return { jobs, complete, reason, timedOut: !!r.timedOut };
}
