import assert from "node:assert/strict";
import test from "node:test";

import { GatewayUploadedAttachmentBundle } from "../../src/cli/GatewayUploadedAttachmentBundle.js";
import type { UploadArtifactLease, UploadedAttachment } from "../../src/gateway/dialog/UploadStore.js";

test("gateway uploaded attachment bundle leases each upload before preserving its model-facing attachment mapping", async () => {
  const calls: Array<{ uploadId: string; projectKey: string; attachmentIds?: string[] }> = [];
  const released: string[] = [];
  const attachmentsByUpload: Record<string, UploadedAttachment[]> = {
    "upload-images": [{
      attachmentId: "image-1",
      name: "diagram.png",
      relativePath: "images/diagram.png",
      mimeType: "image/png",
      bytes: 42,
      sha256: "hash-image",
      path: "/tmp/upload/image-1",
    }],
    "upload-files": [{
      attachmentId: "file-1",
      name: "notes.txt",
      relativePath: "notes.txt",
      mimeType: "text/plain",
      bytes: 7,
      sha256: "hash-file",
      path: "/tmp/upload/file-1",
    }],
  };
  const bundle = new GatewayUploadedAttachmentBundle({
    provider: {
      async acquireAttachmentLease(uploadId, projectKey, attachmentIds) {
        calls.push({ uploadId, projectKey, attachmentIds });
        return lease(uploadId, attachmentsByUpload[uploadId] ?? [], released);
      },
    },
  });

  const resolved = await bundle.resolve({
    projectKey: "/project",
    uploads: [
      { uploadId: "upload-images", attachmentIds: ["image-1"] },
      { uploadId: "upload-files" },
    ],
  });

  assert.deepEqual(calls, [
    { uploadId: "upload-images", projectKey: "/project", attachmentIds: ["image-1"] },
    { uploadId: "upload-files", projectKey: "/project", attachmentIds: undefined },
  ]);
  assert.deepEqual(resolved.attachments, [
    {
      type: "image",
      name: "diagram.png",
      path: "/tmp/upload/image-1",
      mimeType: "image/png",
      bytes: 42,
      metadata: {
        uploadId: "upload-images",
        attachmentId: "image-1",
        relativePath: "images/diagram.png",
        sha256: "hash-image",
      },
    },
    {
      type: "file",
      name: "notes.txt",
      path: "/tmp/upload/file-1",
      mimeType: "text/plain",
      bytes: 7,
      metadata: {
        uploadId: "upload-files",
        attachmentId: "file-1",
        relativePath: "notes.txt",
        sha256: "hash-file",
      },
    },
  ]);
  await resolved.release();
  await resolved.release();
  assert.deepEqual(released, ["upload-files", "upload-images"]);
});

test("gateway uploaded attachment bundle releases already acquired leases when a later upload fails", async () => {
  const released: string[] = [];
  const bundle = new GatewayUploadedAttachmentBundle({
    provider: {
      async acquireAttachmentLease(uploadId) {
        if (uploadId === "broken") throw new Error("upload unavailable");
        return lease(uploadId, [], released);
      },
    },
  });

  await assert.rejects(bundle.resolve({
    projectKey: "/project",
    uploads: [{ uploadId: "first" }, { uploadId: "broken" }],
  }), /upload unavailable/);
  assert.deepEqual(released, ["first"]);
});

function lease(
  uploadId: string,
  attachments: UploadedAttachment[],
  released: string[],
): UploadArtifactLease {
  let done = false;
  return {
    attachments,
    async release() {
      if (done) return;
      done = true;
      released.push(uploadId);
    },
  };
}
