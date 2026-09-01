import test from "node:test";
import assert from "node:assert/strict";
import { resolveDefaultCommandShell } from "../../src/runtime/commandShell.js";

test("command shell prefers /bin/bash on Unix", () => {
  const shell = resolveDefaultCommandShell({
    platform: "linux",
    env: { PATH: "/custom/bin" },
    existsSync: (path) => path === "/bin/bash",
  });

  assert.equal(shell.shell, "/bin/bash");
  assert.equal(shell.kind, "bash");
  assert.equal(shell.windowsVerbatimArguments, false);
  assert.deepEqual(shell.args("printf ok"), ["-c", "printf ok"]);
});

test("command shell uses PATH bash before falling back to sh", () => {
  const pathBash = resolveDefaultCommandShell({
    platform: "linux",
    env: { PATH: "/custom/bin" },
    existsSync: (path) => path === "/custom/bin/bash",
  });
  assert.equal(pathBash.shell, "/custom/bin/bash");

  const fallback = resolveDefaultCommandShell({
    platform: "linux",
    env: { PATH: "/custom/bin" },
    existsSync: () => false,
  });
  assert.equal(fallback.shell, "/bin/sh");
  assert.equal(fallback.kind, "sh");
});

test("command shell prefers configured and standard Git Bash on Windows", () => {
  const configured = resolveDefaultCommandShell({
    platform: "win32",
    env: { PILOTDECK_GIT_BASH_PATH: "D:\\Git\\bin\\bash.exe" },
    existsSync: (path) => path === "D:\\Git\\bin\\bash.exe",
    commandAvailable: () => true,
  });
  assert.equal(configured.shell, "D:\\Git\\bin\\bash.exe");
  assert.equal(configured.kind, "bash");
  assert.deepEqual(configured.args("echo ok"), ["-c", "echo ok"]);

  const standard = resolveDefaultCommandShell({
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    existsSync: (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe",
    commandAvailable: () => true,
  });
  assert.equal(standard.shell, "C:\\Program Files\\Git\\bin\\bash.exe");
});

test("command shell falls back to cmd then PowerShell 7 on Windows", () => {
  const cmd = resolveDefaultCommandShell({
    platform: "win32",
    env: { PATH: "C:\\Windows\\System32" },
    existsSync: () => false,
    commandAvailable: (command) => command === "cmd.exe",
  });
  assert.equal(cmd.shell, "cmd.exe");
  assert.equal(cmd.kind, "cmd");
  assert.equal(cmd.windowsVerbatimArguments, true);
  assert.deepEqual(cmd.args("echo ok"), ["/d", "/s", "/c", "echo ok"]);

  const pwsh = resolveDefaultCommandShell({
    platform: "win32",
    env: { PATH: "C:\\Program Files\\PowerShell\\7" },
    existsSync: () => false,
    commandAvailable: (command) => command === "pwsh.exe",
  });
  assert.equal(pwsh.shell, "pwsh.exe");
  assert.equal(pwsh.kind, "pwsh");
  assert.equal(pwsh.windowsVerbatimArguments, false);
  assert.deepEqual(pwsh.args("Write-Output ok"), ["-NoLogo", "-NoProfile", "-Command", "Write-Output ok"]);
});

test("command shell never falls back to Windows PowerShell 5", () => {
  assert.throws(() => resolveDefaultCommandShell({
    platform: "win32",
    env: { PATH: "C:\\Windows\\System32" },
    existsSync: () => false,
    commandAvailable: () => false,
  }), /No supported PilotDeck command shell/);
});

test("command shell supports an explicit generic shell path", () => {
  const shell = resolveDefaultCommandShell({
    platform: "linux",
    env: { PILOTDECK_SHELL_PATH: "/opt/custom-shell" },
    commandAvailable: (command) => command === "/opt/custom-shell",
  });
  assert.equal(shell.shell, "/opt/custom-shell");
  assert.equal(shell.kind, "custom");
  assert.deepEqual(shell.args("echo ok"), ["-c", "echo ok"]);
});
