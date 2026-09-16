import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EventEmitter } from "node:events";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DialogGatewayError } from "./errors.js";
import type { UploadArtifactLease, UploadedAttachment } from "./UploadArtifactLeasePort.js";
import type {
  UploadLifecyclePort,
  UploadManifestEntry,
  UploadRecord,
  UploadStatus,
} from "./UploadLifecyclePort.js";

export type { UploadArtifactLease, UploadedAttachment } from "./UploadArtifactLeasePort.js";
export type {
  UploadLifecyclePort,
  UploadManifestEntry,
  UploadRecord,
  UploadStatus,
} from "./UploadLifecyclePort.js";

export type UploadStoreOptions = {
  resolveProject: (projectKey: string) => Promise<string>;
  listProjects: () => Promise<string[]>;
  now?: () => Date;
  uuid?: () => string;
  maxFileBytes?: number;
  maxTaskBytes?: number;
  maxFiles?: number;
  maxConcurrentPerProject?: number;
  retentionMs?: number;
  /** Maximum lifetime of a crash-orphaned Gateway artifact lease. */
  leaseRetentionMs?: number;
};

const DEFAULTS = {
  maxFileBytes: 1024 ** 3,
  maxTaskBytes: 2 * 1024 ** 3,
  maxFiles: 500,
  maxConcurrentPerProject: 3,
  retentionMs: 24 * 60 * 60 * 1000,
  leaseRetentionMs: 6 * 60 * 60 * 1000,
};

/** Native filesystem provider for the UploadLifecyclePort. */
export class UploadStore implements UploadLifecyclePort {
  private readonly events = new EventEmitter();
  private readonly updates = new Map<string, Promise<void>>();
  private readonly projectCreates = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(private readonly options: UploadStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
  }

  async create(projectKey: string, files: UploadManifestEntry[], idempotencyKey?: string): Promise<UploadRecord> {
    const root = await this.options.resolveProject(projectKey);
    const canonicalRoot = await realpath(root).catch(() => { throw new DialogGatewayError("PROJECT_NOT_FOUND", `Unknown projectKey: ${projectKey}`); });
    return this.serializeProjectCreate(canonicalRoot, () => this.createAt(canonicalRoot, files, idempotencyKey));
  }

  private async createAt(canonicalRoot: string, files: UploadManifestEntry[], idempotencyKey?: string): Promise<UploadRecord> {
    const manifest = validateManifest(files, this.options);
    const keyHash = idempotencyKey ? createHash("sha256").update(idempotencyKey).digest("hex") : undefined;
    if (keyHash) {
      const prior = await this.findIdempotent(canonicalRoot, keyHash);
      if (prior) return prior;
    }
    const active = (await this.listInProject(canonicalRoot)).filter((item) => item.status === "created" || item.status === "uploading");
    if (active.length >= (this.options.maxConcurrentPerProject ?? DEFAULTS.maxConcurrentPerProject)) {
      throw new DialogGatewayError("UPLOAD_CONCURRENCY_LIMIT", "Project upload concurrency limit reached.");
    }
    const now = this.now();
    const record: UploadRecord = {
      uploadId: this.uuid(),
      projectKey: canonicalRoot,
      status: "created",
      manifest,
      totalBytes: manifest.reduce((sum, item) => sum + item.size, 0),
      uploadedBytes: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (this.options.retentionMs ?? DEFAULTS.retentionMs)).toISOString(),
      ...(keyHash ? { idempotencyKeyHash: keyHash } : {}),
      receivedClientFileIds: [],
    };
    await mkdir(this.filesDir(record), { recursive: true });
    await this.write(record);
    this.emit(record);
    return record;
  }

  private async serializeProjectCreate<T>(projectKey: string, action: () => Promise<T>): Promise<T> {
    const prior = this.projectCreates.get(projectKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const gate = prior.then(() => current);
    this.projectCreates.set(projectKey, gate);
    await prior;
    try {
      return await action();
    } finally {
      release();
      if (this.projectCreates.get(projectKey) === gate) this.projectCreates.delete(projectKey);
    }
  }

  async get(uploadId: string): Promise<UploadRecord> {
    assertUploadId(uploadId);
    for (const project of await this.options.listProjects()) {
      const canonical = await realpath(project).catch(() => undefined);
      if (!canonical) continue;
      const record = await this.readAt(canonical, uploadId);
      if (record) return this.expireIfNeeded(record);
    }
    throw new DialogGatewayError("UPLOAD_NOT_FOUND", `Unknown uploadId: ${uploadId}`);
  }

  async writePart(uploadId: string, clientFileId: string, stream: Readable): Promise<UploadedAttachment> {
    let record = await this.get(uploadId);
    if (record.status !== "created" && record.status !== "uploading") {
      throw new DialogGatewayError("UPLOAD_INVALID_STATE", `Upload is ${record.status}.`);
    }
    const expected = record.manifest.find((item) => item.clientFileId === clientFileId);
    if (!expected || record.receivedClientFileIds?.includes(clientFileId)) {
      throw new DialogGatewayError("UPLOAD_MANIFEST_MISMATCH", `Unexpected or duplicate file part: ${clientFileId}`);
    }
    record = await this.mutate(record, (next) => { next.status = "uploading"; });
    const destination = join(this.filesDir(record), clientFileId);
    const hash = createHash("sha256");
    let bytes = 0;
    let pendingProgressBytes = 0;
    let lastProgressFlushAt = 0;
    const flushProgress = () => {
      const delta = pendingProgressBytes;
      if (delta <= 0) return;
      pendingProgressBytes = 0;
      lastProgressFlushAt = Date.now();
      void this.mutate(record, (next) => {
        next.uploadedBytes = Math.min(next.totalBytes, next.uploadedBytes + delta);
      }).then((updated) => { record = updated; }).catch(() => undefined);
    };
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        bytes += chunk.length;
        if (bytes > expected.size || bytes > (this.options.maxFileBytes ?? DEFAULTS.maxFileBytes)) {
          callback(new DialogGatewayError("UPLOAD_INTEGRITY_MISMATCH", `Uploaded bytes exceed the declared size for ${clientFileId}.`));
          return;
        }
        hash.update(chunk);
        pendingProgressBytes += chunk.length;
        if (Date.now() - lastProgressFlushAt >= 100) flushProgress();
        callback(null, chunk);
      },
    });
    try {
      await pipeline(stream, meter, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
      flushProgress();
      await this.drainUpdates(uploadId);
      const digest = hash.digest("hex");
      if (bytes !== expected.size || (expected.sha256 && expected.sha256.toLowerCase() !== digest)) {
        throw new DialogGatewayError("UPLOAD_INTEGRITY_MISMATCH", `Size or SHA-256 mismatch for ${clientFileId}.`);
      }
      const attachment: UploadedAttachment = {
        attachmentId: clientFileId,
        name: expected.name,
        relativePath: expected.relativePath,
        ...(expected.mimeType ? { mimeType: expected.mimeType } : {}),
        bytes,
        sha256: digest,
        path: destination,
      };
      record = await this.mutate(record, (next) => {
        next.receivedClientFileIds = [...(next.receivedClientFileIds ?? []), clientFileId];
        next.attachments = [...(next.attachments ?? []), attachment];
      });
      return attachment;
    } catch (error) {
      await this.fail(uploadId, error instanceof DialogGatewayError ? error.code : "UPLOAD_STREAM_INTERRUPTED", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async complete(uploadId: string): Promise<UploadRecord> {
    const record = await this.get(uploadId);
    if (record.status !== "created" && record.status !== "uploading") {
      throw new DialogGatewayError("UPLOAD_INVALID_STATE", `Upload is ${record.status}.`);
    }
    const received = new Set(record.receivedClientFileIds ?? []);
    if (record.manifest.some((item) => !received.has(item.clientFileId))) {
      await this.fail(uploadId, "UPLOAD_MANIFEST_MISMATCH", "One or more declared files were not uploaded.");
      throw new DialogGatewayError("UPLOAD_MANIFEST_MISMATCH", "One or more declared files were not uploaded.");
    }
    return this.mutate(record, (next) => {
      next.status = "completed";
      next.uploadedBytes = next.totalBytes;
    });
  }

  async cancel(uploadId: string): Promise<UploadRecord> {
    const record = await this.get(uploadId);
    if (record.status === "completed") throw new DialogGatewayError("UPLOAD_ALREADY_COMPLETED", "Completed uploads cannot be cancelled.");
    if (record.status !== "created" && record.status !== "uploading") return record;
    const updated = await this.mutate(record, (next) => { next.status = "cancelled"; });
    await rm(this.filesDir(updated), { recursive: true, force: true });
    return updated;
  }

  async fail(uploadId: string, code: string, message: string): Promise<UploadRecord> {
    const record = await this.get(uploadId);
    return this.mutate(record, (next) => {
      next.status = "failed";
      next.errorCode = code;
      next.errorMessage = message;
    });
  }

  subscribe(uploadId: string, listener: (record: UploadRecord) => void): () => void {
    const event = `upload:${uploadId}`;
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }

  async cleanupExpired(): Promise<number> {
    let count = 0;
    for (const project of await this.options.listProjects()) {
      const canonical = await realpath(project).catch(() => undefined);
      if (!canonical) continue;
      for (const record of await this.listInProject(canonical)) {
        if (Date.parse(record.expiresAt) > this.now().getTime()) continue;
        await rm(this.taskDir(record), { recursive: true, force: true });
        count += 1;
      }
      await this.cleanupExpiredLeases(canonical);
    }
    return count;
  }

  async verifyAttachment(uploadId: string, projectKey: string, attachmentIds?: string[]): Promise<UploadedAttachment[]> {
    return (await this.getVerifiedAttachments(uploadId, projectKey, attachmentIds)).attachments;
  }

  /**
   * Creates a process-independent hard-link lease for verified artifacts.
   *
   * UI cleanup may remove the completed upload while a Gateway turn is still
   * running. The lease gives that turn stable paths without moving upload
   * ownership or retention policy out of this provider.
   */
  async acquireAttachmentLease(
    uploadId: string,
    projectKey: string,
    attachmentIds?: string[],
  ): Promise<UploadArtifactLease> {
    const { record, attachments } = await this.getVerifiedAttachments(uploadId, projectKey, attachmentIds);
    const leaseDir = this.leaseDir(record, randomUUID());
    const leaseExpiresAt = new Date(
      this.now().getTime() + (this.options.leaseRetentionMs ?? DEFAULTS.leaseRetentionMs),
    ).toISOString();
    await mkdir(leaseDir, { recursive: true });
    try {
      await this.writeLeaseExpiry(leaseDir, leaseExpiresAt);
      for (const attachment of attachments) {
        await link(attachment.path, join(leaseDir, attachment.attachmentId));
      }
    } catch (error) {
      await rm(leaseDir, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DialogGatewayError(
          "ATTACHMENT_TAMPERED",
          "Attachment artifact became unavailable while acquiring its Gateway lease.",
        );
      }
      throw error;
    }

    let released: Promise<void> | undefined;
    return {
      attachments: attachments.map((attachment) => ({
        ...attachment,
        path: join(leaseDir, attachment.attachmentId),
      })),
      release: () => {
        released ??= rm(leaseDir, { recursive: true, force: true });
        return released;
      },
    };
  }

  private async getVerifiedAttachments(
    uploadId: string,
    projectKey: string,
    attachmentIds?: string[],
  ): Promise<{ record: UploadRecord; attachments: UploadedAttachment[] }> {
    const record = await this.get(uploadId);
    const canonicalProject = await realpath(await this.options.resolveProject(projectKey));
    if (record.projectKey !== canonicalProject) throw new DialogGatewayError("PROJECT_PATH_FORBIDDEN", "Upload belongs to another project.");
    if (record.status === "expired") throw new DialogGatewayError("ATTACHMENT_EXPIRED", "Upload expired.");
    if (record.status !== "completed") throw new DialogGatewayError("UPLOAD_NOT_COMPLETED", `Upload is ${record.status}.`);
    const wanted = attachmentIds ? new Set(attachmentIds) : undefined;
    const attachments = (record.attachments ?? []).filter((item) => !wanted || wanted.has(item.attachmentId));
    if (wanted && attachments.length !== wanted.size) throw new DialogGatewayError("ATTACHMENT_NOT_FOUND", "Unknown attachmentId.");
    for (const attachment of attachments) {
      const info = await stat(attachment.path).catch(() => undefined);
      if (!info || info.size !== attachment.bytes || await sha256File(attachment.path) !== attachment.sha256) {
        throw new DialogGatewayError("ATTACHMENT_TAMPERED", `Attachment integrity check failed: ${attachment.attachmentId}`);
      }
    }
    return { record, attachments };
  }

  private async mutate(record: UploadRecord, mutate: (record: UploadRecord) => void): Promise<UploadRecord> {
    let result = record;
    const prior = this.updates.get(record.uploadId) ?? Promise.resolve();
    const update = prior.then(async () => {
      const current = await this.readAt(record.projectKey, record.uploadId) ?? record;
      result = structuredClone(current);
      mutate(result);
      result.updatedAt = this.now().toISOString();
      await this.write(result);
      this.emit(result);
    });
    this.updates.set(record.uploadId, update);
    await update;
    if (this.updates.get(record.uploadId) === update) this.updates.delete(record.uploadId);
    return result;
  }

  private async drainUpdates(uploadId: string): Promise<void> {
    await (this.updates.get(uploadId) ?? Promise.resolve());
  }

  private emit(record: UploadRecord): void { this.events.emit(`upload:${record.uploadId}`, structuredClone(record)); }
  private taskDir(record: Pick<UploadRecord, "projectKey" | "uploadId">): string { return join(record.projectKey, ".tmp", "chat-uploads", record.uploadId); }
  private filesDir(record: Pick<UploadRecord, "projectKey" | "uploadId">): string { return join(this.taskDir(record), "files"); }
  private metadataPath(record: Pick<UploadRecord, "projectKey" | "uploadId">): string { return join(this.taskDir(record), "metadata.json"); }
  private leaseRoot(projectKey: string): string { return join(projectKey, ".tmp", "chat-upload-leases"); }
  private leaseDir(record: Pick<UploadRecord, "projectKey" | "uploadId">, leaseId: string): string {
    return join(this.leaseRoot(record.projectKey), record.uploadId, leaseId);
  }
  private leaseMetadataPath(leaseDir: string): string { return join(leaseDir, "lease.json"); }
  private async write(record: UploadRecord): Promise<void> {
    const path = this.metadataPath(record);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    try {
      await rename(temp, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EEXIST" && code !== "EACCES") {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      await rm(path, { force: true }).catch(() => undefined);
      try {
        await rename(temp, path);
      } catch (retryError) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw retryError;
      }
    }
  }
  private async readAt(projectKey: string, uploadId: string): Promise<UploadRecord | undefined> {
    assertUploadId(uploadId);
    const uploadRoot = resolve(projectKey, ".tmp", "chat-uploads");
    const metadataPath = resolve(uploadRoot, uploadId, "metadata.json");
    if (!metadataPath.startsWith(uploadRoot + sep)) {
      throw new DialogGatewayError("PROJECT_PATH_FORBIDDEN", "Upload metadata must stay inside the upload directory.");
    }
    try {
      const canonicalProject = await realpath(projectKey);
      const canonicalRoot = resolve(canonicalProject, ".tmp", "chat-uploads");
      const canonicalPath = await realpath(metadataPath);
      if (!canonicalPath.startsWith(canonicalRoot + sep)) {
        throw new DialogGatewayError("PROJECT_PATH_FORBIDDEN", "Upload metadata symlink leaves the upload directory.");
      }
      const record = JSON.parse(await readFile(canonicalPath, "utf8")) as UploadRecord;
      if (record.uploadId !== uploadId || record.projectKey !== canonicalProject) {
        throw new DialogGatewayError("UPLOAD_INTEGRITY_MISMATCH", "Upload metadata identity does not match its directory.");
      }
      return record;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  private async listInProject(projectKey: string): Promise<UploadRecord[]> {
    const base = join(projectKey, ".tmp", "chat-uploads");
    const ids = await readdir(base).catch(() => []);
    return (await Promise.all(ids.filter(isSafeUploadId).map((id) => this.readAt(projectKey, id)))).filter((item): item is UploadRecord => Boolean(item));
  }
  private async findIdempotent(projectKey: string, hash: string): Promise<UploadRecord | undefined> {
    return (await this.listInProject(projectKey)).find((item) => item.idempotencyKeyHash === hash && item.status !== "expired");
  }
  private async expireIfNeeded(record: UploadRecord): Promise<UploadRecord> {
    if (Date.parse(record.expiresAt) > this.now().getTime() || record.status === "expired") return record;
    return this.mutate(record, (next) => { next.status = "expired"; next.errorCode = "ATTACHMENT_EXPIRED"; next.errorMessage = "Upload expired."; });
  }
  private async writeLeaseExpiry(leaseDir: string, expiresAt: string): Promise<void> {
    const path = this.leaseMetadataPath(leaseDir);
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ expiresAt })}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  private async cleanupExpiredLeases(projectKey: string): Promise<void> {
    const root = this.leaseRoot(projectKey);
    const uploadIds = await readdir(root).catch(() => []);
    for (const uploadId of uploadIds.filter(isSafeUploadId)) {
      const leasesRoot = join(root, uploadId);
      const leaseIds = await readdir(leasesRoot).catch(() => []);
      for (const leaseId of leaseIds.filter(isSafeUploadId)) {
        const leaseDir = join(leasesRoot, leaseId);
        const metadata = await this.readLeaseExpiry(leaseDir);
        if (metadata && Date.parse(metadata.expiresAt) > this.now().getTime()) continue;
        await rm(leaseDir, { recursive: true, force: true });
      }
      if ((await readdir(leasesRoot).catch(() => [])).length === 0) {
        await rm(leasesRoot, { recursive: true, force: true });
      }
    }
  }
  private async readLeaseExpiry(leaseDir: string): Promise<{ expiresAt: string } | undefined> {
    try {
      const raw = JSON.parse(await readFile(this.leaseMetadataPath(leaseDir), "utf8")) as { expiresAt?: unknown };
      return typeof raw.expiresAt === "string" ? { expiresAt: raw.expiresAt } : undefined;
    } catch {
      return undefined;
    }
  }
}

function validateManifest(files: UploadManifestEntry[], options: UploadStoreOptions): UploadManifestEntry[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > (options.maxFiles ?? DEFAULTS.maxFiles)) {
    throw new DialogGatewayError("UPLOAD_MANIFEST_INVALID", `files must contain 1..${options.maxFiles ?? DEFAULTS.maxFiles} entries.`);
  }
  const ids = new Set<string>(); let total = 0;
  return files.map((raw) => {
    if (!raw || typeof raw.clientFileId !== "string" || !isSafeUploadId(raw.clientFileId) || ids.has(raw.clientFileId)) throw new DialogGatewayError("UPLOAD_MANIFEST_INVALID", "clientFileId must be unique and filesystem-safe.");
    if (typeof raw.name !== "string" || !raw.name.trim() || !isSafeRelativePath(raw.relativePath)) throw new DialogGatewayError("UPLOAD_MANIFEST_INVALID", "name and a safe relativePath are required.");
    if (!Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > (options.maxFileBytes ?? DEFAULTS.maxFileBytes)) throw new DialogGatewayError("UPLOAD_FILE_TOO_LARGE", `Invalid file size for ${raw.clientFileId}.`);
    if (raw.sha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(raw.sha256)) throw new DialogGatewayError("UPLOAD_MANIFEST_INVALID", "sha256 must contain 64 hexadecimal characters.");
    ids.add(raw.clientFileId); total += raw.size;
    if (total > (options.maxTaskBytes ?? DEFAULTS.maxTaskBytes)) throw new DialogGatewayError("UPLOAD_TASK_TOO_LARGE", "Upload task exceeds its byte limit.");
    return { ...raw, name: raw.name.trim(), relativePath: raw.relativePath };
  });
}
function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\")) return false;
  const parts = value.split("/"); return parts.every((part) => part !== "" && part !== "." && part !== "..");
}
function isSafeUploadId(value: string): boolean { return /^[A-Za-z0-9._-]{1,128}$/.test(value) && !value.includes(".."); }
function assertUploadId(value: string): void { if (!isSafeUploadId(value)) throw new DialogGatewayError("UPLOAD_NOT_FOUND", "Invalid uploadId."); }
async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
