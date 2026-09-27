// Opt-in acceptance tooling only. Never imported by the installed runtime.
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const CANARY = "CD_REQUEST_ACCEPTANCE_DESCRIPTION_CANARY";
export const HOOK_CANARY = "CD_REQUEST_ACCEPTANCE_HOOK_CANARY";
export const ORDINARY = "Explain what a unit test checks in one sentence. Do not use tools.";

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

// Preserve arrays, roles, schema keys and all unknown fields. Only the specifically
// documented non-prompt user identifier is excluded from comparison, not capture.
export function comparisonValue(payload, laneRoot) {
  const visit = (value) => {
    if (typeof value === "string") return laneRoot ? value.split(laneRoot).join("<LANE>") : value;
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  };
  const result = visit(payload);
  if (result?.metadata && Object.hasOwn(result.metadata, "user_id")) result.metadata.user_id = "<TRANSPORT_USER_ID>";
  return canonical(result);
}

export function differences(left, right, pointer = "") {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  if (left && right && typeof left === "object" && typeof right === "object" && Array.isArray(left) === Array.isArray(right)) {
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap((key) =>
      differences(left[key], right[key], `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`));
  }
  // No original text is printed in a public result/diff index.
  return [{ pointer: pointer || "/", beforeSha256: left === undefined ? null : sha256(JSON.stringify(left)), afterSha256: right === undefined ? null : sha256(JSON.stringify(right)) }];
}

export function textLeaves(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(textLeaves);
  return [];
}

export function inspectPayload(payload, { body = "", description = "" } = {}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages) || !payload.messages.length || typeof payload.model !== "string") {
    throw new Error("Unsupported or incomplete Anthropic request body");
  }
  const strings = textLeaves(payload);
  return {
    bodyPresent: strings.some((text) => body.trim().length > 0 && text.includes(body.trim())),
    descriptionPresent: strings.some((text) => description.length > 0 && text.includes(description)),
    productReferencePresent: strings.some((text) => /clean[- ]development/i.test(text)),
    descriptionCanaryPresent: strings.some((text) => text.includes(CANARY)),
    hookCanaryPresent: strings.some((text) => text.includes(HOOK_CANARY)),
    ordinaryPromptPresent: strings.some((text) => text.includes(ORDINARY)),
    observedStringUtf8Bytes: strings.reduce((sum, text) => sum + Buffer.byteLength(text), 0)
  };
}

// Privacy redaction is deliberately separate from comparison. A redaction cannot
// erase a measured difference or transform an unavailable capture into a pass.
export function redact(value, replacements = []) {
  const edits = [];
  const ordered = [...replacements].filter(([from]) => typeof from === "string" && from.length > 3).sort((a, b) => b[0].length - a[0].length);
  const visit = (item, pointer = "") => {
    if (typeof item === "string") {
      let result = item;
      for (const [from, to] of ordered) {
        if (result.includes(from)) { result = result.split(from).join(to); edits.push({ pointer, replacement: to }); }
      }
      result = result.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, () => { edits.push({ pointer, replacement: "<CREDENTIAL>" }); return "<CREDENTIAL>"; });
      result = result.replace(/\bBearer\s+[A-Za-z0-9._~-]{12,}/g, () => { edits.push({ pointer, replacement: "<BEARER>" }); return "Bearer <BEARER>"; });
      return result;
    }
    if (Array.isArray(item)) return item.map((child, index) => visit(child, `${pointer}/${index}`));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => {
      const location = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (/^(authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(key) && typeof child === "string") {
        edits.push({ pointer: location, replacement: "<CREDENTIAL>" }); return [key, "<CREDENTIAL>"];
      }
      if (/^(user_id|session_id|account_id|email)$/i.test(key) && typeof child === "string") {
        edits.push({ pointer: location, replacement: "<PRIVATE_IDENTIFIER>" }); return [key, "<PRIVATE_IDENTIFIER>"];
      }
      return [key, visit(child, location)];
    }));
    return item;
  };
  return { value: visit(value), edits };
}

export async function startCapture({ maxBodyBytes = 2 * 1024 * 1024, maxRequests = 12 } = {}) {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || !Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error("Invalid capture limits");
  const token = randomUUID();
  const requests = [], errors = [];
  const recordError = (reason) => { if (errors.length < 32) errors.push(reason); };
  let total = 0, connections = 0;
  const server = http.createServer((request, response) => {
    const reject = (status, reason) => { recordError(reason); response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ error: reason })); request.resume(); };
    if (++connections > maxRequests) return reject(429, "request-limit");
    if (request.headers["x-api-key"] !== token && request.headers.authorization !== `Bearer ${token}`) return reject(401, "unexpected-credential");
    let pathname;
    try { pathname = new URL(request.url, "http://127.0.0.1").pathname; }
    catch { return reject(400, "invalid-request-url"); }
    if (request.method !== "POST" || !["/v1/messages", "/v1/messages/count_tokens"].includes(pathname)) return reject(404, "unsupported-endpoint");
    if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") return reject(415, "unsupported-content-encoding");
    if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) return reject(415, "unsupported-content-type");
    let size = 0, rejected = false;
    const chunks = [];
    request.on("error", () => recordError("request-stream-error"));
    request.on("data", (chunk) => {
      size += chunk.length; total += chunk.length;
      if (rejected) return;
      if (size > maxBodyBytes || total > 8 * maxBodyBytes) { rejected = true; chunks.length = 0; reject(413, "body-limit"); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks);
      let payload;
      try { payload = JSON.parse(raw.toString("utf8")); inspectPayload(payload); }
      catch { reject(400, "invalid-request-body"); return; }
      requests.push({ endpoint: pathname, sequence: requests.length + 1, rawSha256: sha256(raw), rawBytes: raw.length, payload });
      if (pathname.endsWith("/count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"input_tokens":0}'); // Synthetic protocol value, NOT billing evidence.
        return;
      }
      const message = { id: `msg_fixture_${requests.length}`, type: "message", role: "assistant", model: payload.model,
        content: [{ type: "text", text: "Request construction fixture complete." }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 } };
      if (!payload.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send("message_start", { message: { ...message, content: [], stop_reason: null } });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: message.content[0].text } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } });
      send("message_stop", {}); response.end();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 15000;
  server.on("clientError", (_error, socket) => { recordError("client-error"); socket.destroy(); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { token, requests, errors, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
