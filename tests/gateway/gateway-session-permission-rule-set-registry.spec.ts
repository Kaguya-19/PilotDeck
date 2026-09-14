import assert from "node:assert/strict";
import test from "node:test";

import type { SessionRouter } from "../../src/gateway/SessionRouter.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import {
  GatewaySessionPermissionRuleSetRegistry,
} from "../../src/gateway/permission/GatewaySessionPermissionRuleSetRegistry.js";

test("permission rule-set retains share an exact fallback entry through dirty recreation", () => {
  const registry = new GatewaySessionPermissionRuleSetRegistry();
  const previous = registry.acquire("session-a");
  const replacement = registry.acquire("session-a");

  assert.equal(registry.size, 1);
  assert.equal(previous.rules, replacement.rules);
  previous.rules.allow.push({ source: "session", behavior: "allow", toolName: "write_file" });
  assert.deepEqual(replacement.rules.allow, [
    { source: "session", behavior: "allow", toolName: "write_file" },
  ]);

  previous.release();
  assert.equal(registry.size, 1, "disposing the old handle must retain replacement state");
  replacement.release();
  assert.equal(registry.size, 0, "the last live handle releases fallback session state");
});

test("configured partial rules obtain stable missing arrays and are removed after their final release", () => {
  const registry = new GatewaySessionPermissionRuleSetRegistry();
  const configuredAllow = [{ source: "project" as const, behavior: "allow" as const, toolName: "read_file" }];
  const first = registry.acquire("session-b", { allow: configuredAllow });
  const replacement = registry.acquire("session-b", { allow: configuredAllow });

  assert.equal(first.rules.allow, configuredAllow);
  assert.equal(first.rules.deny, replacement.rules.deny);
  first.rules.deny.push({ source: "session", behavior: "deny", toolName: "bash" });
  assert.deepEqual(replacement.rules.deny, [
    { source: "session", behavior: "deny", toolName: "bash" },
  ]);

  first.release();
  replacement.release();
  const fresh = registry.acquire("session-b", { allow: configuredAllow });
  assert.deepEqual(fresh.rules.deny, [], "a later session must not inherit released fallback rules");
  fresh.release();
});

test("a stale idempotent release cannot remove a later session entry", () => {
  const registry = new GatewaySessionPermissionRuleSetRegistry();
  const first = registry.acquire("session-c");
  first.release();
  const later = registry.acquire("session-c");

  first.release();
  assert.equal(registry.size, 1);
  later.release();
  assert.equal(registry.size, 0);
});

test("Gateway grants pin a rule set before session construction and close releases it", () => {
  const registry = new GatewaySessionPermissionRuleSetRegistry();
  assert.equal(
    registry.grant("session-d", { source: "session", behavior: "allow", toolName: "write_file" }),
    true,
  );
  assert.equal(registry.size, 1);

  const handle = registry.acquire("session-d", {
    deny: [{ source: "project", behavior: "deny", toolName: "bash" }],
  });
  assert.deepEqual(handle.rules.allow, [
    { source: "session", behavior: "allow", toolName: "write_file" },
  ]);
  assert.deepEqual(handle.rules.deny, [
    { source: "project", behavior: "deny", toolName: "bash" },
  ]);

  handle.release();
  assert.equal(registry.size, 1, "the pre-session grant remains available until Gateway closes the session");
  registry.closeSession("session-d");
  assert.equal(registry.size, 0);
});

test("InProcessGateway consumes a permission-grant provider without owning session grants", async () => {
  const calls: string[] = [];
  const gateway = new InProcessGateway({
    close: async () => { calls.push("router.close"); },
  } as unknown as SessionRouter, {
    permissionGrants: {
      grant: (sessionKey, rule) => {
        calls.push(`grant:${sessionKey}:${rule.toolName}`);
        return true;
      },
      allowRules: () => [],
      closeSession: (sessionKey) => { calls.push(`close:${sessionKey}`); },
      dispose: () => { calls.push("dispose"); },
    },
  });

  assert.deepEqual(
    await gateway.grantSessionPermission({ sessionKey: "session-e", entry: "Write" }),
    { granted: true, entry: "Write" },
  );
  await gateway.closeSession({ sessionKey: "session-e" });
  gateway.dispose();

  assert.deepEqual(calls, [
    "grant:session-e:write_file",
    "router.close",
    "close:session-e",
    "dispose",
  ]);
});
