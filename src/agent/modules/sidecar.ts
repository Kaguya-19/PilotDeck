export { createHostContextRuntime as createSidecarContextRuntime } from "./context/hostContextRuntime.js";
export {
  createSidecarPorts,
  type SidecarModuleBinding,
  type SidecarModuleCall,
  type SidecarModuleCallClient,
} from "./transport/sidecarPorts.js";
export {
  AgentLoopSidecarServer,
  moduleOutcomeFromAgentResult,
  type AgentLoopSidecarOptions,
  type SidecarExecution,
  type SidecarExecutionFactory,
} from "./transport/agentLoopSidecarServer.js";
