import assert from "node:assert/strict";
import test from "node:test";

import { GatewayCommandCatalogBundle } from "../../src/cli/GatewayCommandCatalogBundle.js";
import type { CommandsListResult } from "../../src/gateway/protocol/types.js";

test("gateway command catalog bundle reads one frozen extension contribution lease and releases it after projection", async () => {
  const calls: string[] = [];
  const bundle = new GatewayCommandCatalogBundle({
    pilotHome: "/pilot-home",
    resolveProjectKey: async (projectKey) => {
      calls.push(`project:${projectKey}`);
      return "/resolved";
    },
    resolveRuntime: (projectKey) => {
      calls.push(`runtime:${projectKey}`);
      return {
        pluginRuntime: {
          refresh: async () => { calls.push("refresh"); },
          acquireCommandCatalog: () => ({
            contributions: { commands: [{ name: "/demo:deploy" }] },
            release: async () => { calls.push("release"); },
          }),
        },
      };
    },
    providers: {
      listCommands: async (input, pilotHome, commands) => {
        calls.push(`list:${input.projectKey}:${pilotHome}:${(commands ?? []).length}`);
        return { pinned: [], builtIn: [], custom: [] } as CommandsListResult;
      },
    },
  });

  const result = await bundle.commandsList({ projectKey: "alias", query: "deploy" });

  assert.deepEqual(result, { pinned: [], builtIn: [], custom: [] });
  assert.deepEqual(calls, [
    "project:alias",
    "runtime:/resolved",
    "refresh",
    "list:/resolved:/pilot-home:1",
    "release",
  ]);
});

test("gateway command catalog bundle releases the frozen lease when command projection fails", async () => {
  let released = 0;
  const bundle = new GatewayCommandCatalogBundle({
    pilotHome: "/pilot-home",
    resolveProjectKey: async () => "/resolved",
    resolveRuntime: () => ({
      pluginRuntime: {
        refresh: async () => undefined,
        acquireCommandCatalog: () => ({
          contributions: { commands: [] },
          release: async () => { released += 1; },
        }),
      },
    }),
    providers: {
      listCommands: async () => { throw new Error("projection failed"); },
    },
  });

  await assert.rejects(bundle.commandsList({ projectKey: "alias" }), /projection failed/);
  assert.equal(released, 1);
});
