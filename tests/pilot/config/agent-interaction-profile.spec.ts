import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";
import {
  DEFAULT_SANDBOX_MODE,
  SANDBOX_MODES,
} from "../../../src/tool/execution-world/SandboxPort.js";

test("agent interaction profile selects headless composition", () => {
  const snapshot = loadFixture("  interactionProfile: headless");
  assert.equal(snapshot.config.agent.interactionProfile, "headless");
  assert.equal(snapshot.diagnostics.some((diagnostic) => diagnostic.path === "agent.interactionProfile"), false);
});

test("agent interaction profile defaults to interactive and fails soft for invalid values", () => {
  assert.equal(loadFixture().config.agent.interactionProfile, "interactive");

  const snapshot = loadFixture("  interactionProfile: unsupported");
  assert.equal(snapshot.config.agent.interactionProfile, "interactive");
  assert.equal(
    snapshot.diagnostics.some(
      (diagnostic) => diagnostic.code === "CONFIG_AGENT_INTERACTION_PROFILE_INVALID",
    ),
    true,
  );
});

test("agent sandbox mode defaults to danger-full-access and validates configured modes", () => {
  assert.equal(loadFixture().config.agent.sandboxMode, DEFAULT_SANDBOX_MODE);
  for (const sandboxMode of SANDBOX_MODES) {
    assert.equal(loadFixture(`  sandboxMode: ${sandboxMode}`).config.agent.sandboxMode, sandboxMode);
  }

  const snapshot = loadFixture("  sandboxMode: unsupported");
  assert.equal(snapshot.config.agent.sandboxMode, DEFAULT_SANDBOX_MODE);
  assert.equal(
    snapshot.diagnostics.some((diagnostic) => diagnostic.code === "CONFIG_AGENT_SANDBOX_MODE_INVALID"),
    true,
  );
});

function loadFixture(interactionLine = "") {
  const home = mkdtempSync(join(tmpdir(), "pilotdeck-interaction-profile-"));
  try {
    writeFileSync(join(home, "pilotdeck.yaml"), [
      "schemaVersion: 1",
      "agent:",
      "  model: test/test-model",
      interactionLine,
      "model:",
      "  providers:",
      "    test:",
      "      protocol: openai",
      "      url: https://example.invalid/v1",
      "      apiKey: test",
      "      models:",
      "        test-model: {}",
      "",
    ].filter(Boolean).join("\n"), "utf8");
    return loadPilotConfig({ env: { PILOT_HOME: home } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
