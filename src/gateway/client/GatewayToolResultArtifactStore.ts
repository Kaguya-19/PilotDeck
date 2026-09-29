import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type {
  GatewayToolResultArtifactInput,
  GatewayToolResultArtifactStorePort,
} from "./GatewayToolResultArtifactStorePort.js";

export type GatewayToolResultArtifactStoreOptions = {
  rootDir?: string;
  thresholdBytes?: number;
  createDirectory?: (path: string) => Promise<void>;
  writeText?: (path: string, text: string) => Promise<void>;
};

const DEFAULT_THRESHOLD_BYTES = 4096;

/**
 * Native best-effort store for large Gateway tool-result display artifacts.
 *
 * It does not replace the canonical Session transcript. The Gateway can show
 * the returned location immediately while a failed write remains non-fatal,
 * matching the historical host-preview behavior.
 */
export class GatewayToolResultArtifactStore implements GatewayToolResultArtifactStorePort {
  private readonly rootDir: string;
  private readonly thresholdBytes: number;
  private readonly createDirectory: (path: string) => Promise<void>;
  private readonly writeText: (path: string, text: string) => Promise<void>;

  constructor(options: GatewayToolResultArtifactStoreOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? resolve(tmpdir(), "pilotdeck-tool-results"));
    this.thresholdBytes = options.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
    this.createDirectory = options.createDirectory ?? (async (path) => {
      await mkdir(path, { recursive: true });
    });
    this.writeText = options.writeText ?? ((path, text) => writeFile(path, text, { mode: 0o600 }));
  }

  persist(input: GatewayToolResultArtifactInput): string | undefined {
    if (Buffer.byteLength(input.text, "utf8") <= this.thresholdBytes) return undefined;
    const dir = resolve(
      this.rootDir,
      safePathPart(input.sessionId),
      safePathPart(input.turnId),
    );
    const path = resolve(dir, `${safePathPart(input.toolCallId)}.txt`);
    void this.write(dir, path, input.text);
    return path;
  }

  private async write(dir: string, path: string, text: string): Promise<void> {
    try {
      await this.createDirectory(dir);
      await this.writeText(path, text);
    } catch {
      // Host preview artifacts are advisory and must not alter tool completion.
    }
  }
}

function safePathPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "value";
}
