import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, lstat, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export type LegalStorageConfig = {
  root: string;
  database?: { url?: string; schema?: string; table?: string };
  snapshotRoot?: string;
  objectPrefix?: string;
  storageConfigVersion?: string;
};

export function resolveLegalStorageConfig(
  env: Record<string, string | undefined> = process.env,
): LegalStorageConfig | undefined {
  const root = env.PILOTDECK_LEGAL_STORAGE_ROOT?.trim();
  if (!root) return undefined;
  return {
    root: resolve(root),
    snapshotRoot: env.PILOTDECK_LEGAL_SNAPSHOT_ROOT?.trim() || resolve(root),
    database: {
      url: env.PILOTDECK_LEGAL_DATABASE_URL?.trim() || undefined,
      schema: env.PILOTDECK_LEGAL_DATABASE_SCHEMA?.trim() || undefined,
      table: env.PILOTDECK_LEGAL_DATABASE_TABLE?.trim() || undefined,
    },
    storageConfigVersion: env.PILOTDECK_LEGAL_STORAGE_CONFIG_VERSION?.trim() || "env",
    objectPrefix: env.PILOTDECK_LEGAL_OBJECT_PREFIX?.trim() || undefined,
  };
}

export type InvocationLogContext = {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  logicalCallId: string;
  caller: "agent" | "subagent" | "router_judge";
  subSessionId?: string;
  parentToolCallId?: string;
  storageConfigVersion?: string;
};

export type InvocationLogRecord = InvocationLogContext & {
  requestLogId: string;
  requestId: string;
  attempt: number;
  provider: string;
  protocol: string;
  model: string;
  stream: boolean;
  requestBody: string;
  responseBody?: string;
  requestBytes: number;
  responseBytes?: number;
  httpStatus?: number;
  outcome: "success" | "provider_error" | "transport_error" | "aborted" | "timeout" | "incomplete";
  responseComplete: boolean;
  startedAt: string;
  completedAt: string;
  retryReason?: string;
  storageConfigVersion?: string;
};

export type ModelInvocationLogSink = {
  stage?(record: InvocationLogRecord): Promise<void>;
  append(record: InvocationLogRecord): Promise<void>;
};

export class JsonlInvocationLogSink implements ModelInvocationLogSink {
  private writeTail: Promise<void> = Promise.resolve();
  private readonly appended = new Set<string>();

  constructor(private readonly config: LegalStorageConfig) {}

  async stage(record: InvocationLogRecord): Promise<void> {
    return this.enqueue(async () => {
      const path = this.pathFor(record);
      await mkdir(dirname(path), { recursive: true });
      await mkdir(join(dirname(path), ".pending"), { recursive: true });
      await writeFile(join(dirname(path), ".pending", `${safePart(record.requestLogId)}.json`), JSON.stringify(record), "utf8");
    });
  }

  async append(record: InvocationLogRecord): Promise<void> {
    return this.enqueue(async () => {
      if (this.appended.has(record.requestLogId)) return;
      const path = this.pathFor(record);
      await mkdir(dirname(path), { recursive: true });
      await unlink(join(dirname(path), ".pending", `${safePart(record.requestLogId)}.json`)).catch(() => undefined);
      await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
      this.appended.add(record.requestLogId);
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeTail.then(operation);
    this.writeTail = next.catch(() => undefined);
    return next;
  }

  private pathFor(record: InvocationLogRecord): string {
    const workspace = safePart(record.workspaceId);
    const session = safePart(record.sessionId);
    return join(this.config.root, "workspaces", workspace, "sessions", session, "llm", "invocations.jsonl");
  }
}

export type WorkspaceSnapshotInput = {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  roundNumber?: number;
  workspaceDir: string;
  failureReason?: string;
};

export type WorkspaceSnapshotResult = {
  snapshotId: string;
  phase: "pre_user" | "post_agent";
  state: "committed" | "failed";
  manifestPath?: string;
  error?: string;
};

type SnapshotEntry = {
  path: string;
  entryType: "file" | "symlink";
  size: number;
  md5?: string;
  objectKey?: string;
  linkTarget?: string;
};

export type WorkspaceSnapshotRecorder = {
  capturePreUser(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotResult>;
  capturePostAgent(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotResult>;
};

export class ContentAddressedWorkspaceSnapshotRecorder implements WorkspaceSnapshotRecorder {
  private readonly completed = new Map<string, WorkspaceSnapshotResult>();
  private readonly inFlight = new Map<string, Promise<WorkspaceSnapshotResult>>();

  constructor(private readonly config: LegalStorageConfig) {}

  capturePreUser(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotResult> {
    return this.capture(input, "pre_user", "captured");
  }

  capturePostAgent(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotResult> {
    return this.capture(input, "post_agent", input.failureReason?.includes("abort") ? "aborted" : "failed");
  }

  private async capture(
    input: WorkspaceSnapshotInput,
    phase: "pre_user" | "post_agent",
    roundStatus: "captured" | "failed" | "aborted",
  ): Promise<WorkspaceSnapshotResult> {
    const key = `${input.sessionId}\0${input.turnId}\0${phase}`;
    const prior = this.completed.get(key);
    if (prior) return prior;
    const active = this.inFlight.get(key);
    if (active) return active;

    const operation = this.captureOnce(input, phase, roundStatus);
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async captureOnce(
    input: WorkspaceSnapshotInput,
    phase: "pre_user" | "post_agent",
    roundStatus: "captured" | "failed" | "aborted",
  ): Promise<WorkspaceSnapshotResult> {
    const key = `${input.sessionId}\0${input.turnId}\0${phase}`;
    const snapshotId = randomUUID();
    const snapshotRoot = resolve(this.config.snapshotRoot ?? this.config.root);
    const partition = join(snapshotRoot, "workspaces", safePart(input.workspaceId), "sessions", safePart(input.sessionId), "snapshots", snapshotId);
    const temp = join(partition, ".tmp");
    const manifestPath = join(partition, "manifest.json");
    try {
      await mkdir(join(snapshotRoot, "objects", "md5"), { recursive: true });
      await mkdir(temp, { recursive: true });
      const entries = await this.scanWorkspace(resolve(input.workspaceDir), snapshotRoot);
      const manifest = {
        snapshotId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        runId: input.runId,
        roundNumber: input.roundNumber,
        phase,
        roundStatus,
        failureReason: input.failureReason,
        storageConfigVersion: this.config.storageConfigVersion,
        entries,
        createdAt: new Date().toISOString(),
      };
      const temporaryManifest = join(temp, "manifest.json");
      await writeFile(temporaryManifest, JSON.stringify(manifest, null, 2), "utf8");
      await rename(temporaryManifest, manifestPath);
      await writeFile(join(partition, "_COMMITTED"), "", "utf8");
      const result = { snapshotId, phase, state: "committed" as const, manifestPath };
      this.completed.set(key, result);
      return result;
    } catch (error) {
      const result = { snapshotId, phase, state: "failed" as const, error: error instanceof Error ? error.message : String(error) };
      return result;
    }
  }

  private async scanWorkspace(workspaceDir: string, snapshotRoot: string): Promise<SnapshotEntry[]> {
    const entries: SnapshotEntry[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const name of await readdir(directory)) {
        const absolute = join(directory, name);
        const relativePath = relative(workspaceDir, absolute).split(sep).join("/");
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) {
          const target = await (await import("node:fs/promises")).readlink(absolute);
          entries.push({ path: relativePath, entryType: "symlink", size: 0, linkTarget: target });
          continue;
        }
        if (info.isDirectory()) {
          await visit(absolute);
          continue;
        }
        if (!info.isFile()) continue;
        const digest = await md5File(absolute);
        const objectPath = join(snapshotRoot, "objects", "md5", digest.slice(0, 2), digest.slice(2, 4), digest);
        try {
          await lstat(objectPath);
        } catch {
          await mkdir(dirname(objectPath), { recursive: true });
          const temporary = join(snapshotRoot, "objects", "md5", `.tmp-${randomUUID()}`);
          await copyFile(absolute, temporary);
          try {
            await rename(temporary, objectPath);
          } catch (error) {
            await unlink(temporary).catch(() => undefined);
            try {
              await lstat(objectPath);
            } catch {
              throw error;
            }
          }
        }
        entries.push({ path: relativePath, entryType: "file", size: info.size, md5: digest, objectKey: `objects/md5/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}` });
      }
    };
    await visit(workspaceDir);
    return entries;
  }
}

async function md5File(path: string): Promise<string> {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function safePart(value: string): string {
  const raw = value.trim();
  if (!raw || raw.includes("\0") || raw.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) {
    throw new Error("Invalid storage identity");
  }
  const part = raw.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!part || part === "." || part === "..") throw new Error("Invalid storage identity");
  return part;
}
