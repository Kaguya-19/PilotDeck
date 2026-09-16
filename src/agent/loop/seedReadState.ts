import { stat } from "node:fs/promises";

import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type {
  PilotDeckReadFileStateMap,
  PilotDeckToolRuntimeContext,
  PilotDeckWriteSnapshotMap,
} from "../../tool/index.js";
import { resolvePilotDeckWorkspacePath } from "../../tool/builtin/filesystem/pathSafety.js";
import { readTextFile } from "../../tool/builtin/filesystem/readTextFile.js";
import { recordWriteSnapshot } from "../../tool/builtin/filesystem/writeSnapshots.js";
import {
  hasBinaryExtension,
  isBlockedDevicePath,
  isImagePath,
  isNotebookPath,
  isPdfPath,
} from "../../tool/builtin/filesystem/fileTypeSafety.js";
import { PilotDeckToolRuntimeError } from "../../tool/protocol/errors.js";

export type MutableAgentFileState = {
  readFileState: PilotDeckReadFileStateMap;
  writeSnapshots: PilotDeckWriteSnapshotMap;
  allowedReadFiles: Set<string>;
};

export async function seedAgentReadState(
  config: AgentRuntimeConfig,
  state: MutableAgentFileState,
  filePath: string,
  mtimeMs: number,
): Promise<{ applied: boolean }> {
  const pathContext = {
    cwd: config.cwd,
    permissionMode: config.permissionMode,
    permissionContext: config.permissionContext,
    allowedReadFiles: [...state.allowedReadFiles],
  } as PilotDeckToolRuntimeContext;
  const resolved = resolvePilotDeckWorkspacePath(filePath, pathContext, {
    mustExist: true,
    allowRegisteredReadFiles: true,
  });
  if (!resolved.ok) {
    throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
  }
  if (
    isBlockedDevicePath(resolved.absolutePath)
    || hasBinaryExtension(resolved.absolutePath)
    || isImagePath(resolved.absolutePath)
    || isPdfPath(resolved.absolutePath)
    || isNotebookPath(resolved.absolutePath)
  ) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "seedReadState supports only text files previously read by read_file.",
    );
  }

  const expectedMtimeMs = Math.floor(mtimeMs);
  const beforeRead = await stat(resolved.absolutePath);
  if (!beforeRead.isFile()) {
    throw new PilotDeckToolRuntimeError("file_conflict", `${resolved.absolutePath} is not a regular file.`);
  }
  if (Math.floor(beforeRead.mtimeMs) !== expectedMtimeMs) return { applied: false };

  const content = await readTextFile(resolved.absolutePath);
  const afterRead = await stat(resolved.absolutePath);
  if (!afterRead.isFile()) {
    throw new PilotDeckToolRuntimeError("file_conflict", `${resolved.absolutePath} is not a regular file.`);
  }
  if (Math.floor(afterRead.mtimeMs) !== expectedMtimeMs) return { applied: false };

  state.allowedReadFiles.add(resolved.absolutePath);
  state.readFileState.set(`${resolved.absolutePath}::text::1::all::`, {
    mtimeMs: expectedMtimeMs,
    kind: "text",
  });
  recordWriteSnapshot(
    { writeSnapshots: state.writeSnapshots } as PilotDeckToolRuntimeContext,
    resolved.absolutePath,
    content,
    expectedMtimeMs,
  );
  return { applied: true };
}
