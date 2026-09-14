import type { ChannelAttachment, UploadedAttachmentRef } from "../protocol/types.js";

/** Gateway-owned turn-local artifact view returned by an attachment resolver. */
export type ResolvedUploadedAttachments = {
  attachments: ChannelAttachment[];
  release(): Promise<void>;
};

/** Definition consumed by Gateway turn admission for browser-upload references. */
export type UploadedAttachmentResolverPort = {
  resolve(input: {
    projectKey: string;
    uploads: UploadedAttachmentRef[];
  }): Promise<ResolvedUploadedAttachments>;
};
