import type { AgentLoopSeedState } from "../../loop/AgentLoop.js";
import type {
  PilotDeckReadFileStateMap,
  PilotDeckWriteSnapshotMap,
} from "../../../tool/index.js";
import {
  parseAgentLoopSeedStateProjection,
  serializeAgentLoopSeedStateProjection,
} from "./seedStateProjection.js";

/**
 * Host-owned mutable file state for one sidecar turn.
 *
 * The sidecar receives a serialized seed at execute admission, but tools run
 * in the host and must share the same maps as native tool execution.
 */
export class HostToolCheckpoint {
  readonly readFileState: PilotDeckReadFileStateMap;
  readonly writeSnapshots: PilotDeckWriteSnapshotMap;
  private readonly allowedReadFiles = new Set<string>();

  constructor(seedState?: AgentLoopSeedState, allowedReadFiles?: Iterable<string>) {
    const seed = cloneSeedState(seedState);
    this.readFileState = seed?.readFileState ?? new Map();
    this.writeSnapshots = seed?.writeSnapshots ?? new Map();
    for (const filePath of seed?.allowedReadFiles ?? []) this.allowedReadFiles.add(filePath);
    for (const filePath of allowedReadFiles ?? []) this.allowedReadFiles.add(filePath);
  }

  toolContextState(): {
    readFileState: PilotDeckReadFileStateMap;
    writeSnapshots: PilotDeckWriteSnapshotMap;
    allowedReadFiles: string[];
  } {
    return {
      readFileState: this.readFileState,
      writeSnapshots: this.writeSnapshots,
      allowedReadFiles: [...this.allowedReadFiles],
    };
  }

  snapshot(): AgentLoopSeedState {
    return cloneSeedState({
      readFileState: this.readFileState,
      writeSnapshots: this.writeSnapshots,
      allowedReadFiles: [...this.allowedReadFiles],
    }) ?? {};
  }

  allowReadFiles(filePaths: Iterable<string> | undefined): void {
    for (const filePath of filePaths ?? []) this.allowedReadFiles.add(filePath);
  }
}

function cloneSeedState(seedState: AgentLoopSeedState | undefined): AgentLoopSeedState | undefined {
  return seedState
    ? parseAgentLoopSeedStateProjection(serializeAgentLoopSeedStateProjection(seedState))
    : undefined;
}
