import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const gateway = vi.hoisted(() => ({
  listProjects: vi.fn(async () => ({ projects: [] })),
}));

vi.mock('../pilotdeck-bridge.js', () => ({
  getPilotDeckGateway: vi.fn(async () => gateway),
}));

const nativeFetch = globalThis.fetch;
const originalPilotHome = process.env.PILOT_HOME;
const temporaryRoots = [];

afterEach(async () => {
  vi.restoreAllMocks();
  gateway.listProjects.mockReset();
  gateway.listProjects.mockResolvedValue({ projects: [] });
  if (originalPilotHome === undefined) delete process.env.PILOT_HOME;
  else process.env.PILOT_HOME = originalPilotHome;
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    fs.rm(root, { recursive: true, force: true })
  )));
});

describe('upload routes', () => {
  it('serves a verified uploaded image without placing it in a queue frame', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-preview-'));
    temporaryRoots.push(root);
    process.env.PILOT_HOME = await fs.realpath(root);
    const { app, store } = await createUploadsApp();
    const bytes = Buffer.from('image fixture');
    const record = await store.create(process.env.PILOT_HOME, [{ clientFileId: 'image', name: 'photo.png', relativePath: 'photo.png', size: bytes.length, mimeType: 'image/png' }]);
    await store.writePart(record.uploadId, 'image', Readable.from(bytes));
    const completed = await store.complete(record.uploadId);
    const attachment = completed.attachments[0];
    const url = `/api/uploads/${record.uploadId}/attachments/${attachment.attachmentId}/preview`;
    const response = await request(app, url);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({ data: `data:image/png;base64,${bytes.toString('base64')}` });
    expect((await request(app, `/api/uploads/${record.uploadId}/attachments/missing/preview`)).status).toBe(404);
    await fs.writeFile(attachment.path, 'tampered');
    expect((await request(app, url)).status).toBe(422);
  });

  it.each(['ATTACHMENT_EXPIRED', 'UPLOAD_NOT_COMPLETED'])('does not serve a preview when %s', async code => {
    const { app, store } = await createUploadsApp();
    vi.spyOn(store, 'get').mockResolvedValue(uploadRecord('completed'));
    vi.spyOn(store, 'verifyAttachment').mockRejectedValue(Object.assign(new Error(code), { code }));
    const response = await request(app, '/api/uploads/upload-1/attachments/image/preview');
    expect(response.status).toBe(code === 'ATTACHMENT_EXPIRED' ? 410 : 409);
  });

  it('does not miss a terminal event emitted while loading the SSE snapshot', async () => {
    const { app, store } = await createUploadsApp();
    const created = uploadRecord('created');
    const completed = uploadRecord('completed');
    let listener;
    const unsubscribe = vi.fn();
    vi.spyOn(store, 'subscribe').mockImplementation((_uploadId, next) => {
      listener = next;
      return unsubscribe;
    });
    vi.spyOn(store, 'get').mockImplementation(async () => {
      listener(completed);
      return created;
    });

    const response = await request(app, '/api/uploads/upload-1/events');

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: upload_completed');
    expect(response.text).toContain('"status":"completed"');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('returns 204 with no response body when an upload is cancelled', async () => {
    const { app, store } = await createUploadsApp();
    vi.spyOn(store, 'cancel').mockResolvedValue(uploadRecord('cancelled'));

    const response = await request(app, '/api/uploads/upload-1', { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
  });

  it('accepts controlled attachment uploads for the General conversation key', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-general-upload-'));
    temporaryRoots.push(root);
    process.env.PILOT_HOME = path.join(root, 'pilot-home');
    await fs.mkdir(process.env.PILOT_HOME);
    const { app } = await createUploadsApp();

    const response = await request(app, '/api/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectKey: process.env.PILOT_HOME,
        files: [{ clientFileId: 'file-1', name: 'note.txt', relativePath: 'note.txt', size: 0 }],
      }),
    });

    expect(response.status).toBe(201);
    expect(JSON.parse(response.text).status).toBe('created');
  });

  it.each([
    ['PROJECT_PATH_FORBIDDEN', 403],
    ['ATTACHMENT_EXPIRED', 410],
    ['UPLOAD_NOT_COMPLETED', 409],
  ])('maps %s to HTTP %i', async (code, status) => {
    const { app, store } = await createUploadsApp();
    vi.spyOn(store, 'get').mockRejectedValue(Object.assign(new Error(code), { code }));

    const response = await request(app, '/api/uploads/upload-1');

    expect(response.status).toBe(status);
    expect(JSON.parse(response.text).error.code).toBe(code);
  });
});

async function createUploadsApp() {
  const { default: routes, uploadStore } = await import('./uploads.js');
  const app = express();
  app.use(express.json());
  app.use('/api/uploads', routes);
  return { app, store: uploadStore };
}

function uploadRecord(status) {
  return {
    uploadId: 'upload-1',
    projectKey: '/project',
    status,
    manifest: [],
    totalBytes: 1,
    uploadedBytes: status === 'completed' ? 1 : 0,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    expiresAt: '2026-08-12T00:00:00.000Z',
  };
}

async function request(app, path, init = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: response.status, text: await response.text() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
