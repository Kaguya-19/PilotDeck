import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { prepareMinimumStartup } from '../../scripts/run-minimum-staffdeck-startup.mjs';

const loader = resolve('node_modules/tsx/dist/loader.mjs');
const native = pathToFileURL(resolve('ui/server/load-env.js')).href;
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-auth-root-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'pilot-home');
  await mkdir(home);
  return { stateRoot: root, pilotdeckHome: home, pilotdeckAuthDatabasePath: join(home, 'auth.db') };
}
async function nativeDatabase(env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('PILOTDECK_') && !['PILOT_HOME', 'DATABASE_PATH', 'NODE_OPTIONS'].includes(key)));
  const child = spawn(process.execPath, ['--import', loader, '--input-type=module', '-e',
    `await import(${JSON.stringify(native)}); process.stdout.write(JSON.stringify({databasePath:process.env.DATABASE_PATH}));`],
  { env: { ...clean, ...env, NODE_OPTIONS: '' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => stdout += value);
  child.stderr.on('data', value => stderr += value);
  const code = await new Promise(resolveExit => child.on('exit', resolveExit));
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout).databasePath;
}

test('native load-env matches the admitted default home auth root', async t => {
  const config = await fixture(t);
  const env = await prepareMinimumStartup(config, 'pd-bootstrap', { inheritedEnv: {} });
  assert.equal(await nativeDatabase(env), config.pilotdeckAuthDatabasePath);
  const receipt = JSON.parse(await readFile(join(config.stateRoot, 'minimum-pd-auth-root.json'), 'utf8'));
  assert.equal(receipt.databasePath, await nativeDatabase(env));
  await assert.rejects(access(config.pilotdeckAuthDatabasePath)); // probe imports no db and creates no identity
});

test('attempt2 second-path input rejects before writing receipt; real native derivation explains it', async t => {
  const config = await fixture(t);
  const wrong = join(config.stateRoot, 'auth.db');
  assert.equal(await nativeDatabase({ PILOT_HOME: config.pilotdeckHome, DATABASE_PATH: wrong }), config.pilotdeckAuthDatabasePath);
  await assert.rejects(prepareMinimumStartup({ ...config, pilotdeckAuthDatabasePath: wrong }, 'pd-bootstrap',
    { inheritedEnv: {} }), { code: 'STARTUP_AUTH_DATABASE_MISMATCH' });
  await assert.rejects(access(join(config.stateRoot, 'minimum-pd-auth-root.json')));
});

test('explicit native database path in bootstrap profile is used by both guard and load-env', async t => {
  const config = await fixture(t);
  const databasePath = join(config.stateRoot, 'explicit-auth.db');
  const bootstrapProfilePath = join(config.stateRoot, 'bootstrap.json');
  await writeFile(bootstrapProfilePath, JSON.stringify({ webui: { runtime: { databasePath } } }));
  const env = await prepareMinimumStartup({ ...config, bootstrapProfilePath, pilotdeckAuthDatabasePath: databasePath },
    'pd-bootstrap', { inheritedEnv: {} });
  assert.equal(await nativeDatabase(env), databasePath);
  await assert.rejects(access(databasePath));
});

test('inherited profile cannot redirect the bootstrap native auth root', async t => {
  const config = await fixture(t);
  const other = join(config.stateRoot, 'other.json');
  await writeFile(other, JSON.stringify({ webui: { runtime: { databasePath: join(config.stateRoot, 'other-auth.db') } } }));
  const env = await prepareMinimumStartup(config, 'pd-bootstrap', { inheritedEnv: { PILOTDECK_CONFIG_PATH: other } });
  assert.equal(env.PILOTDECK_CONFIG_PATH, undefined);
  assert.equal(await nativeDatabase(env), config.pilotdeckAuthDatabasePath);
});
