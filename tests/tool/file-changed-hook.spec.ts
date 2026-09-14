import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HookRuntime } from "../../src/extension/hooks/execution/HookRuntime.js";
import type { LifecycleDispatchInput, LifecycleDispatchResult } from "../../src/lifecycle/protocol/payloads.js";
import { LifecycleRuntime } from "../../src/lifecycle/runtime/LifecycleRuntime.js";
import { PermissionRuntime } from "../../src/permission/decision/PermissionRuntime.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { createWriteFileTool } from "../../src/tool/builtin/writeFile.js";
import type {
  PilotDeckFileUpdateNotification,
  PilotDeckToolDefinition,
  PilotDeckToolRuntimeContext,
} from "../../src/tool/protocol/types.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";

const root = "/workspace";
const update: PilotDeckFileUpdateNotification = {
  absolutePath: "/workspace/changed.txt",
  relativePath: "changed.txt",
  root,
  content: "after",
  previousContent: null,
};

function context(overrides: Partial<PilotDeckToolRuntimeContext> = {}): PilotDeckToolRuntimeContext {
  const cwd = overrides.cwd ?? root;
  return {
    sessionId: "session-file-hook",
    turnId: "turn-file-hook",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    ...overrides,
  };
}

function fileMutationTool(): PilotDeckToolDefinition {
  return {
    name: "file_mutation",
    description: "Test-only file mutation tool.",
    kind: "filesystem",
    inputSchema: { type: "object", additionalProperties: false },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    async execute(_input, toolContext) {
      await toolContext.fileUpdateNotifier?.didChange?.(update);
      await toolContext.fileUpdateNotifier?.didSave?.(update);
      return { content: [{ type: "text", text: "committed" }] };
    },
  };
}

function readOnlyTool(): PilotDeckToolDefinition {
  return {
    name: "read_only",
    description: "Test-only read-only tool.",
    kind: "filesystem",
    inputSchema: { type: "object", additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    async execute() {
      return { content: [{ type: "text", text: "read" }] };
    },
  };
}

function runtime(
  lifecycle: LifecycleRuntime,
  tools: PilotDeckToolDefinition[],
  warnings: Array<{ code: string; message: string }> = [],
): ToolRuntime {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return new ToolRuntime(
    registry,
    new PermissionRuntime(),
    lifecycle,
    (event) => {
      if (event.type === "warning") warnings.push({ code: event.code, message: event.message });
    },
  );
}

class FileChangedFailingLifecycle extends LifecycleRuntime {
  override async dispatch(input: LifecycleDispatchInput): Promise<LifecycleDispatchResult> {
    if (input.event === "FileChanged") {
      throw new Error("FileChanged observer unavailable");
    }
    return super.dispatch(input);
  }
}

test("FileChanged uses the canonical saved path after the host notifier", async () => {
  const hooks = new HookRuntime({
    FileChanged: [{ matcher: update.absolutePath, hooks: [{ type: "callback", name: "capture" }] }],
  });
  const calls: string[] = [];
  const received: Array<Record<string, unknown>> = [];
  hooks.getCallbackExecutor().register("capture", ({ hookInput }) => {
    calls.push("hook");
    received.push(hookInput);
  });
  const toolRuntime = runtime(new LifecycleRuntime(hooks), [fileMutationTool()]);

  const result = await toolRuntime.execute(
    { id: "call-file-changed", name: "file_mutation", input: {} },
    context({
      fileUpdateNotifier: {
        didChange: () => {
          calls.push("change");
        },
        didSave: () => {
          calls.push("save");
        },
      },
    }),
  );

  assert.equal(result.type, "success");
  assert.deepEqual(calls, ["change", "save", "hook"]);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.hookEventName, "FileChanged");
  assert.equal(received[0]?.absolutePath, update.absolutePath);
  assert.equal(received[0]?.relativePath, update.relativePath);
  assert.equal(received[0]?.changeKind, "create");
  await hooks.dispose();
});

test("write_file publishes FileChanged through the ToolRuntime notifier decorator", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pilotdeck-file-changed-"));
  const filePath = join(cwd, "created.txt");
  const hooks = new HookRuntime({
    FileChanged: [{ matcher: filePath, hooks: [{ type: "callback", name: "capture" }] }],
  });
  const received: Array<Record<string, unknown>> = [];
  hooks.getCallbackExecutor().register("capture", ({ hookInput }) => {
    received.push(hookInput);
  });
  const toolRuntime = runtime(new LifecycleRuntime(hooks), [createWriteFileTool()]);

  try {
    const result = await toolRuntime.execute(
      { id: "call-write-file", name: "write_file", input: { file_path: "created.txt", content: "created" } },
      context({ cwd }),
    );

    assert.equal(result.type, "success");
    assert.equal(await readFile(filePath, "utf8"), "created");
    assert.equal(received.length, 1);
    assert.equal(received[0]?.absolutePath, filePath);
    assert.equal(received[0]?.relativePath, "created.txt");
    assert.equal(received[0]?.changeKind, "create");
  } finally {
    await hooks.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("FileChanged block effects and lifecycle failures never fail an already committed tool", async () => {
  const hooks = new HookRuntime({
    FileChanged: [{ hooks: [{ type: "callback", name: "block" }] }],
  });
  hooks.getCallbackExecutor().register("block", () => ({
    type: "sync",
    continue: false,
    reason: "post-commit observation only",
  }));
  const warnings: Array<{ code: string; message: string }> = [];
  const toolRuntime = runtime(new LifecycleRuntime(hooks), [fileMutationTool()], warnings);

  const blocked = await toolRuntime.execute(
    { id: "call-file-block", name: "file_mutation", input: {} },
    context(),
  );
  assert.equal(blocked.type, "success");
  assert.deepEqual(warnings, [{ code: "file_changed_hook_blocked", message: "post-commit observation only" }]);

  const failingToolRuntime = runtime(new FileChangedFailingLifecycle(hooks), [fileMutationTool()], warnings);
  const failedObserver = await failingToolRuntime.execute(
    { id: "call-file-observer-error", name: "file_mutation", input: {} },
    context(),
  );
  assert.equal(failedObserver.type, "success");
  assert.equal(warnings.at(-1)?.code, "file_changed_hook_error");
  await hooks.dispose();
});

test("tools without a successful save do not emit FileChanged", async () => {
  const hooks = new HookRuntime({
    FileChanged: [{ hooks: [{ type: "callback", name: "capture" }] }],
  });
  let count = 0;
  hooks.getCallbackExecutor().register("capture", () => {
    count += 1;
  });
  const toolRuntime = runtime(new LifecycleRuntime(hooks), [readOnlyTool()]);

  const result = await toolRuntime.execute(
    { id: "call-read-only", name: "read_only", input: {} },
    context(),
  );

  assert.equal(result.type, "success");
  assert.equal(count, 0);
  await hooks.dispose();
});
