// clean-development 0.6.3: Codex hook trust hashes, so changed hooks run without a /hooks review click.
// Mirrors openai/codex codex-rs/hooks/src/engine/discovery.rs (hook_hash, normalize_command_hook) and
// codex-rs/config/src/fingerprint.rs (version_for_toml): sha256 over compact JSON with recursively sorted keys of
// { event_name: <snake_case event>, matcher?: <matcher>, hooks: [<normalised handler>] }.
// Normalised command handler: type, command, commandWindows?, timeout (SessionEnd/Interrupt: default 1, clamp 1..3;
// others: default 600), async (default false), statusMessage?, additionalContextLimit?.
// The fingerprint format is covered by fixtures and checked against Codex hook state during installation review.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runtimeRoot } from "./conf.mjs";

const LABEL = (event) => event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}

export function normaliseHandler(event, h) {
  if (h.type !== "command") return null;
  const label = LABEL(event);
  const short = label === "session_end" || label === "interrupt";
  const t = Number.isInteger(h.timeout) ? h.timeout : undefined;
  const timeout = short ? Math.min(3, Math.max(1, t ?? 1)) : Math.max(1, t ?? 600);
  const out = { type: "command", command: h.command, timeout, async: h.async === true };
  const win = h.commandWindows ?? h.command_windows;
  if (typeof win === "string") out.commandWindows = win;
  if (typeof h.statusMessage === "string") out.statusMessage = h.statusMessage;
  if (Number.isInteger(h.additionalContextLimit)) out.additionalContextLimit = h.additionalContextLimit;
  return out;
}

export function hookHash(event, matcher, handler) {
  const identity = { event_name: LABEL(event), hooks: [handler] };
  if (typeof matcher === "string") identity.matcher = matcher;
  const json = JSON.stringify(sortDeep(identity));
  return "sha256:" + crypto.createHash("sha256").update(json).digest("hex");
}

// Returns [{ key, hash }] for every command handler in a hooks.json document located at hooksPath.
export function trustEntries(hooksPath, doc) {
  const out = [];
  for (const [event, groups] of Object.entries(doc?.hooks || {})) {
    (groups || []).forEach((g, gi) => {
      (g.hooks || []).forEach((h, hi) => {
        const n = normaliseHandler(event, h);
        if (!n) return;
        out.push({ key: `${hooksPath}:${LABEL(event)}:${gi}:${hi}`, hash: hookHash(event, g.matcher, n) });
      });
    });
  }
  return out;
}

export function trustToml(entries) {
  return entries.map((e) => `[hooks.state.${JSON.stringify(e.key)}]\ntrusted_hash = ${JSON.stringify(e.hash)}\n`).join("\n");
}

const HOOK_EVENT_NAMES = { "session-start": "SessionStart", stop: "Stop", "session-end": "SessionEnd" };
const HOME_ACTIVE_SHIM = "$HOME/dev/machine/runtime/clean-development/active/bin/cd-hook";
const ABSOLUTE_MANAGED_SHIM = /^\/.*\/runtime\/clean-development\/(?:\d+\.\d+\.\d+|active)\/bin\/cd-hook$/;

// Parse the shell-safe hook spellings written by current and legacy installers.
// $HOME must be double-quoted so the shell expands it; absolute paths may use
// single quotes, double quotes, or no quotes when the path has no spaces.
export function managedHookCommand(command) {
  const m = String(command || "").match(/^(?:"([^"\r\n]+)"|'((?:[^']|'\\'')+)'|(\/[A-Za-z0-9_./-]+)) (session-start|stop|session-end) (claude|codex)$/);
  if (!m) return null;
  const file = m[1] ?? m[2]?.replaceAll("'\\''", "'") ?? m[3];
  const fromHome = m[1] === HOME_ACTIVE_SHIM;
  // Inside double quotes, shell parameter/command substitution, backticks,
  // backslashes and history expansion remain active. Reject them before this
  // path can be treated as an owned hook. Single-quoted paths are literal.
  if (!fromHome && (!ABSOLUTE_MANAGED_SHIM.test(file) || (m[1] !== undefined && /[$`\\!]/.test(file)))) return null;
  return { file, event: HOOK_EVENT_NAMES[m[4]], harness: m[5], fromHome };
}

function installedRuntimeShim(file, env) {
  if (path.resolve(file) !== file) return false;
  let root;
  try { root = path.resolve(runtimeRoot(env)); } catch { return false; }
  return /^(?:\d+\.\d+\.\d+|active)\/bin\/cd-hook$/.test(path.relative(root, file));
}

export function managedTrustEntries(hooksPath, doc, env = process.env) {
  const owned = new Set();
  for (const [event, groups] of Object.entries(doc?.hooks || {})) (groups || []).forEach((g, gi) => (g.hooks || []).forEach((h, hi) => {
    const parsed = managedHookCommand(h.command);
    const managedPath = parsed?.fromHome || parsed && installedRuntimeShim(parsed.file, env);
    if (managedPath && parsed.harness === "codex" && parsed.event === event)
      owned.add(`${hooksPath}:${LABEL(event)}:${gi}:${hi}`);
  }));
  return trustEntries(hooksPath, doc).filter((e) => owned.has(e.key));
}

// Minimal reader for the [hooks.state."..."] trusted_hash lines of config.toml (no full TOML parser needed).
export function readHookStates(configToml) {
  const map = new Map();
  let current = null;
  for (const line of configToml.split(/\r?\n/)) {
    const h = line.match(/^\s*\[hooks\.state\.("(?:[^"\\]|\\.)*")\]\s*(?:#.*)?$/);
    if (h) {
      try { current = JSON.parse(h[1]); map.set(current, {}); } catch { current = null; }
      continue;
    }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    const t = current && line.match(/^\s*trusted_hash\s*=\s*"([^"]+)"/);
    if (t) map.get(current).hash = t[1];
    const enabled = current && line.match(/^\s*enabled\s*=\s*(true|false)(?:\s|$)/);
    if (enabled) map.get(current).enabled = enabled[1] === "true";
  }
  return map;
}

export function readTrusted(configToml) {
  return new Map([...readHookStates(configToml)].filter(([, s]) => s.hash).map(([key, s]) => [key, s.hash]));
}

// Table boundaries only outside multiline arrays/inline values. Quoted brackets/comments are data.
// Triple-quoted strings are rejected by applyTrust rather than implementing a second TOML parser.
function tableBlocks(text) {
  const blocks = []; let block = "", depth = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    if (!depth && /^\s*\[/.test(line)) { if (block) blocks.push(block); block = line; continue; }
    block += line;
    let quote = null, escaped = false;
    for (const ch of line) {
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (quote === '"' && ch === "\\") { escaped = true; continue; }
        if (ch === quote) quote = null;
      } else if (ch === "#") break;
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
    }
    if (depth < 0) throw new Error("ambiguous TOML; repair config.toml with a TOML-aware editor before updating hook trust");
  }
  if (depth) throw new Error("unfinished TOML; repair config.toml with a TOML-aware editor before updating hook trust");
  if (block) blocks.push(block);
  return blocks;
}

// Upsert only supplied hashes. Preserve explicit disablement, unknown fields, removed-handler
// state and unrelated hooks. Positional identity changes still need review when hooks are reordered.
export function applyTrust(configToml, hooksPath, entries) {
  if (entries.some((e) => !e.key.startsWith(`${hooksPath}:`))) throw new Error("trust entry belongs to another hooks file");
  // This dependency-free editor intentionally supports the host's ordinary table form, not all
  // TOML. Reject ambiguous valid forms rather than append a duplicate identity or edit a string.
  if (configToml.includes('"""') || configToml.includes("'''")) throw new Error("multiline TOML is outside the safe editor's supported subset; update hook trust with a TOML-aware editor");
  // Root-table hook state can hide in `hooks = {...}`, `hooks.state... =` (also quoted) before any header, or in
  // `state =` / `state.x =` under [hooks]. `hooks = true` under [features] is Codex's switch and carries no state.
  const key = (k) => `(?:${k}|"${k}"|'${k}')`;
  const topHookState = new RegExp(`^\\s*${key("hooks")}\\s*(?:=|\\.\\s*${key("state")}\\s*[=.])`);
  const hooksTableState = new RegExp(`^\\s*${key("state")}\\s*[=.]`);
  // tableBlocks splits only at headers outside multiline values, so a `[1, 2],` array line never ends the root table.
  const blocks = tableBlocks(configToml), seen = new Set();
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const header = /^\s*\[/.test(lines[0]) ? lines.shift() : null;
    const compact = header === null ? "" : header.replace(/["'\s]/g, "").split("#")[0];
    const standardState = header !== null && /^\s*\[hooks\.state\."(?:[^"\\]|\\.)*"\]\s*(?:#.*)?$/.test(header);
    if (compact.startsWith("[hooks.state.") && !standardState)
      throw new Error("non-standard hook-state table is outside the safe editor's supported subset; update hook trust with a TOML-aware editor");
    // An escaped table name (["h\u006foks".state."x"]) can spell hooks.state invisibly to this scan.
    if (header !== null && header.includes("\\") && !standardState)
      throw new Error("escaped table name is outside the safe editor's supported subset; update hook trust with a TOML-aware editor");
    const rootState = compact === "[hooks.state]", rootHooks = compact === "[hooks]", topLevel = header === null;
    for (const line of lines) {
      if ((rootState && line.trim() && !line.trim().startsWith("#")) || (rootHooks && hooksTableState.test(line)) || (topLevel && topHookState.test(line)))
        throw new Error("inline hook state is outside the safe editor's supported subset; update hook trust with a TOML-aware editor");
      // Likewise an escaped key ("h\u006foks" = {...}) where hook state can live.
      if ((topLevel || rootHooks || rootState) && line.split("=")[0].includes("\\"))
        throw new Error("escaped key is outside the safe editor's supported subset; update hook trust with a TOML-aware editor");
    }
  }
  const pending = new Map(entries.map((e) => [e.key, e]));
  const out = blocks.map((block) => {
    const m = block.match(/^\s*\[hooks\.state\.("(?:[^"\\]|\\.)*")\][ \t]*(?:#[^\n]*)?(?:\r?\n|$)/);
    if (!m) return block;
    let key;
    try { key = JSON.parse(m[1]); } catch { throw new Error("non-standard TOML escaping is outside the safe editor's supported subset; update hook trust with a TOML-aware editor"); }
    if (seen.has(key)) throw new Error("duplicate hook-state identity; repair configuration before trusting");
    seen.add(key);
    const e = pending.get(key);
    if (!e) return block;
    pending.delete(key);
    // A quoted key ("trusted_hash" = ...) is the same key to Codex; a bare assignment beside it would duplicate it.
    if (/^[ \t]*["']/m.test(block.slice(m[0].length))) throw new Error("quoted key in a hook-state table is outside the safe editor's supported subset; update hook trust with a TOML-aware editor");
    const assignment = `trusted_hash = ${JSON.stringify(e.hash)}`;
    if (/^[ \t]*trusted_hash\s*=/m.test(block)) return block.replace(/^[ \t]*trusted_hash\s*=.*$/m, assignment);
    const header = block.slice(0, m[0].length);
    return header + (header.endsWith("\n") ? "" : "\n") + assignment + "\n" + block.slice(m[0].length);
  }).join("");
  if (pending.size) return out.replace(/\n*$/, "\n\n") + trustToml([...pending.values()]);
  return out;
}

// Exact check of an applyTrust result before it is written: both texts must parse as TOML (Python tomllib), no two
// hook-state keys may be one identity once trimmed as Codex trims them (codex-rs/hooks/src/config_rules.rs merges
// such aliases field by field), and the edit must equal the old configuration plus exactly the supplied
// trusted_hash values, compared type-exactly. The interpreter must answer with the request's nonce, so an
// executable that merely exits 0 proves nothing.
const VERIFY = `import json, math, sys, tomllib
d = json.load(sys.stdin)
try:
    before, after = tomllib.loads(d["before"]), tomllib.loads(d["after"])
except tomllib.TOMLDecodeError as error:
    sys.exit("TOML does not parse: %s" % error)
def check_state(doc):
    hooks = doc.get("hooks", {})
    state = hooks.get("state", {}) if isinstance(hooks, dict) else None
    if not isinstance(state, dict):
        sys.exit("hooks.state is not a table")
    seen = set()
    for key in state:
        if key.strip() in seen:
            sys.exit("hook-state keys collide once trimmed as Codex does: %r" % key.strip())
        seen.add(key.strip())
check_state(before)
check_state(after)
state = before.setdefault("hooks", {}).setdefault("state", {})
for e in d["entries"]:
    entry = state.setdefault(e["key"], {})
    if not isinstance(entry, dict):
        sys.exit("hook state is not a table: " + e["key"])
    entry["trusted_hash"] = e["hash"]
def same(a, b):
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, float):
        return a == b or (math.isnan(a) and math.isnan(b))
    return a == b
if not same(before, after):
    sys.exit("the edit changes more than the supplied trusted_hash values")
print("verified " + d["nonce"])
`;

const ok = (r) => !r.error && !r.signal && r.status === 0;

export function tomlPython(env = process.env, { timeoutMs = 10000 } = {}) {
  const fromPath = String(env.PATH || "").split(path.delimiter).filter((dir) => path.isAbsolute(dir)).map((dir) => path.join(dir, "python3"));
  for (const c of [env.CLEAN_DEV_PYTHON, ...fromPath, "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]) {
    if (!c || !path.isAbsolute(c) || !fs.existsSync(c)) continue;
    if (ok(spawnSync(c, ["-I", "-B", "-c", "import tomllib"], { stdio: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" }))) return c;
  }
  return null;
}

export function verifyTrustEdit(before, after, entries, env = process.env, { timeoutMs = 30000 } = {}) {
  const python = tomlPython(env);
  if (!python) throw new Error("verifying the trust edit needs Python 3.11 or later (tomllib); nothing written; install Python or set CLEAN_DEV_PYTHON");
  const nonce = crypto.randomUUID();
  const r = spawnSync(python, ["-I", "-B", "-c", VERIFY], {
    input: JSON.stringify({ before, after, nonce, entries: entries.map(({ key, hash }) => ({ key, hash })) }),
    encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20 });
  if (!ok(r) || r.stdout !== `verified ${nonce}\n`) {
    const why = r.error ? r.error.code || r.error.message : r.signal ? `killed by ${r.signal}`
      : (r.stderr || "").trim().split("\n").pop() || `exit ${r.status} without the verification answer`;
    throw new Error(`trust edit failed verification (${why}); nothing written; inspect config.toml and retry with a supported Python 3.11+ interpreter`);
  }
}
