import type { Readable } from "node:stream";
import type {
  UploadArtifactLeaseProvider,
  UploadedAttachment,
} from "./UploadArtifactLeasePort.js";

/** Durable lifecycle state for one browser-upload request. */
export type UploadStatus = "created" | "uploading" | "completed" | "failed" | "cancelled" | "expired";

/** Client-declared artifact metadata admitted before bytes are streamed. */
export type UploadManifestEntry = {
  clientFileId: string;
  name: string;
  relativePath: string;
  size: number;
  mimeType?: string;
  sha256?: string;
};

/** Provider-owned durable upload state exposed to HTTP/UI consumers. */
export type UploadRecord = {
  uploadId: string;
  projectKey: string;
  status: UploadStatus;
  manifest: UploadManifestEntry[];
  totalBytes: number;
  uploadedBytes: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  idempotencyKeyHash?: string;
  attachments?: UploadedAttachment[];
  receivedClientFileIds?: string[];
  errorCode?: string;
  errorMessage?: string;
};

/**
 * DSH-style upload artifact Definition.
 *
 * The provider owns admission, durable metadata, source artifacts, integrity,
 * retention, and lease cleanup. HTTP/UI consumers only drive this lifecycle;
 * Gateway turn admission consumes the narrower UploadArtifactLeaseProvider
 * view and owns the turn-local lease it acquires.
 */
export type UploadLifecyclePort = UploadArtifactLeaseProvider & {
  create(projectKey: string, files: UploadManifestEntry[], idempotencyKey?: string): Promise<UploadRecord>;
  get(uploadId: string): Promise<UploadRecord>;
  writePart(uploadId: string, clientFileId: string, stream: Readable): Promise<UploadedAttachment>;
  complete(uploadId: string): Promise<UploadRecord>;
  cancel(uploadId: string): Promise<UploadRecord>;
  fail(uploadId: string, code: string, message: string): Promise<UploadRecord>;
  subscribe(uploadId: string, listener: (record: UploadRecord) => void): () => void;
  cleanupExpired(): Promise<number>;
};
