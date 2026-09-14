import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectExecutionWorldBundle } from "../../src/cli/ProjectExecutionWorldBundle.js";
import { resolvePilotDeckRuntimeProfile } from "../../src/cli/PilotDeckRuntimeProfile.js";
import type { PilotConfigSnapshot } from "../../src/pilot/index.js";
import {
  createNodeExecutionWorldBundle,
  type PilotDeckToolDefinition,
} from "../../src/tool/index.js";

test("project execution-world bundle selects the configured sandbox and exposes one base tool registry", async () => {
  const modes: string[] = [];
  const disposed: number[] = [];
  const bundle = new ProjectExecutionWorldBundle({
    projectRoot: process.cwd(),
    snapshot: snapshot("workspace-write"),
    profile: resolvePilotDeckRuntimeProfile({ agent: snapshot("workspace-write").config.agent }),
    now: () => new Date(0),
    extraTools: [{ name: "project_tool" } as PilotDeckToolDefinition],
    skills: {
      async loader() { return undefined; },
      lister() { return []; },
    },
    executionWorldBundleFactory: ({ sandboxMode }) => {
      modes.push(sandboxMode);
      const world = createNodeExecutionWorldBundle({ sandboxMode });
      return {
        ...world,
        async dispose() {
          disposed.push(1);
          await world.dispose();
        },
      };
    },
  });

  const resources = bundle.stage();
  assert.deepEqual(modes, ["workspace-write"]);
  assert.equal(resources.tools.has("read_file"), true);
  assert.equal(resources.tools.has("project_tool"), true);
  assert.deepEqual(
    resources.executionWorld.executeCodeSandbox.resolvePolicy({ workspaceRoot: "/workspace", executionRoot: "/execution" }),
    { mode: "workspace-write", workspaceRoot: "/workspace", executionRoot: "/execution" },
  );

  await bundle.dispose();
  await bundle.dispose();
  assert.deepEqual(disposed, [1]);
});

test("project execution-world bundle rejects a second stage without replacing the selected provider", async () => {
  let created = 0;
  const bundle = new ProjectExecutionWorldBundle({
    projectRoot: process.cwd(),
    snapshot: snapshot(),
    profile: resolvePilotDeckRuntimeProfile({ agent: snapshot().config.agent }),
    now: () => new Date(0),
    extraTools: [],
    skills: {
      async loader() { return undefined; },
      lister() { return []; },
    },
    executionWorldBundleFactory: () => {
      created += 1;
      return createNodeExecutionWorldBundle();
    },
  });

  bundle.stage();
  assert.throws(() => bundle.stage(), /stage called more than once/);
  assert.equal(created, 1);
  await bundle.dispose();
});

test("project execution-world composition enables durable background task recovery", async (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pilotdeck-project-task-state-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const first = new ProjectExecutionWorldBundle({
    projectRoot,
    snapshot: snapshot(),
    profile: resolvePilotDeckRuntimeProfile({ agent: snapshot().config.agent }),
    now: () => new Date(0),
    extraTools: [],
    skills: {
      async loader() { return undefined; },
      lister() { return []; },
    },
  });
  const firstResources = first.stage();
  const task = await firstResources.executionWorld.backgroundTasks.start({
    command: "printf project-durable-output",
    cwd: projectRoot,
    sessionId: "project-session",
  });
  await firstResources.executionWorld.backgroundTasks.waitFor(task.taskId);
  await first.dispose();

  assert.equal(existsSync(join(projectRoot, ".pilotdeck", "background-tasks", "state.json")), true);

  const second = new ProjectExecutionWorldBundle({
    projectRoot,
    snapshot: snapshot(),
    profile: resolvePilotDeckRuntimeProfile({ agent: snapshot().config.agent }),
    now: () => new Date(0),
    extraTools: [],
    skills: {
      async loader() { return undefined; },
      lister() { return []; },
    },
  });
  const secondResources = second.stage();
  const restored = secondResources.executionWorld.backgroundTasks.get(task.taskId, { sessionId: "project-session" });
  assert.equal(restored?.status, "completed");
  assert.equal(
    secondResources.executionWorld.backgroundTasks.getOutput(task.taskId, 0, undefined, { sessionId: "project-session" }).content,
    "project-durable-output",
  );
  await second.dispose();
});

function snapshot(
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access" = "danger-full-access",
): PilotConfigSnapshot {
  return {
    version: 1,
    schemaVersion: 1,
    loadedAt: new Date(0),
    contentHash: "test",
    sources: [],
    diagnostics: [],
    config: {
      agent: {
        model: { id: "test/test", provider: "test", model: "test" },
        sandboxMode,
      },
      model: { providers: {} },
      extension: { builtinPluginsEnabled: {}, includeHookEvents: false },
    },
  };
}
