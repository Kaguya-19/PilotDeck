import assert from "node:assert/strict";
import test from "node:test";

import { LocalGatewayLifecycleBundle } from "../../src/cli/LocalGatewayLifecycleBundle.js";

test("local Gateway lifecycle stops watchers during drain and disposes each provider once", async () => {
  const events: string[] = [];
  let releaseManager!: () => void;
  const managerPending = new Promise<void>((resolve) => { releaseManager = resolve; });
  const bundle = new LocalGatewayLifecycleBundle({
    gateway: { dispose: () => { events.push("gateway"); } },
    subagentManager: {
      async dispose() {
        events.push("manager:start");
        await managerPending;
        events.push("manager:end");
      },
    },
    subagentProviders: { async dispose() { events.push("providers"); } },
    router: { async shutdown() { events.push("router"); } },
    registry: {
      async disposeSessionMcpRuntimes() { events.push("session-mcp"); },
      async disposeProjectRuntimes() { events.push("project-runtimes"); },
    },
    telemetry: { async dispose() { events.push("telemetry"); } },
    stopConfigWatching: () => { events.push("config-watch"); },
    stopExtensionWatching: () => { events.push("extension-watch"); },
    warn: () => { events.push("warn"); },
  });

  const first = bundle.dispose();
  const second = bundle.dispose();
  assert.equal(first, second);
  assert.deepEqual(events, ["gateway", "manager:start", "config-watch", "extension-watch"]);

  releaseManager();
  await first;
  assert.deepEqual(events, [
    "gateway", "manager:start", "config-watch", "extension-watch", "manager:end",
    "providers", "router", "session-mcp", "project-runtimes", "telemetry",
  ]);
});

test("local Gateway lifecycle continues every teardown step after earlier failures", async () => {
  const events: string[] = [];
  const warnings: string[] = [];
  const bundle = new LocalGatewayLifecycleBundle({
    gateway: { dispose: () => { events.push("gateway"); throw new Error("gateway failed"); } },
    subagentManager: { async dispose() { events.push("manager"); throw new Error("drain failed"); } },
    subagentProviders: { async dispose() { events.push("providers"); throw new Error("providers failed"); } },
    router: { async shutdown() { events.push("router"); throw new Error("router failed"); } },
    registry: {
      async disposeSessionMcpRuntimes() { events.push("session-mcp"); throw new Error("mcp failed"); },
      async disposeProjectRuntimes() { events.push("project-runtimes"); throw new Error("project runtimes failed"); },
    },
    telemetry: { async dispose() { events.push("telemetry"); throw new Error("telemetry failed"); } },
    stopConfigWatching: () => { events.push("config-watch"); throw new Error("config watcher failed"); },
    stopExtensionWatching: () => { events.push("extension-watch"); throw new Error("extension watcher failed"); },
    warn: (message) => { warnings.push(message); },
  });

  await bundle.dispose();

  assert.deepEqual(events, [
    "gateway", "manager", "config-watch", "extension-watch", "providers", "router", "session-mcp", "project-runtimes", "telemetry",
  ]);
  assert.deepEqual(warnings, [
    "[pilotdeck] failed to dispose local Gateway:",
    "[pilotdeck] failed to stop config watching:",
    "[pilotdeck] failed to stop extension watching:",
    "[pilotdeck] failed to dispose continuable subagents:",
    "[pilotdeck] failed to dispose subagent providers:",
    "[pilotdeck] failed to shut down session router:",
    "[pilotdeck] failed to dispose per-session MCP runtimes:",
    "[pilotdeck] failed to dispose project runtimes:",
    "[pilotdeck] failed to dispose Gateway telemetry:",
  ]);
});
