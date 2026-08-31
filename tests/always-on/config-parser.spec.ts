import assert from "node:assert/strict";
import test from "node:test";
import { parseAlwaysOnConfig } from "../../src/always-on/config/parseAlwaysOnConfig.js";

test("infers legacy always-on switches from an enabled project", () => {
  const diagnostics = [];
  const config = parseAlwaysOnConfig(
    { projects: { "/tmp/project": { enabled: true } } },
    diagnostics,
  );

  assert.equal(config?.enabled, true);
  assert.equal(config?.trigger.enabled, true);
  assert.deepEqual(diagnostics, []);
});

test("respects explicitly disabled always-on switches", () => {
  const diagnostics = [];
  const config = parseAlwaysOnConfig(
    {
      enabled: false,
      trigger: { enabled: false },
      projects: { "/tmp/project": { enabled: true } },
    },
    diagnostics,
  );

  assert.equal(config?.enabled, false);
  assert.equal(config?.trigger.enabled, false);
});
