import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PilotDeckConfig } from '../types';
import ModelsSection from './ModelsSection';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../../../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function setup({ hasOtherReference = false, rejectSave = false, emptyDefinition = false, brokenUrl = false, noAlternative = false } = {}) {
  const provider = { protocol: 'openai' as const, url: 'https://example.test/v1', apiKey: '********', models: { model: {} } };
  let latest: PilotDeckConfig = {
    agent: { model: 'openai/model' },
    model: { providers: {
      openai: { ...provider, url: brokenUrl ? 'aaa' : provider.url },
      replacement: { ...provider, models: { model: emptyDefinition ? null : {} } },
    } },
  };
  if (noAlternative) delete latest.model!.providers!.replacement;
  const saves = vi.fn();
  mocks.fetch.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.includes('model-references') ? { references: [
    { path: 'agent.model', value: 'openai/model', kind: 'agent' },
    ...(hasOtherReference ? [{ path: 'memory.model', value: 'openai/model', kind: 'memory' }] : []),
  ] } : { tasks: [], models: [] } }));
  function Harness() {
    const [config, setConfig] = useState(latest);
    return <ModelsSection config={config} onChange={async next => {
      saves(next);
      if (rejectSave) return { ok: false, error: 'Save rejected' };
      latest = next;
      setConfig(next);
      return { ok: true };
    }} />;
  }
  render(<Harness />);
  return { saves, config: () => latest };
}

async function selectReplacement() {
  const dialog = within(await screen.findByRole('dialog'));
  const select = await dialog.findByRole('combobox');
  expect(within(select).queryByRole('option', { name: 'openai/model' })).toBeNull();
  fireEvent.change(select, { target: { value: 'replacement/model' } });
  return dialog;
}

it.each([false, true])('atomically replaces the default and deletes a broken provider, including null model definitions: %s', async (emptyDefinition) => {
  const { saves, config } = setup({ emptyDefinition, brokenUrl: true });
  fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.actions.remove' }));
  const dialog = await selectReplacement();
  fireEvent.click(dialog.getByRole('button', { name: 'pilotDeckConfig.panels.models.deleteDialog.replaceDefault' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(saves).toHaveBeenCalledTimes(1);
  expect(config().agent?.model).toBe('replacement/model');
  expect(config().model?.providers?.openai).toBeUndefined();
  expect(config().model?.providers?.replacement.models?.model).toEqual(emptyDefinition ? null : {});
});

it('retains other reference protection without partially switching the default', async () => {
  const { saves, config } = setup({ hasOtherReference: true });
  fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.actions.remove' }));
  const dialog = within(await screen.findByRole('dialog'));
  await waitFor(() => expect(dialog.queryByText('pilotDeckConfig.panels.models.deleteDialog.checking')).toBeNull());
  expect(dialog.queryByRole('combobox')).toBeNull();
  const remove = dialog.getByRole('button', { name: 'pilotDeckConfig.panels.models.deleteDialog.delete' }) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);
  fireEvent.click(remove);
  expect(saves).not.toHaveBeenCalled();
  expect(config().agent?.model).toBe('openai/model');
});

it('keeps the configuration and dialog intact when the atomic save fails', async () => {
  const { saves, config } = setup({ rejectSave: true });
  fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.actions.remove' }));
  const dialog = await selectReplacement();
  fireEvent.click(dialog.getByRole('button', { name: 'pilotDeckConfig.panels.models.deleteDialog.replaceDefault' }));
  expect((await dialog.findByRole('alert')).textContent).toBe('Save rejected');
  expect(saves).toHaveBeenCalledTimes(1);
  expect(config().agent?.model).toBe('openai/model');
  expect(config().model?.providers?.openai).toBeDefined();
});

it('deletes only the selected model when replacing a referenced model', async () => {
  const { saves, config } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.panels.models.removeModelAria' }));
  const dialog = await selectReplacement();
  fireEvent.click(dialog.getByRole('button', { name: 'pilotDeckConfig.panels.models.deleteDialog.replaceDefault' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(saves).toHaveBeenCalledTimes(1);
  expect(config().agent?.model).toBe('replacement/model');
  expect(config().model?.providers?.openai).toBeDefined();
  expect(config().model?.providers?.openai.models).toEqual({});
});


it.each(['model', 'provider'])('allows clearing the final %s and its default without a replacement', async (kind) => {
  const { saves, config } = setup({ noAlternative: true });
  if (kind === 'model') {
    fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.panels.models.removeModelAria' }));
  } else fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.actions.remove' }));
  const dialog = within(await screen.findByRole('dialog'));
  const remove = dialog.getByRole('button', { name: 'pilotDeckConfig.panels.models.deleteDialog.delete' }) as HTMLButtonElement;
  await waitFor(() => expect(remove.disabled).toBe(false));
  expect(dialog.queryByRole('combobox')).toBeNull();
  fireEvent.click(remove);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(saves).toHaveBeenCalledTimes(1);
  expect(config().agent?.model).toBe('');
  expect(config().model?.providers).toEqual(kind === 'provider' ? {} : { openai: expect.objectContaining({ models: {} }) });
});
