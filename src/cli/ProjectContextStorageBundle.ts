import {
  createNodeInstructionStoragePort,
  createNodeToolResultSpillPort,
  type InstructionStoragePort,
  type ToolResultSpillPort,
} from "../context/index.js";

export type ProjectContextStorageBundleOptions = {
  /** Provider used by context instruction discovery for this project generation. */
  instructionStorage?: InstructionStoragePort;
  /** Provider used when context spills oversized tool results for this generation. */
  toolResultSpill?: ToolResultSpillPort;
};

export type ProjectContextStorageResources = {
  instructionStorage: InstructionStoragePort;
  toolResultSpill: ToolResultSpillPort;
};

/**
 * Project-generation composition for ContextRuntime storage capabilities.
 *
 * It owns only provider selection. InstructionDiscovery retains layer order
 * and prompt policy, ToolResultBudget retains replacement policy, and each
 * Agent session retains its context/turn state. The default remains native
 * Node I/O; explicit providers are useful for isolated deployments without
 * leaking concrete filesystem construction into session consumers.
 */
export class ProjectContextStorageBundle {
  constructor(private readonly options: ProjectContextStorageBundleOptions = {}) {}

  stage(): ProjectContextStorageResources {
    return {
      instructionStorage: this.options.instructionStorage ?? createNodeInstructionStoragePort(),
      toolResultSpill: this.options.toolResultSpill ?? createNodeToolResultSpillPort(),
    };
  }
}
