export const VERSION = "0.2.1";
export const PACKAGE_NAME = "clean-development";
export const CONFIG_FILE = ".clean-development.json";

export const SUPPORTED_AGENTS = Object.freeze({
  claude: "claude",
  antigravity: "agy",
  codex: "codex",
  cursor: "cursor-agent",
  devin: "devin",
  droid: "droid",
  gemini: "gemini",
  copilot: "copilot",
  grok: "grok",
  kimi: "kimi",
  opencode: "opencode",
  pi: "pi",
  hermes: "hermes"
});

export const SHIM_TOOLS = Object.freeze([
  "cargo",
  "go",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "uv",
  "pip",
  "pip3",
  "dotnet",
  "composer",
  "ccache",
  "sccache"
]);

export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1,
  enabled: true,
  retention: {
    buildDays: 30
  },
  tools: Object.fromEntries(SHIM_TOOLS.map((tool) => [tool, true]))
});
