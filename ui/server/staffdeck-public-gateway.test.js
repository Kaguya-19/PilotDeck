import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStaffDeckPublicCapabilityGateway } from './routes/modules.js';

const management = { agentId: 'agent', credentialId: 'credential', apiKey: 'server-only-key', endpoint: 'http://127.0.0.1:16699/api/v1/' };
const owner = { tenantId: 'tenant', actorUserId: 'actor', agentId: 'agent', credentialId: 'credential' };
afterEach(() => vi.restoreAllMocks());

describe('server-only public gateway with no explicit grants', () => {
  it('keeps response and event operations at zero upstream requests', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const gateway = createStaffDeckPublicCapabilityGateway({ management, owner });
    await expect(gateway.call('list_tools', {}, { scope: { kind: 'agent', agentId: 'agent' } })).rejects.toMatchObject({ code: 'PUBLIC_OPERATION_NOT_AUTHORIZED', status: 403 });
    await expect(gateway.events({ jobId: 'job' })).rejects.toMatchObject({ code: 'PUBLIC_OPERATION_NOT_AUTHORIZED', status: 403 });
    expect(fetch).not.toHaveBeenCalled();
    expect(Object.keys(gateway)).toEqual(['call', 'file', 'events']);
  });

  it('refuses a mismatched owner before constructing any transport call', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(() => createStaffDeckPublicCapabilityGateway({ management, owner: { ...owner, agentId: 'other' } }))
      .toThrow('verified management owner');
    expect(fetch).not.toHaveBeenCalled();
  });
});
