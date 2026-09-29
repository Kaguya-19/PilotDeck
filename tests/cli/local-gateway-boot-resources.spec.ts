import assert from "node:assert/strict";
import test from "node:test";

import { LocalGatewayBootResources } from "../../src/cli/LocalGatewayBootResources.js";

test("local Gateway boot resources use one inventory for rollback and steady-state shutdown", async () => {
  const rollbackEvents: string[] = [];
  const rollback = new LocalGatewayBootResources({ warn: () => {} });
  registerResources(rollback, rollbackEvents);

  await rollback.rollback();
  assert.deepEqual(rollbackEvents, [
    "config-watch",
    "extension-watch",
    "router",
    "runtime-refresh",
    "session-mcp",
    "project-runtimes",
    "subagent-runtime",
    "telemetry",
  ]);

  const shutdownEvents: string[] = [];
  const steadyState = new LocalGatewayBootResources({ warn: () => {} });
  registerResources(steadyState, shutdownEvents);
  const lifecycle = steadyState.commit({
    gateway: { dispose: () => { shutdownEvents.push("gateway"); } },
  });
  await lifecycle.dispose();
  await steadyState.rollback();

  assert.deepEqual(shutdownEvents, [
    "gateway",
    "subagent-manager",
    "config-watch",
    "extension-watch",
    "runtime-refresh",
    "subagent-providers",
    "router",
    "session-mcp",
    "project-runtimes",
    "telemetry",
  ]);
});

test("local Gateway boot resources reject duplicate registration and incomplete commit", () => {
  const resources = new LocalGatewayBootResources({ warn: () => {} });
  resources.ownTelemetry({ async dispose() {} });

  assert.throws(
    () => resources.ownTelemetry({ async dispose() {} }),
    /already registered: Gateway telemetry/,
  );
  assert.throws(
    () => resources.commit({ gateway: {} }),
    /missing owned resources: subagent runtime, project runtime registry, session router, Gateway runtime refresh, config watcher, extension watcher/,
  );
});

function registerResources(resources: LocalGatewayBootResources, events: string[]): void {
  resources.ownTelemetry({ async dispose() { events.push("telemetry"); } });
  resources.ownSubagentRuntime({
    async dispose() { events.push("subagent-runtime"); },
    manager: { async dispose() { events.push("subagent-manager"); } },
    providers: { async dispose() { events.push("subagent-providers"); } },
  });
  resources.ownRegistry({
    async disposeProjectRuntimes() { events.push("project-runtimes"); },
    async disposeSessionMcpRuntimes() { events.push("session-mcp"); },
  });
  resources.ownConfigWatcher(() => { events.push("config-watch"); });
  resources.ownExtensionWatcher(() => { events.push("extension-watch"); });
  resources.ownRuntimeRefresh({ dispose() { events.push("runtime-refresh"); } });
  resources.ownRouter({ async shutdown() { events.push("router"); } });
}
