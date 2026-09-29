import assert from "node:assert/strict";
import test from "node:test";

import {
  PromptContributionRegistry,
  createToolRegistryPromptSchemaSource,
  renderPromptContributionSections,
  renderPromptRuntimeContextSections,
  type PromptContributionContext,
} from "../../src/context/index.js";
import { ToolRegistry, type PilotDeckToolDefinition } from "../../src/tool/index.js";

const context: PromptContributionContext = {
  sessionId: "session-1",
  turnId: "turn-1",
  cwd: "/workspace",
  provider: "provider",
  model: "model",
  permissionMode: "default",
  additionalWorkingDirectories: [],
};

test("prompt contributions assemble in deterministic order with ToolRegistry as the schema source", async () => {
  const registry = new PromptContributionRegistry({ name: "root" });
  registry.registerSection({ name: "zeta", order: 10, text: "Z" });
  registry.registerSection({ name: "alpha", order: 10, text: "A" });
  registry.registerSection({ name: "identity", order: -100, text: "Identity" });
  registry.registerRuntimeContext({ name: "cwd", order: 20, text: ({ cwd }) => `cwd: ${cwd}` });
  registry.registerVariable("model", ({ model }) => model);

  const tools = new ToolRegistry();
  tools.register(tool("zeta_tool"));
  tools.register(tool("alpha_tool"));

  const snapshot = await registry.snapshot(context, {
    toolSchemas: createToolRegistryPromptSchemaSource(tools),
  });

  assert.deepEqual(snapshot.sections, [
    { name: "identity", order: -100, text: "Identity", complete: false },
    { name: "alpha", order: 10, text: "A", complete: false },
    { name: "zeta", order: 10, text: "Z", complete: false },
  ]);
  assert.deepEqual(snapshot.runtimeContexts, [
    { name: "cwd", order: 20, text: "cwd: /workspace" },
  ]);
  assert.deepEqual(snapshot.variables, { model: "model" });
  assert.deepEqual(snapshot.tools.map((entry) => entry.name), ["alpha_tool", "zeta_tool"]);
});

test("child registries shadow parent contributions and reveal them after exact-handle disposal", async () => {
  const parent = new PromptContributionRegistry({ name: "parent" });
  const parentPersona = parent.registerSection({ name: "persona", order: 0, text: "parent" });
  parent.registerVariable("mode", () => "parent");
  const child = parent.createChild({ name: "child" });
  const childPersona = child.registerSection({ name: "persona", order: 0, text: "child" });
  const childMode = child.registerVariable("mode", () => "child");

  assert.deepEqual((await child.snapshot(context)).sections.map((entry) => entry.text), ["child"]);
  assert.deepEqual((await child.snapshot(context)).variables, { mode: "child" });

  childPersona.dispose();
  childPersona.dispose();
  childMode.dispose();
  assert.equal(childPersona.active, false);
  assert.equal(childMode.active, false);
  assert.deepEqual((await child.snapshot(context)).sections.map((entry) => entry.text), ["parent"]);
  assert.deepEqual((await child.snapshot(context)).variables, { mode: "parent" });
  assert.equal(parentPersona.active, true);

  child.dispose();
  assert.throws(() => child.registerSection({ name: "late", order: 0, text: "late" }), /disposed/);
  await assert.rejects(child.snapshot(context), /disposed/);
  parent.dispose();
});

test("a snapshot keeps the captured generation while later registrations affect only future snapshots", async () => {
  const registry = new PromptContributionRegistry({ name: "snapshot" });
  const mutableContext = {
    ...context,
    cwd: "/captured",
    additionalWorkingDirectories: ["/first"],
  };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const old = registry.registerSection({
    name: "persona",
    order: 0,
    text: async ({ cwd, additionalWorkingDirectories }) => {
      await blocked;
      return `${cwd}:${additionalWorkingDirectories.join(",")}`;
    },
  });

  const inFlight = registry.snapshot(mutableContext);
  old.dispose();
  const replacement = registry.registerSection({ name: "persona", order: 0, text: "new" });
  mutableContext.cwd = "/mutated";
  mutableContext.additionalWorkingDirectories.push("/second");
  release();

  const oldSnapshot = await inFlight;
  const newSnapshot = await registry.snapshot(context);
  assert.deepEqual(oldSnapshot.sections.map((entry) => entry.text), ["/captured:/first"]);
  assert.deepEqual(newSnapshot.sections.map((entry) => entry.text), ["new"]);
  assert.ok(newSnapshot.generation > oldSnapshot.generation);

  old.dispose();
  assert.equal(replacement.active, true);
  assert.deepEqual((await registry.snapshot(context)).sections.map((entry) => entry.text), ["new"]);
  registry.dispose();
});

test("parent disposal revokes child registrations without invalidating an in-flight snapshot", async () => {
  const parent = new PromptContributionRegistry({ name: "parent" });
  const child = parent.createChild({ name: "child" });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registration = child.registerSection({
    name: "slow",
    order: 0,
    text: async () => {
      await blocked;
      return "captured";
    },
  });

  const inFlight = child.snapshot(context);
  parent.dispose();
  assert.equal(parent.state, "disposed");
  assert.equal(child.state, "disposed");
  assert.equal(registration.active, false);

  release();
  assert.deepEqual((await inFlight).sections.map((entry) => entry.text), ["captured"]);
  await assert.rejects(child.snapshot(context), /disposed/);
});

test("ToolRegistry changes are copied into the next prompt snapshot without mutating older snapshots", async () => {
  const registry = new PromptContributionRegistry();
  const tools = new ToolRegistry();
  const source = createToolRegistryPromptSchemaSource(tools);
  tools.register(tool("first"));

  const first = await registry.snapshot(context, { toolSchemas: source });
  tools.register(tool("second"));
  const second = await registry.snapshot(context, { toolSchemas: source });

  assert.deepEqual(first.tools.map((entry) => entry.name), ["first"]);
  assert.deepEqual(second.tools.map((entry) => entry.name), ["first", "second"]);
  assert.notEqual(first.tools[0], second.tools[0]);
  registry.dispose();
});

test("prompt contribution validation rejects ambiguous registrations", async () => {
  const registry = new PromptContributionRegistry();
  registry.registerSection({ name: "persona", order: 0, text: "one", complete: true });
  assert.throws(
    () => registry.registerSection({ name: "persona", order: 1, text: "duplicate" }),
    /already registered/,
  );
  assert.throws(() => registry.registerVariable("Bad-Name", () => "x"), /invalid prompt variable/);
  assert.throws(
    () => registry.registerRuntimeContext({ name: "bad-order", order: Number.NaN, text: "x" }),
    /finite number/,
  );

  registry.registerSection({ name: "override", order: 1, text: "two", complete: true });
  await assert.rejects(registry.snapshot(context), /complete prompt section/);
  registry.dispose();
});

test("prompt rendering resolves defaults and scoped variables with strict failures", async () => {
  const registry = new PromptContributionRegistry();
  registry.registerSection({
    name: "identity",
    order: 0,
    text: "{{model}} in {{cwd}}",
  });
  registry.registerRuntimeContext({
    name: "mode",
    order: 0,
    text: "mode={{permission_mode}}",
  });
  registry.registerVariable("model", () => "scoped-model");
  const snapshot = await registry.snapshot(context, {
    variables: {
      cwd: context.cwd,
      model: "default-model",
      permission_mode: context.permissionMode,
    },
  });

  assert.deepEqual(renderPromptContributionSections(snapshot), ["scoped-model in /workspace"]);
  assert.deepEqual(renderPromptRuntimeContextSections(snapshot), [
    { name: "mode", order: 0, text: "mode=default" },
  ]);

  const unknown = new PromptContributionRegistry();
  unknown.registerSection({ name: "unknown", order: 0, text: "{{missing}}" });
  const unknownSnapshot = await unknown.snapshot(context);
  assert.throws(
    () => renderPromptContributionSections(unknownSnapshot),
    /unknown prompt variable/,
  );

  const undefinedValue = new PromptContributionRegistry();
  undefinedValue.registerVariable("missing", () => undefined);
  undefinedValue.registerSection({ name: "undefined", order: 0, text: "{{missing}}" });
  const undefinedSnapshot = await undefinedValue.snapshot(context);
  assert.throws(() => renderPromptContributionSections(undefinedSnapshot), /has no value/);

  for (const malformed of ["{{ bad }}", "{{a{{b}}"] as const) {
    const malformedRegistry = new PromptContributionRegistry();
    malformedRegistry.registerSection({ name: "malformed", order: 0, text: malformed });
    const malformedSnapshot = await malformedRegistry.snapshot(context);
    assert.throws(() => renderPromptContributionSections(malformedSnapshot), /malformed prompt variable/);
  }

  const literal = new PromptContributionRegistry();
  literal.registerSection({ name: "literal", order: 0, text: "Use {{ in prose without a closing reference." });
  assert.deepEqual(renderPromptContributionSections(await literal.snapshot(context)), [
    "Use {{ in prose without a closing reference.",
  ]);
});

test("a complete section replaces every non-complete contribution", async () => {
  const registry = new PromptContributionRegistry();
  registry.registerSection({ name: "before", order: -1, text: "before" });
  registry.registerSection({ name: "complete", order: 0, text: "complete", complete: true });
  registry.registerSection({ name: "after", order: 1, text: "after" });

  assert.deepEqual(renderPromptContributionSections(await registry.snapshot(context)), ["complete"]);
});

function tool(name: string): PilotDeckToolDefinition {
  return {
    name,
    description: `${name} description`,
    kind: "custom",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}
