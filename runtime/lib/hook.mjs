// SessionStart context only. Reads routing and free space without creating state or probing writes.
import { homeDir, loadConf } from "./conf.mjs";
import { detect, fmtGB, freeBytes } from "./storage.mjs";

export function contextText(env = process.env) {
  const conf = loadConf(env);
  const decision = detect(conf, env, { probe: false, create: false });
  const free = freeBytes(decision.root) ?? freeBytes(decision.mode === "internal" ? homeDir(env) : conf.mountPoint);
  const offer = free !== null && free < conf.INTERNAL_MIN_FREE_GB * 1024 ** 3 ? "; cleanup available: ask to review candidates" : "";
  const policy = conf.valid ? "" : "; storage.conf problems: using internal defaults";
  return `clean-development: mode=${decision.mode}; root=${decision.root}; free=${fmtGB(free)}${offer}${policy}`.replace(/[\r\n]/g, " ");
}
