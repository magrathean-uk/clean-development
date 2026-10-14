import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SUPPORTED_AGENTS } from "./constants.js";
import { ensureRealDirectory, MAX_METADATA_BYTES, readJson, readTextMetadata, writeJsonAtomic, writeJsonAtomicFollowingLeafSymlink, writeTextAtomicFollowingLeafSymlink } from "./io.js";
import { canonicalizePotentialPath, environmentValue, isPathInside, prependUniquePath } from "./platform.js";
import { environmentWithoutSessionRouting, SESSION_ENV_MARKER, SESSION_MODE_ENV } from "./session.js";
import { pathEntries } from "./path-entries.js";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function claudeSettingsPath(config, env = process.env) {
  return env.CLAUDE_CONFIG_DIR
    ? path.join(path.resolve(env.CLAUDE_CONFIG_DIR), "settings.json")
    : path.join(config.locations.home, ".claude", "settings.json");
}

function agentConfigPath(config, env, agent) {
  const override = agent === "codex" ? env.CODEX_HOME : env.GROK_HOME;
  return path.join(override ? path.resolve(override) : path.join(config.locations.home, `.${agent}`), "config.toml");
}

function hookCommand(runtime, ownershipId) {
  if (process.platform === "win32") return `\"${process.execPath}\" \"${runtime.cli}\" hook session-start --owner \"${ownershipId}\"`;
  return `${shellQuote(process.execPath)} ${shellQuote(runtime.cli)} hook session-start --owner ${shellQuote(ownershipId)}`;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validOwnershipId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateIntegrationEntry(config, entry, env, enforcePaths) {
  if (!isObject(entry) || !Object.hasOwn(SUPPORTED_AGENTS, entry.agent) || typeof entry.mode !== "string") return false;
  if (entry.mode === "zero-context-launcher") {
    const expected = path.join(config.locations.binDir, `clean-development-${entry.agent}${process.platform === "win32" ? ".cmd" : ""}`);
    return typeof entry.command === "string" && path.resolve(entry.command) === expected;
  }
  if (entry.mode === "native-hook") {
    const expectedFile = claudeSettingsPath(config, env);
    return entry.agent === "claude"
      && validOwnershipId(entry.ownershipId)
      && typeof entry.file === "string"
      && path.isAbsolute(entry.file)
      && (!enforcePaths || path.resolve(entry.file) === path.resolve(expectedFile))
      && typeof entry.referent === "string"
      && path.isAbsolute(entry.referent)
      && typeof entry.command === "string"
      && entry.command.includes(`${path.sep}bin${path.sep}clean-development.js`)
      && entry.command.includes(config.locations.runtimeDir)
      && entry.command.includes(" hook session-start --owner ")
      && entry.command.includes(entry.ownershipId);
  }
  if (entry.mode === "native-shell-environment") {
    const expectedFile = ["codex", "grok"].includes(entry.agent) ? agentConfigPath(config, env, entry.agent) : null;
    if (
      !["codex", "grok"].includes(entry.agent)
      || !validOwnershipId(entry.ownershipId)
      || typeof entry.file !== "string"
      || !path.isAbsolute(entry.file)
      || (enforcePaths && path.resolve(entry.file) !== path.resolve(expectedFile))
      || typeof entry.referent !== "string"
      || !path.isAbsolute(entry.referent)
      || entry.ownedBlock !== true
      || ![undefined, "", "\n", "\n\n", "\r\n", "\r\n\r\n"].includes(entry.leadingSeparator)
      || (entry.blockSha256 !== undefined && (typeof entry.blockSha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.blockSha256)))
    ) return false;
    const markers = tomlMarkers(entry.agent, entry.ownershipId);
    return entry.beginMarker === markers.begin && entry.endMarker === markers.end;
  }
  return false;
}

function readIntegrationReceipt(config, env = process.env, { enforcePaths = false } = {}) {
  const file = path.join(config.locations.stateDir, "integrations.json");
  if (!fs.existsSync(file)) return { schemaVersion: 1, integrations: [] };
  ensureRealDirectory(config.locations.stateDir, { label: "State directory" });
  const details = fs.lstatSync(file);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Integration receipt is not a real file: ${file}`);
  const receipt = readJson(file, null);
  if (receipt?.schemaVersion !== 1 || !Array.isArray(receipt.integrations) || !receipt.integrations.every((entry) => validateIntegrationEntry(config, entry, env, enforcePaths))) {
    throw new Error(`Invalid integration receipt: ${file}`);
  }
  return receipt;
}

function stripRecordedClaudeHooks(entries, commands) {
  const remainingByCommand = new Map();
  for (const command of commands) {
    if (typeof command === "string" && command) {
      remainingByCommand.set(command, (remainingByCommand.get(command) || 0) + 1);
    }
  }
  let removed = 0;
  const remaining = entries.map((entry) => Array.isArray(entry?.hooks) ? { ...entry, hooks: [...entry.hooks] } : entry);
  for (let entryIndex = remaining.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = remaining[entryIndex];
    if (!Array.isArray(entry?.hooks)) continue;
    for (let hookIndex = entry.hooks.length - 1; hookIndex >= 0; hookIndex -= 1) {
      const hook = entry.hooks[hookIndex];
      const command = hook?.type === "command" ? String(hook.command || "") : "";
      const count = remainingByCommand.get(command) || 0;
      if (count === 0) continue;
      entry.hooks.splice(hookIndex, 1);
      remainingByCommand.set(command, count - 1);
      removed += 1;
    }
    if (entry.hooks.length === 0) remaining.splice(entryIndex, 1);
  }
  return { entries: remaining, removed };
}

function installClaudeHook(config, runtime, env = process.env, previousEntries = []) {
  const file = claudeSettingsPath(config, env);
  const previousForFile = previousEntries.filter((entry) => entry.agent === "claude" && entry.mode === "native-hook" && entry.file === file);
  const settings = readJson(file, {});
  if (!isObject(settings)) return launcherIntegration("claude", runtime, `${file} is not a JSON object`, file);
  if (settings.hooks === undefined) settings.hooks = {};
  else if (!isObject(settings.hooks)) return launcherIntegration("claude", runtime, `${file} hooks is not a JSON object`, file);
  if (settings.hooks.SessionStart === undefined) settings.hooks.SessionStart = [];
  else if (!Array.isArray(settings.hooks.SessionStart)) {
    return launcherIntegration("claude", runtime, `${file} hooks.SessionStart is not an array`, file);
  }
  settings.hooks.SessionStart = stripRecordedClaudeHooks(
    settings.hooks.SessionStart,
    previousForFile.map((entry) => entry.command)
  ).entries;
  const ownershipId = previousForFile.find((entry) => entry.ownershipId)?.ownershipId || randomUUID();
  const command = hookCommand(runtime, ownershipId);
  settings.hooks.SessionStart.push({
    matcher: "startup|resume|clear|compact|fork",
    hooks: [{ type: "command", command }]
  });
  writeJsonAtomicFollowingLeafSymlink(file, settings);
  return {
    agent: "claude",
    mode: "native-hook",
    file,
    referent: fs.realpathSync(file),
    ownershipId,
    command
  };
}

function tomlSyntaxLines(lines) {
  const syntax = [];
  const nesting = [];
  let quote = null;
  let multiline = false;
  for (const line of lines) {
    // A continued value cannot start a table or a top-level key assignment.
    syntax.push(quote === null && nesting.length === 0 ? line : "");
    for (let index = 0; index < line.length;) {
      const character = line[index];
      if (quote !== null) {
        if (quote === '"' && character === "\\") {
          index += 2;
        } else if (multiline && line.startsWith(quote.repeat(3), index)) {
          let end = index + 3;
          while (line[end] === quote) end += 1;
          // TOML permits one or two literal quotes before the closing triple.
          if (end - index > 5) return null;
          index = end;
          quote = null;
          multiline = false;
        } else if (!multiline && character === quote) {
          quote = null;
          index += 1;
        } else index += 1;
        continue;
      }
      if (character === "#") break;
      if (character === '"' || character === "'") {
        quote = character;
        multiline = line.startsWith(character.repeat(3), index);
        index += multiline ? 3 : 1;
      } else {
        if (character === "[" || character === "{") nesting.push(character);
        else if (character === "]" || character === "}") {
          if (nesting.pop() !== (character === "]" ? "[" : "{")) return null;
        }
        index += 1;
      }
    }
    if (quote !== null && !multiline) return null;
  }
  return quote === null && nesting.length === 0 ? syntax : null;
}

function sectionRange(lines, sectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return null;
  const key = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
  const tableName = `${key}(?:\\s*\\.\\s*${key})*`;
  const nextHeader = new RegExp(`^\\s*(?:\\[\\s*${tableName}\\s*\\]|\\[\\[\\s*${tableName}\\s*\\]\\])\\s*(?:#.*)?$`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (nextHeader.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function tomlKeyUse(line, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(?:${escaped}|"${escaped}"|'${escaped}')\\s*(?:=|\\.)`).test(line);
}

function hasUnicodeEscapedTomlKey(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote !== null) {
      if (quote === '"' && character === "\\") {
        if (line[index + 1] === "u" || line[index + 1] === "U") return true;
        index += 1;
      } else if (character === quote) quote = null;
    } else if (character === "=" || character === "#") {
      return false;
    } else if (character === '"' || character === "'") quote = character;
  }
  return false;
}

function policySyntax(line) {
  return /^\s*\[{1,2}\s*(?:shell_environment_policy|"shell_environment_policy"|'shell_environment_policy')(?=\s*[.\]])/.test(line)
    || tomlKeyUse(line, "shell_environment_policy");
}

function supportedPolicyHeader(line) {
  return /^\s*\[shell_environment_policy(?:\.set)?\]\s*(?:#.*)?$/.test(line);
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlMarkers(agent, ownershipId) {
  if (!ownershipId) {
    return {
      begin: `# clean-development begin (${agent})`,
      end: `# clean-development end (${agent})`
    };
  }
  return {
    begin: `# clean-development begin (${agent}) owner=${ownershipId}`,
    end: `# clean-development end (${agent}) owner=${ownershipId}`
  };
}

function receiptTomlMarkers(entry) {
  if (entry.beginMarker && entry.endMarker) {
    return { begin: entry.beginMarker, end: entry.endMarker };
  }
  return tomlMarkers(entry.agent, entry.ownershipId);
}

function tomlBlockSha256(lines) {
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function isOwnedTomlBlock(lines, legacyBinDir) {
  if (lines.at(-1)?.startsWith("cmd_prefix = ")) {
    const encodedPrefix = lines.at(-1).slice("cmd_prefix = ".length);
    let prefix;
    try {
      prefix = JSON.parse(encodedPrefix);
    } catch {
      return false;
    }
    if (
      typeof prefix !== "string"
      || JSON.stringify(prefix) !== encodedPrefix
      || !prefix.startsWith(". ")
    ) return false;
    if (legacyBinDir !== undefined && prefix !== `. ${shellQuote(path.join(legacyBinDir, "clean-development-shell-env"))}`) return false;
    const headers = lines.slice(0, -1);
    return headers.length === 0 || (headers.length === 1 && headers[0] === "[toolset.bash]");
  }
  const routingLine = lines.at(-1);
  if (!["CLEAN_DEVELOPMENT_ACTIVE = \"1\"", "CLEAN_DEVELOPMENT_SESSION_MODE = \"skip\""].includes(routingLine) || !lines.at(-2)?.startsWith("PATH = ")) return false;
  const encodedPath = lines.at(-2).slice("PATH = ".length);
  try {
    const value = JSON.parse(encodedPath);
    if (typeof value !== "string" || !value || JSON.stringify(value) !== encodedPath) return false;
    if (legacyBinDir !== undefined) {
      const first = pathEntries(value)[0]?.value;
      if (!first || !path.isAbsolute(first)) return false;
      const actual = canonicalizePotentialPath(first);
      const expected = canonicalizePotentialPath(legacyBinDir);
      if (process.platform === "win32" ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected) return false;
    }
  } catch {
    return false;
  }
  const headers = lines.slice(0, -2);
  return [
    [],
    ["[shell_environment_policy.set]"],
    ["[shell_environment_policy]", 'inherit = "all"', "", "[shell_environment_policy.set]"],
    ["allow_login_shell = false", "[shell_environment_policy]", 'inherit = "all"', "", "[shell_environment_policy.set]"]
  ].some((shape) => shape.length === headers.length && shape.every((line, index) => line === headers[index]));
}

function installGrokCommandPrefix(config, runtime, file, previousEntries = []) {
  if (process.platform === "win32") {
    return launcherIntegration("grok", runtime, "Grok command-prefix routing has not been accepted on Windows", file);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let original = fs.existsSync(file) ? readTextMetadata(file) : "";
  const previousForFile = previousEntries.filter((entry) => entry.agent === "grok" && entry.mode === "native-shell-environment" && entry.file === file);
  for (const entry of previousForFile) {
    if (removeOwnedTomlBlock(config, entry, { allowAbsent: true }) === "unsafe") {
      throw new Error(`Cannot update owned grok integration safely in ${file}; the recorded block was changed, removed, or is ambiguous`);
    }
    original = fs.existsSync(file) ? readTextMetadata(file) : "";
  }

  const lines = original.split(/\r?\n/);
  const syntaxLines = tomlSyntaxLines(lines);
  if (!syntaxLines) {
    return launcherIntegration("grok", runtime, `${file} contains unterminated or unsupported TOML string/container syntax`, file);
  }
  if (syntaxLines.some(hasUnicodeEscapedTomlKey)) {
    return launcherIntegration("grok", runtime, `${file} uses Unicode-escaped quoted TOML keys; native editing does not decode key escapes`, file);
  }

  const bashHeaders = syntaxLines.filter((line) => /^\s*\[toolset\.bash\]\s*(?:#.*)?$/.test(line));
  const unsupportedBashHeader = syntaxLines.some((line) => {
    if (!/^\s*\[{1,2}/.test(line)) return false;
    const compact = line.replace(/\s+/g, "");
    return /^(?:\[|\[\[)(?:["']?toolset["']?)\.(?:["']?bash["']?)(?:\]|\]\]|\.)/.test(compact)
      && !/^\[toolset\.bash\](?:#.*)?$/.test(compact);
  });
  const dottedToolset = syntaxLines.some((line) => tomlKeyUse(line, "toolset"));
  const toolsetParent = sectionRange(syntaxLines, "toolset");
  const inlineBash = toolsetParent
    ? syntaxLines.slice(toolsetParent.start + 1, toolsetParent.end).some((line) => tomlKeyUse(line, "bash"))
    : false;
  if (bashHeaders.length > 1 || unsupportedBashHeader || dottedToolset || inlineBash) {
    return launcherIntegration("grok", runtime, `${file} uses an unsupported dotted, quoted, inline, or repeated toolset.bash form`, file);
  }

  const bashRange = sectionRange(syntaxLines, "toolset.bash");
  if (bashRange) {
    const section = syntaxLines.slice(bashRange.start + 1, bashRange.end);
    if (section.some((line) => tomlKeyUse(line, "cmd_prefix"))) {
      return launcherIntegration("grok", runtime, `${file} already sets toolset.bash.cmd_prefix`, file);
    }
  }

  const ownershipId = previousForFile.find((entry) => entry.ownershipId)?.ownershipId || randomUUID();
  const { begin, end } = tomlMarkers("grok", ownershipId);
  const commandPrefix = `. ${shellQuote(path.join(runtime.binDir, "clean-development-shell-env"))}`;
  const block = [
    begin,
    ...(bashRange ? [] : ["[toolset.bash]"]),
    `cmd_prefix = ${tomlString(commandPrefix)}`,
    end
  ];
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  let leadingSeparator = "";
  let content;
  if (bashRange) {
    const offset = original.split(/(?<=\n)/).slice(0, bashRange.end).join("").length;
    leadingSeparator = offset > 0 && original[offset - 1] !== "\n" ? newline : "";
    content = `${original.slice(0, offset)}${leadingSeparator}${block.join(newline)}${newline}${original.slice(offset)}`;
  } else {
    leadingSeparator = original && !original.endsWith("\n") ? `${newline}${newline}`
      : original && !original.endsWith(`${newline}${newline}`) ? newline
        : "";
    content = `${original}${leadingSeparator}${block.join(newline)}${newline}`;
  }
  writeTextAtomicFollowingLeafSymlink(file, content);
  return {
    agent: "grok",
    mode: "native-shell-environment",
    file,
    referent: fs.realpathSync(file),
    ownershipId,
    beginMarker: begin,
    endMarker: end,
    leadingSeparator,
    blockSha256: tomlBlockSha256(block),
    ownedBlock: true
  };
}

function removeTomlBlockText(original, entry, binDir) {
  const { begin, end } = receiptTomlMarkers(entry);
  const leadingSeparator = entry.leadingSeparator || "";
  const originalLines = original.split(/\r?\n/);
  const lines = tomlSyntaxLines(originalLines);
  if (!lines) return { content: original, removed: false };
  const starts = [];
  const finishes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === begin) starts.push(index);
    if (lines[index] === end) finishes.push(index);
  }
  if (starts.length !== 1 || finishes.length !== 1 || finishes[0] <= starts[0]) {
    return { content: original, removed: false };
  }
  if (!isOwnedTomlBlock(originalLines.slice(starts[0] + 1, finishes[0]), entry.blockSha256 ? undefined : binDir)) {
    return { content: original, removed: false };
  }
  if (entry.blockSha256 && tomlBlockSha256(originalLines.slice(starts[0], finishes[0] + 1)) !== entry.blockSha256) {
    return { content: original, removed: false };
  }
  const sourceLines = original.split(/(?<=\n)/);
  // Markers are comments, not TOML scope boundaries. A later user setting
  // still belongs to the last table introduced by this block, so retain that
  // header (and its separator) when it is shared with unowned settings.
  const followingSyntax = lines.slice(finishes[0] + 1).find((line) => line.trim() && !line.trimStart().startsWith("#"));
  let retainedHeader = "";
  if (followingSyntax && !followingSyntax.trimStart().startsWith("[")) {
    for (let index = starts[0] + 1; index < finishes[0]; index += 1) {
      if (lines[index].startsWith("[")) retainedHeader = sourceLines[index];
    }
  }
  const start = sourceLines.slice(0, starts[0]).join("").length;
  const finish = sourceLines.slice(0, finishes[0]).join("").length;
  let before = start;
  if (!retainedHeader && leadingSeparator && original.slice(start - leadingSeparator.length, start) === leadingSeparator) {
    before -= leadingSeparator.length;
  }
  let after = finish + end.length;
  if (original.startsWith("\r\n", after)) after += 2;
  else if (original.startsWith("\n", after)) after += 1;
  const content = `${original.slice(0, before)}${retainedHeader}${original.slice(after)}`;
  return { content, removed: true };
}

function launcherIntegration(agent, runtime, reason, configFile) {
  return {
    agent,
    mode: "zero-context-launcher",
    command: path.join(runtime.binDir, `clean-development-${agent}${process.platform === "win32" ? ".cmd" : ""}`),
    ...(configFile ? { configFile } : {}),
    reason
  };
}

function packageRunnerEnvironment(env) {
  return Boolean(
    environmentValue(env, "npm_execpath")
    || environmentValue(env, "npm_lifecycle_event")
    || ["exec", "run-script"].includes(String(environmentValue(env, "npm_command") || "").toLowerCase())
  );
}

function persistentPath(pathValue, runtimeBin, { cwd, env, home }) {
  const temporaryRoot = canonicalizePotentialPath(os.tmpdir());
  const canonicalHome = canonicalizePotentialPath(home);
  const unsafeRoots = [cwd, environmentValue(env, "VIRTUAL_ENV"), environmentValue(env, "CONDA_PREFIX")]
    .filter((value) => typeof value === "string" && value && path.isAbsolute(value))
    .map(canonicalizePotentialPath)
    .filter((value) => value !== path.parse(value).root && value !== canonicalHome);
  const seen = new Set();
  const entries = [];
  for (const { raw, value: entry } of pathEntries(pathValue)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const canonical = canonicalizePotentialPath(entry);
    const normalized = canonical.split(path.sep).join("/").toLowerCase();
    if (normalized.endsWith("/node_modules/.bin") || normalized.includes("/_npx/")) continue;
    if (canonical === temporaryRoot || isPathInside(temporaryRoot, canonical)) continue;
    if (unsafeRoots.some((root) => canonical === root || isPathInside(root, canonical))) continue;
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(raw);
  }
  return prependUniquePath(entries.join(path.delimiter), runtimeBin);
}

function installShellEnvironment(config, runtime, agent, file, env = process.env, previousEntries = [], cwd = process.cwd()) {
  if (packageRunnerEnvironment(env)) {
    return launcherIntegration(
      agent,
      runtime,
      "Refusing to persist npm/npx's transient PATH; use this launcher or rerun setup from a fresh shell",
      file
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let original = fs.existsSync(file) ? readTextMetadata(file) : "";
  const previousForFile = previousEntries.filter((entry) => entry.agent === agent && entry.mode === "native-shell-environment" && entry.file === file);
  for (const entry of previousForFile) {
    const removed = removeTomlBlockText(original, entry, config.locations.binDir);
    if (!removed.removed) {
      throw new Error(`Cannot update owned ${agent} integration safely in ${file}; the recorded block was changed, removed, or is ambiguous`);
    }
    original = removed.content;
  }
  const ownershipId = previousForFile.find((entry) => entry.ownershipId)?.ownershipId || randomUUID();
  const { begin, end } = tomlMarkers(agent, ownershipId);
  const pathValue = persistentPath(environmentValue(env, "PATH"), runtime.binDir, {
    cwd,
    env,
    home: config.locations.home
  });
  if (pathValue === runtime.binDir) {
    return launcherIntegration(agent, runtime, "No stable absolute PATH entries were available to persist", file);
  }
  const blockFor = (includeParent) => [
    begin,
    ...(includeParent ? ["[shell_environment_policy.set]"] : []),
    `PATH = ${tomlString(pathValue)}`,
    `CLEAN_DEVELOPMENT_SESSION_MODE = \"skip\"`,
    end
  ];
  const fullBlock = () => [
    begin,
    ...(ownsLoginPolicy ? ["allow_login_shell = false"] : []),
    "[shell_environment_policy]",
    `inherit = \"all\"`,
    "",
    "[shell_environment_policy.set]",
    `PATH = ${tomlString(pathValue)}`,
    `CLEAN_DEVELOPMENT_SESSION_MODE = \"skip\"`,
    end
  ];

  let content = original;
  const lines = original.split(/\r?\n/);
  const syntaxLines = tomlSyntaxLines(lines);
  if (!syntaxLines) {
    return launcherIntegration(agent, runtime, `${file} contains unterminated or unsupported TOML string/container syntax`, file);
  }
  if (syntaxLines.some(hasUnicodeEscapedTomlKey)) {
    return launcherIntegration(agent, runtime, `${file} uses Unicode-escaped quoted TOML keys; native editing does not decode key escapes`, file);
  }
  const policyLines = syntaxLines.filter(policySyntax);
  const parentHeaders = syntaxLines.filter((line) => /^\s*\[shell_environment_policy\]\s*(?:#.*)?$/.test(line));
  const setHeaders = syntaxLines.filter((line) => /^\s*\[shell_environment_policy\.set\]\s*(?:#.*)?$/.test(line));
  if (policyLines.some((line) => !supportedPolicyHeader(line)) || parentHeaders.length > 1 || setHeaders.length > 1) {
    return launcherIntegration(agent, runtime, `${file} uses an unsupported quoted, dotted, inline, or repeated shell_environment_policy form`, file);
  }
  const firstHeader = syntaxLines.findIndex((line) => /^\s*\[{1,2}/.test(line));
  const topLevelLines = syntaxLines.slice(0, firstHeader === -1 ? syntaxLines.length : firstHeader);
  const loginPolicyLines = topLevelLines.filter((line) => tomlKeyUse(line, "allow_login_shell"));
  const ownsLoginPolicy = loginPolicyLines.length === 0;
  if (loginPolicyLines.length > 1 || (loginPolicyLines.length === 1 && !/^\s*allow_login_shell\s*=\s*false\s*(?:#.*)?$/.test(loginPolicyLines[0]))) {
    return launcherIntegration(agent, runtime, `${file} already sets allow_login_shell; use the launcher to preserve managed PATH routing`, file);
  }
  if (ownsLoginPolicy && (parentHeaders.length > 0 || setHeaders.length > 0)) {
    return launcherIntegration(agent, runtime, `${file} already sets shell_environment_policy without allow_login_shell = false; use the launcher to preserve managed PATH routing`, file);
  }
  const setRange = sectionRange(syntaxLines, "shell_environment_policy.set");
  let leadingSeparator = "";
  let blockSha256;
  const insertBlock = (lineIndex, block) => {
    // Slice the original text so multiline values, CRLF, and the final newline
    // remain byte-for-byte unchanged outside the owned block.
    const offset = original.split(/(?<=\n)/).slice(0, lineIndex).join("").length;
    leadingSeparator = offset > 0 && original[offset - 1] !== "\n" ? "\n" : "";
    const newline = original.includes("\r\n") ? "\r\n" : "\n";
    blockSha256 = tomlBlockSha256(block);
    return `${original.slice(0, offset)}${leadingSeparator}${block.join(newline)}${newline}${original.slice(offset)}`;
  };
  if (setRange) {
    const section = syntaxLines.slice(setRange.start + 1, setRange.end);
    if (section.some((line) => tomlKeyUse(line, "PATH") || tomlKeyUse(line, "CLEAN_DEVELOPMENT_ACTIVE") || tomlKeyUse(line, "CLEAN_DEVELOPMENT_SESSION_MODE"))) {
      return launcherIntegration(agent, runtime, `${file} already sets shell_environment_policy.set.PATH`, file);
    }
    content = insertBlock(setRange.end, blockFor(false));
  } else {
    const parent = sectionRange(syntaxLines, "shell_environment_policy");
    if (parent) {
      const section = syntaxLines.slice(parent.start + 1, parent.end);
      if (section.some((line) => tomlKeyUse(line, "set"))) {
        return launcherIntegration(agent, runtime, `${file} already has an inline shell_environment_policy.set table`, file);
      }
      content = insertBlock(parent.end, blockFor(true));
    } else {
      const block = fullBlock();
      if (ownsLoginPolicy && firstHeader !== -1) {
        content = insertBlock(firstHeader, block);
      } else {
        leadingSeparator = original && !original.endsWith("\n") ? "\n\n"
          : original && !original.endsWith("\n\n") ? "\n"
            : "";
        blockSha256 = tomlBlockSha256(block);
        content = `${original}${leadingSeparator}${block.join("\n")}\n`;
      }
    }
  }
  writeTextAtomicFollowingLeafSymlink(file, content);
  return {
    agent,
    mode: "native-shell-environment",
    file,
    referent: fs.realpathSync(file),
    ownershipId,
    beginMarker: begin,
    endMarker: end,
    leadingSeparator,
    blockSha256,
    ownedBlock: true
  };
}

export function installAgentIntegrations(config, runtime, agents, env = process.env, cwd = process.cwd()) {
  const receiptFile = path.join(config.locations.stateDir, "integrations.json");
  const previous = readIntegrationReceipt(config, env, { enforcePaths: true });
  const previousEntries = Array.isArray(previous.integrations) ? previous.integrations : [];
  let installed = [...previousEntries];
  const persist = () => {
    installed.sort((left, right) => {
      return left.agent.localeCompare(right.agent) || String(left.file || "").localeCompare(String(right.file || ""));
    });
    writeJsonAtomic(receiptFile, {
      schemaVersion: 1,
      installedAt: new Date().toISOString(),
      integrations: installed
    });
  };
  deactivateUnselectedEntries(config, previousEntries, agents, (remaining) => {
    installed = remaining;
    persist();
  });
  for (const agent of agents) {
    if (!Object.hasOwn(SUPPORTED_AGENTS, agent)) throw new Error(`Unsupported agent: ${agent}`);
    let integration;
    if (agent === "claude") integration = installClaudeHook(config, runtime, env, previousEntries);
    else if (agent === "codex") integration = installShellEnvironment(config, runtime, agent, agentConfigPath(config, env, agent), env, previousEntries, cwd);
    else if (agent === "grok") {
      integration = installGrokCommandPrefix(
        config,
        runtime,
        agentConfigPath(config, env, agent),
        previousEntries
      );
      // The installer has safely removed any prior owned Grok block before it
      // returns, including when a new user prefix requires launcher fallback.
      installed = installed.filter((entry) => entry.agent !== agent || entry.mode !== "native-shell-environment");
    }
    else {
      integration = {
        agent,
        mode: "zero-context-launcher",
        command: path.join(runtime.binDir, `clean-development-${agent}${process.platform === "win32" ? ".cmd" : ""}`)
      };
    }
    installed = installed.filter((entry) => {
      if (entry.agent !== agent) return true;
      if (!entry.file) return false;
      if (integration.file) return entry.file !== integration.file;
      return Boolean(entry.file);
    });
    installed.push(integration);
    persist();
  }
  if (agents.length === 0) persist();
  return installed;
}

function removeOwnedTomlBlock(config, entry, { allowAbsent = false } = {}) {
  const { file } = entry;
  if (typeof file !== "string" || !path.isAbsolute(file)) return "unsafe";
  try {
    fs.lstatSync(file);
  } catch (error) {
    return allowAbsent && error.code === "ENOENT" ? "absent" : "unsafe";
  }
  if (entry.referent) {
    try {
      if (fs.realpathSync(file) !== entry.referent) return "unsafe";
    } catch {
      return "unsafe";
    }
  }
  const { begin, end } = receiptTomlMarkers(entry);
  const original = readTextMetadata(file);
  if (allowAbsent && !original.includes(begin) && !original.includes(end)) {
    const syntax = tomlSyntaxLines(original.split(/\r?\n/));
    if (!syntax || syntax.some((line) => /^\s*#\s*clean-development\s+(?:begin|end)\s*\(grok\)/.test(line))) return "unsafe";
    const binForms = [config.locations.binDir, tomlString(config.locations.binDir).slice(1, -1)];
    const text = process.platform === "win32" ? original.toLowerCase() : original;
    const hasRuntimePath = binForms.some((value) => text.includes(process.platform === "win32" ? value.toLowerCase() : value));
    if (hasRuntimePath && syntax.some((line) => tomlKeyUse(line, "CLEAN_DEVELOPMENT_ACTIVE") || tomlKeyUse(line, "CLEAN_DEVELOPMENT_SESSION_MODE") || tomlKeyUse(line, "cmd_prefix"))) return "unsafe";
    if (syntax.some((line, index) => isOwnedTomlBlock(syntax.slice(index, index + 2), config.locations.binDir))) return "unsafe";
    return "absent";
  }
  const result = removeTomlBlockText(original, entry, config.locations.binDir);
  if (!result.removed) return "unsafe";
  writeTextAtomicFollowingLeafSymlink(file, result.content);
  return "removed";
}

function receiptEntries(config, env = process.env) {
  return readIntegrationReceipt(config, env, { enforcePaths: true }).integrations;
}

function removeRecordedClaudeHooks(entries) {
  const file = entries[0]?.file;
  if (typeof file !== "string" || !path.isAbsolute(file)) return { changed: false, removed: 0 };
  for (const entry of entries) {
    if (!entry.referent) continue;
    try {
      if (fs.realpathSync(file) !== entry.referent) return { changed: false, removed: 0 };
    } catch {
      return { changed: false, removed: 0 };
    }
  }
  const settings = readJson(file, null);
  if (!settings?.hooks?.SessionStart || !Array.isArray(settings.hooks.SessionStart)) return { changed: false, removed: 0 };
  const stripped = stripRecordedClaudeHooks(settings.hooks.SessionStart, entries.map((entry) => entry.command));
  if (stripped.removed === 0) return { changed: false, removed: 0 };
  settings.hooks.SessionStart = stripped.entries;
  if (settings.hooks.SessionStart.length === 0) delete settings.hooks.SessionStart;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeJsonAtomicFollowingLeafSymlink(file, settings);
  return { changed: true, removed: stripped.removed };
}

function removeClaudeEntries(entries) {
  const byFile = new Map();
  for (const entry of entries) {
    if (entry.agent !== "claude" || entry.mode !== "native-hook" || typeof entry.file !== "string" || typeof entry.command !== "string") continue;
    const values = byFile.get(entry.file) || [];
    values.push(entry);
    byFile.set(entry.file, values);
  }
  let removed = false;
  for (const values of byFile.values()) removed = removeRecordedClaudeHooks(values).changed || removed;
  return removed;
}

function deactivateUnselectedEntries(config, entries, agents, persist) {
  const selected = new Set(agents);
  const stale = entries.filter((entry) => !selected.has(entry.agent));
  let remaining = [...entries];
  for (const entry of stale) {
    // Launchers belong to the shared runtime; absent native config files also
    // need only their receipt entries removed.
    if (entry.mode === "native-hook" && fs.existsSync(entry.file)) {
      if (removeRecordedClaudeHooks([entry]).removed !== 1) {
        throw new Error(`Cannot deactivate owned Claude integration safely in ${entry.file}; the recorded hook was changed or removed`);
      }
    } else if (entry.mode === "native-shell-environment" && fs.existsSync(entry.file)) {
      if (removeOwnedTomlBlock(config, entry) !== "removed") {
        throw new Error(`Cannot deactivate owned ${entry.agent} integration safely in ${entry.file}; the recorded block was changed or removed`);
      }
    }
    remaining = remaining.filter((value) => value !== entry);
    // Record completed removals before another agent can fail, so a retry does
    // not try to remove an integration that this attempt already deactivated.
    persist(remaining);
  }
}

export function removeOwnedAgentIntegrations(config, env = process.env) {
  const entries = receiptEntries(config, env);
  const result = { claude: false, codex: false, grok: false };
  const removedEntries = new Set();
  const claudeByFile = new Map();
  for (const entry of entries) {
    if (entry.agent !== "claude" || entry.mode !== "native-hook") continue;
    const values = claudeByFile.get(entry.file) || [];
    values.push(entry);
    claudeByFile.set(entry.file, values);
  }
  for (const values of claudeByFile.values()) {
    const removed = removeRecordedClaudeHooks(values);
    result.claude = removed.changed || result.claude;
    if (removed.removed === values.length) for (const entry of values) removedEntries.add(entry);
  }
  for (const entry of entries) {
    if (!["codex", "grok"].includes(entry.agent) || entry.mode !== "native-shell-environment") continue;
    const removed = removeOwnedTomlBlock(config, entry) === "removed";
    result[entry.agent] = removed || result[entry.agent];
    if (removed) removedEntries.add(entry);
  }
  const remaining = entries.filter((entry) => {
    if (removedEntries.has(entry)) return false;
    return ["native-hook", "native-shell-environment"].includes(entry.mode);
  });
  writeJsonAtomic(path.join(config.locations.stateDir, "integrations.json"), {
    schemaVersion: 1,
    uninstalledAt: new Date().toISOString(),
    integrations: remaining
  });
  result.retained = remaining.length;
  return result;
}

export function removeClaudeHook(config, env = process.env) {
  return removeClaudeEntries(receiptEntries(config, env));
}

function claudeHookOwner(config, env, requestedOwner) {
  const hooks = readIntegrationReceipt(config, env, { enforcePaths: true }).integrations
    .filter((entry) => entry.agent === "claude" && entry.mode === "native-hook");
  if (hooks.length === 0) return null;
  if (requestedOwner !== undefined) {
    if (!validOwnershipId(requestedOwner)) throw new Error("Invalid Claude integration owner");
    const matches = hooks.filter((entry) => entry.ownershipId === requestedOwner);
    if (matches.length !== 1) throw new Error("Claude integration owner does not match the installation receipt");
    return matches[0];
  }
  throw new Error("Claude session hook requires the installed --owner value");
}

export function validateClaudeHookOwner(config, env = process.env, requestedOwner) {
  return claudeHookOwner(config, env, requestedOwner);
}

const CLAUDE_ROUTED_ENVIRONMENT = new Set([
  "BUN_INSTALL_CACHE_DIR", "CARGO_TARGET_DIR", "CCACHE_DIR", "COMPOSER_CACHE_DIR", "GOCACHE", "GOMODCACHE",
  "NUGET_PACKAGES", "PIP_CACHE_DIR", "SCCACHE_DIR", "UV_CACHE_DIR", "YARN_CACHE_FOLDER",
  "YARN_ENABLE_GLOBAL_CACHE", "YARN_ENABLE_MIRROR", "npm_config_cache", "npm_config_store_dir"
]);

function claudeSessionBlock(runtime, begin, end) {
  return [
    begin,
    "if [ -z \"${CLEAN_DEVELOPMENT_SESSION_MODE+x}\" ]; then",
    "  CLEAN_DEVELOPMENT_SESSION_MODE=skip",
    "  export CLEAN_DEVELOPMENT_SESSION_MODE",
    "fi",
    `_clean_development_bin=${shellQuote(runtime.binDir)}`,
    "case \"${PATH:-}\" in",
    "  \"${_clean_development_bin}\"|\"${_clean_development_bin}:\"*) ;;",
    "  *) PATH=\"${_clean_development_bin}${PATH:+:${PATH}}\" ;;",
    "esac",
    "export PATH",
    "if [ \"${CLEAN_DEVELOPMENT_SESSION_MODE}\" = \"skip\" ]; then",
    "  unset CLEAN_DEVELOPMENT_ACTIVE",
    "else",
    "  export CLEAN_DEVELOPMENT_ACTIVE=1",
    "fi",
    "unset _clean_development_bin",
    end
  ];
}

function claudeDisabledBlock(runtime, env, begin, end) {
  const cleaned = environmentWithoutSessionRouting(env, runtime.binDir);
  const removed = [...CLAUDE_ROUTED_ENVIRONMENT]
    .filter((name) => environmentValue(env, name) !== undefined && environmentValue(cleaned, name) === undefined)
    .sort();
  const body = [
    "# clean-development disabled-project pass-through",
    ...removed.map((name) => `unset ${name}`),
    `unset CLEAN_DEVELOPMENT_ACTIVE CLEAN_DEVELOPMENT_RESOLVED_ROOT CLEAN_DEVELOPMENT_WORKSPACE_ID CLEAN_DEVELOPMENT_WORKSPACE CLEAN_DEVELOPMENT_CARGO_TARGET_DIR ${SESSION_ENV_MARKER}`,
    `_clean_development_bin=${shellQuote(runtime.binDir)}`,
    "case \"${PATH:-}\" in",
    "  \"${_clean_development_bin}\") PATH= ;;",
    "  \"${_clean_development_bin}:\"*) PATH=${PATH#*:} ;;",
    "esac",
    "export PATH",
    `${SESSION_MODE_ENV}=skip`,
    `export ${SESSION_MODE_ENV}`,
    "unset _clean_development_bin"
  ];
  const digest = tomlBlockSha256([begin, ...body, end]);
  return [begin, `${body[0]} sha256=${digest}`, ...body.slice(1), end];
}

function isKnownClaudeDisabledBlock(lines, runtime, begin, end) {
  if (lines[0] !== begin || lines.at(-1) !== end) return false;
  const digest = lines[1]?.match(/^# clean-development disabled-project pass-through sha256=([a-f0-9]{64})$/)?.[1];
  if (!digest) return false;
  const unsigned = [begin, "# clean-development disabled-project pass-through", ...lines.slice(2)];
  if (tomlBlockSha256(unsigned) !== digest) return false;
  let index = 2;
  let previous = "";
  while (lines[index]?.startsWith("unset ") && lines[index] !== `unset CLEAN_DEVELOPMENT_ACTIVE CLEAN_DEVELOPMENT_RESOLVED_ROOT CLEAN_DEVELOPMENT_WORKSPACE_ID CLEAN_DEVELOPMENT_WORKSPACE CLEAN_DEVELOPMENT_CARGO_TARGET_DIR ${SESSION_ENV_MARKER}`) {
    const name = lines[index].slice("unset ".length);
    if (!CLAUDE_ROUTED_ENVIRONMENT.has(name) || name <= previous) return false;
    previous = name;
    index += 1;
  }
  const suffix = [
    `unset CLEAN_DEVELOPMENT_ACTIVE CLEAN_DEVELOPMENT_RESOLVED_ROOT CLEAN_DEVELOPMENT_WORKSPACE_ID CLEAN_DEVELOPMENT_WORKSPACE CLEAN_DEVELOPMENT_CARGO_TARGET_DIR ${SESSION_ENV_MARKER}`,
    null,
    "case \"${PATH:-}\" in",
    "  \"${_clean_development_bin}\") PATH= ;;",
    "  \"${_clean_development_bin}:\"*) PATH=${PATH#*:} ;;",
    "esac",
    "export PATH",
    `${SESSION_MODE_ENV}=skip`,
    `export ${SESSION_MODE_ENV}`,
    "unset _clean_development_bin",
    end
  ];
  if (lines.length - index !== suffix.length) return false;
  return suffix.every((line, offset) => offset === 1
    ? lines[index + offset] === `_clean_development_bin=${shellQuote(runtime.binDir)}`
    : lines[index + offset] === line);
}

export function applyClaudeSessionEnvironment(config, runtime, env = process.env, requestedOwner, { disabled = false } = {}) {
  const environmentFile = env.CLAUDE_ENV_FILE;
  if (!environmentFile) return { applied: false, reason: "CLAUDE_ENV_FILE is not set" };
  const receipt = validateClaudeHookOwner(config, env, requestedOwner);
  if (!receipt) return { applied: false, reason: "Claude native hook is not installed" };
  const begin = `# clean-development begin (claude-session) owner=${receipt.ownershipId}`;
  const end = `# clean-development end (claude-session) owner=${receipt.ownershipId}`;
  const normalBlockLines = claudeSessionBlock(runtime, begin, end);
  const blockLines = disabled ? claudeDisabledBlock(runtime, env, begin, end) : normalBlockLines;
  const block = blockLines.join("\n");
  fs.mkdirSync(path.dirname(environmentFile), { recursive: true });
  const original = fs.existsSync(environmentFile) ? readTextMetadata(environmentFile) : "";
  const lines = original.split(/\r?\n/);
  const starts = lines.flatMap((line, index) => line === begin ? [index] : []);
  const finishes = lines.flatMap((line, index) => line === end ? [index] : []);
  const markerLines = lines.filter((line) => /^# clean-development (?:begin|end)(?:\b|\s*\()/.test(line));
  if (starts.length === 0 && finishes.length === 0) {
    if (markerLines.length > 0) throw new Error(`Refusing unowned or ambiguous clean-development block in ${environmentFile}`);
  } else {
    if (starts.length !== 1 || finishes.length !== 1 || finishes[0] <= starts[0] || markerLines.length !== 2) {
      throw new Error(`Refusing malformed clean-development block in ${environmentFile}`);
    }
    const existingBlock = lines.slice(starts[0], finishes[0] + 1);
    const matchesNormal = existingBlock.length === normalBlockLines.length
      && existingBlock.every((line, index) => line === normalBlockLines[index]);
    const matchesDisabled = isKnownClaudeDisabledBlock(existingBlock, runtime, begin, end);
    if (!matchesNormal && !matchesDisabled) {
      throw new Error(`Refusing modified clean-development block in ${environmentFile}`);
    }
    if (existingBlock.length === blockLines.length && existingBlock.every((line, index) => line === blockLines[index])) {
      return { applied: true, environmentFile, binDir: runtime.binDir, owner: receipt.ownershipId };
    }
    lines.splice(starts[0], finishes[0] - starts[0] + 1, ...blockLines);
    const content = lines.join("\n");
    writeTextAtomicFollowingLeafSymlink(environmentFile, content.endsWith("\n") ? content : `${content}\n`);
    return { applied: true, environmentFile, binDir: runtime.binDir, owner: receipt.ownershipId };
  }
  const content = `${original}${original && !original.endsWith("\n") ? "\n" : ""}${block}\n`;
  writeTextAtomicFollowingLeafSymlink(environmentFile, content.endsWith("\n") ? content : `${content}\n`);
  return { applied: true, environmentFile, binDir: runtime.binDir, owner: receipt.ownershipId };
}

export function integrationStatus(config, env = process.env, options = {}) {
  return readIntegrationReceipt(config, env, options);
}

function healthResult(status, reason, detail) {
  return { status, reason, detail };
}

function expectedIntegrationFile(config, env, agent) {
  return agent === "claude" ? claudeSettingsPath(config, env) : agentConfigPath(config, env, agent);
}

// Observe a snapshot only. Leaf symlinks installed intentionally are supported;
// changed referents and symlinked parent directories do not establish presence.
function observedIntegrationText(entry) {
  try {
    const leaf = fs.lstatSync(entry.file);
    if (!leaf.isFile() && !leaf.isSymbolicLink()) return healthResult("unavailable", "not-regular-file", "Configuration is not a regular file or supported leaf symlink");
    ensureRealDirectory(path.dirname(entry.file), { label: "Integration configuration directory" });
    if (fs.realpathSync(entry.file) !== entry.referent) return healthResult("modified", "referent-changed", "Configuration referent differs from the recorded installation");
    const before = fs.statSync(entry.file);
    const text = readTextMetadata(entry.file);
    const after = fs.statSync(entry.file);
    if (fs.realpathSync(entry.file) !== entry.referent || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      return healthResult("unavailable", "configuration-changed-during-read", "Configuration changed while being inspected");
    }
    return { text };
  } catch (error) {
    return error.code === "ENOENT"
      ? healthResult("missing", "configuration-missing", "Recorded configuration file is missing")
      : healthResult("unavailable", "configuration-unreadable", `Configuration could not be inspected: ${error.code || error.message}`);
  }
}

function claudeIntegrationHealth(entry, text) {
  let settings;
  try { settings = JSON.parse(text); } catch {
    return healthResult("modified", "invalid-json", "Configuration is not valid JSON");
  }
  if (!isObject(settings) || (settings.hooks !== undefined && !isObject(settings.hooks))
    || (settings.hooks?.SessionStart !== undefined && !Array.isArray(settings.hooks.SessionStart))) {
    return healthResult("modified", "hook-shape-changed", "Claude SessionStart configuration has an unsupported shape");
  }
  const candidates = [];
  for (const group of settings.hooks?.SessionStart || []) {
    for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
      if (typeof hook?.command === "string" && (hook.command === entry.command || hook.command.includes(entry.ownershipId))) {
        candidates.push({ group, hook });
      }
    }
  }
  if (!candidates.length) return healthResult("missing", "owned-hook-missing", "Recorded Claude SessionStart hook is missing");
  if (candidates.length !== 1) return healthResult("ambiguous", "owned-hook-duplicated", "More than one hook claims the recorded Claude owner");
  const { group, hook } = candidates[0];
  if (group.matcher !== "startup|resume|clear|compact|fork" || hook.type !== "command" || hook.command !== entry.command
    || Object.keys(hook).some((key) => !["type", "command"].includes(key))
    || Object.keys(group).some((key) => !["matcher", "hooks"].includes(key))) {
    return healthResult("modified", "owned-hook-changed", "Recorded Claude hook command or lifecycle shape changed");
  }
  return healthResult("present", "owned-hook-matched", "Recorded Claude hook command and lifecycle shape are present");
}

// This is deliberately a bounded subset validator, not a native host parser.
// A matching owned block cannot make an invalid surrounding file loadable.
// Syntax we cannot establish conservatively is unavailable, never present.
function tomlConfigurationHealth(text) {
  const source = text.replaceAll("\r\n", "\n");
  let index = 0, entries = 0, values = 0, definitionBytes = 0, table = [];
  const definitions = new Map();
  const reject = (unsupported = false) => { throw { unsupported }; };
  const horizontal = () => { while (source[index] === " " || source[index] === "\t") index += 1; };
  const space = () => {
    while (index < source.length) {
      if (/[ \t\n]/.test(source[index])) index += 1;
      else if (source[index] === "#") { while (index < source.length && source[index] !== "\n") index += 1; }
      else break;
    }
  };
  const endLine = () => {
    horizontal();
    if (source[index] === "#") { while (index < source.length && source[index] !== "\n") index += 1; }
    if (index < source.length && source[index] !== "\n") reject();
  };
  function string(key = false) {
    const quote = source[index];
    const multiline = source.startsWith(quote.repeat(3), index);
    if (multiline && key) reject();
    index += multiline ? 3 : 1;
    let decoded = "";
    while (index < source.length) {
      if (source[index] === quote) {
        if (!multiline) { index += 1; return decoded; }
        let count = 0;
        while (source[index + count] === quote) count += 1;
        if (count >= 3) {
          if (count > 5) reject();
          decoded += quote.repeat(count - 3); index += count; return decoded;
        }
      }
      const character = source[index++];
      if ((character.charCodeAt(0) < 32 && character !== "\t" && !(multiline && character === "\n")) || character.charCodeAt(0) === 127) reject();
      if (quote !== '"' || character !== "\\") { decoded += character; continue; }
      if (multiline && /[ \t\n]/.test(source[index] || "")) {
        horizontal();
        if (source[index] !== "\n") reject();
        while (/[ \t\n]/.test(source[index] || "")) index += 1;
        continue;
      }
      const escape = source[index++];
      const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
      if (Object.hasOwn(simple, escape)) decoded += simple[escape];
      else if (escape === "u" || escape === "U") {
        const length = escape === "u" ? 4 : 8, digits = source.slice(index, index + length);
        if (digits.length !== length || !/^[0-9a-f]+$/i.test(digits)) reject();
        const point = Number.parseInt(digits, 16);
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) reject();
        decoded += String.fromCodePoint(point); index += length;
      } else if (escape === "e" || escape === "x") reject(true); // Newer native syntax is outside this subset.
      else reject();
    }
    reject();
  }
  function keys() {
    const parts = [];
    while (true) {
      horizontal();
      if (source[index] === '"' || source[index] === "'") parts.push(string(true));
      else {
        const start = index;
        while (/[A-Za-z0-9_-]/.test(source[index] || "")) index += 1;
        if (index === start) reject();
        parts.push(source.slice(start, index));
      }
      horizontal();
      if (parts.length > 32 || parts.at(-1).length > 4096) reject(true);
      if (source[index] !== ".") return parts;
      index += 1;
    }
  }
  function value(depth = 0) {
    if (depth > 32 || ++values > 50_000) reject(true);
    if (source[index] === '"' || source[index] === "'") { string(); return; }
    if (source[index] === "{") reject(true);
    if (source[index] === "[") {
      index += 1; space();
      while (source[index] !== "]") {
        value(depth + 1); space();
        if (source[index] === "]") break;
        if (source[index++] !== ",") reject();
        space();
      }
      index += 1; return;
    }
    const start = index;
    while (index < source.length && !/[ \t\n#\],}]/.test(source[index])) index += 1;
    const token = source.slice(start, index);
    const integer = "(?:0|[1-9](?:_?[0-9])*)", fraction = "[0-9](?:_?[0-9])*";
    if (/^(?:true|false|[+-]?(?:inf|nan))$/.test(token)
      || new RegExp(`^[+-]?${integer}$`).test(token)
      || /^0x[0-9a-f](?:_?[0-9a-f])*$/i.test(token) || /^0o[0-7](?:_?[0-7])*$/.test(token) || /^0b[01](?:_?[01])*$/.test(token)
      || new RegExp(`^[+-]?${integer}(?:\\.${fraction}(?:[eE][+-]?${fraction})?|[eE][+-]?${fraction})$`).test(token)) return;
    if (/^(?:[0-9]{4}-[0-9]{2}-|[0-9]{2}:[0-9]{2}:)/.test(token)) reject(true);
    reject();
  }
  function define(parts, kind) {
    if (parts.length > 64) reject(true);
    const store = (key, type) => {
      definitionBytes += Buffer.byteLength(key);
      if (definitionBytes > MAX_METADATA_BYTES * 2) reject(true);
      definitions.set(key, type);
    };
    for (let length = 1; length < parts.length; length += 1) {
      const key = JSON.stringify(parts.slice(0, length)), existing = definitions.get(key);
      if (existing === "value") reject();
      if (!existing) store(key, kind === "value" ? "dotted-table" : "implicit-table");
    }
    const key = JSON.stringify(parts), existing = definitions.get(key);
    if (existing && !(kind === "table" && existing === "implicit-table")) reject();
    store(key, kind);
  }
  try {
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(source)) reject();
    space();
    while (index < source.length) {
      if (++entries > 10_000) reject(true);
      if (source[index] === "[") {
        if (source[index + 1] === "[") reject(true);
        index += 1; table = keys();
        if (source[index++] !== "]") reject();
        define(table, "table");
      } else {
        const parts = [...table, ...keys()];
        if (source[index++] !== "=") reject();
        horizontal(); value(); define(parts, "value");
      }
      endLine(); space();
    }
    return null;
  } catch (error) {
    return error?.unsupported
      ? healthResult("unavailable", "native-toml-form-unverified", "Surrounding TOML uses inline/array tables, datetime values, newer escapes or nesting/entry limits outside the bounded diagnostic subset; native configuration loadability was not established")
      : healthResult("modified", "invalid-native-toml", "Surrounding TOML has invalid value/key syntax or duplicate/redefined keys/tables");
  }
}

function tomlIntegrationHealth(config, entry, text) {
  const originalLines = text.split(/\r?\n/);
  const syntax = tomlSyntaxLines(originalLines);
  if (!syntax) return healthResult("modified", "unsupported-toml", "Configuration has unterminated or unsupported TOML syntax");
  const { begin, end } = receiptTomlMarkers(entry);
  const starts = [], finishes = [];
  for (let index = 0; index < syntax.length; index += 1) {
    if (syntax[index] === begin) starts.push(index);
    if (syntax[index] === end) finishes.push(index);
  }
  if (starts.length > 1 || finishes.length > 1) return healthResult("ambiguous", "owned-block-duplicated", "Recorded native block markers occur more than once");
  if (!starts.length && !finishes.length) {
    const escapedAgent = entry.agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const otherMarkers = syntax.some((line) => new RegExp(`^\\s*#\\s*clean-development\\s+(?:begin|end)\\s*\\(${escapedAgent}\\)`).test(line));
    return otherMarkers ? healthResult("modified", "owner-markers-changed", "Native ownership markers differ from the recorded installation")
      : healthResult("missing", "owned-block-missing", "Recorded native block is missing");
  }
  if (starts.length !== 1 || finishes.length !== 1 || finishes[0] <= starts[0]) {
    return healthResult("modified", "owned-markers-changed", "Recorded native block has incomplete or reordered ownership markers");
  }
  const body = originalLines.slice(starts[0] + 1, finishes[0]);
  const commandPrefix = body.at(-1)?.startsWith("cmd_prefix = ");
  const shapeMatchesAgent = entry.agent !== "codex" || !commandPrefix;
  if (!shapeMatchesAgent || !isOwnedTomlBlock(body, entry.blockSha256 ? undefined : config.locations.binDir)
    || (entry.blockSha256 && tomlBlockSha256(originalLines.slice(starts[0], finishes[0] + 1)) !== entry.blockSha256)) {
    return healthResult("modified", "owned-block-changed", "Recorded native block content or supported shape changed");
  }
  // A marked assignment without its own table header still relies on the host
  // table immediately preceding it. Markers alone cannot establish its scope.
  const precedingHeader = syntax.slice(0, starts[0]).findLast((line) => /^\s*\[/.test(line));
  const expectedHeader = commandPrefix ? /^\s*\[toolset\.bash\]\s*(?:#.*)?$/
    : /^\s*\[shell_environment_policy\.set\]\s*(?:#.*)?$/;
  if ((body[0] === "allow_login_shell = false" && precedingHeader !== undefined)
    || (body[0] !== "allow_login_shell = false" && !body[0]?.startsWith("[")
      && !expectedHeader.test(precedingHeader || ""))) {
    return healthResult("modified", "owned-block-scope-changed", "Recorded native assignments are outside their expected TOML table");
  }
  const configuration = tomlConfigurationHealth(text);
  if (configuration) return configuration;
  return healthResult("present", entry.blockSha256 ? "owned-block-hash-matched" : "legacy-owned-block-matched",
    entry.blockSha256 ? "Recorded normalized native block and supported shape are present" : "Legacy native block shape and runtime-bin prefix are present");
}

/** Read-only observed integration health, separate from ownership authority. */
export function integrationHealth(config, env = process.env) {
  const file = path.join(config.locations.stateDir, "integrations.json");
  let recorded = { schemaVersion: 1, integrations: [] };
  let receipt;
  try {
    const leaf = fs.lstatSync(file);
    if (!leaf.isFile() || leaf.isSymbolicLink()) {
      receipt = healthResult("invalid", "not-real-receipt", "Integration receipt is not a real file");
    } else {
      recorded = readIntegrationReceipt(config, env);
      receipt = healthResult("present", "receipt-valid", "Integration ownership receipt is valid");
    }
  } catch (error) {
    receipt = error.code === "ENOENT" ? healthResult("missing", "receipt-missing", "No integration ownership receipt was found")
      : healthResult(error.code === "EACCES" || error.code === "EPERM" ? "unavailable" : "invalid", "receipt-unreadable-or-invalid", `Integration receipt could not be validated: ${error.message}`);
  }
  const selectedAgents = new Set(config.agents || []);
  const integrations = recorded.integrations.map((entry) => {
    const result = { agent: entry.agent, mode: entry.mode, recorded: true, selected: selectedAgents.has(entry.agent),
      ...(entry.file ? { file: entry.file } : { command: entry.command }) };
    if (recorded.integrations.filter((candidate) => candidate.agent === entry.agent).length !== 1) {
      return { ...result, ...healthResult("ambiguous", "multiple-recorded-integrations", "More than one installation entry is recorded for this host") };
    }
    if (entry.mode === "zero-context-launcher") {
      try {
        const details = fs.lstatSync(entry.command);
        return { ...result, scope: "launcher-path-only", ...(details.isFile() && !details.isSymbolicLink()
          ? healthResult("present", "launcher-present", "Recorded launcher file is present; runtime inventory is checked separately")
          : healthResult("modified", "launcher-shape-changed", "Recorded launcher is not a real file")) };
      } catch (error) {
        return { ...result, ...healthResult(error.code === "ENOENT" ? "missing" : "unavailable", "launcher-unavailable", `Recorded launcher could not be inspected: ${error.code || error.message}`) };
      }
    }
    const expectedFile = expectedIntegrationFile(config, env, entry.agent);
    if (path.resolve(entry.file) !== path.resolve(expectedFile)) {
      return { ...result, expectedFile, ...healthResult("modified", "configuration-path-changed", "Current host configuration path differs from the recorded installation") };
    }
    const observed = observedIntegrationText(entry);
    return { ...result, ...(observed.text === undefined ? observed : entry.mode === "native-hook"
      ? claudeIntegrationHealth(entry, observed.text) : tomlIntegrationHealth(config, entry, observed.text)) };
  });
  for (const agent of new Set(["claude", "codex", "grok", ...selectedAgents])) {
    if (integrations.some((entry) => entry.agent === agent)) continue;
    integrations.push({ agent, recorded: false, selected: selectedAgents.has(agent),
      ...healthResult("missing", "integration-not-recorded", "No integration is recorded for this host; host availability is not inferred") });
  }
  return { schemaVersion: 1, receipt: { file, ...receipt }, recorded, integrations,
    scope: "Configuration snapshot only; command wrappers, shell startup and already-running host environments are independent and are not tested" };
}
