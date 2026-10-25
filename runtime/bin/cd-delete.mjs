#!/usr/bin/env node
// Detached deletion is only for validated, uniquely renamed trash (or a validated trash retry).
// Receipt status is distinct from the hook's scheduling status. Never fall back to an original path.
import path from "node:path";
import fs from "node:fs";
import { appendJsonl, deleteNow, safeDirectory, strictlyBelow } from "../lib/fsutil.mjs";

const queue = process.argv[2];
const { jobs, anchor, eventsFile } = JSON.parse(fs.readFileSync(queue, "utf8"));
if (eventsFile) appendJsonl(eventsFile, { ts: new Date().toISOString(), event: "delete-worker", status: "started", queue, jobs: jobs.length });
let failed = false;
for (const { id, path: p, source } of jobs) {
  let status = "completed", error;
  try {
    if (!safeDirectory(anchor, path.dirname(p)) || !strictlyBelow(path.join(anchor, "trash"), p)) throw new Error("unsafe deletion boundary");
    deleteNow(p);
  } catch (e) { status = "failed"; failed = true; error = e.code || e.message; }
  if (eventsFile) appendJsonl(eventsFile, { ts: new Date().toISOString(), event: "delete", id, status, source, path: p, ...(error ? { error } : {}) });
}
if (!failed && safeDirectory(anchor, path.dirname(queue)) && strictlyBelow(path.join(anchor, "trash"), queue)) {
  try { fs.unlinkSync(queue); } catch (e) { if (e.code !== "ENOENT") throw e; }
}
