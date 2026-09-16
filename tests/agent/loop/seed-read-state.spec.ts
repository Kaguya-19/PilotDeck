import assert from "node:assert/strict";
import { mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { createWriteFileTool } from "../../../src/tool/builtin/writeFile.js";

function loopFor(cwd: string): AgentLoop {
  return new AgentLoop({
    provider: "test",
    model: "test",
    cwd,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd }),
  }, {
    ports: {
      model: {
        async prepare({ request }) { return { request, provider: request.provider, model: request.model }; },
        stream: async function* () {},
      },
      tools: { list: () => [], executeAll: async () => [] },
    },
    router: {} as never,
    tools: { registry: {} as never, scheduler: {} as never },
  });
}

function writeContext(cwd: string, fileState: ReturnType<AgentLoop["snapshotFileState"]>) {
  return {
    sessionId: "seed-session",
    turnId: "seed-turn",
    cwd,
    permissionMode: "default" as const,
    permissionContext: createDefaultPermissionContext({ cwd }),
    readFileState: fileState.readFileState,
    writeSnapshots: fileState.writeSnapshots,
  };
}

test("seedReadState restores text-file write eligibility only when the observed mtime still matches", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pilotdeck-seed-read-"));
  const filePath = join(cwd, "fixture.txt");
  try {
    await writeFile(filePath, "before\n", "utf8");
    const loop = loopFor(cwd);
    const observedMtime = Math.floor((await stat(filePath)).mtimeMs);

    assert.deepEqual(await loop.seedReadState("fixture.txt", observedMtime), { applied: true });
    const seeded = loop.snapshotFileState();
    assert.equal(seeded.readFileState?.get(`${filePath}::text::1::all::`)?.mtimeMs, observedMtime);
    assert.equal(seeded.writeSnapshots?.get(filePath)?.mtimeMs, observedMtime);
    assert.deepEqual(
      await createWriteFileTool().validateInput?.({ file_path: "fixture.txt", content: "after\n" }, writeContext(cwd, seeded) as never),
      { ok: true, input: { file_path: "fixture.txt", content: "after\n" } },
    );

    await writeFile(filePath, "changed\n", "utf8");
    await utimes(filePath, new Date(observedMtime + 2_000), new Date(observedMtime + 2_000));
    const staleLoop = loopFor(cwd);
    assert.deepEqual(await staleLoop.seedReadState("fixture.txt", observedMtime), { applied: false });
    const stale = staleLoop.snapshotFileState();
    assert.equal(stale.writeSnapshots?.has(filePath), false);
    const validation = await createWriteFileTool().validateInput?.(
      { file_path: "fixture.txt", content: "after\n" },
      writeContext(cwd, stale) as never,
    );
    assert.equal(validation?.ok, false);
  } finally {
    await (await import("node:fs/promises")).rm(cwd, { recursive: true, force: true });
  }
});

test("seedReadState rejects unsupported and out-of-workspace files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pilotdeck-seed-read-safety-"));
  const outside = await mkdtemp(join(tmpdir(), "pilotdeck-seed-read-outside-"));
  const binaryPath = join(cwd, "fixture.png");
  const outsidePath = join(outside, "outside.txt");
  try {
    await Promise.all([
      writeFile(binaryPath, Buffer.from([0, 1, 2, 3])),
      writeFile(outsidePath, "outside\n", "utf8"),
    ]);
    const loop = loopFor(cwd);
    const binaryMtime = Math.floor((await stat(binaryPath)).mtimeMs);
    const outsideMtime = Math.floor((await stat(outsidePath)).mtimeMs);

    await assert.rejects(
      loop.seedReadState("fixture.png", binaryMtime),
      (error: Error & { code?: string }) => error.code === "invalid_tool_input",
    );
    await assert.rejects(
      loop.seedReadState(outsidePath, outsideMtime),
      /outside the PilotDeck workspace/,
    );
  } finally {
    const { rm } = await import("node:fs/promises");
    await Promise.all([
      rm(cwd, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});
