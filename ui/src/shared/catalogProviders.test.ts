import { describe, expect, it } from 'vitest';
import { findCatalogProviderById } from './catalogProviders';

describe('catalogProviders maxOutputTokens', () => {
  it('exposes model output caps for settings placeholders', () => {
    const deepseek = findCatalogProviderById('deepseek');
    const openai = findCatalogProviderById('openai');

    expect(deepseek?.models.find((model) => model.id === 'deepseek-v4-flash')?.maxOutputTokens).toBe(384 * 1024);
    expect(deepseek?.models.find((model) => model.id === 'deepseek-chat')?.maxOutputTokens).toBe(384 * 1024);
    expect(openai?.models.find((model) => model.id === 'gpt-4.1-mini')?.maxOutputTokens).toBe(32_768);
    expect(openai?.models.find((model) => model.id === 'o3-mini')?.maxOutputTokens).toBe(100_000);
  });
});
