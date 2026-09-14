import assert from "node:assert/strict";
import test from "node:test";

import {
  InputProcessor,
  MAX_PLUGIN_COMMAND_BODY_CHARS,
  type ContributedCommand,
  type ExtensionResolver,
} from "../../src/context/index.js";

test("extension command input emits a delimited body and argument", () => {
  const processor = new InputProcessor({
    extension: resolver([{ name: "deploy", content: "Deploy the selected service safely." }]),
  });

  const result = processor.process({ type: "text", text: "/deploy api" });
  const text = textOf(result);

  assert.match(text, /<plugin-command name="\/deploy">/);
  assert.match(text, /<command-body>\n<<<PILOTDECK_COMMAND_BODY_0>>>\nDeploy the selected service safely\./);
  assert.match(text, /<command-argument>\n<<<PILOTDECK_COMMAND_ARGUMENT_0>>>\napi/);
  assert.match(text, /<\/plugin-command>$/);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.command, { name: "deploy", argument: "api", source: "extension" });
});

test("extension commands without a body retain the legacy model-visible fallback", () => {
  const processor = new InputProcessor({ extension: resolver([{ name: "deploy" }]) });

  const result = processor.process({ type: "text", text: "/deploy api" });

  assert.equal(textOf(result), "Run plugin command \"/deploy\" with argument: api");
  assert.deepEqual(result.diagnostics, []);
});

test("extension command body admission is bounded and reports truncation", () => {
  const body = "x".repeat(MAX_PLUGIN_COMMAND_BODY_CHARS + 64);
  const processor = new InputProcessor({ extension: resolver([{ name: "large", content: body }]) });

  const result = processor.process({ type: "text", text: "/large" });
  const text = textOf(result);

  assert.match(text, /\[truncated by PilotDeck command admission\]/);
  assert.ok(text.length < MAX_PLUGIN_COMMAND_BODY_CHARS + 500);
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["plugin_command_body_truncated"]);
});

function resolver(commands: ContributedCommand[]): ExtensionResolver {
  return {
    listCommands: () => commands.map((command) => ({ ...command })),
    listSkills: () => [],
    listMcpInstructions: () => [],
  };
}

function textOf(result: ReturnType<InputProcessor["process"]>): string {
  const block = result.messages[0]?.content[0];
  assert.equal(block?.type, "text");
  return block.text;
}
