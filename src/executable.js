import fs from "node:fs";
import path from "node:path";
import { canonicalizePotentialPath, environmentValue, isPathInside } from "./platform.js";

function candidateNames(executable, env) {
  if (process.platform !== "win32") return [executable];
  if (path.extname(executable)) return [executable];
  const extensions = (environmentValue(env, "PATHEXT") || ".EXE;.CMD;.BAT;.COM").split(";");
  return [...extensions.map((item) => `${executable}${item.toLowerCase()}`), ...extensions.map((item) => `${executable}${item.toUpperCase()}`), executable];
}

function sameFile(left, right) {
  try {
    const a = fs.statSync(left, { bigint: true }), b = fs.statSync(right, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

function sameSnapshot(a, b) {
  return b.isFile() && ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].every((key) => a[key] === b[key]);
}

function fileIdentity(stat) {
  // Some filesystems do not expose useful inode numbers. Do not collapse
  // unrelated candidates into one when identity cannot be established.
  return stat?.isFile() && stat.ino !== 0n ? `${stat.dev}:${stat.ino}` : null;
}

function usableCandidate(file, rejectedFiles) {
  let descriptor;
  let expected;
  let accepted = false;
  try {
    expected = fs.statSync(file, { bigint: true });
    if (!expected.isFile() || rejectedFiles.has(fileIdentity(expected))) return false;
    fs.accessSync(file, fs.constants.X_OK);
    // A FIFO swapped in after stat must not block open on Unix. A successfully
    // opened handle is checked again before any read. Symlinked executables are
    // supported; the returned invocation path is not replaced with its referent.
    const flags = fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : (fs.constants.O_NONBLOCK || 0));
    try { descriptor = fs.openSync(file, flags); }
    catch (error) {
      // Execute-only regular files are valid on Unix. Preserve that behaviour
      // when content inspection is denied, but recheck type/identity and access.
      if (error.code !== "EACCES") return false;
      fs.accessSync(file, fs.constants.X_OK);
      accepted = sameSnapshot(expected, fs.statSync(file, { bigint: true }));
      return accepted;
    }
    if (!sameSnapshot(expected, fs.fstatSync(descriptor, { bigint: true }))) return false;
    const prefix = Buffer.alloc(4096);
    const bytes = fs.readSync(descriptor, prefix, 0, prefix.length, 0);
    if (!sameSnapshot(expected, fs.fstatSync(descriptor, { bigint: true }))
      || !sameSnapshot(expected, fs.statSync(file, { bigint: true }))) return false;
    const contents = prefix.toString("utf8", 0, bytes);
    accepted = !contents.includes("clean-development-shim.js")
      && !(contents.includes("import { runTool }") && contents.includes("import { resolveConfig }"));
    return accepted;
  } catch { return false; }
  finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (!accepted) {
      const previous = fileIdentity(expected);
      if (previous) rejectedFiles.add(previous);
      try {
        // A Windows case alias or a second hard link must not retry a file just
        // rejected for changing during inspection. Remember its replacement too.
        const current = fileIdentity(fs.statSync(file, { bigint: true }));
        if (current) rejectedFiles.add(current);
      } catch { /* Missing or inaccessible candidates remain rejected. */ }
    }
  }
}

/** Read-only executable discovery. Explicit paths remain caller-selected.
 * Relative PATH entries are resolved against the child's cwd, never the caller's.
 * Empty PATH entries remain ignored; use an explicit '.' to search the cwd.
 */
export function resolveExecutable(executable, env, excludedDirectory, cwd = process.cwd()) {
  if (executable.includes(path.sep) || (path.sep === "\\" && executable.includes("/"))) return path.resolve(cwd, executable);
  const excluded = excludedDirectory ? canonicalizePotentialPath(excludedDirectory) : null;
  const directories = (environmentValue(env, "PATH") || "").split(path.delimiter).filter(Boolean);
  const attemptedPaths = new Set(), rejectedFiles = new Set();
  for (const directory of directories) {
    const absolute = path.resolve(cwd, directory);
    if (excluded && canonicalizePotentialPath(absolute) === excluded) continue;
    for (const name of candidateNames(executable, env)) {
      const candidate = path.join(absolute, name);
      if (attemptedPaths.has(candidate)) continue;
      attemptedPaths.add(candidate);
      try {
        if (excluded && isPathInside(excluded, candidate)) continue;
        if (excluded && sameFile(candidate, path.join(excluded, name))) continue;
        if (usableCandidate(candidate, rejectedFiles)) return candidate;
      } catch {
        // Raced or inaccessible candidates do not hide later real tools.
      }
    }
  }
  return null;
}
