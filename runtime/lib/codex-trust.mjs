// clean-development 0.6.0: Codex hook trust hashes, so changed hooks run without a /hooks review click.
// Mirrors openai/codex codex-rs/hooks/src/engine/discovery.rs (hook_hash, normalize_command_hook) and
// codex-rs/config/src/fingerprint.rs (version_for_toml): sha256 over compact JSON with recursively sorted keys of
// { event_name: <snake_case event>, matcher?: <matcher>, hooks: [<normalised handler>] }.
// Normalised command handler: type, command, commandWindows?, timeout (SessionEnd/Interrupt: default 1, clamp 1..3;
// others: default 600), async (default false), statusMessage?, additionalContextLimit?.
// Verified against five trusted_hash values in ~/.codex/config.toml (Codex CLI 0.163.0-alpha.10.2) on 19 Oct 2026.
import crypto from "node:crypto";

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

export function managedTrustEntries(hooksPath, doc) {
  const owned = new Set();
  for (const [event, groups] of Object.entries(doc?.hooks || {})) (groups || []).forEach((g, gi) => (g.hooks || []).forEach((h, hi) => {
    const m = String(h.command || "").match(/^(?:'([^']+)'|"([^"]+)"|(\/[A-Za-z0-9_./-]+)) (session-start|stop|session-end) codex$/);
    const file = m && (m[1] || m[2] || m[3]);
    const expected = { SessionStart: "session-start", Stop: "stop", SessionEnd: "session-end" }[event];
    if (file && /^[A-Za-z0-9_./ -]+$/.test(file) && /^\/.*\/runtime\/clean-development\/\d+\.\d+\.\d+\/bin\/cd-hook$/.test(file) && m[4] === expected)
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
    if (depth < 0) throw new Error("ambiguous TOML requires the host codex-hooks-trust helper");
  }
  if (depth) throw new Error("unfinished TOML requires the host codex-hooks-trust helper");
  if (block) blocks.push(block);
  return blocks;
}

// Upsert only supplied hashes. Preserve explicit disablement, unknown fields, removed-handler
// state and unrelated hooks. Positional identity changes still need review when hooks are reordered.
export function applyTrust(configToml, hooksPath, entries) {
  if (entries.some((e) => !e.key.startsWith(`${hooksPath}:`))) throw new Error("trust entry belongs to another hooks file");
  // This dependency-free editor intentionally supports the host's ordinary table form, not all
  // TOML. Reject ambiguous valid forms rather than append a duplicate identity or edit a string.
  if (configToml.includes('"""') || configToml.includes("'''")) throw new Error("multiline TOML requires the host codex-hooks-trust helper");
  let rootState = false, rootHooks = false;
  for (const line of configToml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      const compact = line.replace(/["'\s]/g, "").split("#")[0];
      rootState = compact === "[hooks.state]"; rootHooks = compact === "[hooks]";
      if (compact.startsWith("[hooks.state.") && !/^\s*\[hooks\.state\."(?:[^"\\]|\\.)*"\]\s*(?:#.*)?$/.test(line))
        throw new Error("non-standard hook-state table requires the host codex-hooks-trust helper");
    } else if ((rootState && line.trim() && !line.trim().startsWith("#")) || (rootHooks && /^\s*state\s*=/.test(line)) || /^\s*hooks\s*=/.test(line)) {
      throw new Error("inline hook state requires the host codex-hooks-trust helper");
    }
  }
  const pending = new Map(entries.map((e) => [e.key, e]));
  const blocks = tableBlocks(configToml), seen = new Set();
  const out = blocks.map((block) => {
    const m = block.match(/^\s*\[hooks\.state\.("(?:[^"\\]|\\.)*")\][ \t]*(?:#[^\n]*)?(?:\r?\n|$)/);
    if (!m) return block;
    let key;
    try { key = JSON.parse(m[1]); } catch { throw new Error("non-standard TOML escaping requires the host codex-hooks-trust helper"); }
    if (seen.has(key)) throw new Error("duplicate hook-state identity; repair configuration before trusting");
    seen.add(key);
    const e = pending.get(key);
    if (!e) return block;
    pending.delete(key);
    const assignment = `trusted_hash = ${JSON.stringify(e.hash)}`;
    if (/^[ \t]*trusted_hash\s*=/m.test(block)) return block.replace(/^[ \t]*trusted_hash\s*=.*$/m, assignment);
    const header = block.slice(0, m[0].length);
    return header + (header.endsWith("\n") ? "" : "\n") + assignment + "\n" + block.slice(m[0].length);
  }).join("");
  if (pending.size) return out.replace(/\n*$/, "\n\n") + trustToml([...pending.values()]);
  return out;
}
