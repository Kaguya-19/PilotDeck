import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyBashPermission,
  isReadOnlyShellCommand,
} from "../../../../src/tool/builtin/bash/permissions.js";

test("git read-only detection skips global options before the subcommand", () => {
  assert.equal(isReadOnlyShellCommand("git -C C:\\repo status"), true);
  assert.equal(isReadOnlyShellCommand("git -C /tmp/repo diff"), true);
  assert.equal(
    isReadOnlyShellCommand("git --git-dir=C:\\repo\\.git --work-tree C:\\repo log"),
    true,
  );
  assert.equal(
    isReadOnlyShellCommand("git --git-dir C:\\repo\\.git --work-tree C:\\repo show"),
    true,
  );
  assert.equal(isReadOnlyShellCommand("git -C /tmp/repo diff --output patch.txt"), false);
});

test("Windows read-only commands are passed through", () => {
  assert.equal(isReadOnlyShellCommand("findstr foo file.txt"), true);
  assert.equal(isReadOnlyShellCommand("Get-Command git"), true);
  assert.equal(isReadOnlyShellCommand("Resolve-Path ."), true);
});

test("simple PowerShell read-only commands are passed through", () => {
  assert.equal(
    isReadOnlyShellCommand("powershell -NoProfile -Command Get-ChildItem ."),
    true,
  );
  assert.equal(
    isReadOnlyShellCommand('pwsh -NoLogo -NoProfile -Command "Resolve-Path ."'),
    true,
  );
});

test("mutating Windows commands are not classified as read-only", () => {
  assert.equal(
    classifyBashPermission("powershell -NoProfile -Command Remove-Item -Recurse -Force .").type,
    "deny",
  );
  assert.equal(
    classifyBashPermission("powershell -NoProfile -Command Set-ExecutionPolicy Bypass").type,
    "deny",
  );
  assert.equal(isReadOnlyShellCommand('powershell -NoProfile -Command "Get-ChildItem . | Select-Object Name"'), false);
  assert.equal(classifyBashPermission("echo x > file.txt").type, "ask");
});
