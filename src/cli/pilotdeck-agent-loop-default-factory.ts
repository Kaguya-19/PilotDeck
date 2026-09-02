import { createSidecarPorts, type SidecarExecution, type SidecarExecutionFactory } from "../agent/modules/sidecar.js";
import { AgentLoop } from "../agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../agent/runtime/AgentRuntimeConfig.js";
import { createDefaultPermissionContext } from "../permission/index.js";
import type { PilotDeckToolDefinition } from "../tool/index.js";

/** Default factory used by the StaffDeck sidecar command. */
export const createSidecarExecution: SidecarExecutionFactory = ({ request, abortSignal, callModule }) => {
  const payload = request.payload as Record<string, unknown>;
  const requirement = payload.taskRequirement as Record<string, unknown>;
  const tenantId = String(payload.tenantId ?? "unknown");
  const sessionId = String(request.sessionId ?? "staffdeck-session");
  const turnId = String(request.turnId ?? request.operationId);
  const cwd = String(requirement.cwd ?? process.cwd());
  const config: AgentRuntimeConfig = {
    provider: String(requirement.provider ?? "staffdeck"),
    model: String(requirement.model ?? "staffdeck-model"),
    cwd,
    systemPrompt: "You are the StaffDeck task execution agent. Return the required HarnessAction-compatible result.",
    maxOutputTokens: 4096,
    maxContextTokens: 32768,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({ cwd, mode: "bypassPermissions", canPrompt: false, bypassAvailable: true }),
  };
  const manifest = requirement.capability_manifest as { available?: Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }> } | undefined;
  const tools: PilotDeckToolDefinition[] = (manifest?.available ?? [])
    .filter((item) => Boolean(item.name))
    .map((item) => ({
      name: String(item.name),
      description: String(item.description ?? "StaffDeck capability"),
      kind: "custom",
      inputSchema: (item.input_schema ?? { type: "object" }) as PilotDeckToolDefinition["inputSchema"],
      isReadOnly: () => true,
      isConcurrencySafe: () => false,
      execute: async () => ({ content: [{ type: "text", text: "StaffDeck capability is executed by the host bridge." }] }),
    }));
  const ports = createSidecarPorts(callModule, { tools });
  const loop = new AgentLoop(config, {
    router: {} as never,
    ports,
    tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
  });
  return {
    loop,
    input: {
      sessionId,
      turnId,
      messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify(requirement) }] }],
      abortSignal,
      execution: {
        runId: request.runId,
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        operationDeadline: request.operationDeadline,
      },
    },
  } as SidecarExecution;
};

export default createSidecarExecution;
