import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import PrivacySections from '.';
import { authenticatedFetch } from '../../../../utils/api';
vi.mock('../../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../../hooks/usePilotDeckConfig', () => ({ usePilotDeckConfig: () => ({ raw: '{}', commitRaw: vi.fn(), loading: false, error: null }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
it('opening and reopening privacy never writes or disables global full access', async () => {
  const permissions = { skipPermissions: true, allowedTools: ['read_file'], askTools: ['bash'], disallowedTools: ['blocked'] };
  const fetch = vi.mocked(authenticatedFetch);
  fetch.mockResolvedValue(new Response(JSON.stringify({ permissions })));
  const first = render(<PrivacySections title="Privacy" />);
  await waitFor(() => expect(first.getByText('read_file')).toBeTruthy()); first.unmount();
  render(<PrivacySections title="Privacy" />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(fetch.mock.calls.every((call) => !(call[1] as RequestInit)?.method || (call[1] as RequestInit).method === 'GET')).toBe(true);
  expect(JSON.parse(localStorage.getItem('pilotdeck-settings')!).skipPermissions).toBe(true);
});
