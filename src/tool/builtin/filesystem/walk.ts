import path from "node:path";
import { createNodeFsPort } from "../../execution-world/NodeFsPort.js";
import type { FsPort } from "../../execution-world/FsPort.js";

const DEFAULT_IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist"]);

export async function walkFiles(
  root: string,
  fs: Pick<FsPort, "readDirectory"> = createNodeFsPort(),
  signal?: AbortSignal,
): Promise<string[]> {
  const files: string[] = [];
  await walk(root, root, files, fs, signal);
  return files.sort((left, right) => left.localeCompare(right));
}

async function walk(
  root: string,
  current: string,
  files: string[],
  fs: Pick<FsPort, "readDirectory">,
  signal?: AbortSignal,
): Promise<void> {
  const entries = await fs.readDirectory(current, signal);
  for (const entry of entries) {
    if (entry.kind === "directory" && DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(current, entry.name);
    if (entry.kind === "directory") {
      await walk(root, fullPath, files, fs, signal);
    } else if (entry.kind === "file") {
      files.push(path.relative(root, fullPath));
    }
  }
}
