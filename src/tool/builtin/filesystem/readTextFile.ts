import { PilotDeckToolRuntimeError } from "../../protocol/errors.js";
import { createNodeFsPort } from "../../execution-world/NodeFsPort.js";
import type { FsPort } from "../../execution-world/FsPort.js";

export async function readTextFile(
  filePath: string,
  fs: Pick<FsPort, "stat" | "readFile"> = createNodeFsPort(),
): Promise<string> {
  const fileStat = await fs.stat(filePath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new PilotDeckToolRuntimeError("file_not_found", `File ${filePath} does not exist.`);
    }
    throw error;
  });

  if (fileStat.kind !== "file") {
    throw new PilotDeckToolRuntimeError("file_conflict", `${filePath} is not a regular file.`);
  }

  const value = await fs.readFile(filePath);
  const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (buffer.includes(0)) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", `${filePath} appears to be a binary file.`);
  }

  return buffer.toString("utf8");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
