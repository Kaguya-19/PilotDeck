import assert from "node:assert/strict";
import test from "node:test";

import {
  FORK_BOILERPLATE_TAG,
  FORK_PLACEHOLDER_RESULT,
  buildChildMessage,
  buildForkedMessages,
} from "../../../src/agent/sub/buildForkedMessages.js";

test("buildForkedMessages forwards only the fork directive", () => {
  assert.deepEqual(buildForkedMessages("Inspect the changed files."), [
    { role: "user", content: [{ type: "text", text: "Inspect the changed files." }] },
  ]);
});

test("buildChildMessage trims the directive and uses the stable fork tag", () => {
  assert.equal(
    buildChildMessage("  Check the tests.  "),
    `<${FORK_BOILERPLATE_TAG}>\nDirective:\nCheck the tests.\n</${FORK_BOILERPLATE_TAG}>`,
  );
});

test("fork placeholder remains explicit and bounded for parent transcript projection", () => {
  assert.match(FORK_PLACEHOLDER_RESULT, /^<pilotdeck-fork-placeholder>.*<\/pilotdeck-fork-placeholder>$/u);
  assert.ok(FORK_PLACEHOLDER_RESULT.length < 256);
});
