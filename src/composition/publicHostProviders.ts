/**
 * Composition-root adapters for the public host ports.
 *
 * The composition root supplies the configured native or external binding.
 * This file owns no catalog, provider credentials, task state, or HTTP client;
 * it only preserves the public contract while handing control to that binding.
 */
import type {
  PublicFileParsingPort,
  PublicHostPorts,
  PublicHostTaskPort,
  PublicModelInvokerBinding,
  PublicSkillManagementPort,
  PublicToolDescriptor,
  PublicToolPort,
} from "./publicHostPorts.js";
import { createPublicModelInvokerClient } from "./publicHostPorts.js";

export type PublicHostProviderKind = "native" | "external";

export type PublicHostProviderBindings = {
  modelInvoker: PublicModelInvokerBinding;
  task: PublicHostTaskPort;
  fileParsing: PublicFileParsingPort;
  tools: PublicToolPort;
  skills: PublicSkillManagementPort;
};

export type PublicHostProvider = PublicHostPorts & {
  kind: PublicHostProviderKind;
};

function requireBinding<T>(name: string, value: T | undefined): T {
  if (value === undefined || value === null) {
    throw new Error(`PUBLIC_HOST_PROVIDER_UNAVAILABLE: ${name} binding is not configured.`);
  }
  return value;
}

function preserveDescriptors(port: PublicToolPort | PublicSkillManagementPort): PublicToolPort | PublicSkillManagementPort {
  return {
    ...port,
    list: async (options) => {
      const descriptors = await port.list(options);
      return descriptors.map((descriptor: PublicToolDescriptor) => ({
        ...descriptor,
        inputSchema: descriptor.inputSchema,
        outputSchema: descriptor.outputSchema,
        capabilities: descriptor.capabilities ? [...descriptor.capabilities] : undefined,
      }));
    },
  } as PublicToolPort | PublicSkillManagementPort;
}

/**
 * Build the host capability bundle selected by the active configuration.
 * Native and external bindings use the same contract; the mode is metadata
 * for audit/diagnostics and does not select a fallback implementation.
 */
export function createPublicHostProvider(
  kind: PublicHostProviderKind,
  bindings: PublicHostProviderBindings,
): PublicHostProvider {
  const modelBinding = requireBinding("modelInvoker", bindings.modelInvoker);
  const task = requireBinding("task", bindings.task);
  const fileParsing = requireBinding("fileParsing", bindings.fileParsing);
  const tools = requireBinding("tools", bindings.tools);
  const skills = requireBinding("skills", bindings.skills);
  return Object.freeze({
    kind,
    modelInvoker: createPublicModelInvokerClient(modelBinding),
    task,
    fileParsing,
    tools: preserveDescriptors(tools) as PublicToolPort,
    skills: preserveDescriptors(skills) as PublicSkillManagementPort,
  });
}

export const createNativePublicHostProvider = (bindings: PublicHostProviderBindings) =>
  createPublicHostProvider("native", bindings);

export const createExternalPublicHostProvider = (bindings: PublicHostProviderBindings) =>
  createPublicHostProvider("external", bindings);
