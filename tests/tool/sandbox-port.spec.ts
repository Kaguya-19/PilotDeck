import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createNodeSandboxPort } from "../../src/tool/execution-world/NodeSandboxPort.js";
import {
  DEFAULT_SANDBOX_MODE,
  SANDBOX_MODES,
  SandboxUnavailableError,
  isSandboxMode,
  resolveSandboxMode,
} from "../../src/tool/execution-world/SandboxPort.js";

const baseRequest = {
  executable: process.execPath,
  args: ["-e", "process.exit(0)"],
  cwd: process.cwd(),
  env: process.env,
};

test("sandbox definition owns its vocabulary and profile fallback", () => {
  assert.deepEqual(SANDBOX_MODES, ["read-only", "workspace-write", "danger-full-access"]);
  assert.equal(DEFAULT_SANDBOX_MODE, "danger-full-access");
  assert.equal(isSandboxMode("workspace-write"), true);
  assert.equal(isSandboxMode("unsupported"), false);
  assert.equal(resolveSandboxMode("read-only"), "read-only");
  assert.equal(resolveSandboxMode("unsupported"), DEFAULT_SANDBOX_MODE);
});

test("node sandbox adapter permits only explicitly unconfined commands", async () => {
  const sandbox = createNodeSandboxPort();
  const command = await sandbox.prepare({
    ...baseRequest,
    policy: { mode: "danger-full-access", workspaceRoot: process.cwd() },
  });
  assert.deepEqual(command, baseRequest);
});

test("node sandbox adapter fails closed when a confined policy is requested", async () => {
  const sandbox = createNodeSandboxPort({ platform: "linux" });
  await assert.rejects(
    sandbox.prepare({
      ...baseRequest,
      policy: { mode: "read-only", workspaceRoot: process.cwd() },
    }),
    (error: unknown) => error instanceof SandboxUnavailableError && error.code === "sandbox_unavailable",
  );
});

test("macOS sandbox adapter wraps the exact argv in one DSH-equivalent Seatbelt profile", async () => {
  let probes = 0;
  const sandbox = createNodeSandboxPort({
    platform: "darwin",
    seatbeltExecutable: "/test/sandbox-exec",
    probeSeatbelt: () => {
      probes += 1;
      return true;
    },
  });

  const command = await sandbox.prepare({
    ...baseRequest,
    policy: { mode: "workspace-write", workspaceRoot: "/workspace", executionRoot: "/execution" },
  });
  const second = await sandbox.prepare({
    ...baseRequest,
    policy: { mode: "read-only", workspaceRoot: "/workspace" },
  });

  assert.equal(command.executable, "/test/sandbox-exec");
  const separator = command.args.indexOf("--");
  assert.equal(separator, 2);
  assert.deepEqual(command.args.slice(separator + 1), [baseRequest.executable, ...baseRequest.args]);
  assert.match(command.args[1] ?? "", /\(deny file-write\*\)/);
  assert.match(command.args[1] ?? "", /\(subpath "\/workspace"\)/);
  assert.match(command.args[1] ?? "", /\(subpath "\/execution"\)/);
  assert.equal(second.executable, "/test/sandbox-exec");
  assert.equal(probes, 1, "the native provider probes its selected backend once");
});

test("macOS Seatbelt denies read-only writes and permits workspace-write", { skip: process.platform !== "darwin" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-seatbelt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sandbox = createNodeSandboxPort();
  const script = "require('node:fs').writeFileSync(process.argv[1], 'sandboxed')";
  const readOnlyTarget = join(root, "read-only.txt");
  const readOnly = await sandbox.prepare({
    executable: process.execPath,
    args: ["-e", script, readOnlyTarget],
    cwd: root,
    env: process.env,
    policy: { mode: "read-only", workspaceRoot: root },
  });
  const denied = spawnSync(readOnly.executable, readOnly.args, {
    cwd: readOnly.cwd,
    env: readOnly.env,
    encoding: "utf8",
  });
  assert.notEqual(denied.status, 0);
  assert.equal(existsSync(readOnlyTarget), false);

  const writableTarget = join(root, "workspace-write.txt");
  const workspaceWrite = await sandbox.prepare({
    executable: process.execPath,
    args: ["-e", script, writableTarget],
    cwd: root,
    env: process.env,
    policy: { mode: "workspace-write", workspaceRoot: root },
  });
  const allowed = spawnSync(workspaceWrite.executable, workspaceWrite.args, {
    cwd: workspaceWrite.cwd,
    env: workspaceWrite.env,
    encoding: "utf8",
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(existsSync(writableTarget), true);
});
