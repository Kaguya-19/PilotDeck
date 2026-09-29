/** Metadata for one completed upload artifact exposed to a Gateway consumer. */
export type UploadedAttachment = {
  attachmentId: string;
  name: string;
  relativePath: string;
  mimeType?: string;
  bytes: number;
  sha256: string;
  path: string;
};

/** A turn-local view over verified upload artifacts. */
export type UploadArtifactLease = {
  attachments: UploadedAttachment[];
  release(): Promise<void>;
};

/**
 * Provider definition consumed by Gateway attachment composition.
 *
 * Providers retain authorization, integrity verification, source artifact and
 * retention ownership. Consumers own only the lease they acquire.
 */
export type UploadArtifactLeaseProvider = {
  acquireAttachmentLease(
    uploadId: string,
    projectKey: string,
    attachmentIds?: string[],
  ): Promise<UploadArtifactLease>;
};
