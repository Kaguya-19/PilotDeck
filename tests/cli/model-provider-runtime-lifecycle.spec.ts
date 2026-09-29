import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { PilotDeckLoadedPlugin } from "../../src/extension/index.js";
import type { McpRuntimePort } from "../../src/mcp/index.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelInvocationProvider,
} from "../../src/model/index.js";
import {
  createNativeRouterSessionCustomRouterPort,
  type RouterSessionCustomRouterPort,
  type RouterSessionStateProvider,
} from "../../src/router/index.js";
import type { ExecutionWorldBundle } from "../../src/tool/execution-world/ExecutionWorldBundle.js";
import type { PilotDeckToolDefinition } from "../../src/tool/protocol/types.js";

const CONFIG = `
schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 8192
  maxOutputTokens: 1024
model:
  providers:
    test:
      protocol: openai
      url: http://127.0.0.1:1
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 8192
            maxOutputTokens: 1024
        fallback:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 8192
            maxOutputTokens: 1024
`;

test("retired project runtime keeps provider alive until its session and stream leases drain", async (t) => {
  const root = await fixture(t);
  let releaseStream!: () => void;
  let firstStreamStarted!: () => void;
  const streamStarted = new Promise<void>((resolve) => { firstStreamStarted = resolve; });
  const disposed: number[] = [];
  let generation = 0;
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    modelInvocationProviderFactory: () => {
      generation += 1;
      const current = generation;
      return [provider(current, {
        stream: current === 1
          ? async function* () {
              yield { type: "text_delta", text: "old-start" };
              firstStreamStarted();
              await new Promise<void>((resolve) => { releaseStream = resolve; });
              yield { type: "text_delta", text: "old-end" };
            }
          : undefined,
        onDispose: () => { disposed.push(current); },
      })];
    },
  });
  try {
    const oldRuntime = local.registry.resolve(root);
    const handle = await local.registry.createSession({
      sessionKey: "runtime-lease",
      projectKey: root,
      channelKey: "test",
    });
    const streamed: CanonicalModelEvent[] = [];
    const drainingStream = (async () => {
      for await (const event of oldRuntime.modelProviders.stream(request())) streamed.push(event);
    })();
    await streamStarted;

    local.registry.invalidate(root);
    const replacement = local.registry.resolve(root);
    assert.notEqual(replacement, oldRuntime);
    assert.deepEqual(disposed, [], "old stream and session must retain the retired runtime");
    assert.equal(replacement.modelProviders.getProviderGeneration("test"), 1);

    releaseStream();
    await drainingStream;
    assert.equal(disposed.length, 0, "the old session lease still owns its runtime");
    assert.deepEqual(streamed.map((event) => event.type), ["text_delta", "text_delta"]);

    await handle.dispose("test_finished");
    assert.deepEqual(disposed, [1], "the old provider disposes once after both leases drain");
  } finally {
    await local.dispose();
  }
});

test("retired project runtime stops a shared plugin MCP before releasing its plugin generation", async (t) => {
  const root = await fixture(t);
  const lifecycle: string[] = [];
  const plugin: PilotDeckLoadedPlugin = {
    name: "test-mcp-plugin",
    path: "/plugins/test-mcp-plugin",
    source: "builtin",
    manifest: { name: "test-mcp-plugin", version: "1.0.0" },
    mcpServers: {
      test_mcp: { url: "http://127.0.0.1:1/mcp" },
    },
    dispose: () => { lifecycle.push("plugin.dispose"); },
  };
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    builtinPlugins: [plugin],
    mcpRuntimeFactory: () => fakeMcpRuntime(lifecycle),
  });
  try {
    const oldRuntime = local.registry.resolve(root);
    const handle = await local.registry.createSession({
      sessionKey: "plugin-mcp-lease",
      projectKey: root,
      channelKey: "test",
    });
    assert.deepEqual(lifecycle, ["mcp.start"]);

    local.registry.invalidate(root);
    assert.deepEqual(
      lifecycle,
      ["mcp.start"],
      "the active session retains the retired runtime and its plugin MCP consumer",
    );

    await handle.dispose("test_finished");
    assert.deepEqual(lifecycle, ["mcp.start", "mcp.stop", "plugin.dispose"]);
    assert.equal(oldRuntime.runtimeState, "disposed");
  } finally {
    await local.dispose();
  }
});

test("per-session MCP uses the composed factory and its exact handle owns shutdown", async (t) => {
  const root = await fixture(t);
  const lifecycle: string[] = [];
  const createdFor: string[][] = [];
  const plugin: PilotDeckLoadedPlugin = {
    name: "per-session-mcp-plugin",
    path: "/plugins/per-session-mcp-plugin",
    source: "builtin",
    manifest: { name: "per-session-mcp-plugin", version: "1.0.0" },
    mcpServers: {
      session_mcp: {
        command: "node",
        args: ["server.mjs"],
        perSession: true,
      },
    },
  };
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testBuiltinPlugins: [plugin],
    __testMcpRuntimeFactory: (servers) => {
      createdFor.push(servers.map((server) => server.id));
      return fakeMcpRuntime(lifecycle);
    },
  });
  try {
    const handle = await local.registry.createSession({
      sessionKey: "per-session-mcp",
      projectKey: root,
      channelKey: "test",
    });

    assert.deepEqual(createdFor, [["session_mcp"]]);
    assert.deepEqual(lifecycle, ["mcp.start"]);

    await handle.dispose("test_finished");
    assert.deepEqual(lifecycle, ["mcp.start", "mcp.stop"]);
  } finally {
    await local.dispose();
  }
});

test("a refreshed plugin MCP generation serves only new sessions while old sessions drain", async (t) => {
  const root = await fixture(t);
  const pluginDir = join(root, ".pilotdeck", "plugins", "live-mcp");
  await mkdir(pluginDir, { recursive: true });
  const writePlugin = async (serverId: string) => {
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({
      name: "live-mcp",
      version: "1.0.0",
      mcpServers: {
        [serverId]: { url: `http://127.0.0.1:1/${serverId}` },
      },
    }), "utf8");
  };
  await writePlugin("old_server");

  const lifecycle: string[] = [];
  const createdFor: string[][] = [];
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testBuiltinPlugins: [],
    __testMcpRuntimeFactory: (servers) => {
      const serverId = servers[0]?.id ?? "none";
      createdFor.push(servers.map((server) => server.id));
      return {
        async start() {
          lifecycle.push(`start:${serverId}`);
          return [];
        },
        async stop() {
          lifecycle.push(`stop:${serverId}`);
        },
        async listAllTools() { return []; },
        getServerInfo() { return undefined; },
        async callTool() { return { content: [] }; },
      };
    },
  });
  try {
    const old = await local.registry.createSession({
      sessionKey: "live-mcp-old",
      projectKey: root,
      channelKey: "test",
    });
    await writePlugin("new_server");
    const replacement = await local.registry.createSession({
      sessionKey: "live-mcp-new",
      projectKey: root,
      channelKey: "test",
    });

    assert.deepEqual(createdFor, [["old_server"], ["new_server"]]);
    assert.deepEqual(lifecycle, ["start:old_server", "start:new_server"]);

    await replacement.dispose("test_finished");
    assert.deepEqual(lifecycle, ["start:old_server", "start:new_server", "stop:new_server"]);

    await old.dispose("test_finished");
    assert.deepEqual(lifecycle, [
      "start:old_server",
      "start:new_server",
      "stop:new_server",
      "stop:old_server",
    ]);
  } finally {
    await local.dispose();
  }
});

test("closing a session leaves the project tool registry available to later sessions", async (t) => {
  const root = await fixture(t);
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
  });
  try {
    const runtime = local.registry.resolve(root);
    const first = await local.registry.createSession({
      sessionKey: "project-tools-first",
      projectKey: root,
      channelKey: "test",
    });

    await first.dispose("test_finished");
    assert.equal(runtime.tools.state, "active");

    const second = await local.registry.createSession({
      sessionKey: "project-tools-second",
      projectKey: root,
      channelKey: "test",
    });
    assert.equal(runtime.tools.state, "active");
    await second.dispose("test_finished");
    assert.equal(runtime.tools.state, "active");
  } finally {
    await local.dispose();
  }
});

test("staged project runtime reload preserves the published runtime when a candidate cannot be built", async (t) => {
  const root = await fixture(t);
  let buildAttempts = 0;
  let disposed = 0;
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testModelInvocationProviderFactory: () => {
      buildAttempts += 1;
      if (buildAttempts > 1) throw new Error("candidate provider construction failed");
      return [provider(1, { onDispose: () => { disposed += 1; } })];
    },
  });
  try {
    const published = local.registry.resolve(root);
    await assert.rejects(() => local.registry.reload(), /candidate provider construction failed/);

    assert.equal(local.registry.resolve(root), published);
    const completion = await published.modelProviders.complete(request());
    assert.equal(completion.content[0]?.type, "text");
    assert.equal(disposed, 0, "failed staging must not retire a published runtime");
  } finally {
    await local.dispose();
  }
});

test("failed staging disposes providers that were registered before the build failed", async (t) => {
  const root = await fixture(t);
  let buildAttempts = 0;
  const disposed: number[] = [];
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testModelInvocationProviderFactory: () => {
      buildAttempts += 1;
      if (buildAttempts === 1) return [provider(1, { onDispose: () => { disposed.push(1); } })];
      return [
        provider(2, { onDispose: () => { disposed.push(2); } }),
        provider(2),
      ];
    },
  });
  try {
    const published = local.registry.resolve(root);
    await assert.rejects(() => local.registry.reload());

    assert.equal(local.registry.resolve(root), published);
    assert.deepEqual(disposed, [2], "the partially staged provider must not leak after registration fails");
  } finally {
    await local.dispose();
  }
});

test("concurrent reload calls wait for a failed staging cleanup before the next stage begins", async (t) => {
  const root = await fixture(t);
  let buildAttempts = 0;
  let beginCleanup!: () => void;
  let releaseCleanup!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => { beginCleanup = resolve; });
  const cleanupReleased = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testModelInvocationProviderFactory: () => {
      buildAttempts += 1;
      if (buildAttempts === 1) return [provider(1)];
      if (buildAttempts === 2) {
        return [
          provider(2, {
            onDispose: async () => {
              beginCleanup();
              await cleanupReleased;
            },
          }),
          provider(2),
        ];
      }
      return [provider(buildAttempts)];
    },
  });
  try {
    local.registry.resolve(root);
    const first = local.registry.reload();
    await cleanupStarted;
    const second = local.registry.reload();
    await Promise.resolve();

    assert.equal(buildAttempts, 2, "the second reload must wait behind the failed staging cleanup");

    releaseCleanup();
    await assert.rejects(() => first);
    await second;
    assert.equal(buildAttempts, 3);
    const completion = await local.registry.resolve(root).modelProviders.complete(request());
    assert.equal(completion.content[0]?.type, "text");
    assert.equal(completion.content[0]?.text, "generation-3");
  } finally {
    await local.dispose();
  }
});

test("failed project runtime construction releases an already-created execution-world bundle", async (t) => {
  const root = await fixture(t);
  let generation = 0;
  const disposed: number[] = [];
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testExecutionWorldBundleFactory: () => {
      generation += 1;
      return fakeExecutionWorldBundle(generation, disposed);
    },
  });
  try {
    assert.equal(generation, 1, "initial runtime owns the first execution-world bundle");
    local.registry.updateSubsystems({ extraTools: [duplicateBuiltinTool()] });

    assert.throws(
      () => local.registry.resolve(root),
      /Tool read_file is already registered/,
    );
    await waitFor(() => disposed.includes(2));

    assert.equal(disposed.filter((id) => id === 2).length, 1);
  } finally {
    await local.dispose();
  }
});

test("project runtime resource bundle disposes a provider generation only once", async (t) => {
  const root = await fixture(t);
  let disposed = 0;
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testModelInvocationProviderFactory: () => [
      provider(1, { onDispose: () => { disposed += 1; } }),
    ],
  });

  const runtime = local.registry.resolve(root);
  await runtime.resourcesBundle.dispose();
  await runtime.resourcesBundle.dispose();
  await local.dispose();

  assert.equal(disposed, 1);
});

test("local Gateway disposal awaits project runtime cleanup and rejects new runtime construction", async (t) => {
  const root = await fixture(t);
  let beginDispose!: () => void;
  let releaseDispose!: () => void;
  const disposeStarted = new Promise<void>((resolve) => { beginDispose = resolve; });
  const disposeReleased = new Promise<void>((resolve) => { releaseDispose = resolve; });
  let disposed = 0;
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testModelInvocationProviderFactory: () => [
      provider(1, {
        onDispose: async () => {
          beginDispose();
          await disposeReleased;
          disposed += 1;
        },
      }),
    ],
  });

  try {
    const stopping = Promise.resolve(local.dispose());
    await disposeStarted;
    assert.equal(disposed, 0, "Gateway disposal must wait for the project generation cleanup");

    releaseDispose();
    await stopping;

    assert.equal(disposed, 1);
    assert.throws(() => local.registry.resolve(root), /Project runtime registry is disposed/);
  } finally {
    releaseDispose?.();
    await local.dispose();
  }
});

test("local Gateway disposal waits for an admitted reload cleanup before retiring published generations", async (t) => {
  const root = await fixture(t);
  let buildAttempts = 0;
  let beginCandidateCleanup!: () => void;
  let releaseCandidateCleanup!: () => void;
  const candidateCleanupStarted = new Promise<void>((resolve) => { beginCandidateCleanup = resolve; });
  const candidateCleanupReleased = new Promise<void>((resolve) => { releaseCandidateCleanup = resolve; });
  const disposed: number[] = [];
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testModelInvocationProviderFactory: () => {
      buildAttempts += 1;
      if (buildAttempts === 1) {
        return [provider(1, { onDispose: () => { disposed.push(1); } })];
      }
      return [
        provider(2, {
          onDispose: async () => {
            beginCandidateCleanup();
            await candidateCleanupReleased;
            disposed.push(2);
          },
        }),
        provider(2),
      ];
    },
  });

  try {
    const reload = local.registry.reload();
    await candidateCleanupStarted;

    const stopping = Promise.resolve(local.dispose());
    await Promise.resolve();
    assert.deepEqual(disposed, [], "shutdown must wait behind the admitted reload cleanup");

    releaseCandidateCleanup();
    await assert.rejects(reload);
    await stopping;

    assert.deepEqual(disposed, [2, 1]);
  } finally {
    releaseCandidateCleanup?.();
    await local.dispose();
  }
});

test("local Gateway disposal awaits a previously invalidated generation cleanup", async (t) => {
  const root = await fixture(t);
  let beginDispose!: () => void;
  let releaseDispose!: () => void;
  const disposeStarted = new Promise<void>((resolve) => { beginDispose = resolve; });
  const disposeReleased = new Promise<void>((resolve) => { releaseDispose = resolve; });
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testModelInvocationProviderFactory: () => [
      provider(1, {
        onDispose: async () => {
          beginDispose();
          await disposeReleased;
        },
      }),
    ],
  });

  try {
    local.registry.invalidate(root);
    await disposeStarted;

    const stopping = Promise.resolve(local.dispose());
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false, "shutdown must include retired generations no longer in the runtime map");

    releaseDispose();
    await stopping;
  } finally {
    releaseDispose?.();
    await local.dispose();
  }
});

test("project Router generations share volatile session state across reload and application shutdown", async (t) => {
  const root = await fixture(t, `${CONFIG}
router:
  enabled: true
  tokenSaver:
    enabled: false
`);
  const local = createLocalGateway({ projectRoot: root, pilotHome: root });
  const registryWithState = local.registry as unknown as {
    sharedSessionState: RouterSessionStateProvider;
  };
  const sessionId = "router-state-reload";
  const decisionInput = {
    request: request(),
    sessionId,
    isMainAgent: true,
  };
  try {
    const state = registryWithState.sharedSessionState;
    const first = local.registry.resolve(root);
    await first.router.decide(decisionInput);
    assert.equal(state.get(sessionId, false)?.stickyProvider, "test");

    state.set({
      sessionId,
      isSubagent: false,
      stickyProvider: "stale",
      stickyModel: "stale",
      orchestrating: false,
      updatedAt: 0,
    });
    local.registry.invalidate(root);
    const replacement = local.registry.resolve(root);
    await replacement.router.decide(decisionInput);
    assert.equal(
      state.get(sessionId, false)?.stickyProvider,
      "test",
      "the replacement RouterRuntime must write through the registry-owned state provider",
    );

    await local.dispose();
    assert.equal(state.get(sessionId, false), undefined);
  } finally {
    await local.dispose();
  }
});

test("local Gateway preserves an application-selected Router session-state provider across reload and shutdown", async (t) => {
  const root = await fixture(t, `${CONFIG}
router:
  enabled: true
  tokenSaver:
    enabled: false
`);
  const values = new Map<string, ReturnType<RouterSessionStateProvider["get"]>>();
  let reads = 0;
  let writes = 0;
  let clears = 0;
  const state: RouterSessionStateProvider = {
    get(sessionId, isSubagent) {
      reads += 1;
      return values.get(`${sessionId}:${isSubagent}`);
    },
    set(next) {
      writes += 1;
      values.set(`${next.sessionId}:${next.isSubagent}`, next);
    },
    clear() {
      clears += 1;
      values.clear();
    },
  };
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    routerSessionState: state,
  });
  const sessionId = "selected-router-state";
  const decisionInput = {
    request: request(),
    sessionId,
    isMainAgent: true,
  };
  try {
    await local.registry.resolve(root).router.decide(decisionInput);
    assert.ok(reads > 0);
    assert.ok(writes > 0);
    local.registry.invalidate(root);
    await local.registry.resolve(root).router.decide(decisionInput);
    assert.ok(reads > 1, "the replacement RouterRuntime must read the selected provider");
  } finally {
    await local.dispose();
  }
  assert.equal(clears, 0, "the registry must not clear an application-owned provider");
  assert.ok(values.has(`${sessionId}:false`));
});

test("local Gateway composes a per-generation custom-router provider and owns its teardown", async (t) => {
  const root = await fixture(t, `${CONFIG}
router:
  enabled: true
  tokenSaver:
    enabled: false
  customRouter:
    extensionId: selected-router
`);
  let lookups = 0;
  let disposed = 0;
  const native = createNativeRouterSessionCustomRouterPort();
  const selected: RouterSessionCustomRouterPort = {
    register: (sessionId, routers) => native.register(sessionId, routers),
    lookupRouter: (extensionId, sessionId) => {
      lookups += 1;
      return native.lookupRouter(extensionId, sessionId);
    },
    clear: () => native.clear(),
    dispose: () => {
      disposed += 1;
      native.dispose();
    },
  };
  const plugin: PilotDeckLoadedPlugin = {
    name: "selected-router-plugin",
    path: "/plugins/selected-router-plugin",
    source: "builtin",
    manifest: { name: "selected-router-plugin", version: "1.0.0" },
    routerContributions: [{
      id: "selected-router",
      createCustomRouter: () => ({
        id: "selected-router",
        async decide() {
          return { provider: "test", model: "test" };
        },
      }),
    }],
  };
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    builtinPlugins: [plugin],
    routerSessionCustomRouterFactory: () => selected,
  });
  const handle = await local.registry.createSession({
    sessionKey: "selected-custom-router",
    projectKey: root,
    channelKey: "test",
  });
  try {
    const decision = await local.registry.resolve(root).router.decide({
      request: request(),
      sessionId: "selected-custom-router",
      isMainAgent: true,
    });
    assert.equal(decision.resolvedFrom, "custom");
    assert.ok(lookups > 0, "RouterRuntime must consume the selected custom-router provider");
  } finally {
    await handle.dispose("test_finished");
    await local.dispose();
  }
  assert.equal(disposed, 1);
});

test("local Gateway composes a per-generation Router provider-health policy", async (t) => {
  const root = await fixture(t, `${CONFIG}
router:
  enabled: true
  tokenSaver:
    enabled: false
  fallback:
    default:
      - test/fallback
    maxFallbacks: 1
  transientRetry:
    enabled: false
    maxAttempts: 1
    baseDelayMs: 0
    maxDelayMs: 0
  zeroUsageRetry:
    enabled: false
    maxAttempts: 1
`);
  let created = 0;
  let checks = 0;
  const disposed: number[] = [];
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    modelInvocationProviderFactory: () => [provider(1, {
      stream: async function* () {
        yield {
          type: "error",
          error: {
            provider: "test",
            protocol: "openai",
            code: "server_error",
            message: "primary unavailable",
            retryable: true,
          },
        };
      },
    })],
    routerProviderHealthFactory: () => {
      const generation = ++created;
      return {
        shouldSkip() {
          checks += 1;
          return false;
        },
        recordFailure() {},
        recordSuccess() {},
        dispose() {
          disposed.push(generation);
        },
      };
    },
  });
  try {
    const first = local.registry.resolve(root);
    for await (const _event of first.router.stream(request(), {
      sessionId: "router-health",
      turnId: "turn-1",
      projectPath: root,
      isMainAgent: true,
    })) {
      // The stream drives RouterRuntime's provider-health consumer.
    }
    assert.ok(checks > 0);
    local.registry.invalidate(root);
    const replacement = local.registry.resolve(root);
    assert.notEqual(replacement, first);
    assert.equal(created, 2);
  } finally {
    await local.dispose();
  }
  assert.deepEqual(disposed.sort((a, b) => a - b), [1, 2]);
});

test("project runtime shutdown clears shared Router state even when resource cleanup fails", async (t) => {
  const root = await fixture(t);
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testExecutionWorldBundleFactory: () => ({
      async dispose() {
        throw new Error("execution-world cleanup failed");
      },
    }) as unknown as ExecutionWorldBundle,
  });
  const registryWithState = local.registry as unknown as {
    sharedSessionState: RouterSessionStateProvider;
  };
  const state = registryWithState.sharedSessionState;
  state.set({
    sessionId: "failed-cleanup-state",
    isSubagent: false,
    stickyProvider: "test",
    stickyModel: "test",
    orchestrating: false,
    updatedAt: 0,
  });
  try {
    await assert.rejects(
      () => local.registry.disposeProjectRuntimes(),
      /execution-world cleanup failed/,
    );
    assert.equal(state.get("failed-cleanup-state", false), undefined);
  } finally {
    await local.dispose();
  }
});

test("local Gateway boot rolls back published resources when construction fails after watchers start", async (t) => {
  const root = await fixture(t);
  let disposed = 0;

  assert.throws(() => createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testModelInvocationProviderFactory: () => [
      provider(1, { onDispose: () => { disposed += 1; } }),
    ],
    __testFailAfterBootstrapWatchers: () => {
      throw new Error("bootstrap failure after watchers");
    },
  }), /bootstrap failure after watchers/);

  await waitFor(() => disposed === 1);
});

test("project runtime passes the configured sandbox mode into its execution-world bundle", async (t) => {
  const root = await fixture(t, CONFIG.replace(
    "  model: test/test\n",
    "  model: test/test\n  sandboxMode: workspace-write\n",
  ));
  const selectedModes: string[] = [];
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    executionWorldBundleFactory: ({ sandboxMode }) => {
      selectedModes.push(sandboxMode);
      return fakeExecutionWorldBundle(selectedModes.length, []);
    },
  });
  try {
    assert.deepEqual(selectedModes, ["workspace-write"]);
  } finally {
    await local.dispose();
  }
});

async function fixture(
  t: { after(callback: () => void | Promise<void>): void },
  config = CONFIG,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-provider-runtime-"));
  await writeFile(join(root, "pilotdeck.yaml"), config, "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function request(): CanonicalModelRequest {
  return {
    provider: "test",
    model: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
}

function provider(
  generation: number,
  options: {
    stream?: (request: CanonicalModelRequest) => AsyncIterable<CanonicalModelEvent>;
    onDispose?: () => void | Promise<void>;
  } = {},
): ModelInvocationProvider {
  return {
    providerId: "test",
    stream: options.stream ?? (async function* () {
      yield { type: "text_delta", text: `generation-${generation}` };
    }),
    async complete(_request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
      return {
        role: "assistant",
        content: [{ type: "text", text: `generation-${generation}` }],
        finishReason: "stop",
      };
    },
    getCapabilities() {
      return {
        supportsToolUse: true,
        supportsStreaming: true,
        supportsParallelToolCalls: false,
        supportsThinking: false,
        supportsJsonSchema: false,
        supportsSystemPrompt: true,
        supportsPromptCache: false,
        maxContextTokens: 8192,
        maxOutputTokens: 1024,
      };
    },
    getMultimodal() { return { input: ["text"] }; },
    getProviderProtocol() { return "openai" as const; },
    getProviderBaseUrl() { return `https://provider-${generation}.invalid`; },
    dispose: options.onDispose,
  };
}

function fakeMcpRuntime(lifecycle: string[]): McpRuntimePort {
  return {
    async start() {
      lifecycle.push("mcp.start");
      return [];
    },
    async stop() {
      lifecycle.push("mcp.stop");
    },
    async listAllTools() {
      return [];
    },
    getServerInfo() {
      return undefined;
    },
    async callTool() {
      throw new Error("No MCP tools are exposed by this lifecycle fake.");
    },
  };
}

function duplicateBuiltinTool(): PilotDeckToolDefinition {
  return { name: "read_file" } as PilotDeckToolDefinition;
}

function fakeExecutionWorldBundle(generation: number, disposed: number[]): ExecutionWorldBundle {
  return {
    dispose: async () => { disposed.push(generation); },
  } as ExecutionWorldBundle;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("Expected lifecycle cleanup to complete.");
}
