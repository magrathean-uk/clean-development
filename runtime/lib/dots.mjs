// clean-development 0.6.0: no-dot-folder policy for ~ and ~/dev (Q8/Q9). Report only, never delete.
import fs from "node:fs";
import path from "node:path";
import { children } from "./fsutil.mjs";

export function scanDots(dir, allowDirs, allowFiles = new Set()) {
  const folders = [];
  const files = [];
  for (const d of children(dir)) {
    if (!d.name.startsWith(".") || d.name === "." || d.name === "..") continue;
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) { try { isDir = fs.statSync(path.join(dir, d.name)).isDirectory(); } catch { isDir = true; } }
    if (isDir) { if (!allowDirs.has(d.name)) folders.push(d.name); }
    else if (!allowFiles.has(d.name) && !/^\.zcompdump/.test(d.name)) files.push(d.name);
  }
  return { folders: folders.sort(), files: files.sort() };
}

export function dotReport(conf, home) {
  const h = scanDots(home, conf.HOME_DOT_ALLOW, conf.HOME_DOTFILE_ALLOW);
  const d = scanDots(path.join(home, "dev"), conf.DEV_DOT_ALLOW, conf.DEV_DOT_ALLOW);
  return {
    folders: [...h.folders.map((n) => `~/${n}`), ...d.folders.map((n) => `~/dev/${n}`)],
    files: [...h.files.map((n) => `~/${n}`), ...d.files.map((n) => `~/dev/${n}`)]
  };
}
