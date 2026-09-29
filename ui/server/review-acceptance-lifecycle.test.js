// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SessionRouter } from '../../src/gateway/SessionRouter.js';
import { InProcessGateway } from '../../src/gateway/client/InProcessGateway.js';
import { AgentSession } from '../../src/agent/session/AgentSession.js';
import { TurnRunner } from '../../src/agent/turn/TurnRunner.js';
import { SessionMetadataStore } from '../../src/session/metadata/SessionMetadataStore.js';
import { JsonlTranscriptWriter } from '../../src/session/transcript/JsonlTranscriptWriter.js';
import { createProjectId, sanitizeSessionIdForPath } from './utils/pilotPaths.js';

let home, bridge, projects, modelHandlers, gateway;
const previousHome = process.env.PILOT_HOME;
const A = {mode: 'model', provider: 'test', model: 'M1'};
const B = {mode: 'model', provider: 'test', model: 'M2'};
const AUTO = {mode: 'auto'};
const drain = async session => { for await (const _ of session.submit({type: 'text', text: 'Original request'})) { /* drain */ } };
const tick = () => new Promise(resolve => setImmediate(resolve));

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'pilotdeck-review-lifecycle-'));
  process.env.PILOT_HOME = home;
  vi.resetModules();
  bridge = await import('./pilotdeck-bridge.js');
  vi.doMock('./pilotdeck-bridge.js', () => ({...bridge, getPilotDeckGateway: async () => gateway}));
  vi.doMock('./database/db.js', () => ({applyCustomSessionNames: rows => rows}));
  projects = await import('./projects.js');
  modelHandlers = (await import('./routes/models.js')).createSessionModelHandlers();
});
afterAll(async () => {
  if (previousHome === undefined) delete process.env.PILOT_HOME;
  else process.env.PILOT_HOME = previousHome;
  vi.doUnmock('./pilotdeck-bridge.js'); vi.doUnmock('./database/db.js');
  await rm(home, {recursive: true, force: true});
});

async function fixture() {
  const projectKey = join(home, 'workspace-' + randomUUID());
  const projectDirectory = join(home, 'projects', createProjectId(projectKey));
  const sessionKey = 'web:s_' + randomUUID();
  await mkdir(join(projectDirectory, 'chats'), {recursive: true});
  await writeFile(join(projectDirectory, '.cwd'), projectKey);
  const transcriptPath = join(projectDirectory, 'chats', sanitizeSessionIdForPath(sessionKey) + '.jsonl');
  const queuePath = join(projectDirectory, 'pending-inputs', sanitizeSessionIdForPath(sessionKey) + '.json');
  return {projectKey, projectDirectory, sessionKey, transcriptPath, queuePath};
}

describe('project deletion with real runtime and files', () => {
  it('deletes a whole project without late titles recreating it, and leaves another project usable', async () => {
    const target = await fixture(), other = await fixture();
    const titles = new Map(), signals = new Map();
    const router = new SessionRouter({idleSweepIntervalMs: 0, createSession: context => {
      const current = context.projectKey === target.projectKey ? target : other;
      const writer = new JsonlTranscriptWriter({path: current.transcriptPath});
      const metadataStore = new SessionMetadataStore({transcript: writer, sessionId: context.sessionKey});
      const loop = {async *run(input) {
        const now = new Date().toISOString();
        const result = {type: 'success', sessionId: input.sessionId, turnId: input.turnId, stopReason: 'completed', usage: {}, permissionDenials: [], turns: 1, startedAt: now, completedAt: now};
        yield {type: 'turn_completed', sessionId: input.sessionId, turnId: input.turnId, result};
        return {result, messages: input.messages};
      }};
      const runner = new TurnRunner(loop, writer, undefined, () => new Date(), undefined,
        {cwd: current.projectKey, transcriptPath: current.transcriptPath, collectFileArtifacts: false},
        {metadataStore, autoGenerateSessionTitle: true, sessionTitleGenerator: input => {
          signals.set(input.sessionId, input.signal);
          return new Promise(resolve => titles.set(input.sessionId, resolve));
        }});
      return new AgentSession({sessionId: context.sessionKey, turnRunner: runner});
    }});
    gateway = new InProcessGateway(router);
    try {
      for (const current of [target, other]) await drain(await router.getOrCreate({projectKey: current.projectKey, sessionKey: current.sessionKey, channelKey: 'web'}));
      expect(await projects.deleteProject(target.projectKey, true)).toBe(true);
      expect(signals.get(target.sessionKey).aborted).toBe(true);
      expect(signals.get(other.sessionKey).aborted).toBe(false);
      titles.get(target.sessionKey)('Late deleted title');
      titles.get(other.sessionKey)('Other project title');
      await tick();
      await expect(readFile(target.transcriptPath)).rejects.toMatchObject({code: 'ENOENT'});
      await expect(readFile(join(target.projectDirectory, '.cwd'))).rejects.toMatchObject({code: 'ENOENT'});
      await vi.waitFor(async () => expect(await readFile(other.transcriptPath, 'utf8')).toContain('Other project title'));
    } finally { for (const resolve of titles.values()) resolve('cleanup'); router.shutdown(); }
  });
});

async function queryModel(current) {
  let response;
  const res = {json: data => {response = data; return res;}, status: code => {if(code >= 400) throw new Error('HTTP ' + code); return res;}};
  await modelHandlers.get({query: {projectKey: current.projectKey, sessionKey: current.sessionKey}}, res);
  return response;
}

it('persists accepted queued choices independently of execution, across reload, replay, and queue removal', async () => {
  const current = await fixture();
  const writer = new JsonlTranscriptWriter({path: current.transcriptPath});
  await writer.recordSessionMetadata(current.sessionKey, 'running-M1', {modelSelection: A});
  await mkdir(join(current.projectDirectory, 'pending-inputs'));
  // A recovered queue is paused, so this test never contacts a real model/Gateway.
  await writeFile(current.queuePath, JSON.stringify({version: 2, items: [{id: 'existing', command: 'existing', options: {modelSelection: A}}]}));
  gateway = {
    describeServer: async () => ({capabilities: ['session_model_get']}),
    sessionModelGet: async () => {
      const entries = (await readFile(current.transcriptPath, 'utf8')).trim().split('\n').map(JSON.parse);
      return {...current, saved: entries.at(-1).metadata.modelSelection};
    },
  };
  const frames = [];
  const output = {send: frame => frames.push(frame)};
  const queued = {id: 'q-M2', runId: 'q-M2', command: 'M2 pending', options: {projectPath: current.projectKey, modelSelection: B}};
  expect((await bridge.enqueueInputViaGateway(current.sessionKey, queued, output)).ok).toBe(true);
  expect(await queryModel(current)).toMatchObject({saved: A, acceptedSelection: B});
  expect(frames).toContainEqual(expect.objectContaining({type: 'model-selection-saved', selection: B}));
  const persisted = JSON.parse(await readFile(current.queuePath, 'utf8'));
  expect(persisted.items.at(-1).options.modelSelection).toEqual(B);
  expect(persisted.lastAcceptedModelSelection.selection).toEqual(B);
  // A new server module has no in-memory state. Restore from the actual sidecar.
  vi.doUnmock('./pilotdeck-bridge.js'); vi.resetModules();
  const reloaded = await import('./pilotdeck-bridge.js');
  expect(reloaded.getAcceptedModelSelection(current.projectKey, current.sessionKey)).toEqual(B);
  // Accept Auto after M2, then execute M2. Execution must retain the Auto preference.
  expect((await bridge.enqueueInputViaGateway(current.sessionKey, {id: 'q-auto', command: 'later', options: {...queued.options, modelSelection: AUTO}}, output)).ok).toBe(true);
  await writer.recordSessionMetadata(current.sessionKey, 'execute-M2', {modelSelection: B});
  const executed = [];
  const executionGateway = {submitTurn: async function* (input) {
    executed.push(input.modelSelection);
    yield {type: 'input_accepted', runId: input.runId, modelSelection: input.modelSelection};
    yield {type: 'turn_completed', runId: input.runId, finishReason: 'completed'};
  }};
  await bridge.runChatViaGateway('M2 pending', {...queued.options, sessionId: current.sessionKey, runId: 'q-M2'}, output, 'pilotdeck', {fromQueue: true, getGateway: async () => executionGateway});
  expect(executed).toEqual([B]);
  expect(await queryModel(current)).toMatchObject({saved: B, acceptedSelection: AUTO});
  // A duplicate enqueue is not a new acceptance.
  await bridge.enqueueInputViaGateway(current.sessionKey, queued, output);
  expect(bridge.getAcceptedModelSelection(current.projectKey, current.sessionKey)).toEqual(AUTO);
  for (const id of ['existing', 'q-M2', 'q-auto']) await bridge.deleteQueuedInputViaGateway(current.sessionKey, id, output);
  expect(JSON.parse(await readFile(current.queuePath, 'utf8'))).toMatchObject({items: [], lastAcceptedModelSelection: {selection: AUTO}});
  // A new direct send updates the preference only after input_accepted.
  await bridge.runChatViaGateway('new direct', {...queued.options, sessionId: current.sessionKey, runId: 'direct'}, output, 'pilotdeck', {getGateway: async () => executionGateway});
  expect(await queryModel(current)).toMatchObject({acceptedSelection: B});
  await writer.close();
});

it('does not accept queued choices or dispatch while a project is being deleted', async () => {
  const current = await fixture();
  bridge.recordAcceptedModelSelection(current.projectKey, current.sessionKey, A, 'previous');
  const finish = bridge.beginProjectDeletion(current.projectKey);
  await expect(bridge.enqueueInputViaGateway(current.sessionKey, {id: 'blocked', command: 'blocked', options: {projectPath: current.projectKey, modelSelection: B}}, {send() {}})).rejects.toThrow('being deleted');
  finish(false);
  expect(bridge.getAcceptedModelSelection(current.projectKey, current.sessionKey)).toEqual(A);
});


it('does not acknowledge a queued model choice when persistence fails', async () => {
  const current = await fixture();
  bridge.recordAcceptedModelSelection(current.projectKey, current.sessionKey, A, 'previous');
  const output = {send: vi.fn()};
  const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {throw new Error('Disk unavailable');});
  try {
    const result = await bridge.enqueueInputViaGateway(current.sessionKey, {id: 'failed', command: 'failed', options: {projectPath: current.projectKey, modelSelection: B}}, output);
    expect(result.ok).toBe(false);
    expect(output.send).not.toHaveBeenCalled();
    expect(bridge.getAcceptedModelSelection(current.projectKey, current.sessionKey)).toEqual(A);
    expect(JSON.parse(await readFile(current.queuePath, 'utf8')).lastAcceptedModelSelection.selection).toEqual(A);
  } finally { rename.mockRestore(); }
});

it('removes persisted composer preference and pending inputs when deleting a single session', async () => {
  const current = await fixture();
  await writeFile(current.transcriptPath, 'original');
  bridge.recordAcceptedModelSelection(current.projectKey, current.sessionKey, B, 'accepted');
  gateway = {closeSession: async () => {}};
  expect(await projects.deleteSession(current.projectKey, current.sessionKey)).toBe(true);
  await expect(readFile(current.queuePath)).rejects.toMatchObject({code: 'ENOENT'});
  expect(bridge.getAcceptedModelSelection(current.projectKey, current.sessionKey)).toBeNull();
});
