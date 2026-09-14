import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecutionWorkspace, ExecutionWorkspacePort } from "./ExecutionWorkspacePort.js";

/** Native provider for one private temporary execution workspace. */
export function createNodeExecutionWorkspacePort(): ExecutionWorkspacePort {
  return {
    async create(options = {}): Promise<ExecutionWorkspace> {
      options.signal?.throwIfAborted();
      const prefix = normalizePrefix(options.prefix ?? "pilotdeck_execution_");
      const root = await mkdtemp(path.join(tmpdir(), prefix));
      let state: "active" | "cleaning" | "cleaned" = "active";
      let cleanupPromise: Promise<void> | undefined;

      const cleanup = (): Promise<void> => {
        if (cleanupPromise) return cleanupPromise;
        state = "cleaning";
        cleanupPromise = rm(root, { recursive: true, force: true }).then(
          () => { state = "cleaned"; },
          (error) => {
            state = "active";
            cleanupPromise = undefined;
            throw error;
          },
        );
        return cleanupPromise;
      };

      return {
        root,
        async writeText(relativePath, content) {
          if (state !== "active") {
            throw new Error(`Execution workspace is ${state}; refusing to write.`);
          }
          const target = resolveChild(root, relativePath);
          await writeFile(target, content, "utf8");
          return target;
        },
        cleanup,
      };
    },
  };
}

function normalizePrefix(prefix: string): string {
  const normalized = prefix.trim();
  if (!normalized || normalized.includes(path.sep) || normalized.includes("/")) {
    throw new Error("Execution workspace prefix must be a single non-empty path component.");
  }
  return normalized;
}

function resolveChild(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Execution workspace paths must be non-empty relative paths.");
  }
  const target = path.resolve(root, relativePath);
  const boundary = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target !== root && !target.startsWith(boundary)) {
    throw new Error(`Execution workspace path escapes its root: ${relativePath}`);
  }
  return target;
}
