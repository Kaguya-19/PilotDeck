import path from "node:path";
import type { PermissionResult, PermissionRule } from "../../../permission/index.js";
import type { PilotDeckToolRuntimeContext } from "../../protocol/types.js";
import { resolvePilotDeckWorkspacePath } from "./pathSafety.js";

export function checkFilesystemWritePermission(
  toolName: "write_file" | "edit_file",
  inputPath: string,
  context: PilotDeckToolRuntimeContext,
): PermissionResult {
  const workspaceResolved = resolvePilotDeckWorkspacePath(inputPath, context, { forWrite: true });
  if (workspaceResolved.ok) {
    return { type: "passthrough" };
  }

  const outsideResolved = resolvePilotDeckWorkspacePath(inputPath, context, {
    forWrite: true,
    allowOutsideWorkspace: true,
  });
  if (!outsideResolved.ok) {
    return {
      type: "deny",
      reason: { type: "safety", message: outsideResolved.error.message },
      message: outsideResolved.error.message,
    };
  }

  const rule = buildRecursiveFileWriteRule(toolName, outsideResolved.absolutePath);
  const reason = {
    type: "tool" as const,
    toolName,
    message: `${toolName} targets a path outside the workspace.`,
  };
  return {
    type: "ask",
    reason,
    request: {
      toolCallId: "",
      toolName,
      inputSummary: JSON.stringify({ file_path: outsideResolved.absolutePath }),
      reason,
      options: [
        { id: "allow_once", label: "Allow once" },
        { id: "allow_session", label: "Allow this folder for this session", rules: [rule] },
        { id: "deny", label: "Deny" },
        { id: "cancel", label: "Cancel" },
      ],
      metadata: {
        externalPath: outsideResolved.absolutePath,
        allowedDirectory: path.dirname(outsideResolved.absolutePath),
        pattern: rule.pattern,
      },
    },
  };
}

function buildRecursiveFileWriteRule(
  toolName: "write_file" | "edit_file",
  absolutePath: string,
): PermissionRule {
  return {
    source: "session",
    behavior: "allow",
    toolName,
    pattern: path.join(path.dirname(absolutePath), "*"),
  };
}
