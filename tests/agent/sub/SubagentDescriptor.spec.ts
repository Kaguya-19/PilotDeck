import assert from "node:assert/strict";
import test from "node:test";

import {
  SUBAGENT_CONTINUABLE_DESCRIPTOR_VERSION,
  SUBAGENT_DESCRIPTOR_METADATA_KEY,
  SUBAGENT_DESCRIPTOR_VERSION,
  foldSubagentDescriptor,
  parseSubagentDescriptor,
  recordSubagentAcceptedInputWithDescriptor,
  snapshotSubagentDescriptor,
} from "../../../src/agent/sub/index.js";
import { InMemoryTranscriptWriter } from "../../../src/session/transcript/InMemoryTranscriptWriter.js";
import { replayTranscriptEntries } from "../../../src/session/transcript/TranscriptReplay.js";

test("subagent descriptor is persisted before accepted input and remains model-hidden", async () => {
  let entryId = 0;
  const writer = new InMemoryTranscriptWriter({
    now: () => new Date("2026-09-08T00:00:00.000Z"),
    uuid: () => `entry-${++entryId}`,
  });
  const descriptor = snapshotSubagentDescriptor({
    mode: "one-shot",
    provider: "pilotdeck-native",
    definitionId: "explore",
  });

  await recordSubagentAcceptedInputWithDescriptor(
    writer,
    "child-session",
    "child-turn",
    [{ role: "user", content: [{ type: "text", text: "Inspect files." }] }],
    {
      [SUBAGENT_DESCRIPTOR_METADATA_KEY]: descriptor,
      source: "parent",
    },
  );

  assert.deepEqual(writer.entries.map((entry) => entry.type), [
    "subagent_descriptor",
    "accepted_input",
  ]);
  assert.deepEqual(foldSubagentDescriptor(writer.entries), descriptor);
  assert.deepEqual(replayTranscriptEntries(writer.entries).messages, [
    { role: "user", content: [{ type: "text", text: "Inspect files." }] },
  ]);
  const accepted = writer.entries[1];
  assert.ok(accepted?.type === "accepted_input");
  assert.deepEqual(accepted.metadata, { source: "parent" });
  assert.equal(JSON.stringify(accepted).includes("pilotdeck-native"), false);
});

test("one-shot descriptor keeps its version 1 durable shape", () => {
  assert.deepEqual(snapshotSubagentDescriptor({
    mode: "one-shot",
    provider: "pilotdeck-native",
    definitionId: "explore",
  }), {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    mode: "one-shot",
    provider: "pilotdeck-native",
    definitionId: "explore",
  });
});

test("continuable descriptor snapshots and folds its cold-resume composition", async () => {
  const writer = new InMemoryTranscriptWriter();
  const descriptor = snapshotSubagentDescriptor({
    mode: "continuable",
    provider: "pilotdeck-native",
    definitionId: "explore",
    parentSessionId: "parent-session",
    label: "Inspect the runtime",
    agentProvider: "anthropic",
    agentModel: "claude-sonnet",
  });
  assert.deepEqual(descriptor, {
    version: SUBAGENT_CONTINUABLE_DESCRIPTOR_VERSION,
    mode: "continuable",
    provider: "pilotdeck-native",
    definitionId: "explore",
    parentSessionId: "parent-session",
    label: "Inspect the runtime",
    agentProvider: "anthropic",
    agentModel: "claude-sonnet",
  });
  assert.deepEqual(parseSubagentDescriptor(structuredClone(descriptor)), descriptor);

  await writer.recordSessionEvent("child-session", "child-turn", {
    type: "subagent_descriptor",
    descriptor,
  });
  assert.deepEqual(foldSubagentDescriptor(writer.entries), descriptor);
  assert.deepEqual(replayTranscriptEntries(writer.entries).messages, []);
});

test("continuable descriptor parser rejects schema drift and ignores unsupported versions", () => {
  const descriptor = {
    version: SUBAGENT_CONTINUABLE_DESCRIPTOR_VERSION,
    mode: "continuable",
    provider: "pilotdeck-native",
    definitionId: "explore",
    parentSessionId: "parent-session",
    label: "Inspect the runtime",
    agentProvider: "anthropic",
    agentModel: "claude-sonnet",
  } as const;

  assert.throws(
    () => parseSubagentDescriptor({ ...descriptor, extra: true }),
    /unknown field "extra"/,
  );
  assert.throws(
    () => parseSubagentDescriptor({ ...descriptor, parentSessionId: undefined }),
    /parentSessionId must be a non-empty string/,
  );
  assert.throws(
    () => parseSubagentDescriptor({ ...descriptor, mode: "one-shot" }),
    /mode must be "continuable"/,
  );
  assert.throws(
    () => parseSubagentDescriptor({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: "continuable",
      provider: "pilotdeck-native",
      definitionId: "explore",
    }),
    /mode must be "one-shot"/,
  );
  assert.equal(parseSubagentDescriptor({ version: 999 }), undefined);
});

test("invalid subagent descriptor fails before accepted input is durable", async () => {
  const writer = new InMemoryTranscriptWriter();
  await assert.rejects(
    recordSubagentAcceptedInputWithDescriptor(
      writer,
      "child-session",
      "child-turn",
      [{ role: "user", content: [{ type: "text", text: "Inspect files." }] }],
      {
        [SUBAGENT_DESCRIPTOR_METADATA_KEY]: {
          version: 1,
          mode: "one-shot",
          provider: "",
          definitionId: "explore",
        },
      },
    ),
    /provider must be a non-empty string/,
  );
  assert.deepEqual(writer.entries, []);
});

test("the first durable subagent descriptor is authoritative", async () => {
  const writer = new InMemoryTranscriptWriter();
  const first = snapshotSubagentDescriptor({
    mode: "one-shot",
    provider: "first",
    definitionId: "explore",
  });
  const second = snapshotSubagentDescriptor({
    mode: "one-shot",
    provider: "second",
    definitionId: "plan",
  });
  await writer.recordSessionEvent("child-session", "turn-1", {
    type: "subagent_descriptor",
    descriptor: first,
  });
  await writer.recordSessionEvent("child-session", "turn-2", {
    type: "subagent_descriptor",
    descriptor: second,
  });

  assert.deepEqual(foldSubagentDescriptor(writer.entries), first);
});
