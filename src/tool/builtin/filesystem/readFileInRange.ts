import type { FsReadRangeResult } from "../../execution-world/FsPort.js";
import { createNodeFsPort } from "../../execution-world/NodeFsPort.js";

/** Compatibility alias for callers that used the pre-port helper directly. */
export type ReadFileRangeResult = FsReadRangeResult;

const nodeFs = createNodeFsPort();

export async function readFileInRange(
  filePath: string,
  startLine: number,
  limit?: number,
  signal?: AbortSignal,
): Promise<ReadFileRangeResult> {
  return nodeFs.readFileInRange(filePath, startLine, limit, signal);
}
