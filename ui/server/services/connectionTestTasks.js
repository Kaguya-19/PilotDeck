import { randomUUID } from 'node:crypto';

const BUSY = new Set(['testing', 'savingTest', 'manual', 'cancelling']);
const fail = (message, status = 409, code = 'TEST_BUSY') => Object.assign(new Error(message), { status, code });

// Tasks belong to the authenticated user, not an HTTP connection or settings page.
// Only public results enter snapshots; provider credentials remain inside the runner.
export function createConnectionTestTasks({ prepare, persist, getRecord, applyImage, isCurrent = () => true }) {
  const users = new Map();
  const publicTask = ({ controller, result, ...task }) => ({ ...task, result });
  const prune = () => {
    for (const [userId, tasks] of users) {
      for (const [providerId, task] of tasks) {
        if (['manual', 'saveError'].includes(task.status) && Date.now() - task.updatedAt > 10 * 60_000) {
          task.status = 'error'; task.code = 'TEST_EXPIRED'; task.message = 'Connection test has expired.';
        }
        if (!BUSY.has(task.status) && Date.now() - task.updatedAt > 60 * 60_000) tasks.delete(providerId);
      }
      if (!tasks.size) users.delete(userId);
    }
  };
  const timer = setInterval(prune, 60_000); timer.unref();
  const list = (userId) => {
    prune();
    return [...(users.get(userId)?.values() || [])]
      .filter(task => task.status !== 'success' || isCurrent(userId, task))
      .map(publicTask);
  };
  const active = (userId) => [...(users.get(userId)?.values() || [])].find(task => BUSY.has(task.status));
  const lookup = (userId, id) => {
    prune();
    const task = [...(users.get(userId)?.values() || [])].find(task => task.id === id);
    if (!task) throw fail('Connection test task was not found.', 404, 'TEST_NOT_FOUND');
    return task;
  };
  const update = (task, patch) => Object.assign(task, patch, { updatedAt: Date.now() });
  const save = async (userId, task) => {
    update(task, { status: 'savingTest', message: '', code: '' });
    try {
      await persist(userId, task.result.testId);
      update(task, { status: 'success' });
    } catch (error) {
      update(task, { status: error.code === 'TEST_EXPIRED' ? 'error' : 'saveError', message: error.message, code: error.code || 'TEST_SAVE_FAILED' });
    }
  };
  return {
    list,
    start(userId, body, { modelId } = {}) {
      prune();
      if (active(userId)) throw fail('Another connection test is in progress.');
      const run = prepare(body, userId, true); // validation and slot acquisition happen before acceptance
      const task = { id: randomUUID(), providerId: body.providerId, ...(modelId ? { modelId } : {}), status: 'testing', result: null, message: '', code: '', updatedAt: Date.now(), controller: new AbortController() };
      if (!users.has(userId)) users.set(userId, new Map());
      users.get(userId).set(JSON.stringify([task.providerId, modelId || null]), task);
      void (async () => {
        try {
          const result = await run(task.controller.signal);
          if (task.controller.signal.aborted) return;
          update(task, { result });
          if (modelId) {
            if (!isCurrent(userId, task)) update(task, { status: 'error', result: null, code: 'CONFIGURATION_MISMATCH', message: 'The model connection configuration changed during testing.' });
            else update(task, { status: result.status === 'failed' ? 'error' : 'success' });
          }
          else if (result.status === 'passed') await save(userId, task);
          else if (result.manualInputRequired) update(task, { status: 'manual' });
          else update(task, { status: 'error', message: result.error?.message || 'Connection failed.', code: result.error?.code || 'TEST_FAILED' });
        } catch (error) {
          if (!task.controller.signal.aborted) update(task, { status: 'error', message: error.message, code: error.code || 'TEST_FAILED' });
        } finally {
          if (task.controller.signal.aborted) update(task, { status: 'cancelled', message: '', code: '' });
        }
      })();
      return publicTask(task);
    },
    retry(userId, id) {
      const task = lookup(userId, id);
      if (active(userId) || task.status !== 'saveError') throw fail('Another connection test is in progress.');
      void save(userId, task);
      return publicTask(task);
    },
    confirm(userId, id, body) {
      const task = lookup(userId, id);
      if (task.status !== 'manual') throw fail('This task is not waiting for image capabilities.');
      const { record, reason } = getRecord(userId, task.result.testId);
      if (!record) {
        update(task, { status: 'error', code: 'TEST_EXPIRED', message: 'Connection test has expired.' });
        throw fail(reason, 410, 'TEST_EXPIRED');
      }
      const result = applyImage(record, body);
      update(task, { result });
      void save(userId, task);
      return publicTask(task);
    },
    acknowledge(userId, id) {
      const task = lookup(userId, id);
      if (!task.modelId || BUSY.has(task.status)) throw fail('This model test has not finished.');
      update(task, { acknowledged: true });
      return publicTask(task);
    },
    cancel(userId, id) {
      const task = lookup(userId, id);
      if (task.status === 'savingTest') throw fail('Test results are being saved.');
      if (task.status === 'testing') {
        update(task, { status: 'cancelling' });
        task.controller.abort(new Error('Connection test cancelled.'));
      } else if (['manual', 'saveError'].includes(task.status)) update(task, { status: 'cancelled' });
      return publicTask(task);
    },
  };
}
