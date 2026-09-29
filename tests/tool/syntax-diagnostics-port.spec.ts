import assert from "node:assert/strict";
import test from "node:test";

import {
  collectPythonSyntaxDiagnostics,
  formatSyntaxDiagnostics,
} from "../../src/tool/builtin/filesystem/syntaxDiagnostics.js";
import type { SubprocessPort } from "../../src/tool/execution-world/SubprocessPort.js";

test("syntax diagnostics consumes the injected direct-executable provider", async () => {
  const requests: Array<Parameters<NonNullable<SubprocessPort["executeFile"]>>[0]> = [];
  const subprocess: Pick<SubprocessPort, "executeFile"> = {
    async executeFile(request) {
      requests.push(request);
      return {
        exitCode: 1,
        stdout: JSON.stringify({ line: 4, column: 3, message: "invalid syntax" }),
        stderr: "",
        timedOut: false,
        durationMs: 2,
      };
    },
  };

  const diagnostics = await collectPythonSyntaxDiagnostics("script.py", "bad(", { subprocess });
  assert.deepEqual(diagnostics, [{ line: 4, column: 3, message: "invalid syntax" }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.executable, "python3");
  assert.deepEqual(requests[0]?.args.slice(0, 1), ["-c"]);
  assert.equal(requests[0]?.args.at(-1), "script.py");
  assert.equal(requests[0]?.stdin, "bad(");
  assert.equal(requests[0]?.timeoutMs, 2_000);
});

test("native direct-executable provider accepts checker stdin", async () => {
  const result = await formatSyntaxDiagnostics("script.py", "def broken(:\n  pass\n");
  assert.match(result ?? "", /Syntax issues detected/);
});
