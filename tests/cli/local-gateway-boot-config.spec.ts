import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { readPositiveIntegerEnv, resolveLocalGatewayBootConfig } from "../../src/cli/LocalGatewayBootConfig.js";

test("local Gateway boot config preserves option, environment, and default precedence", () => {
  const config = resolveLocalGatewayBootConfig({
    env: {
      PILOT_HOME: "/env-home",
      PILOTDECK_BUNDLED_SKILLS_DIR: "/env-skills",
      PILOTDECK_PERMISSION_TIMEOUT_MS: "111",
      PILOTDECK_ELICITATION_TIMEOUT_MS: "222",
    },
    projectRoot: "project",
    pilotHome: "/option-home",
    builtinSkillsRoot: "/option-skills",
    fallbackProjectRoot: "fallback",
    permissionMode: "bypassPermissions",
    permissionTimeoutMs: 333,
    elicitationTimeoutMs: 444,
  }, "/workspace");

  assert.deepEqual(config, {
    env: {
      PILOT_HOME: "/option-home",
      PILOTDECK_BUNDLED_SKILLS_DIR: "/env-skills",
      PILOTDECK_PERMISSION_TIMEOUT_MS: "111",
      PILOTDECK_ELICITATION_TIMEOUT_MS: "222",
    },
    projectRoot: resolve("project"),
    pilotHome: "/option-home",
    builtinSkillsRoot: "/option-skills",
    fallbackProjectRoot: "fallback",
    permissionMode: "bypassPermissions",
    permissionTimeoutMs: 333,
    elicitationTimeoutMs: 444,
  });
  assert.equal(Object.isFrozen(config), true);
});

test("local Gateway boot config uses env timeouts and ignores invalid positive-integer values", () => {
  const fromEnv = resolveLocalGatewayBootConfig({
    env: {
      PILOT_HOME: "/env-home",
      PILOTDECK_BUNDLED_SKILLS_DIR: "/env-skills",
      PILOTDECK_PERMISSION_TIMEOUT_MS: "31.8",
      PILOTDECK_ELICITATION_TIMEOUT_MS: " 42 ",
    },
  }, "/workspace");
  assert.equal(fromEnv.permissionTimeoutMs, 31);
  assert.equal(fromEnv.elicitationTimeoutMs, 42);
  assert.equal(fromEnv.pilotHome, "/env-home");
  assert.equal(fromEnv.builtinSkillsRoot, "/env-skills");
  assert.equal(fromEnv.fallbackProjectRoot, fromEnv.projectRoot);

  const defaults = resolveLocalGatewayBootConfig({
    env: {
      PILOT_HOME: "/env-home",
      PILOTDECK_BUNDLED_SKILLS_DIR: "/env-skills",
      PILOTDECK_PERMISSION_TIMEOUT_MS: "0",
      PILOTDECK_ELICITATION_TIMEOUT_MS: "invalid",
    },
  }, "/workspace");
  assert.equal(defaults.permissionTimeoutMs, 120_000);
  assert.equal(defaults.elicitationTimeoutMs, 120_000);
  assert.equal(defaults.permissionMode, "default");
  assert.equal(readPositiveIntegerEnv(" 2.9 "), 2);
  assert.equal(readPositiveIntegerEnv("-1"), undefined);
});
