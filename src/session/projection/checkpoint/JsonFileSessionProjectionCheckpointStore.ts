import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseSessionProjectionCheckpointEnvelope,
  type SessionProjectionCheckpointEnvelope,
  type SessionProjectionCheckpointStore,
} from "./SessionProjectionCheckpointStore.js";

export type JsonFileSessionProjectionCheckpointStoreOptions = {
  path: string;
  onError?: (error: unknown) => void;
};

export class JsonFileSessionProjectionCheckpointStore implements SessionProjectionCheckpointStore {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: JsonFileSessionProjectionCheckpointStoreOptions) {}

  async load(sessionId: string): Promise<SessionProjectionCheckpointEnvelope | undefined> {
    await this.writeTail;
    try {
      const raw = await readFile(this.options.path, "utf8");
      return parseSessionProjectionCheckpointEnvelope(JSON.parse(raw), sessionId);
    } catch (error) {
      if (!isNotFoundError(error)) this.report(error);
      return undefined;
    }
  }

  save(envelope: SessionProjectionCheckpointEnvelope): Promise<void> {
    const stable = parseSessionProjectionCheckpointEnvelope(
      JSON.parse(JSON.stringify(envelope)),
      envelope.sessionId,
    );
    const write = this.writeTail.then(async () => {
      await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.options.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(stable)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporaryPath, this.options.path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => {});
        throw error;
      }
    });
    this.writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private report(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // A diagnostic sink must not make a disposable cache authoritative.
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}
