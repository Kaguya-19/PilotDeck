import { describe, expect, it } from 'vitest';
import { clearProviderConnectionTests, isProviderConfigured, isProviderPending } from './providerStatus';
const complete = { protocol: 'openai' as const, url: 'https://example.test/v1', apiKey: '********', models: { model: {} } };
describe('provider completeness', () => {
  it('is configured without a connection test, or after a failed test', () => {
    expect(isProviderConfigured(complete)).toBe(true);
    expect(isProviderConfigured({ ...complete, models: { model: { connectionTest: { status: 'failed' } } } })).toBe(true);
  });
  it.each([{ protocol: undefined }, { url: '' }, { apiKey: '' }, { apiKey: 'PLACEHOLDER_KEY' }, { models: {} }])('requires necessary fields: %j', (patch) => {
    expect(isProviderPending({ ...complete, ...patch })).toBe(true);
  });
  it('accepts catalog defaults, keyless providers and environment credentials', () => {
    const catalog = { id: 'ollama', displayName: 'Ollama', protocol: 'openai' as const, defaultUrl: 'http://localhost:11434/v1', requiresApiKey: false, models: [] };
    expect(isProviderConfigured({ models: { model: {} } }, catalog)).toBe(true);
    expect(isProviderConfigured({ models: { model: {} } }, { ...catalog, requiresApiKey: true, apiKeyEnvVar: 'API_KEY' })).toBe(true);
    expect(isProviderConfigured({ models: {} }, catalog)).toBe(false);
  });
  it('clears stale tests without changing model settings', () => {
    const provider = { ...complete, models: { model: { capabilities: { maxOutputTokens: 1024 }, connectionTest: { status: 'passed' } } } };
    expect(clearProviderConnectionTests(provider).models?.model).toEqual({ capabilities: { maxOutputTokens: 1024 } });
  });
});
