// @vitest-environment node
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
});

async function request(app, path, options) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, options);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function approvalApp() {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'pd-owner' }; next(); });
  return app;
}
const approvalHeader = { 'x-staffdeck-approver-authorization': 'Bearer fixture-approver' };
const boundPilotDeckUserId = () => 'pd-owner';

describe('SOP routes', () => {
  it('forwards status through the read retry helper', async () => {
    const status = { sessionId: 'session-1', revision: 2, state: { status: 'handoff' }, wait: { id: 'wait-1' } };
    const readRetry = vi.fn(async (operation) => operation({ sopStatus: vi.fn(async () => status) }));
    const { createSopRouter } = await import('./sop.js');
    const app = approvalApp();
    app.use('/api/sop', createSopRouter({ readRetry, boundPilotDeckUserId }));

    const response = await request(app, '/api/sop/status?sessionKey=session-1&projectKey=%2Fproject', { headers: approvalHeader });

    expect(response).toEqual({ status: 200, body: { status } });
    expect(readRetry).toHaveBeenCalledOnce();
  });

  it('forwards a resume request without replaying it', async () => {
    const resumeSop = vi.fn(async (input) => ({ accepted: true, duplicate: false, sessionId: input.sessionKey, requestId: input.requestId, message: input.message, revision: 3 }));
    const { createSopRouter } = await import('./sop.js');
    const app = approvalApp();
    app.use('/api/sop', createSopRouter({ getGateway: async () => ({ resumeSop }), boundPilotDeckUserId }));

    const payload = {
      sessionKey: 'session-1', projectKey: '/project', requestId: 'resume-1', waitId: 'wait-1',
      source: 'human', message: 'Approved.', expectedRevision: 2, slotUpdates: { approved: true },
    };
    const response = await request(app, '/api/sop/resume', { method: 'POST', headers: { 'content-type': 'application/json', ...approvalHeader }, body: JSON.stringify(payload) });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ accepted: true, duplicate: false, requestId: 'resume-1', revision: 3 });
    expect(response.body.approverAuthorization).toBeUndefined();
    expect(resumeSop).toHaveBeenCalledOnce();
    expect(resumeSop).toHaveBeenCalledWith({ ...payload, approverAuthorization: approvalHeader['x-staffdeck-approver-authorization'] });
  });

  it.each([
    ['SOP_SESSION_NOT_FOUND', 404],
    ['SOP_WAIT_STALE', 409],
    ['SOP_REVISION_CONFLICT', 409],
    ['SESSION_BUSY', 409],
    ['SOP_MODULE_DISABLED', 501],
    ['SOP_APPROVAL_SESSION_MAPPING_UNAVAILABLE', 503],
    ['SOP_APPROVAL_FORBIDDEN', 403],
  ])('maps %s to HTTP %i', async (code, expectedStatus) => {
    const { createSopRouter } = await import('./sop.js');
    const app = approvalApp();
    app.use('/api/sop', createSopRouter({
      boundPilotDeckUserId,
      getGateway: async () => ({ resumeSop: async () => { throw Object.assign(new Error(code), { code }); } }),
    }));

    const response = await request(app, '/api/sop/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...approvalHeader },
      body: JSON.stringify({ sessionKey: 's', requestId: 'r', waitId: 'w', source: 'human', message: 'done', expectedRevision: 2 }),
    });

    expect(response).toEqual({ status: expectedStatus, body: { error: { code, message: code } } });
  });

  it('rejects malformed resume input before opening a Gateway connection', async () => {
    const getGateway = vi.fn();
    const { createSopRouter } = await import('./sop.js');
    const app = express();
    app.use(express.json());
    app.use('/api/sop', createSopRouter({ getGateway }));

    const response = await request(app, '/api/sop/resume', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'robot' }),
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
    expect(getGateway).not.toHaveBeenCalled();
  });

  it('rejects caller authority and a different authenticated PD user before calling the Gateway', async () => {
    const getGateway = vi.fn(); const { createSopRouter } = await import('./sop.js');
    const app = approvalApp();
    app.use('/api/sop', createSopRouter({ getGateway, boundPilotDeckUserId: () => 'other-owner' }));
    const payload = { sessionKey: 's', requestId: 'r', waitId: 'w', source: 'human', message: 'Reviewed', expectedRevision: 2 };
    const forged = await request(app, '/api/sop/resume', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, authority: { subject: { role: 'admin' } } }) });
    expect(forged.status).toBe(400);
    const foreignUser = await request(app, '/api/sop/resume', { method: 'POST', headers: { 'content-type': 'application/json', ...approvalHeader }, body: JSON.stringify(payload) });
    expect(foreignUser.status).toBe(403);
    expect(getGateway).not.toHaveBeenCalled();
  });

  it('preserves the original SD authentication status carried by the SOP RPC error', async () => {
    const { createSopRouter } = await import('./sop.js'); const app = approvalApp();
    app.use('/api/sop', createSopRouter({ boundPilotDeckUserId, getGateway: async () => ({ resumeSop: async () => {
      throw Object.assign(new Error('Rejected'), { code: 'APPROVAL_AUTH_REJECTED', details: { httpStatus: 403 } });
    } }) }));
    const response = await request(app, '/api/sop/resume', { method: 'POST', headers: { 'content-type': 'application/json', ...approvalHeader },
      body: JSON.stringify({ sessionKey: 's', requestId: 'r', waitId: 'w', source: 'human', expectedRevision: 2, message: 'Reviewed' }) });
    expect(response.status).toBe(403);
  });
});
