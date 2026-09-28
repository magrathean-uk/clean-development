import path from "node:path";
import { resolveConfig } from "./config.js";
import { canonicalizePotentialPath, isPathInside } from "./platform.js";
import { detectStack, identifyWorkspace } from "./workspace.js";
import { planSwiftpm } from "./swiftpm.js";

/** The home-directory exception applies only to that root, not its projects. */
export function repositoryManagedPaths(projectRoot, managed) {
  const root = canonicalizePotentialPath(projectRoot);
  const home = managed.locations?.home
    ? canonicalizePotentialPath(managed.locations.home)
    : null;
  if (root === home) return [];
  return [...new Set([managed.root, managed.cacheRoot, managed.buildRoot, managed.scratchRoot]
    .map((value) => canonicalizePotentialPath(value))
    .filter((value) => value === root || isPathInside(root, value)))];
}

/** Check the selected storage against both command contexts and the tool's
 * workspace. Cargo can call this again with its authoritative workspace root.
 * This inspects metadata only; it does not execute tools or create directories.
 */
export function commandStorageConflicts(config, cwd, workspace) {
  const roots = new Set([workspace.root]);
  const directories = new Set([cwd, workspace.effectiveCwd || cwd].map(canonicalizePotentialPath));
  for (const directory of directories) roots.add(detectStack(directory, { home: config.locations.home }).root);
  return [...new Set([...roots].flatMap((root) => repositoryManagedPaths(root, config)))];
}

export function assertRoutingBoundary(conflicts) {
  if (conflicts.length) {
    const error = new Error(`Managed storage must be outside the project for routed commands: ${conflicts.join(", ")}`);
    error.code = "ERR_MANAGED_STORAGE_IN_PROJECT";
    throw error;
  }
}

/** Resolve an explicit supported tool's effective configuration before writes.
 * A disabled starting project is pass-through, even with a different target.
 * Callers must handle explicit skip before reaching this metadata inspection.
 */
export function preflightToolRouting(tool, args, { config, cwd = process.cwd(), env = process.env } = {}) {
  if (config.enabled === false) return { config, workspace: null, disabled: true, repositoryPaths: [] };
  const workspace = identifyWorkspace(tool, args, cwd);
  const configCwd = tool === "swift" ? workspace.configCwd : workspace.effectiveCwd;
  const selected = configCwd === path.resolve(cwd) ? config : resolveConfig({ cwd: configCwd, env });
  const disabled = selected.enabled === false || selected.tools?.[tool] === false
    || (tool === "swift" && (selected.tools?.swift !== true || workspace.invocation.passthrough));
  const swiftpm = tool === "swift" && !disabled ? planSwiftpm(args, { config: selected, cwd, env, workspace,
    projectRoots: [cwd, workspace.effectiveCwd].map((directory) => detectStack(canonicalizePotentialPath(directory), { home: selected.locations.home }).root)
  }) : null;
  return { config: selected, workspace, disabled, swiftpm,
    repositoryPaths: disabled ? [] : commandStorageConflicts(selected, cwd, workspace) };
}
