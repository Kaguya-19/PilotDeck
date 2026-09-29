import assert from "node:assert/strict";
import test from "node:test";

import { AgentRuntimeScope } from "../../src/agent/scope/AgentRuntimeScope.js";
import type { AgentRouterRuntime } from "../../src/agent/runtime/AgentRuntimeDependencies.js";
import { GatewayElicitationBus } from "../../src/gateway/elicitation/GatewayElicitationBus.js";
import { GatewayPermissionBus } from "../../src/gateway/permission/GatewayPermissionBus.js";
import type { GatewayEvent } from "../../src/gateway/protocol/types.js";
import {
  createNativeInteractionReconnectPort,
  resolveInteractionProfile,
} from "../../src/interaction/index.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import { ToolRegistry, type ShellPort } from "../../src/tool/index.js";
import {
  SessionInteractionBundle,
  type GatewaySessionInteractionFacade,
} from "../../src/cli/SessionInteractionBundle.js";

const shell: ShellPort = {
  async execute() {
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 };
  },
};

const question = {
  toolCallId: "call-question",
  toolName: "ask_user_question",
  questions: [{ question: "Proceed?", header: "Confirm", options: [{ label: "yes", description: "Yes" }] }],
};

test("interactive composition uses Gateway providers and the scope-owned callback", async () => {
  const gateway = createGatewayFacade((event, facade) => {
    if (event.type === "permission_request") {
      facade.permissionBus.consume("session-interactive", event.requestId)?.resolve({
        requestId: event.requestId,
        decision: "allow",
      });
    }
    return true;
  });
  const bundle = createBundle({ profile: "interactive", gateway: gateway.facade });
  const effects: Array<() => void | Promise<void>> = [];

  bundle.attach({
    own(dispose) {
      effects.push(dispose);
    },
  });

  assert.equal(bundle.interactionReconnect, gateway.facade.interactionReconnect);
  assert.equal(bundle.ownedElicitation, true);
  const pendingAnswer = bundle.elicitation!.askUser(question);
  const questionEvent = gateway.events.find((event) => event.type === "elicitation_request");
  assert.ok(questionEvent && questionEvent.type === "elicitation_request");
  gateway.elicitationBus.consume("session-interactive", questionEvent.requestId)?.resolve({
    type: "answered",
    answers: { "Proceed?": "yes" },
  });
  assert.deepEqual(await pendingAnswer, { type: "answered", answers: { "Proceed?": "yes" } });

  const decision = await bundle.permission.decide(
    { name: "write_file", isReadOnly: () => false } as never,
    {},
    { permissionContext: permissionContext(true) } as never,
    "call-permission",
  );
  assert.equal(decision.type, "ask");
  await bundle.lifecycle.dispatch({
    event: "PermissionRequest",
    baseInput: { sessionId: "session-interactive", transcriptPath: "", cwd: "/workspace" },
    payload: { toolName: "write_file", toolCallId: "call-permission", toolInput: { path: "a.txt" } },
    matchQuery: "PermissionRequest",
  });
  assert.equal(gateway.events.filter((event) => event.type === "permission_request").length, 1);
  assert.equal(gateway.permissionBus.pendingCount("session-interactive"), 0);

  await effects[0]!();
});

test("headless and disabled profiles keep deterministic and fail-closed behavior", async () => {
  const headless = createBundle({ profile: "headless" });
  assert.equal(headless.interactionReconnect, undefined);
  assert.equal(headless.ownedElicitation, true);
  assert.deepEqual(await headless.elicitation!.askUser(question), {
    type: "answered",
    answers: { "Proceed?": "yes" },
  });
  assert.deepEqual(await headless.permission.decide(
    { name: "write_file", isReadOnly: () => false } as never,
    {},
    { permissionContext: permissionContext(true) } as never,
    "headless-permission",
  ), {
    type: "deny",
    reason: { type: "runtime", message: "No interaction answerer is available." },
    message: "No interaction answerer is available.",
  });

  const disabled = createBundle({ profile: "disabled", canPrompt: false });
  assert.equal(disabled.elicitation, undefined);
  assert.equal(disabled.ownedElicitation, false);
  assert.equal(disabled.interactionReconnect, undefined);
  assert.deepEqual(await disabled.permission.decide(
    { name: "write_file", isReadOnly: () => false } as never,
    {},
    { permissionContext: permissionContext(false) } as never,
    "disabled-permission",
  ), {
    type: "deny",
    reason: { type: "runtime", message: "Permission prompt denied because prompts are disabled for this session." },
    message: "Permission prompt denied because prompts are disabled for this session.",
  });
});

test("interactive profile without a Gateway is fail-closed and does not create a pending owner", async () => {
  const bundle = createBundle({ profile: "interactive" });

  assert.equal(bundle.elicitation, undefined);
  assert.equal(bundle.interactionReconnect, undefined);
  assert.deepEqual(await bundle.permission.decide(
    { name: "write_file", isReadOnly: () => false } as never,
    {},
    { permissionContext: permissionContext(true) } as never,
    "missing-gateway-permission",
  ), {
    type: "deny",
    reason: { type: "runtime", message: "No interaction answerer is available." },
    message: "No interaction answerer is available.",
  });
});

test("failed scope attachment rolls the permission callback back", async () => {
  const gateway = createGatewayFacade(() => true);
  const bundle = createBundle({ profile: "interactive", gateway: gateway.facade });

  assert.throws(() => bundle.attach({
    own() {
      throw new Error("scope already closed");
    },
  }), /scope already closed/);
  await bundle.lifecycle.dispatch({
    event: "PermissionRequest",
    baseInput: { sessionId: "session-interactive", transcriptPath: "", cwd: "/workspace" },
    payload: { toolName: "write_file", toolCallId: "call-rollback", toolInput: { path: "a.txt" } },
    matchQuery: "PermissionRequest",
  });
  assert.equal(gateway.events.length, 0);
  assert.equal(gateway.permissionBus.pendingCount("session-interactive"), 0);
});

test("scope disposal releases callback registration and the owned Gateway channel", async () => {
  const gateway = createGatewayFacade(() => true);
  const bundle = createBundle({ profile: "interactive", gateway: gateway.facade });
  const scope = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: bundle.permission,
    interactionPolicy: bundle.policy,
    interactionDeadlinePolicy: bundle.deadlinePolicy,
    interactionReconnect: bundle.interactionReconnect,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
    lifecycle: bundle.lifecycle,
    elicitation: bundle.elicitation,
  }, {
    ownedLifecycle: true,
    ownedElicitation: bundle.ownedElicitation,
  });
  bundle.attach(scope);

  await scope.dispose();
  await assert.rejects(bundle.elicitation!.askUser(question), /disposed/);
  await assert.rejects(bundle.lifecycle.dispatch({
    event: "PermissionRequest",
    baseInput: { sessionId: "session-interactive", transcriptPath: "", cwd: "/workspace" },
    payload: { toolName: "write_file", toolCallId: "call-disposed", toolInput: { path: "a.txt" } },
    matchQuery: "PermissionRequest",
  }), /disposed/);
  assert.equal(gateway.events.length, 0);
});

function createBundle(input: {
  profile: "interactive" | "headless" | "disabled";
  canPrompt?: boolean;
  gateway?: GatewaySessionInteractionFacade;
}): SessionInteractionBundle {
  const profile = resolveInteractionProfile(input.profile);
  return new SessionInteractionBundle({
    sessionKey: "session-interactive",
    profile,
    canPrompt: input.canPrompt ?? profile.canPrompt,
    permissionRules: [],
    hookSettings: {},
    shell,
    projectRoot: "/workspace",
    gateway: input.gateway,
  });
}

function permissionContext(canPrompt: boolean) {
  return createDefaultPermissionContext({
    cwd: "/workspace",
    canPrompt,
    rules: { allow: [], deny: [], ask: [] },
  });
}

function createGatewayFacade(
  emit: (event: GatewayEvent, facade: GatewaySessionInteractionFacade) => boolean,
): {
  facade: GatewaySessionInteractionFacade;
  events: GatewayEvent[];
  permissionBus: GatewayPermissionBus;
  elicitationBus: GatewayElicitationBus;
} {
  const reconnect = createNativeInteractionReconnectPort();
  const permissionBus = new GatewayPermissionBus(reconnect);
  const elicitationBus = new GatewayElicitationBus(reconnect);
  const events: GatewayEvent[] = [];
  let facade!: GatewaySessionInteractionFacade;
  facade = {
    permissionBus,
    elicitationBus,
    interactionReconnect: reconnect,
    emit(event) {
      events.push(event);
      return emit(event, facade);
    },
  };
  return { facade, events, permissionBus, elicitationBus };
}
