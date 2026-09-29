import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  SandboxUnavailableError,
  type SandboxPolicy,
  type SandboxPort,
} from "./SandboxPort.js";

/**
 * Native host adapter for per-process file-effect confinement.
 *
 * macOS uses Seatbelt through `sandbox-exec`; unsupported platforms fail
 * closed for constrained policies. `danger-full-access` intentionally does
 * not probe or wrap the command.
 */
export function createNodeSandboxPort(options: CreateNodeSandboxPortOptions = {}): SandboxPort {
  const platform = options.platform ?? process.platform;
  const seatbeltExecutable = options.seatbeltExecutable ?? "/usr/bin/sandbox-exec";
  let seatbeltAvailable: boolean | undefined;

  return {
    async prepare(request) {
      request.signal?.throwIfAborted();
      if (request.policy.mode === "danger-full-access") {
        return {
          executable: request.executable,
          args: [...request.args],
          cwd: request.cwd,
          env: request.env,
        };
      }
      if (platform !== "darwin" || !isSeatbeltAvailable()) {
        throw new SandboxUnavailableError(request.policy.mode);
      }
      return {
        executable: seatbeltExecutable,
        args: [...seatbeltProfileArgs(request.policy), "--", request.executable, ...request.args],
        cwd: request.cwd,
        env: request.env,
      };
    },
  };

  function isSeatbeltAvailable(): boolean {
    if (seatbeltAvailable !== undefined) return seatbeltAvailable;
    seatbeltAvailable = options.probeSeatbelt?.(seatbeltExecutable) ?? probeSeatbelt(seatbeltExecutable);
    return seatbeltAvailable;
  }
}

export type CreateNodeSandboxPortOptions = {
  /** Test-only platform override; normal composition uses the current host. */
  platform?: NodeJS.Platform;
  /** Test-only override for the macOS Seatbelt binary. */
  seatbeltExecutable?: string;
  /** Test-only bounded probe override. */
  probeSeatbelt?: (executable: string) => boolean;
};

/** DSH-equivalent macOS Seatbelt profile for one exact child argv. */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (literal ${sbplString("/dev/null")}))`,
  ];
  const writableRoots = getWritableRoots(policy);
  if (writableRoots.length > 0) {
    forms.push(`(allow file-write* ${writableRoots.map((root) => `(subpath ${sbplString(root)})`).join(" ")})`);
  }
  return ["-p", forms.join(" ")];
}

function probeSeatbelt(executable: string): boolean {
  if (!existsSync(executable)) return false;
  try {
    return spawnSync(
      executable,
      [...seatbeltProfileArgs({ mode: "read-only", workspaceRoot: "/" }), "--", "/usr/bin/true"],
      { stdio: "ignore", timeout: 5_000 },
    ).status === 0;
  } catch {
    return false;
  }
}

function getWritableRoots(policy: SandboxPolicy): string[] {
  if (policy.mode !== "workspace-write") return [];
  return [...new Set([
    policy.workspaceRoot,
    policy.executionRoot,
    "/tmp",
    tmpdir(),
  ].filter((root): root is string => !!root).map(canonicalPath))];
}

function canonicalPath(value: string): string {
  const absolute = resolve(value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function sbplString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
