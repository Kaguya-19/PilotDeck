import { mkdirSync, readFileSync } from "node:fs";

/** Minimal storage Definition for the plan-workflow capability. */
export type PlanStoragePort = {
  ensureDirectory(path: string): void;
  readText(path: string): string;
};

/** Native provider for project-local plan documents. */
export function createNodePlanStoragePort(): PlanStoragePort {
  return {
    ensureDirectory(path) {
      mkdirSync(path, { recursive: true });
    },
    readText(path) {
      return readFileSync(path, "utf8");
    },
  };
}
