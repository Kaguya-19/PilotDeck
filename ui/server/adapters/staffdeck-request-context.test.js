import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStaffDeckRequestContext, staffDeckCreateContent, staffDeckDraftResponse } from './staffdeck-request-context.js';

test('browser connection closure aborts the actual upstream fetch', async () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const context = createStaffDeckRequestContext(req, res, 10000);
  // A real fetch is aborted before network admission; no service or business run.
  res.emit('close');
  await assert.rejects(fetch('http://127.0.0.1:1', { signal: context.signal }), { name: 'AbortError' });
  context.dispose();
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('close'), 0);
});

test('normal response completion and old disposal do not cancel another request', () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const first = createStaffDeckRequestContext(req, res, 10000);
  const second = createStaffDeckRequestContext(req, res, 10000);
  first.dispose();
  res.writableFinished = true;
  res.emit('close');
  assert.equal(second.signal.aborted, false);
  res.writableFinished = false;
  req.emit('aborted');
  assert.equal(second.signal.aborted, true);
  second.dispose();
});

test('create binds the selected SOP without mutating content or extensions', () => {
  const content = { skill_id: 'body-other', nodes: [{ extension: { keep: true } }], version: '1.2.3' };
  assert.deepEqual(staffDeckCreateContent({ sopId: 'selected', content }), { ...content, skill_id: 'selected' });
  assert.equal(content.skill_id, 'body-other');
  assert.throws(() => staffDeckCreateContent({ content: [] }), { code: 'SOP_MANAGEMENT_INPUT_INVALID' });
});

test('draft projection uses only the ETag from that response, including create and rollback', () => {
  const response = new Response('{}', { headers: { etag: '"same-response"' } });
  for (const operation of ['create', 'get_draft', 'replace_draft', 'rollback']) {
    assert.deepEqual(staffDeckDraftResponse({ id: 'draft', content: { name: 'original' } }, response, operation), { id: 'draft', content: { name: 'original' }, etag: '"same-response"' });
  }
  const payload = { id: 'draft', etag: '"body-original"' };
  assert.equal(staffDeckDraftResponse(payload, response, 'get_draft'), payload);
});
