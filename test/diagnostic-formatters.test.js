import assert from "node:assert/strict";
import test from "node:test";
import { formatExplanation, formatStorageStatus, formatProbe } from "../src/diagnostic-formatters.js";

const forbidden = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
const controls = [...Array.from({ length: 32 }, (_, n) => String.fromCharCode(n)),
  ...Array.from({ length: 33 }, (_, n) => String.fromCharCode(n + 127)),
  ...[0x061c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
    0x2066, 0x2067, 0x2068, 0x2069].map((n) => String.fromCharCode(n))].join("");

function fixtures(text) {
  return [
    [formatExplanation, { command: text, executable: { path: text, found: true },
      session: { mode: "session-only", source: text }, workspace: { root: text, authority: text },
      routing: { status: "predicted", reason: text, commandLineTarget: text,
        variables: [{ name: text, value: text, action: "preserve", source: text, reason: text }] }, limitations: [text] }],
    [formatStorageStatus, { version: "0.2.1", buildRoot: text, retentionBuildDays: 30, workspaces: 1,
      workspaceDetails: [{ workspaceId: text, workspace: text, path: text, lastUsedAt: text,
        reason: "pinned", pinned: true, activeOrUncertain: true, size: { status: "complete", logicalBytes: 1024 } }],
      sizeMeasurements: { caches: { status: "complete", logicalBytes: 1024 } },
      registeredBuilds: { status: "complete", observedLogicalBytes: 1024 },
      eligibleBuilds: { status: "complete", observedLogicalBytes: 0 }, buildBudget: { limitBytes: 2048, status: "within" } }],
    [formatProbe, { tool: "npm", status: "failed", executable: { path: text }, executed: true, toolVersion: text,
      observations: [{ name: text, matches: true }, { name: text, matches: false }], reason: text,
      cleanup: "failed", scope: text, retainedFixture: text }]
  ];
}

for (const [index, name] of ["explain", "status", "probe"].entries()) {
  test(`${name} renders control payloads without terminal effects or extra report lines`, () => {
    const [render, report] = fixtures(`prefix${controls}\x1b]52;c;ignored\x07\nFORGED: passed`)[index];
    const [, baseline] = fixtures("ordinary")[index];
    const output = render(report);
    assert.doesNotMatch(output, forbidden);
    assert.equal(output.split("\n").length, render(baseline).split("\n").length);
    assert.ok(output.includes("\\u2028"));
    assert.ok(output.includes("\\u061c"));
    assert.ok(output.includes("\\nFORGED: passed"));
    assert.ok(output.includes("\\u001b]52"));
  });
}

test("literal escape spellings, real newlines and unpaired surrogates remain distinguishable", () => {
  for (const index of [0, 1, 2]) {
    const [render, actual] = fixtures("start\nend\ud800")[index];
    const [, literal] = fixtures("start\\nend\\ud800")[index];
    const output = render(actual), spelled = render(literal);
    assert.notEqual(output, spelled);
    assert.ok(output.includes("start\\nend\\ud800"));
    assert.ok(spelled.includes("start\\\\nend\\\\ud800"));
  }
});

test("ordinary Unicode, emoji and quoted Windows paths survive exactly one encoding pass", () => {
  const value = 'Gyöngyös 日本語 👩‍💻 "C:\\Users\\name"';
  for (const [render, report] of fixtures(value)) {
    const output = render(report);
    const decoded = output.split("\n").map((line) => JSON.parse(`"${line}"`));
    assert.ok(decoded.some((line) => line.includes(value)));
    assert.ok(output.includes("Gyöngyös 日本語 👩‍💻"));
  }
});

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("rendering frozen reports changes neither raw values nor their JSON representation", () => {
  for (const [render, report] of fixtures(`path\u2029with\ncontrols`)) {
    const before = JSON.stringify(report);
    freeze(report);
    assert.equal(typeof render(report), "string");
    assert.equal(JSON.stringify(report), before);
    assert.ok(JSON.parse(before));
  }
});

test("summary and measurement fields cannot bypass line encoding", () => {
  const [, report] = fixtures("path")[1];
  report.version = "x\nFORGED";
  report.retentionBuildDays = "x\u2028FORGED";
  report.sizeMeasurements = { ["x\nFORGED"]: { logicalBytes: null, status: "x\x1b[0m" } };
  report.registeredBuilds.status = "x\nFORGED";
  report.buildBudget.status = "x\u200fFORGED";
  const output = formatStorageStatus(report);
  assert.doesNotMatch(output, forbidden);
  assert.doesNotMatch(output, /^FORGED/m);
  assert.match(output, /unknown/);
});

test("ordinary diagnostic semantics and missing-data messages are retained", () => {
  const [, status] = fixtures("/managed")[1];
  const output = formatStorageStatus(status);
  assert.match(output, /1\.00 KiB \(complete\)/);
  assert.match(output, /pinned; active\/uncertain lease/);
  assert.match(output, /actual reclaimable space unknown/);
  assert.match(output, /Advisory only; pins, leases and retention unchanged/);
  const [, probe] = fixtures("/tool")[2];
  probe.status = "not-tested"; probe.executed = false; probe.observations = [];
  assert.match(formatProbe(probe), /Use --execute/);
  status.workspaceDetails = [];
  assert.match(formatStorageStatus(status), /No valid registered build records/);
});
