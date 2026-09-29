import assert from "node:assert/strict";
import test from "node:test";

import { createExitPlanModeTool } from "../../src/tool/builtin/planMode.js";
import { createPlanFileManager } from "../../src/tool/builtin/planFile.js";
import type { PlanStoragePort } from "../../src/tool/execution-world/PlanStoragePort.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";

test("plan file manager consumes an injected storage provider", () => {
  const calls: string[] = [];
  const storage: PlanStoragePort = {
    ensureDirectory(path) { calls.push(`ensure:${path}`); },
    readText(path) { calls.push(`read:${path}`); return "# Plan\nDo the work."; },
  };
  const plans = createPlanFileManager({ projectRoot: "/project", storage });

  assert.equal(plans.getPlanDirectoryPath(), "/project/.pilotdeck/plans");
  assert.equal(plans.resolvePlanFilePath(".pilotdeck/plans/work.md", "/project"), "/project/.pilotdeck/plans/work.md");
  assert.equal(plans.resolvePlanFilePath("/outside.md", "/project"), undefined);
  assert.equal(plans.readPlanFile(".pilotdeck/plans/work.md", "/project"), "# Plan\nDo the work.");
  assert.deepEqual(calls, [
    "ensure:/project/.pilotdeck/plans",
    "read:/project/.pilotdeck/plans/work.md",
  ]);
});

test("exit_plan_mode reads the already-resolved plan through its plan-directory consumer seam", async () => {
  const reads: string[] = [];
  const approvals: Array<{ plan: string; turnId: string }> = [];
  const tool = createExitPlanModeTool();
  const context: PilotDeckToolRuntimeContext = {
    sessionId: "plan-session",
    turnId: "plan-turn",
    cwd: "/project",
    permissionMode: "plan",
    permissionContext: {
      mode: "plan",
      cwd: "/project",
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: false,
      rules: { allow: [], deny: [], ask: [] },
    },
    planDirectory: {
      path: "/project/.pilotdeck/plans",
      resolve(input: string) {
        return input === "work.md" ? "/project/.pilotdeck/plans/work.md" : undefined;
      },
      read(input: string) {
        reads.push(input);
        return "# Delivery Plan\n\nImplement the provider seam.";
      },
    },
    elicitation: {
      async askUser() {
        return { type: "answered", answers: { action: "execute_plan" } };
      },
    },
    planTodo: {
      async markPlanApproved(plan: string, options: { turnId: string }) {
        approvals.push({ plan, turnId: options.turnId });
      },
      getSnapshot() { return { todos: [] }; },
      async recordTodoWrite() { return []; },
      async writeTodos() { return []; },
      async markToolProgressChanged() {},
      buildPromptAddendum() { return undefined; },
      blockingMessageFor() { return undefined; },
    },
  } as unknown as PilotDeckToolRuntimeContext;

  const result = await tool.execute({ plan_file_path: "work.md" }, context);
  assert.equal(result.data?.action, "execute_plan");
  assert.deepEqual(reads, ["work.md"]);
  assert.deepEqual(approvals, [{
    plan: "# Delivery Plan\n\nImplement the provider seam.",
    turnId: "plan-turn",
  }]);
});
