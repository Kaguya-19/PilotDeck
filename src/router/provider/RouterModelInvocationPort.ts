import type { ModelRuntime } from "../../model/index.js";
import { type ModelInvocationProviderRegistry } from "../../model/index.js";

/** DSH-style invocation Definition consumed by RouterRuntime. */
export type RouterModelInvocationPort = Pick<
  ModelRuntime,
  "stream" | "getCapabilities" | "getMultimodal" | "getProviderProtocol" | "getProviderBaseUrl"
> & {
  /** Present when this invocation provider can also serve the token-saver judge. */
  complete?: ModelRuntime["complete"];
  /** Current route generation when the provider has replacement lifecycle. */
  getProviderGeneration?(providerId: string): number | undefined;
  dispose?(): void | Promise<void>;
};

/** Narrow judge consumer contract; the Router never needs a full ModelRuntime. */
export type RouterJudgeInvocationPort = Pick<ModelRuntime, "complete">;

/** Native provider adapter around the existing ModelRuntime implementation. */
export function createNativeRouterModelInvocationPort(
  runtime: ModelRuntime,
): RouterModelInvocationPort {
  return {
    stream: (request, options) => runtime.stream(request, options),
    complete: (request, options) => runtime.complete(request, options),
    getCapabilities: (providerId, modelId) => runtime.getCapabilities(providerId, modelId),
    getMultimodal: (providerId, modelId) => runtime.getMultimodal(providerId, modelId),
    getProviderProtocol: (providerId) => runtime.getProviderProtocol(providerId),
    getProviderBaseUrl: (providerId) => runtime.getProviderBaseUrl(providerId),
  };
}

/**
 * Consumer adapter for the route-provider registry. It deliberately does not
 * expose `dispose`: application composition owns registry teardown, while a
 * Router shutdown only releases Router-owned policies.
 */
export function createRegistryRouterModelInvocationPort(
  registry: ModelInvocationProviderRegistry,
): RouterModelInvocationPort {
  return {
    stream: (request, options) => registry.stream(request, options),
    complete: (request, options) => registry.complete(request, options),
    getCapabilities: (providerId, modelId) => registry.getCapabilities(providerId, modelId),
    getMultimodal: (providerId, modelId) => registry.getMultimodal(providerId, modelId),
    getProviderProtocol: (providerId) => registry.getProviderProtocol(providerId),
    getProviderBaseUrl: (providerId) => registry.getProviderBaseUrl(providerId),
    getProviderGeneration: (providerId) => registry.getProviderGeneration(providerId),
  };
}
