import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindModuleRequestAbort, moduleUpstreamSignal } from './module-request-abort.js';

test('a browser disconnect aborts upstream and releases listeners', () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const signal = moduleUpstreamSignal(bindModuleRequestAbort(req, res), 1000);
  res.emit('close');
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.name, 'AbortError');
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('close'), 0);
});

test('normal response completion does not cancel upstream or leave request listeners', () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const signal = bindModuleRequestAbort(req, res);
  res.writableFinished = true;
  res.emit('finish');
  res.emit('close');
  assert.equal(signal.aborted, false);
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('close'), 0);
});
