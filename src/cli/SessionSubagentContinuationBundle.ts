import type {
  AgentRuntimeConfig,
  AgentRuntimeDependencies,
  AgentLoopRuntimeFactory,
  AgentSessionConfigureContext,
  AgentSessionDisposer,
  CreateAgentSessionOptions,
  NativeSubagentContinuationHost,
  SubagentContinuationManager,
} from "../agent/index.js";
import { bindSubagentContinuationPort } from "../agent/index.js";
import type { AgentProjectSessionStorageOptions } from "../session/storage/ProjectSessionStorage.js";
import {
  createSendMessageTool,
  createSubagentContinuationTool,
} from "../tool/index.js";

export type SessionSubagentContinuationRuntime = {
  provider: string;
  host: Pick<NativeSubagentContinuationHost, "bindParent">;
  manager: Pick<SubagentContinuationManager, "start" | "followup" | "drainDescendants">;
};

export type SessionSubagentContinuationBundleOptions = {
  runtime: SessionSubagentContinuationRuntime;
};

export type AttachSessionSubagentContinuationOptions = Pick<
  AgentSessionConfigureContext,
  "handle" | "config" | "dependencies"
> & {
  projectStorage: Omit<AgentProjectSessionStorageOptions, "sessionId" | "now">;
  agentLoopFactory?: AgentLoopRuntimeFactory;
  testAgentLoopFactory?: CreateAgentSessionOptions["__agentLoopFactory"];
  collectFileArtifacts?: boolean;
};

/**
 * Attaches the continuable-subagent tool consumer to one exact AgentHandle.
 *
 * The manager owns child activation and teardown; the native host owns child
 * session construction. This bundle owns only parent binding and the two
 * session-local tool registrations, releasing them in reverse order.
 */
export class SessionSubagentContinuationBundle {
  constructor(private readonly options: SessionSubagentContinuationBundleOptions) {}

  attach(input: AttachSessionSubagentContinuationOptions): AgentSessionDisposer {
    const unbindParent = this.options.runtime.host.bindParent({
      parent: input.handle,
      config: input.config,
      dependencies: input.dependencies,
      projectStorage: input.projectStorage,
      agentLoopFactory: input.agentLoopFactory,
      testAgentLoopFactory: input.testAgentLoopFactory,
      collectFileArtifacts: input.collectFileArtifacts,
    });
    const removeDescendantDrain = input.handle.addDisposeStartListener((reason) =>
      this.options.runtime.manager.drainDescendants(input.handle, `parent_${reason}`));
    try {
      const port = bindSubagentContinuationPort({
        manager: this.options.runtime.manager,
        parent: input.handle,
        parentConfig: input.config,
        parentDependencies: input.dependencies,
        provider: this.options.runtime.provider,
      });
      const registrations = [
        input.dependencies.tools.registry.register(createSubagentContinuationTool(port)),
        input.dependencies.tools.registry.register(createSendMessageTool(port)),
      ];
      return () => {
        for (const registration of registrations.reverse()) registration.dispose();
        removeDescendantDrain();
        unbindParent();
      };
    } catch (error) {
      removeDescendantDrain();
      unbindParent();
      throw error;
    }
  }
}
