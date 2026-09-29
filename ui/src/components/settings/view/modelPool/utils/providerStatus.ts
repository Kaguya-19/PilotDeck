import type { CatalogProvider } from "../../../../../shared/catalogProviders";
import { hasUsableSecret, isMaskedSecret } from "./providerRefs";
import type { V2Provider } from "../types";

export function countEnabledModels(provider: V2Provider): number {
  return Object.keys(provider.models ?? {}).length;
}

export function providerHasCredential(
  provider: V2Provider,
  catalogEntry?: CatalogProvider,
): boolean {
  if (catalogEntry?.requiresApiKey === false) return true;
  const key = provider.apiKey;
  return isMaskedSecret(key) || hasUsableSecret(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isProviderUrlValid(value: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

/** Completeness is independent of the optional connection probe. */
export function isProviderConfigured(provider: V2Provider, catalogEntry?: CatalogProvider): boolean {
  return Boolean(
    (provider.protocol || catalogEntry?.protocol)?.trim()
    && isProviderUrlValid(provider.url || catalogEntry?.defaultUrl || '')
    && (providerHasCredential(provider, catalogEntry) || catalogEntry?.apiKeyEnvVar)
    && Object.keys(provider.models ?? {}).some((id) => id.trim()),
  );
}

export function isProviderPending(provider: V2Provider, catalogEntry?: CatalogProvider): boolean {
  return !isProviderConfigured(provider, catalogEntry);
}

export function clearProviderConnectionTests(provider: V2Provider): V2Provider {
  const models = provider.models ?? {};
  const nextModels: NonNullable<V2Provider["models"]> = {};
  for (const [id, model] of Object.entries(models)) {
    if (!isRecord(model) || !("connectionTest" in model)) {
      nextModels[id] = model;
      continue;
    }
    const { connectionTest: _ignored, ...rest } = model;
    nextModels[id] = rest;
  }
  return { ...provider, models: nextModels };
}
