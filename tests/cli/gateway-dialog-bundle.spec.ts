import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { GatewayDialogBundle } from "../../src/cli/GatewayDialogBundle.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { AttachmentPort } from "../../src/context/index.js";
import type {
  UploadArtifactLease,
  UploadLifecyclePort,
  UploadManifestEntry,
  UploadRecord,
} from "../../src/gateway/index.js";
import {
  type CanonicalModelEvent,
  type CanonicalModelRequest,
  type CanonicalModelResponse,
  type ModelRuntime,
  type MultimodalConstraints,
} from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import type { SessionCatalogPort } from "../../src/session/index.js";

test("gateway dialog bundle keeps project lookup, upload leases, and model attachment projection on their existing owners", async (t) => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-dialog-bundle-"));
  t.after(() => rm(pilotHome, { recursive: true, force: true }));

  const bundle = new GatewayDialogBundle({
    pilotHome,
    sessionCatalog: emptySessionCatalog(),
    attachmentPort: {
      async stat() { return { size: 4 }; },
      async readText() { return "note"; },
      async readBytes() { return Uint8Array.from([0x89, 0x50, 0x4e, 0x47]); },
    },
  });

  assert.equal(await bundle.projects.resolveProjectKey(pilotHome), pilotHome);
  assert.deepEqual(await bundle.listProjects(), { projects: [] });
  const attachment = await bundle.attachmentResolver.resolve({
    type: "file",
    path: join(pilotHome, "note.txt"),
  });
  assert.deepEqual(attachment.blocks, [{
    type: "text",
    text: `<attachment path="${join(pilotHome, "note.txt")}">\nnote\n</attachment>`,
  }]);
  const prepared = await bundle.attachmentTurnComposer.prepare({
    message: "inspect",
    attachments: [{ type: "file", path: join(pilotHome, "note.txt") }],
  });
  assert.equal(prepared.agentInput.type, "blocks");
  assert.deepEqual(prepared.agentInput.content, [
    { type: "text", text: "inspect" },
    { type: "text", text: `<attachment path="${join(pilotHome, "note.txt")}">\nnote\n</attachment>` },
  ]);
});

test("gateway dialog bundle routes uploaded artifact authorization through its dialog project registry", async (t) => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-dialog-upload-"));
  t.after(() => rm(pilotHome, { recursive: true, force: true }));
  const bundle = new GatewayDialogBundle({
    pilotHome,
    sessionCatalog: emptySessionCatalog(),
  });

  const record = await bundle.uploads.create(pilotHome, [{
    clientFileId: "note",
    name: "note.txt",
    relativePath: "note.txt",
    size: 4,
    mimeType: "text/plain",
  }]);
  await bundle.uploads.writePart(record.uploadId, "note", Readable.from(["note"]));
  await bundle.uploads.complete(record.uploadId);
  const resolved = await bundle.uploadedAttachments.resolve({
    projectKey: pilotHome,
    uploads: [{ uploadId: record.uploadId, attachmentIds: ["note"] }],
  });

  assert.equal(record.projectKey, await realpath(pilotHome));
  assert.equal(record.status, "created");
  assert.deepEqual(resolved.attachments.map((attachment) => ({
    type: attachment.type,
    name: attachment.name,
    metadata: attachment.metadata,
  })), [{
    type: "file",
    name: "note.txt",
    metadata: {
      uploadId: record.uploadId,
      attachmentId: "note",
      relativePath: "note.txt",
      sha256: "edb465624291e4053c6c5ea4b7eb320dec773e10a57d26b95dcf0564f8e310f8",
    },
  }]);
  await resolved.release();
  await assert.rejects(
    bundle.uploads.create(join(pilotHome, "unknown"), []),
    (error: unknown) => (error as { code?: string }).code === "PROJECT_NOT_FOUND",
  );
});

test("gateway dialog bundle keeps an application-selected upload lifecycle provider intact", async (t) => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-dialog-upload-provider-"));
  t.after(() => rm(pilotHome, { recursive: true, force: true }));
  const calls: string[] = [];
  const provider: UploadLifecyclePort = {
    async create(projectKey, files) {
      calls.push(`create:${projectKey}:${files[0]?.clientFileId}`);
      return record("created");
    },
    async get() { return record("completed"); },
    async writePart() { throw new Error("not used"); },
    async complete() { return record("completed"); },
    async cancel() { return record("cancelled"); },
    async fail() { return record("failed"); },
    subscribe() { return () => undefined; },
    async cleanupExpired() { return 0; },
    async acquireAttachmentLease(uploadId, projectKey) {
      calls.push(`lease:${uploadId}:${projectKey}`);
      return lease();
    },
  };
  const bundle = new GatewayDialogBundle({
    pilotHome,
    sessionCatalog: emptySessionCatalog(),
    uploadLifecycle: provider,
  });

  assert.equal(bundle.uploads, provider);
  await bundle.uploads.create(pilotHome, [manifest("draft")]);
  const resolved = await bundle.uploadedAttachments.resolve({
    projectKey: pilotHome,
    uploads: [{ uploadId: "uploaded" }],
  });
  await resolved.release();

  assert.deepEqual(calls, [
    `create:${pilotHome}:draft`,
    `lease:uploaded:${pilotHome}`,
  ]);
});

test("local gateway carries an application-selected attachment provider into a real turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-dialog-attachment-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), [
    "schemaVersion: 1",
    "agent:",
    "  model: test/test",
    "router:",
    "  enabled: false",
    "model:",
    "  providers:",
    "    test:",
    "      protocol: openai",
    "      url: http://127.0.0.1:1",
    "      apiKey: test-only",
    "      models:",
    "        test: {}",
    "",
  ].join("\n"));

  const attachmentPath = join(root, "injected.txt");
  const calls: string[] = [];
  const attachmentPort: AttachmentPort = {
    async stat(path) {
      calls.push(`stat:${path}`);
      assert.equal(path, attachmentPath);
      return { size: 17 };
    },
    async readText(path) {
      calls.push(`readText:${path}`);
      assert.equal(path, attachmentPath);
      return "provider attachment";
    },
    async readBytes() {
      throw new Error("binary reads are not expected for a text attachment");
    },
  };
  const model = new AttachmentInspectingModel();
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    env: { PILOT_HOME: root },
    attachmentPort,
    __testModelFactory: () => model,
  });
  t.after(() => local.dispose());

  for await (const _event of local.gateway.submitTurn({
    sessionKey: "attachment-provider-session",
    channelKey: "test",
    projectKey: root,
    message: "Inspect this attachment.",
    attachments: [{ type: "file", path: attachmentPath }],
  })) {
    // Consuming the stream drives Gateway attachment composition and AgentSession execution.
  }

  assert.deepEqual(calls, [`stat:${attachmentPath}`, `readText:${attachmentPath}`]);
  assert.equal(model.requests.length, 1);
  assert.equal(
    model.requests[0]?.messages.some((message) => message.content.some(
      (block) => block.type === "text" && block.text.includes("provider attachment"),
    )),
    true,
  );
});

test("local gateway carries an application-selected upload lifecycle provider into a real turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-dialog-upload-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), [
    "schemaVersion: 1",
    "agent:",
    "  model: test/test",
    "router:",
    "  enabled: false",
    "model:",
    "  providers:",
    "    test:",
    "      protocol: openai",
    "      url: http://127.0.0.1:1",
    "      apiKey: test-only",
    "      models:",
    "        test: {}",
    "",
  ].join("\n"));
  const attachmentPath = join(root, "uploaded.txt");
  await writeFile(attachmentPath, "uploaded provider content", "utf8");

  let leaseCalls = 0;
  const uploadLifecycle: UploadLifecyclePort = {
    async create() { return record("created"); },
    async get() { return record("completed"); },
    async writePart() { throw new Error("not used"); },
    async complete() { return record("completed"); },
    async cancel() { return record("cancelled"); },
    async fail() { return record("failed"); },
    subscribe() { return () => undefined; },
    async cleanupExpired() { return 0; },
    async acquireAttachmentLease(uploadId, projectKey) {
      leaseCalls += 1;
      assert.equal(uploadId, "upload-from-provider");
      assert.equal(projectKey, root);
      return {
        attachments: [{
          attachmentId: "uploaded-file",
          name: "uploaded.txt",
          relativePath: "uploaded.txt",
          mimeType: "text/plain",
          bytes: 25,
          sha256: "provider-hash",
          path: attachmentPath,
        }],
        async release() {},
      };
    },
  };
  const model = new AttachmentInspectingModel();
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    env: { PILOT_HOME: root },
    uploadLifecycle,
    __testModelFactory: () => model,
  });
  t.after(() => local.dispose());

  for await (const _event of local.gateway.submitTurn({
    sessionKey: "upload-provider-session",
    channelKey: "test",
    projectKey: root,
    message: "Inspect this uploaded attachment.",
    uploadedAttachments: [{ uploadId: "upload-from-provider" }],
  })) {
    // Drain the turn so Gateway acquires and releases the provider lease.
  }

  assert.equal(leaseCalls, 1);
  assert.equal(model.requests.length, 1);
  assert.equal(
    model.requests[0]?.messages.some((message) => message.content.some(
      (block) => block.type === "text" && block.text.includes("uploaded provider content"),
    )),
    true,
  );
});

function emptySessionCatalog(): SessionCatalogPort {
  return {
    async list() {
      return [];
    },
  };
}

function manifest(clientFileId: string): UploadManifestEntry {
  return {
    clientFileId,
    name: `${clientFileId}.txt`,
    relativePath: `${clientFileId}.txt`,
    size: 1,
  };
}

function record(status: UploadRecord["status"]): UploadRecord {
  return {
    uploadId: "uploaded",
    projectKey: "/project",
    status,
    manifest: [manifest("uploaded")],
    totalBytes: 1,
    uploadedBytes: status === "completed" ? 1 : 0,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    expiresAt: "2026-09-13T00:00:00.000Z",
  };
}

function lease(): UploadArtifactLease {
  return {
    attachments: [],
    async release() {},
  };
}

class AttachmentInspectingModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    yield { type: "request_started", provider: request.provider, model: request.model };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "attachment provider used" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [], finishReason: "stop" };
  }

  getCapabilities() {
    return { ...DEFAULT_MODEL_CAPABILITIES, maxContextTokens: 128_000, maxOutputTokens: 8_192 };
  }

  getMultimodal(): MultimodalConstraints {
    return { input: ["text"] };
  }

  getProviderProtocol() {
    return "openai" as const;
  }

  getProviderBaseUrl() {
    return undefined;
  }
}
