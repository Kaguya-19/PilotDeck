import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Context-owned persistence boundary for large model-visible tool results. */
export type ToolResultSpillPort = {
  writeTextIfAbsent(path: string, content: string): Promise<{ created: boolean }>;
  copyFileIfAbsent(sourcePath: string, destinationPath: string): Promise<{ created: boolean }>;
};

/** Native provider preserves exclusive-write and private-directory semantics. */
export function createNodeToolResultSpillPort(): ToolResultSpillPort {
  return {
    async writeTextIfAbsent(path, content) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try {
        await writeFile(path, content, { flag: "wx", mode: 0o600, encoding: "utf8" });
        return { created: true };
      } catch (error) {
        if (isFileExistsError(error)) return { created: false };
        throw error;
      }
    },
    async copyFileIfAbsent(sourcePath, destinationPath) {
      await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
      try {
        await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
        return { created: true };
      } catch (error) {
        if (isFileExistsError(error)) return { created: false };
        throw error;
      }
    },
  };
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
