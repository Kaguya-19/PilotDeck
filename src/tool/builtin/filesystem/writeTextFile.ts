import { createNodeFsPort } from "../../execution-world/NodeFsPort.js";
import type { FsPort, FsWriteTextOptions } from "../../execution-world/FsPort.js";

export async function writeTextFile(
  filePath: string,
  content: string,
  options?: FsWriteTextOptions,
  fs: Pick<FsPort, "writeText"> = createNodeFsPort(),
): Promise<"created" | "overwritten"> {
  return (await fs.writeText(filePath, content, options)).action;
}
