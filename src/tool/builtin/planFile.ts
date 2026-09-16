import { isAbsolute, relative, resolve } from "node:path";
import {
  ensureWritableDirectory,
  isVirtualProjectRoot,
  PILOT_PROJECT_DIR_NAME,
  resolvePilotHomeProjectArtifactDir,
  resolveRuntimeArtifactFallbackDir,
} from "../../pilot/index.js";
import { createNodePlanStoragePort, type PlanStoragePort } from "../execution-world/PlanStoragePort.js";

export type PlanFileManager = {
  getPlanDirectoryPath(): string;
  resolvePlanFilePath(filePath: string, cwd: string): string | undefined;
  readPlanFile(filePath: string, cwd: string): string | undefined;
};

export function createPlanFileManager(options: {
  projectRoot: string;
  /** @deprecated Plans are project-scoped; retained for SDK call-site compatibility. */
  pilotHome?: string;
  env?: Record<string, string | undefined>;
  storage?: PlanStoragePort;
}): PlanFileManager {
  const storage = options.storage ?? createNodePlanStoragePort();
  const pilotHome = options.pilotHome ?? options.projectRoot;
  const virtualProject = options.pilotHome !== undefined && isVirtualProjectRoot({
    projectRoot: options.projectRoot,
    pilotHome,
    env: options.env,
  });
  const preferredPlanDir = virtualProject
    ? resolvePilotHomeProjectArtifactDir({ pilotHome, projectRoot: options.projectRoot, artifact: "plans" })
    : resolve(options.projectRoot, PILOT_PROJECT_DIR_NAME, "plans");
  let planDir: string | undefined;

  function getPlanDirectoryPath(): string {
    if (!planDir) {
      planDir = virtualProject && !options.storage
        ? ensureWritableDirectory({
            preferredDir: preferredPlanDir,
            fallbackDir: resolveRuntimeArtifactFallbackDir({ pilotHome, purpose: "plans" }),
            purpose: "plans",
          }).dir
        : preferredPlanDir;
      storage.ensureDirectory(planDir);
    }
    return planDir;
  }

  function resolvePlanFilePath(filePath: string, cwd: string): string | undefined {
    if (!filePath.trim()) return undefined;
    const planDir = getPlanDirectoryPath();
    const absolutePath = resolve(isAbsolute(filePath) ? filePath : resolve(cwd, filePath));
    const relativeToPlanDir = relative(planDir, absolutePath);
    if (
      isAbsolute(relativeToPlanDir)
      || relativeToPlanDir.startsWith("..")
      || relativeToPlanDir.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      || relativeToPlanDir === ""
    ) {
      return undefined;
    }
    if (!absolutePath.toLowerCase().endsWith(".md")) {
      return undefined;
    }
    return absolutePath;
  }

  function readPlanFile(filePath: string, cwd: string): string | undefined {
    const absolutePath = resolvePlanFilePath(filePath, cwd);
    if (!absolutePath) {
      return undefined;
    }
    try {
      const content = storage.readText(absolutePath);
      return content.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  return { getPlanDirectoryPath, resolvePlanFilePath, readPlanFile };
}
