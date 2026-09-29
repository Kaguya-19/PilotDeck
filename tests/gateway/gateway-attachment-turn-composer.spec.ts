import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { AttachmentResolver } from "../../src/context/attachments/AttachmentResolver.js";
import type { AttachmentPort } from "../../src/context/attachments/AttachmentPort.js";
import { GatewayAttachmentTurnComposer } from "../../src/gateway/dialog/GatewayAttachmentTurnComposer.js";

test("attachment turn composer preserves registered-path authorization and composed model input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-turn-composer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "notes.txt");
  await writeFile(path, "native content", "utf8");

  const resolverCalls: string[] = [];
  const attachmentPort: AttachmentPort = {
    async stat(candidate) {
      resolverCalls.push(`stat:${candidate}`);
      return { size: 16 };
    },
    async readText(candidate) {
      resolverCalls.push(`text:${candidate}`);
      return "provider content";
    },
    async readBytes() {
      throw new Error("not used");
    },
  };
  const composer = new GatewayAttachmentTurnComposer({
    attachmentResolver: new AttachmentResolver({ attachmentPort }),
  });

  const prepared = await composer.prepare({
    message: "inspect attachment",
    attachments: [{
      type: "file",
      name: "notes.txt",
      path,
      metadata: { channelKey: "web" },
    }],
  });

  assert.ok(prepared.allowedReadFiles.includes(resolve(path)));
  assert.ok(prepared.allowedReadFiles.includes(resolve(await realpath(path))));
  assert.equal(prepared.agentInput.type, "blocks");
  const text = prepared.agentInput.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.match(text, /inspect attachment/);
  assert.match(text, /provider content/);
  assert.match(text, /Registered attachment files in this session/);
  assert.match(text, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(resolverCalls, [`stat:${path}`, `text:${path}`]);
});

test("attachment turn composer keeps audio as a project-contained FunASR path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-turn-audio-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "meeting.wav");
  await writeFile(path, Buffer.from("RIFF"));
  const composer = new GatewayAttachmentTurnComposer();

  const prepared = await composer.prepare({
    message: "transcribe this",
    projectRoot: root,
    funasrInstallCommand: "pilotdeck install funasr",
    attachments: [{
      type: "file",
      name: "meeting.wav",
      path,
      mimeType: "audio/wav",
      metadata: { channelKey: "web" },
    }],
  });

  assert.equal(prepared.agentInput.type, "blocks");
  const text = prepared.agentInput.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.match(text, /mcp__funasr__transcribe_audio/);
  assert.match(text, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /pilotdeck install funasr/);
});
