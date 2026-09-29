import { createNodeFsPort } from "../../tool/execution-world/NodeFsPort.js";
import type { FsPort } from "../../tool/execution-world/FsPort.js";

/** Storage metadata consumed by attachment policy and model projection. */
export type AttachmentMetadata = {
  size: number;
};

/**
 * Attachment-owned storage boundary. It intentionally exposes no generic
 * workspace operations: path policy, MIME validation, and model projection
 * remain owned by AttachmentResolver.
 */
export type AttachmentPort = {
  stat(path: string): Promise<AttachmentMetadata>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
};

/** Native attachment provider; model projection and MIME policy remain in AttachmentResolver. */
export function createNodeAttachmentPort(
  fs: Pick<FsPort, "stat" | "readFile"> = createNodeFsPort(),
): AttachmentPort {
  return {
    async stat(path) {
      const metadata = await fs.stat(path);
      return { size: metadata.size };
    },
    async readText(path) {
      const value = await fs.readFile(path, { encoding: "utf8" });
      return typeof value === "string" ? value : Buffer.from(value).toString("utf8");
    },
    async readBytes(path) {
      const value = await fs.readFile(path);
      return typeof value === "string" ? Buffer.from(value, "utf8") : new Uint8Array(value);
    },
  };
}
