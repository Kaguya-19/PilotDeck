import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentInput, AgentSession, AgentSubmitOptions } from "../../src/agent/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

test("Gateway releases an uploaded artifact lease only after its agent turn settles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-uploaded-lease-turn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attachmentPath = join(root, "leased.txt");
  await writeFile(attachmentPath, "leased content", "utf8");

  let releases = 0;
  let releasesWhenSessionStarted = -1;
  let capturedInput: AgentInput | undefined;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => ({
      async *submit(input: AgentInput, options: AgentSubmitOptions = {}) {
        capturedInput = input;
        releasesWhenSessionStarted = releases;
        const turnId = options.turnId ?? "turn-1";
        yield { type: "turn_started", sessionId: "session-1", turnId };
        yield {
          type: "turn_completed",
          sessionId: "session-1",
          turnId,
          result: {
            type: "success",
            sessionId: "session-1",
            turnId,
            stopReason: "completed",
            usage: {},
            permissionDenials: [],
            turns: 1,
            startedAt: "2026-09-10T00:00:00.000Z",
            completedAt: "2026-09-10T00:00:01.000Z",
          },
        };
      },
      abort() {},
      snapshot() {
        return {
          sessionId: "session-1",
          messages: [],
          usage: {},
          status: "idle",
          permissionDenials: [],
        };
      },
    } as unknown as AgentSession),
  });
  const gateway = new InProcessGateway(router, {
    async resolveUploadedAttachments() {
      return {
        attachments: [{
          type: "file",
          name: "leased.txt",
          path: attachmentPath,
          mimeType: "text/plain",
          bytes: 14,
          metadata: { uploadId: "upload-1", attachmentId: "file-1", relativePath: "leased.txt", sha256: "hash" },
        }],
        async release() { releases += 1; },
      };
    },
  });

  for await (const _event of gateway.submitTurn({
    sessionKey: "session-1",
    channelKey: "web",
    projectKey: root,
    message: "inspect upload",
    uploadedAttachments: [{ uploadId: "upload-1" }],
  })) {
    // Drain the turn so Gateway reaches its exact lease-release point.
  }

  assert.equal(releasesWhenSessionStarted, 0);
  assert.equal(releases, 1);
  assert.ok(capturedInput);
  const text = capturedInput.type === "text"
    ? capturedInput.text
    : capturedInput.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  assert.match(text, /leased content/);
});
