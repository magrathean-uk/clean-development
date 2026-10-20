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
  return entries.map((e) => `[hooks.state."${e.key}"]\ntrusted_hash = "${e.hash}"\n`).join("\n");
}

// Minimal reader for the [hooks.state."..."] trusted_hash lines of config.toml (no full TOML parser needed).
export function readTrusted(configToml) {
  const map = new Map();
  let current = null;
  for (const line of configToml.split(/\r?\n/)) {
    const h = line.match(/^\[hooks\.state\."(.+)"\]\s*$/);
    if (h) { current = h[1]; continue; }
    if (/^\[/.test(line)) { current = null; continue; }
    const t = current && line.match(/^trusted_hash\s*=\s*"([^"]+)"/);
    if (t) map.set(current, t[1]);
  }
  return map;
}

// Replaces every [hooks.state."<hooksPath>:..."] table in config.toml text with fresh trusted_hash tables; other
// tables (plugin hook states, enabled flags of other files) are kept byte for byte.
export function applyTrust(configToml, hooksPath, entries) {
  const lines = configToml.split(/\r?\n/);
  const out = [];
  let skipping = false;
  const prefix = `[hooks.state."${hooksPath}:`;
  for (const line of lines) {
    if (/^\[/.test(line)) skipping = line.startsWith(prefix);
    if (!skipping) out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n\n" + trustToml(entries);
}
