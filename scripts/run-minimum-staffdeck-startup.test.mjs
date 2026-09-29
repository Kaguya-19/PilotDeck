import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { prepareMinimumStartup } from './run-minimum-staffdeck-startup.mjs';

const manifest = { status: 'ok', moduleId: 'sop.runtime', contract: 'sop.lifecycle/v2',
  protocolVersion: '2.0', operations: ['prepare', 'submit'] };
const catalog = { data: [{ id: 'p/m', provider: 'p', model: 'm', available: true }],
  defaultSelection: { mode: 'model', provider: 'p', model: 'm' } };
const operations = ['list_model_catalog', 'model_stream', 'file_parse'];
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'minimum-startup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { stateRoot: root, pilotdeckAuthDatabasePath: join(root, 'pilot-home/auth.db'),
    pilotdeckHome: join(root, 'pilot-home'), harnessRoot: join(root, 'harness'),
    preparedBindingsPath: join(root, 'prepared.json'), profilePath: join(root, 'profile.json') };
  await mkdir(config.pilotdeckHome);
  await mkdir(join(config.harnessRoot, 'apps/cli/lib'), { recursive: true });
  await writeFile(join(config.harnessRoot, 'apps/cli/lib/bin.js'), '// built fixture');
  await writeFile(config.pilotdeckAuthDatabasePath, 'fixture auth db');
  const identity = { pilotDeckUserId: '17', tenantId: 'tenant', actorUserId: 'actor', targetAgentId: 'target' };
  const prepared = { readiness: { recordedTupleConsistent: true }, identity, env: {
    PILOTDECK_USER_ID: '17', STAFFDECK_COPY_TENANT_ID: 'tenant', STAFFDECK_COPY_ACTOR_USER_ID: 'actor',
    STAFFDECK_COPY_TARGET_AGENT_ID: 'target', PILOTDECK_GATEWAY_URL: 'ws://127.0.0.1:17711/ws',
    PILOTDECK_GATEWAY_TOKEN_PATH: join(config.pilotdeckHome, 'server-token'),
  } };
  const profile = { agent: { model: 'p/m' }, modules: { sop: {
    endpoint: 'http://127.0.0.1:17712', discoveryAgentId: 'target' }, knowledge: { agentId: 'target' } } };
  const save = async () => {
    await writeFile(config.preparedBindingsPath, JSON.stringify(prepared));
    await writeFile(config.profilePath, JSON.stringify(profile));
  };
  await save();
  await prepareMinimumStartup(config, 'pd-bootstrap', { inheritedEnv: {} });
  await writeFile(prepared.env.PILOTDECK_GATEWAY_TOKEN_PATH, 'fixture-token\n');
  const calls = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ url: String(url), ...options });
    return response(path === '/healthz' ? manifest : path.endsWith('/describe') ? { operations } : catalog);
  };
  return { config, prepared, profile, save, fetchImpl, calls };
}

test('both SD phases gate on the completed Harness CLI artifact before any callback', async t => {
  const f = await fixture(t);
  await rm(join(f.config.harnessRoot, 'apps/cli/lib/bin.js'));
  for (const stage of ['sd-bootstrap', 'sd-enabled']) {
    await assert.rejects(prepareMinimumStartup(f.config, stage, { fetchImpl: f.fetchImpl }),
      { code: 'STARTUP_HARNESS_BUILD_REQUIRED' });
  }
  assert.equal(f.calls.length, 0);
});

test('enabled uses the bootstrap auth root, ignores inherited DB, rejects a second configured DB', async t => {
  const f = await fixture(t);
  const bootstrap = await prepareMinimumStartup(f.config, 'pd-bootstrap', {
    inheritedEnv: { PILOTDECK_CONFIG_PATH: '/old/profile.json' },
  });
  assert.equal(bootstrap.PILOTDECK_CONFIG_PATH, undefined);
  const bootstrapProfilePath = join(f.config.stateRoot, 'bootstrap-profile.json');
  await writeFile(bootstrapProfilePath, '{}');
  const explicit = await prepareMinimumStartup({ ...f.config, bootstrapProfilePath }, 'pd-bootstrap', { inheritedEnv: {} });
  assert.equal(explicit.PILOTDECK_CONFIG_PATH, bootstrapProfilePath);
  const env = await prepareMinimumStartup(f.config, 'pd-enabled', {
    fetchImpl: f.fetchImpl, inheritedEnv: { DATABASE_PATH: '/old/auth.db', PILOTDECK_DISABLE_LOCAL_AUTH: '1' },
  });
  assert.equal(env.DATABASE_PATH, f.config.pilotdeckAuthDatabasePath);
  assert.equal(env.PILOTDECK_DISABLE_LOCAL_AUTH, '0');
  await assert.rejects(prepareMinimumStartup({ ...f.config,
    pilotdeckAuthDatabasePath: join(f.config.stateRoot, 'formal-auth.db') }, 'pd-enabled'),
  { code: 'STARTUP_AUTH_DATABASE_MISMATCH' });
  f.profile.webui = { runtime: { databasePath: join(f.config.stateRoot, 'profile-other.db') } };
  await f.save();
  await assert.rejects(prepareMinimumStartup(f.config, 'pd-enabled', { fetchImpl: f.fetchImpl }),
    { code: 'STARTUP_AUTH_DATABASE_MISMATCH' });
  await assert.rejects(prepareMinimumStartup({ ...f.config,
    environment: { DATABASE_PATH: join(f.config.stateRoot, 'formal-auth.db') } }, 'pd-bootstrap'),
  { code: 'STARTUP_AUTH_DATABASE_MISMATCH' });
});

test('verified tuple and explicit Gateway binding cannot be replaced at startup', async t => {
  const f = await fixture(t);
  for (const environment of [{ PILOTDECK_USER_ID: '18' }, { PILOTDECK_GATEWAY_URL: 'ws://other/ws' },
    { PILOTDECK_GATEWAY_TOKEN_PATH: join(f.config.stateRoot, 'old-token') }]) {
    await assert.rejects(prepareMinimumStartup({ ...f.config, environment }, 'sd-enabled', { fetchImpl: f.fetchImpl }));
  }
  f.prepared.env.PILOTDECK_USER_ID = '18'; await f.save();
  await assert.rejects(prepareMinimumStartup(f.config, 'sd-enabled', { fetchImpl: f.fetchImpl }),
    { code: 'STARTUP_IDENTITY_MISMATCH' });
  assert.equal(f.calls.length, 0);
});

test('missing, empty and foreign-root token fail without accessing Gateway', async t => {
  const f = await fixture(t);
  const tokenPath = f.prepared.env.PILOTDECK_GATEWAY_TOKEN_PATH;
  for (const remove of [true, false]) {
    if (remove) await rm(tokenPath); else await writeFile(tokenPath, ' \n');
    await assert.rejects(prepareMinimumStartup(f.config, 'sd-enabled', { fetchImpl: f.fetchImpl }),
      { code: 'STARTUP_GATEWAY_TOKEN_NOT_READY' });
  }
  f.prepared.env.PILOTDECK_GATEWAY_TOKEN_PATH = join(f.config.stateRoot, 'foreign-token'); await f.save();
  await assert.rejects(prepareMinimumStartup(f.config, 'sd-enabled', { fetchImpl: f.fetchImpl }),
    { code: 'STARTUP_GATEWAY_TOKEN_PATH_MISMATCH' });
  assert.ok(f.calls.every(call => new URL(call.url).pathname === '/healthz'));
});

test('SD DI admission reads real protocol manifest and authenticated selected Port without a model call', async t => {
  const f = await fixture(t); const readiness = {};
  const env = await prepareMinimumStartup(f.config, 'sd-enabled', { inheritedEnv: {}, fetchImpl: f.fetchImpl, readiness });
  assert.equal(env.PILOTDECK_DOMAIN_HOST_ENABLED, 'true');
  assert.deepEqual(f.calls.map(call => new URL(call.url).pathname),
    ['/healthz', '/api/module-host/describe', '/api/module-host/call']);
  for (const call of f.calls.slice(1)) {
    assert.equal(call.headers.authorization, 'Bearer fixture-token');
    assert.deepEqual(JSON.parse(call.body).principal,
      { pilotDeckUserId: '17', tenantId: 'tenant', actorUserId: 'actor', agentId: 'target' });
  }
  assert.equal(JSON.parse(f.calls[2].body).operation, 'list_model_catalog');
  assert.equal(readiness.candidateReady, false);
  assert.deepEqual(readiness.gateway.selected, { id: 'p/m', provider: 'p', model: 'm' });
  assert.ok(!JSON.stringify(readiness).includes('fixture-token'));
});

test('bad manifest, missing required Port, malformed catalog and mismatched profile remain blockers', async t => {
  const f = await fixture(t);
  const check = async (manifestBody, describeBody, catalogBody, code) => {
    const fetchImpl = async url => response(new URL(url).pathname === '/healthz' ? manifestBody
      : new URL(url).pathname.endsWith('/describe') ? describeBody : catalogBody);
    await assert.rejects(prepareMinimumStartup(f.config, 'sd-enabled', { fetchImpl }), { code });
  };
  await check({ status: 'ok' }, { operations }, catalog, 'SOP_RUNTIME_MANIFEST_INVALID');
  await check(manifest, { operations: ['list_model_catalog'] }, catalog, 'STARTUP_REQUIRED_PORT_UNAVAILABLE');
  await check(manifest, { operations }, { data: {} }, 'STARTUP_MODEL_CATALOG_INVALID');
  await check(manifest, { operations }, { data: [] }, 'STARTUP_SELECTED_MODEL_UNAVAILABLE');
  await check(manifest, { operations }, { ...catalog, defaultSelection: { mode: 'auto' } }, 'STARTUP_SELECTED_MODEL_MISMATCH');
  f.profile.agent.model = 'p/other'; await f.save();
  await check(manifest, { operations }, catalog, 'STARTUP_SELECTED_MODEL_MISMATCH');
});

test('Gateway non2xx preserves original problem body; network failure never enables SD', async t => {
  const f = await fixture(t);
  const body = { code: 'ORIGINAL_CODE', detail: 'binding rejected', request_id: 'original-request' };
  await assert.rejects(prepareMinimumStartup(f.config, 'sd-enabled', { fetchImpl: async url =>
    new URL(url).pathname === '/healthz' ? response(manifest) : response(body, 403) }), error => {
    assert.deepEqual(error.receipt, { path: '/api/module-host/describe', status: 403, body });
    return error.code === 'STARTUP_GATEWAY_BINDING_REJECTED';
  });
  await assert.rejects(prepareMinimumStartup(f.config, 'sd-enabled', { fetchImpl: async url => {
    if (new URL(url).pathname === '/healthz') return response(manifest);
    throw new Error('connection refused');
  } }), { code: 'STARTUP_GATEWAY_NOT_READY' });
});

function run(args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}

test('CLI passes the gated bootstrap environment to the process and records preparation separately', async t => {
  const f = await fixture(t);
  const configPath = join(f.config.stateRoot, 'startup.json');
  const outputPath = join(f.config.stateRoot, 'child-env.json');
  f.config.readinessReceiptPath = join(f.config.stateRoot, 'bootstrap-readiness.json');
  await writeFile(configPath, JSON.stringify(f.config));
  const runner = fileURLToPath(new URL('./run-minimum-staffdeck-startup.mjs', import.meta.url));
  const childCode = `require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({
    database:process.env.DATABASE_PATH, home:process.env.PILOT_HOME,
    auth:process.env.PILOTDECK_DISABLE_LOCAL_AUTH, domain:process.env.PILOTDECK_DOMAIN_HOST_ENABLED}))`;
  const result = await run([runner, configPath, 'sd-bootstrap', '--', process.execPath, '-e', childCode]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), { database: f.config.pilotdeckAuthDatabasePath,
    home: f.config.pilotdeckHome, auth: '0', domain: 'false' });
  const receipt = JSON.parse(await readFile(f.config.readinessReceiptPath, 'utf8'));
  assert.equal(receipt.stage, 'sd-bootstrap'); assert.equal(receipt.candidateReady, false);
});

test('CLI never spawns after rejected admission and preserves the first private error receipt', async t => {
  const f = await fixture(t);
  const problem = { code: 'ORIGINAL_403', detail: 'fixed principal refused', request_id: 'raw-request' };
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.statusCode = req.url === '/healthz' ? 200 : 403;
    res.end(JSON.stringify(req.url === '/healthz' ? manifest : problem));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  f.profile.modules.sop.endpoint = origin; f.prepared.env.PILOTDECK_GATEWAY_URL = origin;
  await f.save();
  f.config.failureReceiptPath = join(f.config.stateRoot, 'first-failure.json');
  const configPath = join(f.config.stateRoot, 'startup.json');
  const spawnedPath = join(f.config.stateRoot, 'unexpected-child.txt');
  await writeFile(configPath, JSON.stringify(f.config));
  const runner = fileURLToPath(new URL('./run-minimum-staffdeck-startup.mjs', import.meta.url));
  const childCode = `require('node:fs').writeFileSync(${JSON.stringify(spawnedPath)}, 'started')`;
  const result = await run([runner, configPath, 'sd-enabled', '--', process.execPath, '-e', childCode]);
  assert.equal(result.code, 1); assert.equal(result.stderr.trim(), 'STARTUP_GATEWAY_BINDING_REJECTED');
  await assert.rejects(readFile(spawnedPath), { code: 'ENOENT' });
  const raw = await readFile(f.config.failureReceiptPath, 'utf8');
  assert.deepEqual(JSON.parse(raw), { path: '/api/module-host/describe', status: 403, body: problem });
  await run([runner, configPath, 'sd-enabled', '--', process.execPath, '-e', childCode]);
  assert.equal(await readFile(f.config.failureReceiptPath, 'utf8'), raw);
});
