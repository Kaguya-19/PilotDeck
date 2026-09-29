import { readFile, readdir } from "node:fs/promises";

/** A directory entry needed by instruction discovery, without Node Dirent leakage. */
export type InstructionStorageDirectoryEntry = {
  name: string;
  kind: "file" | "directory" | "other";
};

/**
 * Context capability Definition for discovering instruction documents.
 *
 * Discovery ordering, duplicate suppression, scope attribution and prompt
 * assembly stay with the Context consumer; this provider owns only storage
 * access. Missing paths are interpreted by the consumer as an absent layer.
 */
export type InstructionStoragePort = {
  readText(path: string): Promise<string>;
  readDirectory(path: string): Promise<InstructionStorageDirectoryEntry[]>;
};

/** Native Node provider for context instruction storage. */
export function createNodeInstructionStoragePort(): InstructionStoragePort {
  return {
    readText: (path) => readFile(path, "utf8"),
    async readDirectory(path) {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
      }));
    },
  };
}
