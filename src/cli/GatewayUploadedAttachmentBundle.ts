import type {
  ChannelAttachment,
  UploadedAttachmentRef,
} from "../gateway/protocol/types.js";
import type {
  UploadArtifactLease,
  UploadArtifactLeaseProvider,
} from "../gateway/dialog/UploadArtifactLeasePort.js";
import type {
  ResolvedUploadedAttachments,
  UploadedAttachmentResolverPort,
} from "../gateway/dialog/UploadedAttachmentResolverPort.js";

export type GatewayUploadedAttachmentBundleOptions = {
  provider: UploadArtifactLeaseProvider;
};

export type { ResolvedUploadedAttachments as GatewayResolvedUploadedAttachments } from "../gateway/dialog/UploadedAttachmentResolverPort.js";

/**
 * Acquires verified upload artifact leases and maps them onto Gateway attachment
 * inputs. Upload lifetime, project authorization, and integrity checking stay
 * with the injected provider; this consumer only owns exact lease release.
 */
export class GatewayUploadedAttachmentBundle implements UploadedAttachmentResolverPort {
  constructor(private readonly options: GatewayUploadedAttachmentBundleOptions) {}

  async resolve(input: {
    projectKey: string;
    uploads: UploadedAttachmentRef[];
  }): Promise<ResolvedUploadedAttachments> {
    const acquired: Array<{ uploadId: string; lease: UploadArtifactLease }> = [];
    try {
      for (const upload of input.uploads) {
        acquired.push({
          uploadId: upload.uploadId,
          lease: await this.options.provider.acquireAttachmentLease(
            upload.uploadId,
            input.projectKey,
            upload.attachmentIds,
          ),
        });
      }
    } catch (error) {
      await releaseLeases(acquired);
      throw error;
    }

    let releasePromise: Promise<void> | undefined;
    return {
      attachments: acquired.flatMap(({ uploadId, lease }) => lease.attachments.map((attachment) => ({
        type: attachment.mimeType?.startsWith("image/") ? "image" as const : "file" as const,
        name: attachment.name,
        path: attachment.path,
        mimeType: attachment.mimeType,
        bytes: attachment.bytes,
        metadata: {
          uploadId,
          attachmentId: attachment.attachmentId,
          relativePath: attachment.relativePath,
          sha256: attachment.sha256,
        },
      }))),
      release: () => {
        releasePromise ??= releaseLeases(acquired);
        return releasePromise;
      },
    };
  }
}

async function releaseLeases(leases: Array<{ lease: UploadArtifactLease }>): Promise<void> {
  const failures: unknown[] = [];
  for (const { lease } of [...leases].reverse()) {
    try {
      await lease.release();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Failed to release uploaded attachment leases.");
}
