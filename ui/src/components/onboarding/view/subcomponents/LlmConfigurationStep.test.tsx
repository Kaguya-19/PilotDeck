// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LlmConfigurationStep from './LlmConfigurationStep';

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  fetchProviderModels: vi.fn(),
  fetchRemoteDefaultModels: vi.fn(),
}));

vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

vi.mock('../../../../shared/modelListApi', () => ({
  fetchProviderModels: mocks.fetchProviderModels,
  fetchRemoteDefaultModels: mocks.fetchRemoteDefaultModels,
}));

describe('LlmConfigurationStep', () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockImplementation(async (url: string) => {
      if (url === '/api/config/provider') {
        return { ok: true, json: async () => ({ exists: false, provider: null }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    mocks.fetchRemoteDefaultModels.mockResolvedValue([]);
    mocks.fetchProviderModels.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('fetches Ollama models through the no-key provider path without also running catalog fallback', async () => {
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    await waitFor(() => {
      expect(mocks.fetchRemoteDefaultModels).toHaveBeenCalledWith('openrouter');
    });

    mocks.fetchRemoteDefaultModels.mockClear();
    mocks.fetchProviderModels.mockClear();
    mocks.fetchProviderModels.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    fireEvent.click(screen.getByRole('button', { name: /^Ollama$/ }));

    await waitFor(() => {
      expect(mocks.fetchProviderModels).toHaveBeenCalledTimes(1);
    });

    expect(mocks.fetchProviderModels).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'ollama',
      protocol: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
    }));
    expect(mocks.fetchRemoteDefaultModels).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText(/Using bundled model list\. Local model list unavailable: ECONNREFUSED/)).toBeTruthy();
    });
  });

  it('uses DeepSeek bundled models until an API key is entered', async () => {
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    await waitFor(() => {
      expect(mocks.fetchRemoteDefaultModels).toHaveBeenCalledWith('openrouter');
    });
    mocks.fetchRemoteDefaultModels.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /^DeepSeek$/ }));

    expect(mocks.fetchRemoteDefaultModels).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Fetch model list' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toContain('DeepSeek V4 Pro');
  });

  it('uses Kimi bundled models until an API key is entered', async () => {
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    await waitFor(() => {
      expect(mocks.fetchRemoteDefaultModels).toHaveBeenCalledWith('openrouter');
    });
    mocks.fetchRemoteDefaultModels.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /^Moonshot AI \(Kimi\)$/ }));

    expect(mocks.fetchRemoteDefaultModels).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Fetch model list' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toContain('Kimi K2.6');
  });

  it('creates a passing connection-test record and binds it when saving', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mocks.authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/api/config/provider') {
        return { ok: true, json: async () => ({ exists: false, provider: null }) };
      }
      if (url === '/api/config/test-connections') {
        return {
          ok: true,
          json: async () => ({
            testId: 'test_luna',
            status: 'passed',
            models: [{ modelId: 'gpt-5.6-luna', textInput: 'supported', imageInput: 'supported', error: null }],
          }),
        };
      }
      if (url === '/api/config') {
        if (init?.method === 'PUT') return { ok: true, json: async () => ({ raw: '' }) };
        return { ok: true, json: async () => ({ raw: '' }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<LlmConfigurationStep onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Custom OpenAI/ }));
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'modelbest' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://llm-center.modelbest.co/v1' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-test' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.6-luna' } });

    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
    await waitFor(() => expect(screen.getByText(/Connected successfully/)).toBeTruthy());
    expect(calls.some((call) => call.url === '/api/config/test-connection')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const testCall = calls.find((call) => call.url === '/api/config/test-connections');
      expect(testCall).toBeTruthy();
      expect(JSON.parse(String(testCall?.init?.body))).toMatchObject({
        providerId: 'modelbest',
        protocol: 'openai',
        endpoint: 'https://llm-center.modelbest.co/v1',
        models: ['gpt-5.6-luna'],
      });
      const saveCall = calls.find((call) => call.url === '/api/config' && call.init?.method === 'PUT');
      expect(JSON.parse(String(saveCall?.init?.body))).toMatchObject({
        modelTestBindings: [{ testId: 'test_luna' }],
      });
    });
  });

  it('ignores a connection result when the form changes while testing', async () => {
    let resolveTest!: (response: Response) => void;
    const pendingTest = new Promise<Response>((resolve) => { resolveTest = resolve; });
    mocks.authenticatedFetch.mockImplementation(async (url: string) => {
      if (url === '/api/config/provider') {
        return { ok: true, json: async () => ({ exists: false, provider: null }) };
      }
      if (url === '/api/config/test-connections') return pendingTest;
      if (url === '/api/config') return { ok: true, json: async () => ({ raw: '' }) };
      return { ok: true, json: async () => ({}) };
    });

    render(<LlmConfigurationStep onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Custom OpenAI/ }));
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'modelbest' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://example.com/v1' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-old' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.6-luna' } });

    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Testing...' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-new' } });
    resolveTest({
      ok: true,
      json: async () => ({
        testId: 'stale_test',
        status: 'passed',
        models: [{ modelId: 'gpt-5.6-luna', textInput: 'supported', imageInput: 'supported', error: null }],
      }),
    } as Response);

    await waitFor(() => expect(screen.queryByText(/Connected successfully/)).toBeNull());
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  it('normalizes custom provider IDs to lowercase for testing and saving', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mocks.authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/api/config/provider') {
        return { ok: true, json: async () => ({ exists: false, provider: null }) };
      }
      if (url === '/api/config/test-connections') {
        return {
          ok: true,
          json: async () => ({ testId: 'lowercase_test', status: 'passed', models: [] }),
        };
      }
      if (url === '/api/config') {
        if (init?.method === 'PUT') return { ok: true, json: async () => ({ raw: '' }) };
        return { ok: true, json: async () => ({ raw: '' }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<LlmConfigurationStep onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Custom OpenAI/ }));
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'ModelBest' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://example.com/v1' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-test' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.6-luna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));

    await waitFor(() => expect(screen.getByText(/Connected successfully/)).toBeTruthy());
    const testCall = calls.find((call) => call.url === '/api/config/test-connections');
    expect(JSON.parse(String(testCall?.init?.body))).toMatchObject({ providerId: 'modelbest' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const saveCall = calls.find((call) => call.url === '/api/config' && call.init?.method === 'PUT');
      const body = JSON.parse(String(saveCall?.init?.body));
      expect(body.raw).toContain('modelbest:');
      expect(body.raw).not.toContain('ModelBest:');
    });
  });

  it('keeps the test failed when manual image capability input is cancelled', async () => {
    const calls: string[] = [];
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
    mocks.authenticatedFetch.mockImplementation(async (url: string) => {
      calls.push(url);
      if (url === '/api/config/provider') {
        return { ok: true, json: async () => ({ exists: false, provider: null }) };
      }
      if (url === '/api/config/test-connections') {
        return {
          ok: true,
          json: async () => ({
            testId: 'manual_test',
            status: 'manual_input_required',
            models: [{ modelId: 'gpt-5.6-luna', textInput: 'supported', imageInput: 'unknown', error: null }],
          }),
        };
      }
      return { ok: true, json: async () => ({ raw: '' }) };
    });

    render(<LlmConfigurationStep onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Custom OpenAI/ }));
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'modelbest' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://example.com/v1' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-test' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.6-luna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));

    await waitFor(() => expect(screen.getByText(/cancelled/i)).toBeTruthy());
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain('/api/config/test-connections/manual_test/image-capabilities');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    prompt.mockRestore();
  });

  it('locks the form controls while save is in flight', async () => {
    let resolveSave!: (response: { ok: boolean; json: () => Promise<{ raw: string }> }) => void;
    const pendingSave = new Promise<{ ok: boolean; json: () => Promise<{ raw: string }> }>((resolve) => { resolveSave = resolve; });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const onSaved = vi.fn();
    mocks.authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/api/config/provider') return { ok: true, json: async () => ({ exists: false, provider: null }) };
      if (url === '/api/config/test-connections') return { ok: true, json: async () => ({ testId: 'save_test', status: 'passed', models: [] }) };
      if (url === '/api/config' && init?.method === 'PUT') return pendingSave;
      return { ok: true, json: async () => ({ raw: '' }) };
    });

    render(<LlmConfigurationStep onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: /^Custom OpenAI/ }));
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'modelbest' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://example.com/v1' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-old' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.6-luna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
    await waitFor(() => expect(screen.getByText(/Connected successfully/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/config' && call.init?.method === 'PUT')).toBe(true));
    expect(screen.getByLabelText('Provider ID')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Base URL')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('API Key')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Model')).toHaveProperty('disabled', true);
    expect(onSaved).not.toHaveBeenCalled();
    resolveSave({ ok: true, json: async () => ({ raw: '' }) });

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const saveCall = calls.find((call) => call.url === '/api/config' && call.init?.method === 'PUT');
    expect(JSON.parse(String(saveCall?.init?.body))).toMatchObject({ modelTestBindings: [{ testId: 'save_test' }] });
  });

  it('aborts an in-flight connection test when the form changes', async () => {
    let rejectTest!: (error: Error) => void;
    const pendingTest = new Promise<never>((_, reject) => { rejectTest = reject; });
    const signals: AbortSignal[] = [];
    mocks.authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/config/provider') return { ok: true, json: async () => ({ exists: false, provider: null }) };
      if (url === '/api/config/test-connections') {
        if (init?.signal) signals.push(init.signal);
        return pendingTest;
      }
      return { ok: true, json: async () => ({ raw: '' }) };
    });

    render(<LlmConfigurationStep onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Custom OpenAI/ }));
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'modelbest' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://example.com/v1' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-old' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.6-luna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
    await waitFor(() => expect(signals).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-new' } });
    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    rejectTest(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  });

  it('rejects custom provider IDs reserved for catalog aliases', async () => {
    const calls: string[] = [];
    mocks.authenticatedFetch.mockImplementation(async (url: string) => {
      calls.push(url);
      if (url === '/api/config/provider') return { ok: true, json: async () => ({ exists: false, provider: null }) };
      return { ok: true, json: async () => ({ raw: '' }) };
    });

    render(<LlmConfigurationStep onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Custom OpenAI/ }));
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'gemini' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://example.com/v1' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-test' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.6-luna' } });

    expect(screen.getByRole('button', { name: 'Test Connection' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/reserved/i)).toBeTruthy();
    expect(calls).not.toContain('/api/config/test-connections');
  });
});
