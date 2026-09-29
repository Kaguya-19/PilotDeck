import { readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verifyPortableSopRuntime } from './compose-limited-staffdeck-profile.mjs';

function requireValue(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}
function statePath(config, name) {
  const value = config[name];
  requireValue(isAbsolute(config.stateRoot ?? '') && isAbsolute(value ?? ''), 'STARTUP_ABSOLUTE_PATH_REQUIRED');
  const child = relative(resolve(config.stateRoot), resolve(value));
  requireValue(child && child !== '..' && !child.startsWith('../') && !isAbsolute(child), 'STARTUP_STATE_PATH_MISMATCH');
  return resolve(value);
}
async function requireFile(path, code) {
  try { requireValue((await stat(path)).isFile(), code); }
  catch { throw Object.assign(new Error(code), { code }); }
}

/** One run's authoritative auth DB is used for bootstrap and enabled processes. */
export async function prepareMinimumStartup(config, stage, {
  fetchImpl = fetch, inheritedEnv = process.env, readiness = {},
} = {}) {
  requireValue(['pd-bootstrap', 'sd-bootstrap', 'pd-enabled', 'sd-enabled'].includes(stage), 'STARTUP_STAGE_INVALID');
  const database = statePath(config, 'pilotdeckAuthDatabasePath');
  const home = statePath(config, 'pilotdeckHome');
  const phaseProfilePath = stage.endsWith('-enabled') ? statePath(config, 'profilePath')
    : config.bootstrapProfilePath ? statePath(config, 'bootstrapProfilePath') : undefined;
  let phaseProfile;
  if (phaseProfilePath) {
    await requireFile(phaseProfilePath, stage.endsWith('-enabled')
      ? 'STARTUP_ENABLED_PROFILE_REQUIRED' : 'STARTUP_BOOTSTRAP_PROFILE_REQUIRED');
    phaseProfile = JSON.parse(await readFile(phaseProfilePath, 'utf8'));
  }
  // ui/server/services/pilotdeckConfig.js derives this value before db.js loads;
  // DATABASE_PATH alone does not override a profile's webui.runtime.databasePath.
  const profileDatabase = phaseProfile?.customEnv?.DATABASE_PATH
    ?? phaseProfile?.webui?.runtime?.databasePath ?? resolve(home, 'auth.db');
  requireValue(isAbsolute(profileDatabase) && resolve(profileDatabase) === database,
    'STARTUP_AUTH_DATABASE_MISMATCH');
  requireValue(!config.environment?.DATABASE_PATH || resolve(config.environment.DATABASE_PATH) === database,
    'STARTUP_AUTH_DATABASE_MISMATCH');
  const authReceiptPath = resolve(config.stateRoot, 'minimum-pd-auth-root.json');
  const authRoot = { databasePath: database, pilotdeckHome: home };
  if (stage === 'pd-bootstrap') {
    try { await writeFile(authReceiptPath, JSON.stringify(authRoot), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const recorded = JSON.parse(await readFile(authReceiptPath, 'utf8'));
      requireValue(recorded.databasePath === database && recorded.pilotdeckHome === home,
        'STARTUP_AUTH_DATABASE_MISMATCH');
    }
  }
  Object.assign(readiness, { stage, databasePath: database, pilotdeckHome: home,
    candidateReady: false, business: 'NOT RUN' });
  const env = { ...inheritedEnv, ...config.environment, DATABASE_PATH: database,
    PILOT_HOME: home, PILOTDECK_DISABLE_LOCAL_AUTH: '0', NODE_ENV: 'production' };
  if (stage.endsWith('-bootstrap')) {
    delete env.PILOTDECK_CONFIG_PATH;
    if (config.bootstrapProfilePath) {
      const bootstrapProfile = statePath(config, 'bootstrapProfilePath');
      await requireFile(bootstrapProfile, 'STARTUP_BOOTSTRAP_PROFILE_REQUIRED');
      env.PILOTDECK_CONFIG_PATH = bootstrapProfile;
    }
  }
  if (stage.startsWith('sd-')) {
    requireValue(isAbsolute(config.harnessRoot ?? ''), 'STARTUP_HARNESS_ROOT_REQUIRED');
    await requireFile(resolve(config.harnessRoot, 'apps/cli/lib/bin.js'), 'STARTUP_HARNESS_BUILD_REQUIRED');
    env.HARNESS_V3_ROOT = resolve(config.harnessRoot);
    env.PILOTDECK_DOMAIN_HOST_ENABLED = 'false';
  }
  if (stage.endsWith('-enabled')) {
    let recorded;
    try { recorded = JSON.parse(await readFile(authReceiptPath, 'utf8')); }
    catch { throw Object.assign(new Error('STARTUP_BOOTSTRAP_AUTH_ROOT_REQUIRED'), { code: 'STARTUP_BOOTSTRAP_AUTH_ROOT_REQUIRED' }); }
    requireValue(recorded.databasePath === database && recorded.pilotdeckHome === home,
      'STARTUP_AUTH_DATABASE_MISMATCH');
    const preparedPath = statePath(config, 'preparedBindingsPath');
    const profilePath = statePath(config, 'profilePath');
    await requireFile(database, 'STARTUP_AUTH_DATABASE_REQUIRED');
    await requireFile(preparedPath, 'STARTUP_PREPARED_BINDINGS_REQUIRED');
    await requireFile(profilePath, 'STARTUP_ENABLED_PROFILE_REQUIRED');
    const prepared = JSON.parse(await readFile(preparedPath, 'utf8'));
    requireValue(prepared?.readiness?.recordedTupleConsistent === true, 'STARTUP_VERIFIED_TUPLE_REQUIRED');
    const identity = prepared.identity;
    for (const [name, field] of [['PILOTDECK_USER_ID', 'pilotDeckUserId'],
      ['STAFFDECK_COPY_TENANT_ID', 'tenantId'], ['STAFFDECK_COPY_ACTOR_USER_ID', 'actorUserId'],
      ['STAFFDECK_COPY_TARGET_AGENT_ID', 'targetAgentId']]) {
      requireValue(typeof identity?.[field] === 'string' && identity[field]
        && prepared.env?.[name] === identity[field], 'STARTUP_IDENTITY_MISMATCH');
      requireValue(config.environment?.[name] === undefined || config.environment[name] === identity[field],
        'STARTUP_IDENTITY_MISMATCH');
    }
    requireValue(prepared.env.DATABASE_PATH === undefined || resolve(prepared.env.DATABASE_PATH) === database,
      'STARTUP_AUTH_DATABASE_MISMATCH');
    for (const name of ['PILOTDECK_GATEWAY_URL', 'PILOTDECK_GATEWAY_TOKEN_PATH']) {
      requireValue(config.environment?.[name] === undefined || config.environment[name] === prepared.env[name],
        'STARTUP_GATEWAY_BINDING_MISMATCH');
    }
    Object.assign(env, prepared.env, { DATABASE_PATH: database, PILOT_HOME: home,
      PILOTDECK_DISABLE_LOCAL_AUTH: '0', PILOTDECK_CONFIG_PATH: profilePath });
    const profile = phaseProfile;
    const manifest = await verifyPortableSopRuntime(profile, fetchImpl);
    requireValue(profile.modules?.sop?.discoveryAgentId === identity.targetAgentId
      && profile.modules?.knowledge?.agentId === identity.targetAgentId,
      'STARTUP_PROFILE_TARGET_MISMATCH');
    Object.assign(readiness, { preparedBindingsPath: preparedPath, profilePath,
      identity: { pilotDeckUserId: identity.pilotDeckUserId, tenantId: identity.tenantId,
        actorUserId: identity.actorUserId, targetAgentId: identity.targetAgentId },
      portable: { endpoint: profile.modules.sop.endpoint, manifest },
      profileModel: profile.agent?.model, bootstrapAuthRootMatched: true });
    if (stage === 'sd-enabled') {
      const tokenPath = resolve(home, 'server-token');
      requireValue(env.PILOTDECK_GATEWAY_TOKEN_PATH === tokenPath, 'STARTUP_GATEWAY_TOKEN_PATH_MISMATCH');
      let token;
      try { token = (await readFile(tokenPath, 'utf8')).trim(); }
      catch { throw Object.assign(new Error('STARTUP_GATEWAY_TOKEN_NOT_READY'), { code: 'STARTUP_GATEWAY_TOKEN_NOT_READY' }); }
      requireValue(token, 'STARTUP_GATEWAY_TOKEN_NOT_READY');
      const gateway = new URL(env.PILOTDECK_GATEWAY_URL);
      requireValue(['ws:', 'wss:', 'http:', 'https:'].includes(gateway.protocol)
        && !gateway.username && !gateway.password && !gateway.search && !gateway.hash
        && ['', '/', '/ws'].includes(gateway.pathname), 'STARTUP_GATEWAY_ORIGIN_INVALID');
      gateway.protocol = gateway.protocol === 'wss:' ? 'https:' : gateway.protocol === 'ws:' ? 'http:' : gateway.protocol;
      const principal = { pilotDeckUserId: identity.pilotDeckUserId, tenantId: identity.tenantId,
        actorUserId: identity.actorUserId, agentId: identity.targetAgentId };
      async function gatewayRead(path, payload) {
        gateway.pathname = path;
        let response;
        try {
          response = await fetchImpl(new URL(gateway), { method: 'POST', signal: AbortSignal.timeout(5000),
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ ...payload, principal }) });
        } catch { throw Object.assign(new Error('STARTUP_GATEWAY_NOT_READY'), { code: 'STARTUP_GATEWAY_NOT_READY' }); }
        const body = await response.json().catch(() => null);
        if (!response.ok) throw Object.assign(new Error('STARTUP_GATEWAY_BINDING_REJECTED'), {
          code: 'STARTUP_GATEWAY_BINDING_REJECTED', receipt: { path, status: response.status, body },
        });
        return { status: response.status, body };
      }
      const description = await gatewayRead('/api/module-host/describe', {});
      requireValue(Array.isArray(description.body?.operations)
        && ['list_model_catalog', 'model_stream', 'file_parse'].every(operation => description.body.operations.includes(operation)),
        'STARTUP_REQUIRED_PORT_UNAVAILABLE');
      const { status, body } = await gatewayRead('/api/module-host/call', { operation: 'list_model_catalog', input: {} });
      requireValue(Array.isArray(body?.data), 'STARTUP_MODEL_CATALOG_INVALID');
      const available = body.data.filter(item => item && (item.available === true || (item.available === undefined && item.enabled === true)));
      requireValue(available?.length === 1, 'STARTUP_SELECTED_MODEL_UNAVAILABLE');
      const selected = available[0];
      requireValue(typeof selected.provider === 'string' && selected.provider
        && typeof selected.model === 'string' && selected.model
        && selected.id === `${selected.provider}/${selected.model}` && profile.agent?.model === selected.id
        && (body.defaultSelection ? body.defaultSelection.mode === 'model' && body.defaultSelection.provider === selected.provider
          && body.defaultSelection.model === selected.model : selected.is_default === true),
        'STARTUP_SELECTED_MODEL_MISMATCH');
      env.PILOTDECK_DOMAIN_HOST_ENABLED = 'true';
      readiness.gateway = { origin: gateway.origin, tokenPath, tokenReadable: true,
        describe: { status: description.status, operations: description.body.operations },
        authenticatedCatalogStatus: status, operation: 'list_model_catalog',
        selected: { id: selected.id, provider: selected.provider, model: selected.model },
        principal };
    }
  }
  return env;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let config;
  try {
    requireValue(process.argv[4] === '--' && process.argv.length >= 6, 'STARTUP_USAGE');
    config = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const readiness = {};
    const env = await prepareMinimumStartup(config, process.argv[3], { readiness });
    if (config.readinessReceiptPath) {
      await writeFile(statePath(config, 'readinessReceiptPath'), `${JSON.stringify(readiness, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 });
    }
    const child = spawn(process.argv[5], process.argv.slice(6), { env, stdio: 'inherit' });
    child.once('error', () => { process.stderr.write('STARTUP_COMMAND_FAILED\n'); process.exitCode = 1; });
    child.once('exit', code => { process.exitCode = code ?? 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  } catch (error) {
    if (error.receipt && config?.failureReceiptPath) {
      try { await writeFile(statePath(config, 'failureReceiptPath'), JSON.stringify(error.receipt), { flag: 'wx', mode: 0o600 }); }
      catch { /* Keep the original startup failure; never overwrite an earlier receipt. */ }
    }
    process.stderr.write(`${error.code ?? 'STARTUP_INPUT_INVALID'}\n`);
    process.exitCode = 1;
  }
}
