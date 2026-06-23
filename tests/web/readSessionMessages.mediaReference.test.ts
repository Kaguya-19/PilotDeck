import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import { getPilotProjectChatDir } from "../../src/pilot/index.js";
import { sanitizeSessionIdForPath } from "../../src/session/storage/ProjectSessionStorage.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";

test("readWebSessionMessages returns lightweight placeholders for media references", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-web-media-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  const sessionKey = "web:s_media_ref";
  const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
  await mkdir(chatDir, { recursive: true });

  const bigBase64 = "x".repeat(100_000);
  const entries: AgentTranscriptEntry[] = [
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 1,
      createdAt: "2026-06-23T00:00:00.000Z",
      messages: [{ role: "user", content: [{ type: "text", text: "read a document" }] }],
    },
    {
      type: "assistant_message",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 2,
      createdAt: "2026-06-23T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_call", id: "call-1", name: "read_file", input: { path: "doc.pdf" } }],
      },
    },
    {
      type: "tool_result_message",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 3,
      createdAt: "2026-06-23T00:00:02.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "call-1",
            content: [{ type: "text", text: "Rendered PDF page." }],
          },
        ],
      },
    },
    {
      type: "durable_message",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 4,
      createdAt: "2026-06-23T00:00:03.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "media_reference",
            toolCallId: "call-1",
            path: join(chatDir, sanitizeSessionIdForPath(sessionKey), "tool-results", "image-0.b64"),
            originalBytes: bigBase64.length,
            preview: "[Image: image/png, 98KB — persisted tool result]",
            hasMore: true,
            mimeType: "image/png",
            mediaType: "image",
          },
        ],
      },
    },
    {
      type: "turn_result",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 5,
      createdAt: "2026-06-23T00:00:04.000Z",
      result: {
        type: "success",
        sessionId: sessionKey,
        turnId: "turn-1",
        stopReason: "completed",
        usage: {},
        permissionDenials: [],
        turns: 1,
        startedAt: "2026-06-23T00:00:00.000Z",
        completedAt: "2026-06-23T00:00:04.000Z",
      },
    },
  ];

  await writeFile(
    join(chatDir, `${sanitizeSessionIdForPath(sessionKey)}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join("\n"),
    "utf8",
  );

  const result = await readWebSessionMessages(
    { sessionKey, projectKey: projectRoot, cursor: "0" },
    { projectRoot, pilotHome },
  );

  const serialized = JSON.stringify(result.messages);
  assert.equal(serialized.includes(bigBase64), false);
  assert.equal(serialized.includes("data:image/png;base64"), false);

  const mediaMessage = result.messages.find((message) => {
    const payload = message.payload;
    return typeof payload === "object" && payload !== null && "mediaType" in payload && payload.mediaType === "image";
  });
  assert.ok(mediaMessage);
  assert.equal(mediaMessage?.kind, "tool_result");
  assert.equal(mediaMessage?.role, "tool");
  assert.equal(mediaMessage?.toolCallId, "call-1");
  assert.equal(mediaMessage?.text, "[Image: image/png, 98KB — persisted tool result]");
});
