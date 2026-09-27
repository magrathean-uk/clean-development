import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

export const DEFAULT_SCAN_LIMITS = Object.freeze({ maxEntries: 200_000, maxDurationMs: 5_000 });
const MAX_ISSUES = 20;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** A metadata-only scanner with one shared work budget across all its roots.
 * Time is checked between filesystem calls; a stalled syscall cannot be cancelled.
 * This is a best-effort observation, not a filesystem snapshot or a sandbox.
 */
export function createSizeScanner({ maxEntries = DEFAULT_SCAN_LIMITS.maxEntries, maxDurationMs = DEFAULT_SCAN_LIMITS.maxDurationMs } = {}) {
  for (const [name, value] of Object.entries({ maxEntries, maxDurationMs })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  }
  const started = performance.now();
  let visited = 0;
  const exhausted = () => visited >= maxEntries ? "entry-limit" : performance.now() - started >= maxDurationMs ? "time-limit" : null;
  const cached = new Map();

  function measure(root) {
    const resolved = path.resolve(root);
    if (cached.has(resolved)) return cached.get(resolved);
    const scanStarted = performance.now();
    const result = { schemaVersion: 1, path: resolved, status: "complete", logicalBytes: 0, allocatedBytes: null,
      files: 0, directories: 0, entriesVisited: 0, hardlinkDuplicates: 0, symlinksSkipped: 0, specialFilesSkipped: 0,
      issueCount: 0, issues: [], durationMs: 0 };
    let logical = 0n;
    let allocated = 0n;
    let allocationKnown = process.platform !== "win32";
    const seen = new Set();
    const issue = (code, file = resolved) => {
      result.status = "partial";
      result.issueCount += 1;
      if (result.issues.length < MAX_ISSUES) result.issues.push({ code, path: path.relative(resolved, file) || "." });
    };
    const errorCode = (error) => typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "io-error";
    const finish = () => {
      if (logical > BigInt(Number.MAX_SAFE_INTEGER)) { issue("logical-size-overflow"); result.logicalBytes = null; }
      else result.logicalBytes = Number(logical);
      if (allocationKnown && allocated <= BigInt(Number.MAX_SAFE_INTEGER)) result.allocatedBytes = Number(allocated);
      else if (allocationKnown) issue("allocated-size-overflow");
      if (["missing", "unsafe", "unavailable"].includes(result.status)) {
        result.logicalBytes = null;
        result.allocatedBytes = null;
      }
      result.durationMs = Math.round((performance.now() - scanStarted) * 100) / 100;
      cached.set(resolved, result);
      return result;
    };
    const noBudget = exhausted();
    if (noBudget) { issue(noBudget); return finish(); }
    let rootStat;
    try {
      rootStat = fs.lstatSync(resolved, { bigint: true });
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync.native(resolved) !== resolved) {
        issue("unsafe-root"); result.status = "unsafe"; return finish();
      }
    } catch (error) {
      issue(errorCode(error)); result.status = error.code === "ENOENT" ? "missing" : "unavailable"; return finish();
    }
    const pending = [{ file: resolved, stat: rootStat }];
    // Validate both the leaf identity and the entire canonical directory path.
    const validate = ({ file, stat }) => {
      const current = fs.lstatSync(file, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, stat)
        || fs.realpathSync.native(file) !== file) throw Object.assign(new Error("directory changed"), { code: "DIRECTORY_CHANGED" });
      return current;
    };
    while (pending.length) {
      const limit = exhausted();
      if (limit) { issue(limit); break; }
      const item = pending.pop();
      let directory;
      try {
        validate(item);
        directory = fs.opendirSync(item.file, { bufferSize: 32 });
        validate(item);
        result.directories += 1;
        while (true) {
          const stop = exhausted();
          if (stop) { issue(stop, item.file); break; }
          const entry = directory.readSync();
          if (!entry) break;
          visited += 1;
          result.entriesVisited += 1;
          const target = path.join(item.file, entry.name);
          let stat;
          validate(item);
          try {
            stat = fs.lstatSync(target, { bigint: true });
          } catch (error) { issue(errorCode(error), target); continue; }
          validate(item);
          if (stat.isSymbolicLink()) { result.symlinksSkipped += 1; continue; }
          if (stat.dev !== rootStat.dev) { issue("different-device", target); continue; }
          if (stat.isDirectory()) { pending.push({ file: target, stat }); continue; }
          if (!stat.isFile()) { result.specialFilesSkipped += 1; continue; }
          result.files += 1;
          logical += stat.size;
          // Logical bytes count file names; allocated bytes count each inode
          // once within this root. Neither is a reclaimable-space guarantee.
          const identity = `${stat.dev}:${stat.ino}`;
          if (stat.ino === 0n) allocationKnown = false;
          if (stat.ino !== 0n && seen.has(identity)) { result.hardlinkDuplicates += 1; continue; }
          seen.add(identity);
          if (typeof stat.blocks === "bigint" && stat.blocks >= 0n) allocated += stat.blocks * 512n;
          else allocationKnown = false;
        }
        const after = validate(item);
        if (after.mtimeNs !== item.stat.mtimeNs || after.ctimeNs !== item.stat.ctimeNs) issue("directory-changed-during-scan", item.file);
      } catch (error) { issue(errorCode(error), item.file); }
      finally {
        if (directory) {
          try { directory.closeSync(); } catch (error) { issue(errorCode(error), item.file); }
        }
      }
    }
    try { validate({ file: resolved, stat: rootStat }); }
    catch (error) { issue(errorCode(error)); }
    return finish();
  }
  return { measure, limits: { maxEntries, maxDurationMs } };
}

export function measureDirectory(root, options) {
  return createSizeScanner(options).measure(root);
}
