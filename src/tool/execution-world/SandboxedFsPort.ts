import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  FsPort,
  FsWriteTextOptions,
  FsWriteTextResult,
} from "./FsPort.js";
import type { SandboxMode } from "./SandboxPort.js";

export type CreateNodeSandboxedFsPortOptions = {
  /** Native filesystem mechanics; the wrapper owns only mutation policy. */
  fs: FsPort;
  /** Deployment-selected policy mode for this execution world. */
  sandboxMode: SandboxMode;
};

/**
 * DSH-style filesystem sandbox provider.
 *
 * Reads deliberately pass through. For mutations, `read-only` denies every
 * write while `workspace-write` canonicalizes the target immediately before
 * the underlying provider sees it and requires it to remain inside the
 * consumer-authorized workspace or a platform temporary directory. This is a
 * trusted-process containment fence, not a kernel sandbox for untrusted code.
 */
export function createNodeSandboxedFsPort(options: CreateNodeSandboxedFsPortOptions): FsPort {
  const { fs, sandboxMode } = options;
  return {
    stat: (filePath, signal) => fs.stat(filePath, signal),
    readDirectory: (directory, signal) => fs.readDirectory(directory, signal),
    readFile: (filePath, readOptions) => fs.readFile(filePath, readOptions),
    readFileInRange: (filePath, startLine, limit, signal) => fs.readFileInRange(filePath, startLine, limit, signal),
    async writeText(filePath, content, writeOptions = {}): Promise<FsWriteTextResult> {
      const { workspaceRoot, ...delegateOptions } = writeOptions;
      const checkedPath = await checkedWritePath(filePath, workspaceRoot, sandboxMode);
      return fs.writeText(checkedPath, content, delegateOptions);
    },
  };
}

async function checkedWritePath(
  filePath: string,
  workspaceRoot: string | undefined,
  sandboxMode: SandboxMode,
): Promise<string> {
  if (sandboxMode === "danger-full-access") return filePath;
  if (sandboxMode === "read-only") {
    throw sandboxDenied(filePath, sandboxMode);
  }
  if (!workspaceRoot) {
    throw sandboxDenied(filePath, sandboxMode, "no workspace root was supplied");
  }

  const target = await canonicalizeTarget(filePath);
  const rootCandidates = process.platform === "win32"
    ? [workspaceRoot, tmpdir()]
    : [workspaceRoot, tmpdir(), "/tmp"];
  const writableRoots = await Promise.all(rootCandidates.map(canonicalizeRoot));
  if (!writableRoots.some((root) => isPathWithinRoot(target, root))) {
    throw sandboxDenied(filePath, sandboxMode);
  }
  return target;
}

async function canonicalizeRoot(value: string): Promise<string> {
  try {
    return await realpath(path.resolve(value));
  } catch {
    throw sandboxDenied(value, "workspace-write", "the writable root cannot be canonicalized");
  }
}

/** Resolve the deepest existing ancestor so a swapped symlink cannot redirect the next write. */
async function canonicalizeTarget(value: string): Promise<string> {
  let candidate = path.resolve(value);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const existing = await realpath(candidate);
      return path.join(existing, ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw sandboxDenied(value, "workspace-write", "no existing ancestor can be canonicalized");
      }
      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
    && "code" in error
    && ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}

function sandboxDenied(filePath: string, mode: Exclude<SandboxMode, "danger-full-access">, detail?: string): PilotDeckToolRuntimeError {
  return new PilotDeckToolRuntimeError(
    "permission_denied",
    `Writing to ${filePath} is denied by the ${mode} sandbox policy${detail ? `: ${detail}` : "."}`,
    { sandboxMode: mode, filePath },
  );
}
