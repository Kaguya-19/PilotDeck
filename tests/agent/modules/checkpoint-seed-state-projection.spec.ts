import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentLoopSeedStateProjection } from "../../../src/agent/modules/checkpoint/index.js";

test("checkpoint seed projection validates all AgentLoop file state", () => {
  const projection = {
    allowedReadFiles: ["/workspace/input.txt"],
    readFileState: {
      "/workspace/input.txt": {
        mtimeMs: 10,
        kind: "text",
        offset: 1,
        limit: 20,
        hostOnly: "ignored",
      },
    },
    writeSnapshots: {
      "/workspace/output.txt": {
        absolutePath: "/workspace/output.txt",
        mtimeMs: 20,
        contentHash: "hash",
        offset: 2,
        limit: 30,
        hostOnly: "ignored",
      },
    },
    hostCheckpoint: { revision: 17 },
  };

  const seed = parseAgentLoopSeedStateProjection(projection);

  assert.deepEqual(seed?.allowedReadFiles, ["/workspace/input.txt"]);
  assert.deepEqual(seed?.readFileState?.get("/workspace/input.txt"), {
    mtimeMs: 10,
    kind: "text",
    offset: 1,
    limit: 20,
  });
  assert.deepEqual(seed?.writeSnapshots?.get("/workspace/output.txt"), {
    absolutePath: "/workspace/output.txt",
    mtimeMs: 20,
    contentHash: "hash",
    offset: 2,
    limit: 30,
  });
  assert.equal("hostCheckpoint" in (seed as object), false);
});

test("checkpoint seed projection clones arrays, maps, and entries", () => {
  const allowedReadFiles = ["/workspace/input.txt"];
  const readEntry = { mtimeMs: 10, kind: "text" as const };
  const writeEntry = {
    absolutePath: "/workspace/output.txt",
    mtimeMs: 20,
    contentHash: "hash",
  };
  const readFileState = new Map([["/workspace/input.txt", readEntry]]);
  const writeSnapshots = new Map([["/workspace/output.txt", writeEntry]]);

  const seed = parseAgentLoopSeedStateProjection({ allowedReadFiles, readFileState, writeSnapshots });

  assert.notEqual(seed?.allowedReadFiles, allowedReadFiles);
  assert.notEqual(seed?.readFileState, readFileState);
  assert.notEqual(seed?.writeSnapshots, writeSnapshots);
  assert.notEqual(seed?.readFileState?.get("/workspace/input.txt"), readEntry);
  assert.notEqual(seed?.writeSnapshots?.get("/workspace/output.txt"), writeEntry);

  allowedReadFiles.push("/workspace/later.txt");
  readEntry.mtimeMs = 99;
  writeEntry.contentHash = "changed";
  readFileState.clear();
  writeSnapshots.clear();

  assert.deepEqual(seed?.allowedReadFiles, ["/workspace/input.txt"]);
  assert.equal(seed?.readFileState?.get("/workspace/input.txt")?.mtimeMs, 10);
  assert.equal(seed?.writeSnapshots?.get("/workspace/output.txt")?.contentHash, "hash");
});

test("checkpoint seed projection rejects malformed supported fields", () => {
  assert.throws(() => parseAgentLoopSeedStateProjection([]), /expected an object/);
  assert.throws(
    () => parseAgentLoopSeedStateProjection({ allowedReadFiles: [42] }),
    /allowedReadFiles/,
  );
  assert.throws(
    () => parseAgentLoopSeedStateProjection({ readFileState: { file: { mtimeMs: 1, kind: "audio" } } }),
    /readFileState entry: file/,
  );
  assert.throws(
    () => parseAgentLoopSeedStateProjection({ writeSnapshots: { file: { mtimeMs: 1 } } }),
    /writeSnapshots entry: file/,
  );
});

test("checkpoint seed projection accepts an absent state", () => {
  assert.equal(parseAgentLoopSeedStateProjection(undefined), undefined);
  assert.equal(parseAgentLoopSeedStateProjection(null), undefined);
});
