#!/usr/bin/env node

/**
 * Browser-level seven-state composition matrix.
 *
 * Each state gets its own generated frontend entrypoint. The default mock mode
 * supplies deterministic shell responses, while --mode=real starts the actual
 * PilotDeck server/Vite/runtime projection and authenticates through its JWT
 * API. Both modes exercise the real browser router, settings composition,
 * legacy redirects, chat surface, and request contract.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { stringify as stringifyYaml } from 'yaml';
import { renderGeneratedEntrypoint } from './generate-frontend-modules.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const uiRoot = resolve(root, 'ui');
const generatedPath = resolve(uiRoot, 'src/composition/generated/frontend-modules.ts');
const artifactRoot = resolve(process.env.G3_ARTIFACT_ROOT || resolve(root, 'test-results/frontend-g3-browser-matrix'));
const mode = process.argv.includes('--mode=real') ? 'real' : 'mock';
const vitePortBase = Number(process.env.G3_VITE_PORT_BASE || 16300);
const serverPortBase = Number(process.env.G3_SERVER_PORT_BASE || 16330);
const gatewayPortBase = Number(process.env.G3_GATEWAY_PORT_BASE || 16360);

const core = {
  agentLoop: { enabled: true, provider: 'pilotdeck' },
  skills: { enabled: true, provider: 'pilotdeck' },
  tools: { enabled: true, provider: 'pilotdeck' },
  context: { enabled: true, provider: 'pilotdeck' },
  modelProvider: { enabled: true, provider: 'pilotdeck' },
};
const staffdeckSlots = {
  ...core,
  sop: {
    enabled: true,
    implementationId: 'staffdeck.portable-sop',
    contract: 'sop.lifecycle/v2',
    transport: 'sop-http-v2',
    methods: ['prepare', 'submit'],
  },
  knowledge: {
    enabled: true,
    implementationId: 'staffdeck.knowledge',
    contract: 'staffdeck.knowledge/v1',
    transport: 'module-http-v2',
    methods: ['list_bases', 'import_document', 'get_job', 'update_document', 'query', 'resolve_citation'],
  },
};
const minimalSlots = {
  ...core,
  skills: { enabled: false },
  sop: { enabled: false },
  knowledge: { enabled: false },
};

const replacementKnowledgeSlots = {
  ...core,
  skills: { enabled: false },
  knowledge: {
    enabled: true,
    implementationId: 'replacement.knowledge',
    frontendModule: 'fixture.knowledge-search',
    contract: 'staffdeck.knowledge/v1',
    transport: 'module-http-v2',
    methods: ['query', 'resolve_citation'],
  },
};

const states = [
  {
    id: 'native-routing-installed-off', modules: core, routingInstalled: true, routingEnabled: false,
    permissionsInstalled: true, expectedKnowledge: false, expectedSop: false,
  },
  {
    id: 'native-routing-enabled', modules: core, routingInstalled: true, routingEnabled: true,
    permissionsInstalled: true, expectedKnowledge: false, expectedSop: false,
  },
  {
    id: 'staffdeck-routing-installed-off', modules: staffdeckSlots, routingInstalled: true, routingEnabled: false,
    permissionsInstalled: true, expectedKnowledge: true, expectedSop: true,
  },
  {
    id: 'staffdeck-routing-enabled', modules: staffdeckSlots, routingInstalled: true, routingEnabled: true,
    permissionsInstalled: true, expectedKnowledge: true, expectedSop: true,
  },
  {
    id: 'minimal-routing-installed-off', modules: minimalSlots, routingInstalled: false, routingEnabled: false,
    permissionsInstalled: false, expectedKnowledge: false, expectedSop: false,
  },
  {
    id: 'minimal-routing-enabled', modules: minimalSlots, routingInstalled: false, routingEnabled: false,
    permissionsInstalled: false, expectedKnowledge: false, expectedSop: false,
  },
  {
    id: 'replacement-knowledge-enabled', modules: replacementKnowledgeSlots, routingInstalled: false, routingEnabled: false,
    permissionsInstalled: true, expectedKnowledge: false, expectedSop: false, replacement: true,
  },
].map((state) => ({
  ...state,
  frontend: { businessModules: {
    ...(state.routingInstalled ? { 'agent.routing': { enabled: true } } : {}),
    'tools.permissions': { enabled: state.permissionsInstalled },
  } },
  expectedRoutingSettings: state.routingInstalled,
  expectedPermissions: state.permissionsInstalled,
}));
const requestedState = process.env.G3_STATE;
const matrixStates = requestedState ? states.filter((state) => state.id === requestedState) : states;
if (requestedState && matrixStates.length === 0) throw new Error(`Unknown G3_STATE: ${requestedState}`);

const slotContracts = {
  agentLoop: 'pilotdeck.agent-loop/v1',
  skills: 'pilotdeck.skills/v1',
  tools: 'pilotdeck.tools/v1',
  context: 'pilotdeck.context/v1',
  modelProvider: 'pilotdeck.model-provider/v1',
  sop: 'sop.lifecycle/v2',
  knowledge: 'staffdeck.knowledge/v1',
};
const slotTransports = {
  agentLoop: 'pilotdeck-http-v1',
  skills: 'pilotdeck-http-v1',
  tools: 'pilotdeck-http-v1',
  context: 'pilotdeck-http-v1',
  modelProvider: 'pilotdeck-http-v1',
  sop: 'sop-http-v2',
  knowledge: 'module-http-v2',
};
const slotMethods = {
  agentLoop: ['execute', 'cancel', 'status', 'resume', 'ack'],
  skills: ['list', 'read'],
  tools: ['execute'],
  context: ['prepare_for_model', 'apply_tool_results', 'try_auto_compact'],
  modelProvider: ['prepare', 'stream'],
  sop: ['prepare', 'submit', 'status', 'resume'],
  knowledge: ['list_bases', 'import_document', 'get_job', 'update_document', 'query', 'resolve_citation'],
};

function runtimeFor(modules) {
  const result = {};
  for (const [slot, binding] of Object.entries(modules)) {
    result[slot] = {
      enabled: binding.enabled !== false,
      provider: binding.provider,
      implementationId: binding.implementationId,
      frontendModule: binding.frontendModule,
      contract: binding.contract ?? slotContracts[slot],
      transport: binding.transport ?? slotTransports[slot],
      methods: binding.methods ?? slotMethods[slot],
    };
  }
  for (const slot of Object.keys(slotContracts)) {
    if (!result[slot]) result[slot] = { enabled: false };
  }
  return {
    modules: result,
    gatewayCapabilities: ['chat', 'permissions'],
    runtime: { gatewayState: 'ready', unavailableSlots: [] },
  };
}

function findRuntimeMismatches(actual, expected) {
  const mismatches = [];
  for (const [slot, expectedBinding] of Object.entries(expected.modules)) {
    const actualBinding = actual?.modules?.[slot];
    for (const field of ['enabled', 'provider', 'implementationId', 'frontendModule', 'contract', 'transport', 'methods']) {
      const expectedValue = expectedBinding[field];
      if (expectedValue === undefined) continue;
      const actualValue = actualBinding?.[field];
      if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
        mismatches.push({ slot, field, expected: expectedValue, actual: actualValue });
      }
    }
  }
  return mismatches;
}

function runtimeExpectedFor(modules) {
  const expected = runtimeFor(modules);
  for (const [slot, binding] of Object.entries(modules)) {
    const expectedBinding = expected.modules[slot];
    for (const field of ['contract', 'transport', 'methods']) {
      if (binding[field] === undefined) delete expectedBinding[field];
    }
  }
  return expected;
}

const sharedSettingsRequestPaths = new Set([
  '/api/auth/status', '/api/auth/user', '/api/config', '/api/commands/list',
  '/api/models', '/api/agents/runtime-config', '/api/modules/runtime',
  '/api/mcp-utils/taskmaster-server', '/api/plugins', '/api/projects', '/api/settings/permissions',
  '/api/taskmaster/installation-status', '/api/taskmaster/tasks/general',
  '/api/user/onboarding-status', '/api/user/runtime-status',
]);

function waitForHttp(url, timeoutMs = 20_000) {
  const started = Date.now();
  return new Promise((resolveWait, reject) => {
    const poll = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) return resolveWait();
      } catch {}
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out waiting for ${url}`));
      setTimeout(poll, 100);
    };
    void poll();
  });
}

function start(command, args, env, { detached = false, cwd = uiRoot } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  return { child, detached, getOutput: () => output };
}

async function installLifecycleProbe(page) {
  await page.addInitScript(() => {
    const trackedEvents = new Set([
      'staffdeck-capability-catalog-refresh',
      'ultrarag-enterprise-agent-scope-change',
    ]);
    const documentId = crypto.randomUUID();
    const probeId = crypto.randomUUID();
    const intervals = new Map();
    const timeouts = new Map();
    const subscriptions = new Map();
    const originalSetInterval = window.setInterval.bind(window);
    const originalClearInterval = window.clearInterval.bind(window);
    const originalSetTimeout = window.setTimeout.bind(window);
    const originalClearTimeout = window.clearTimeout.bind(window);
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    const originalRemoveEventListener = EventTarget.prototype.removeEventListener;
    const captureOf = (options) => typeof options === 'boolean' ? options : Boolean(options?.capture);
    const targetName = (target) => target === window ? 'window' : target === document ? 'document' : 'other';
    const ownerOf = (stack) => stack?.split('\n').find((line) => line.includes('/src/')) || '';

    window.setInterval = ((handler, timeout, ...args) => {
      const id = originalSetInterval(handler, timeout, ...args);
      const stack = new Error().stack;
      intervals.set(id, { identity: crypto.randomUUID(), stack, owner: ownerOf(stack) });
      return id;
    });
    window.clearInterval = ((id) => {
      intervals.delete(id);
      return originalClearInterval(id);
    });
    window.setTimeout = ((handler, timeout, ...args) => {
      let id;
      const wrapped = typeof handler === 'function'
        ? (...handlerArgs) => {
          timeouts.delete(id);
          handler(...handlerArgs);
        }
        : handler;
      id = originalSetTimeout(wrapped, timeout, ...args);
      const stack = new Error().stack;
      timeouts.set(id, { identity: crypto.randomUUID(), stack, owner: ownerOf(stack) });
      return id;
    });
    window.clearTimeout = ((id) => {
      timeouts.delete(id);
      return originalClearTimeout(id);
    });
    EventTarget.prototype.addEventListener = function addTrackedEventListener(type, listener, options) {
      if (trackedEvents.has(type) && listener) {
        const key = `${targetName(this)}:${type}:${captureOf(options)}`;
        const entries = subscriptions.get(key) ?? [];
        entries.push({ listener, identity: crypto.randomUUID() });
        subscriptions.set(key, entries);
      }
      return originalAddEventListener.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function removeTrackedEventListener(type, listener, options) {
      if (trackedEvents.has(type) && listener) {
        const key = `${targetName(this)}:${type}:${captureOf(options)}`;
        const entries = subscriptions.get(key) ?? [];
        const index = entries.findIndex((entry) => entry.listener === listener);
        if (index >= 0) entries.splice(index, 1);
        if (entries.length === 0) subscriptions.delete(key);
        else subscriptions.set(key, entries);
      }
      return originalRemoveEventListener.call(this, type, listener, options);
    };
    window.__pilotdeckG3LifecycleSnapshot = () => ({
      documentId,
      probeId,
      intervals: [...intervals.values()].map((entry) => entry.identity).sort(),
      timeouts: [...timeouts.values()].map((entry) => entry.identity).sort(),
      intervalDetails: [...intervals.values()].sort((left, right) => left.identity.localeCompare(right.identity)),
      timeoutDetails: [...timeouts.values()].sort((left, right) => left.identity.localeCompare(right.identity)),
      staffdeckIntervals: [...intervals.values()].filter((entry) => entry.owner.includes('/composition/modules/staffdeck/')).map((entry) => entry.identity).sort(),
      staffdeckTimeouts: [...timeouts.values()].filter((entry) => entry.owner.includes('/composition/modules/staffdeck/')).map((entry) => entry.identity).sort(),
      subscriptions: Object.fromEntries([...subscriptions.entries()].map(([key, entries]) => [key, entries.map((entry) => entry.identity).sort()])),
    });
  });
}

function lifecycleRestored(before, after) {
  return Boolean(before.documentId && before.probeId)
    && before.documentId === after.documentId
    && before.probeId === after.probeId
    && JSON.stringify(after.staffdeckIntervals) === JSON.stringify(before.staffdeckIntervals)
    && JSON.stringify(after.staffdeckTimeouts) === JSON.stringify(before.staffdeckTimeouts)
    && JSON.stringify(after.subscriptions) === JSON.stringify(before.subscriptions);
}

function lifecycleMounted(before, mounted) {
  const mountedSubscriptions = Object.values(mounted.subscriptions).flat();
  return before.documentId === mounted.documentId
    && before.probeId === mounted.probeId
    && (mounted.staffdeckIntervals.length > before.staffdeckIntervals.length
      || mounted.staffdeckTimeouts.length > before.staffdeckTimeouts.length
      || mountedSubscriptions.length > Object.values(before.subscriptions).flat().length);
}

async function stop(processHandle) {
  if (!processHandle || processHandle.child.exitCode !== null) return;
  if (processHandle.detached) {
    try { process.kill(-processHandle.child.pid, 'SIGTERM'); } catch {}
  } else processHandle.child.kill('SIGTERM');
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      if (processHandle.child.exitCode === null) processHandle.child.kill('SIGKILL');
      resolveStop();
    }, 2_000);
    processHandle.child.once('exit', () => { clearTimeout(timer); resolveStop(); });
  });
}

async function startStaffDeckServices(state, stateRoot, realModules) {
  if (mode !== 'real') return [];
  const staffRoot = process.env.STAFFDECK_ROOT || resolve(root, '../StaffDeck-shared-business-ui');
  const python = process.env.STAFFDECK_PYTHON || '/tmp/staffdeck-shared-venv/bin/python';
  const services = [];
  const baseEnv = {
    ...process.env,
    PYTHONPATH: `${resolve(staffRoot, 'backend')}:${resolve(staffRoot, 'backend/src')}:${resolve(staffRoot, 'portable_sop/src')}`,
  };
  if (realModules.knowledge?.enabled && realModules.knowledge.frontendModule === 'fixture.knowledge-search') {
    const port = 19993;
    const evidencePath = resolve(stateRoot, 'replacement-evidence.jsonl');
    const replacement = start(process.execPath, [resolve(root, 'products/pilotdeck-staffdeck-sop/fixtures/replacement-knowledge-runtime.mjs')], {
      ...process.env,
      REPLACEMENT_KNOWLEDGE_PORT: String(port),
      REPLACEMENT_KNOWLEDGE_EVIDENCE_PATH: evidencePath,
    });
    services.push(replacement);
    await waitForHttp(`http://127.0.0.1:${port}/healthz`);
    realModules.knowledge.endpoint = `http://127.0.0.1:${port}`;
  } else if (realModules.knowledge?.enabled) {
    const port = 19990;
    const database = resolve(stateRoot, 'knowledge.db');
    const knowledge = start(python, ['-m', 'uvicorn', 'app.module_knowledge_app:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'], {
      ...baseEnv,
      DATABASE_URL: `sqlite:///${database}`,
      APP_SECRET: 'g3-real-browser-secret',
      STAFFDECK_KNOWLEDGE_SEED: 'true',
      STAFFDECK_KNOWLEDGE_USER_ID: 'admin',
    }, { cwd: resolve(staffRoot, 'backend') });
    services.push(knowledge);
    await waitForHttp(`http://127.0.0.1:${port}/api/health`);
    realModules.knowledge.endpoint = `http://127.0.0.1:${port}`;
  }
  if (realModules.sop?.enabled) {
    const port = 19991;
    const sop = start(python, ['-m', 'uvicorn', 'staffdeck_sop_runtime.api:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'], baseEnv, { cwd: staffRoot });
    services.push(sop);
    await waitForHttp(`http://127.0.0.1:${port}/healthz`);
    realModules.sop.endpoint = `http://127.0.0.1:${port}`;
  }
  return services;
}

async function runState(state, index, browser) {
  const stateRoot = resolve(artifactRoot, state.id);
  const distDir = resolve(stateRoot, 'dist');
  await rm(stateRoot, { recursive: true, force: true });
  await mkdir(stateRoot, { recursive: true });
  const source = renderGeneratedEntrypoint(
    { modules: state.modules, frontend: state.frontend },
    generatedPath,
  );
  await writeFile(generatedPath, source, 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

  const build = start('pnpm', ['exec', 'vite', 'build', '--outDir', distDir, '--logLevel', 'error'], {
    ...process.env,
    NODE_OPTIONS: '',
    PILOTDECK_DISABLE_LOCAL_AUTH: '1',
  });
  const buildExit = await new Promise((resolveBuild, rejectBuild) => {
    build.child.once('exit', (code) => code === 0 ? resolveBuild() : rejectBuild(new Error(`Vite build failed for ${state.id}: ${build.getOutput()}`)));
    build.child.once('error', rejectBuild);
  });
  void buildExit;
    const port = vitePortBase + index;
    const serverPort = serverPortBase + index;
    const gatewayPort = gatewayPortBase + index;
  const realRoot = resolve(stateRoot, 'pilot-home');
  await mkdir(realRoot, { recursive: true });
  const profilePath = resolve(stateRoot, 'profile.yaml');
  const auxiliaryServices = [];
  const realModules = JSON.parse(JSON.stringify(state.modules));
  if (realModules.sop?.enabled) {
    realModules.sop.endpoint = 'http://127.0.0.1:19991';
    realModules.sop.definitionsPath = resolve(stateRoot, 'sops.yaml');
    realModules.sop.defaultSopId = 'g3_probe';
    await writeFile(realModules.sop.definitionsPath, 'sops:\n  - id: g3_probe\n    version: "1"\n    name: G3 probe\n    content:\n      start_node_id: done\n      nodes:\n        - node_id: done\n      terminal_node_ids: [done]\n', 'utf8');
  }
  if (realModules.knowledge?.enabled) {
    realModules.knowledge.tenantId = 'tenant_demo';
    realModules.knowledge.actorUserId = 'admin';
  }
  auxiliaryServices.push(...await startStaffDeckServices(state, stateRoot, realModules));
  await writeFile(profilePath, stringifyYaml({
    schemaVersion: 1,
    agent: { model: 'smoke/operator' },
    model: { providers: { smoke: { protocol: 'openai', url: 'http://127.0.0.1:19992/v1', apiKey: 'local-only', models: { operator: { capabilities: { supportsToolUse: true } } } } } },
    webui: { runtime: { serverPort, vitePort: port, databasePath: resolve(realRoot, 'auth.db'), workspacesRoot: resolve(realRoot, 'workspaces') } },
    modules: realModules,
    router: { enabled: state.routingEnabled },
    frontend: state.frontend,
  }), 'utf8');
  const service = mode === 'real'
    ? start(process.execPath, [resolve(root, 'scripts/dev-launcher.mjs')], {
      ...process.env,
      NODE_OPTIONS: '',
      PILOT_HOME: realRoot,
      PILOTDECK_CONFIG_PATH: profilePath,
      PILOTDECK_FRONTEND_PROFILE: profilePath,
      PILOTDECK_DISABLE_LOCAL_AUTH: '0',
      SERVER_PORT: String(serverPort),
      VITE_PORT: String(port),
      PILOTDECK_GATEWAY_PORT: String(gatewayPort),
      PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${gatewayPort}/ws`,
    }, { detached: true })
    : start('pnpm', ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--outDir', distDir], {
      ...process.env,
      NODE_OPTIONS: '',
      PILOTDECK_DISABLE_LOCAL_AUTH: '1',
    });
  const baseURL = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${baseURL}/`);
    if (mode === 'real') await waitForHttp(`${baseURL}/api/auth/status`);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await installLifecycleProbe(page);
    let currentProbe = 'initial';
    const requests = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, method: request.method(), body: request.postDataJSON?.() ?? null, probe: currentProbe });
    });
    if (mode === 'mock') {
      await page.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        if (path === '/api/modules/runtime') {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(runtimeFor(state.modules)) });
        }
        if (path === '/api/auth/status') {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authDisabled: true }) });
        }
        if (path === '/api/user/onboarding-status' || path === '/api/user/runtime-status') {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configuration: { state: 'empty', modelRef: '', configPath: null, revision: '' }, gateway: { state: 'ready' } }) });
        }
        if (path === '/api/projects') {
          return route.fulfill({ status: 200, headers: { 'X-Projects-Revision': '1' }, contentType: 'application/json', body: JSON.stringify([{ name: 'general', displayName: 'General', fullPath: '/tmp/general', kind: 'general', sessions: [], sessionMeta: { total: 0, hasMore: false }, capabilities: { files: true, explore: true } }]) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
      });
    } else {
      const credentials = { username: `g3-${state.id}`, password: 'g3-browser-evidence-password' };
      const registration = await context.request.post(`${baseURL}/api/auth/register`, { data: credentials });
      const account = registration.ok()
        ? await registration.json()
        : await (await context.request.post(`${baseURL}/api/auth/login`, { data: credentials })).json();
      assert.equal(typeof account.token, 'string', `${state.id}: real authentication did not return JWT`);
      await context.request.post(`${baseURL}/api/user/complete-onboarding`, { headers: { authorization: `Bearer ${account.token}` } });
      await page.addInitScript((token) => localStorage.setItem('auth-token', token), account.token);
    }

    await page.addInitScript(() => localStorage.setItem('userLanguage', 'zh-CN'));
    currentProbe = 'home';
    const runtimeResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/modules/runtime', { timeout: 15_000 });
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    const runtimeResult = await runtimeResponse;
    assert.equal(runtimeResult.status(), 200, `${state.id}: runtime projection failed`);
    const runtimeProjection = await runtimeResult.json();
    const expectedRuntime = runtimeExpectedFor(state.modules);
    const runtimeMismatches = findRuntimeMismatches(runtimeProjection, expectedRuntime);
    assert.deepEqual(runtimeMismatches, [], `${state.id}: actual runtime projection differs from the independently expected profile`);
    await page.waitForTimeout(600);
    const chatSurface = await page.locator('textarea').count() > 0 || await page.locator('[data-chat-composer-slot]').count() > 0;
    if (!chatSurface && state.replacement) {
      throw new Error(`${state.id}: replacement profile did not render chat surface at ${page.url()}\n${(await page.locator('body').innerText().catch(() => '')).slice(0, 2000)}`);
    }
    assert.equal(chatSurface, true, `${state.id}: chat surface not rendered`);

    const settingsEffects = [];
    for (const { section, expected, label } of [
      { section: 'agent-route', expected: state.expectedRoutingSettings, label: 'agent route' },
      { section: 'tools-permissions', expected: state.expectedPermissions, label: 'tool permissions' },
      { section: 'sop', expected: Boolean(state.modules.sop?.enabled), label: 'SOP' },
      { section: 'knowledge', expected: Boolean(state.modules.knowledge?.enabled), label: 'knowledge' },
    ]) {
      currentProbe = `settings-${section}`;
      const beforeRequestCount = requests.length;
      await page.goto(`${baseURL}/settings/module/${section}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(250);
      const settingsPresent = await page.locator(`[data-testid="module-settings-${section}"]`).count() > 0;
      const unavailablePresent = await page.locator(`[data-testid="module-settings-unavailable-${section}"]`).count() > 0;
      assert.equal(settingsPresent, expected, `${state.id}: ${label} settings mismatch`);
      assert.equal(unavailablePresent, !expected, `${state.id}: ${label} unavailable mismatch`);
      if (section === 'agent-route' && state.routingInstalled && mode === 'real') {
        const routingSwitch = page.getByRole('switch', { name: /智能路由|smart routing/i });
        await routingSwitch.waitFor({ state: 'visible' });
        assert.equal(await routingSwitch.getAttribute('aria-checked'), String(state.routingEnabled), `${state.id}: routing runtime switch mismatch`);
      }
      const requestDelta = requests.slice(beforeRequestCount);
      const unloadedPrefixes = [
        ...(!state.modules.sop?.enabled ? ['/api/modules/sop/'] : []),
        ...(!state.modules.knowledge?.enabled ? ['/api/modules/knowledge/'] : []),
      ];
      const unloadedModuleRequests = requestDelta.filter((item) => unloadedPrefixes.some((prefix) => item.path.startsWith(prefix)));
      const sharedHostRequests = requestDelta.filter((item) => sharedSettingsRequestPaths.has(item.path));
      const unexpectedRequests = requestDelta.filter((item) => !sharedSettingsRequestPaths.has(item.path) && !unloadedModuleRequests.includes(item));
      assert.equal(unloadedModuleRequests.length, 0, `${state.id}: absent ${section} settings form triggered an unloaded module request`);
      settingsEffects.push({
        section,
        expected,
        settingsPresent,
        unavailablePresent,
        sharedHostRequests: sharedHostRequests.map((item) => item.path),
        unloadedModuleRequests,
        unexpectedRequests,
      });
    }

    for (const [path, placeholder, enabled] of [
      ...(state.replacement ? [['/knowledge-search', 'Search the replacement knowledge service', true]] : []),
      ['/sop', '搜索 SOP 名称、ID、业务域', Boolean(state.modules.sop?.enabled)],
      ['/knowledge', '输入知识问题', Boolean(state.modules.knowledge?.enabled && !state.replacement)],
    ]) {
      currentProbe = `route:${path}`;
      await page.goto(`${baseURL}${path}`, { waitUntil: 'domcontentloaded' });
      // A replacement module is selected asynchronously by the runtime
      // projection. If the first deep link arrives before the shell has
      // assembled its page table, use the rendered sidebar control so the
      // second attempt follows the real client-side route.
      if (mode === 'real' && state.replacement && new URL(page.url()).pathname !== path) {
        const replacementNav = page.locator('nav.primary-actions button').filter({ hasText: /Knowledge search/ }).first();
        await replacementNav.waitFor({ state: 'visible', timeout: 15_000 });
        await replacementNav.click();
      }
      if (mode === 'real' && enabled) {
        try {
          await page.getByPlaceholder(placeholder).first().waitFor({ state: 'visible', timeout: 15_000 });
        } catch (error) {
          const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 1600);
          const serviceOutput = auxiliaryServices.map((item) => item.getOutput()).join('\n').slice(-4000);
          throw new Error(`${state.id}: ${path} did not mount (url=${page.url()})\n${bodyText}\nservices:\n${serviceOutput}`, { cause: error });
        }
      } else {
        await page.waitForTimeout(300);
      }
      const present = await page.getByPlaceholder(placeholder).count() > 0;
      const routeVisible = new URL(page.url()).pathname === path;
      if (mode === 'real' && enabled) assert.equal(routeVisible, true, `${state.id}: ${path} route did not mount`);
      else if (mode === 'real') assert.equal(present, false, `${state.id}: disabled ${path} route exposed its page`);
      else if (enabled) assert.equal(routeVisible, true, `${state.id}: ${path} route did not mount in mock mode`);
      else assert.ok(['/','/p/general'].includes(new URL(page.url()).pathname), `${state.id}: disabled ${path} route leaked in mock mode`);
    }

    const legacy = {};
    for (const path of ['/always-on', '/cron', '/memory']) {
      currentProbe = `legacy:${path}`;
      await page.goto(`${baseURL}${path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(250);
      legacy[path] = new URL(page.url()).pathname;
      assert.ok(['/','/p/general'].includes(legacy[path]), `${state.id}: legacy route ${path} was not redirected`);
    }

    const forbiddenOptionalPaths = [
      ...(!state.modules.sop?.enabled ? ['/api/modules/sop/'] : []),
      ...(!state.modules.knowledge?.enabled ? ['/api/modules/knowledge/'] : []),
    ];
    const forbiddenOptionalRequests = forbiddenOptionalPaths.map((prefix) => ({
      prefix,
      requests: requests.filter((item) => item.path.startsWith(prefix)),
    }));
    for (const assertion of forbiddenOptionalRequests) {
      assert.equal(assertion.requests.length, 0, `${state.id}: unloaded module request leaked: ${assertion.prefix}`);
    }
    const settingsOptionalRequests = requests.filter((item) => (
      item.probe.startsWith('settings-')
      && forbiddenOptionalPaths.some((prefix) => item.path.startsWith(prefix))
    ));
    assert.equal(settingsOptionalRequests.length, 0, `${state.id}: unloaded module request leaked from Settings.`);

    let lifecycle = { status: 'not-applicable', reason: 'No mounted StaffDeck Distill surface in this state.' };
    if (mode === 'real' && state.modules.sop?.enabled) {
      // Use the shell's client-side controls so the React tree stays in one
      // document. A page.goto here would recreate the probe and make timer IDs
      // look clean even when the component leaked resources.
      const documentBeforeLifecycle = await page.evaluate(() => ({
        documentId: window.__pilotdeckG3LifecycleSnapshot?.().documentId,
        probeId: window.__pilotdeckG3LifecycleSnapshot?.().probeId,
      }));
      const homeButton = page.locator('nav.primary-actions button').filter({ hasText: /新对话|New conversation/ }).first();
      await homeButton.click();
      await page.waitForURL((url) => ['/','/p/general'].includes(url.pathname), { timeout: 5_000 });
      await page.waitForTimeout(700);
      const documentAfterHome = await page.evaluate(() => ({
        documentId: window.__pilotdeckG3LifecycleSnapshot?.().documentId,
        probeId: window.__pilotdeckG3LifecycleSnapshot?.().probeId,
      }));
      assert.deepEqual(documentAfterHome, documentBeforeLifecycle, `${state.id}: shell home navigation recreated the document/probe`);
      currentProbe = 'lifecycle-before';
      const before = await page.evaluate(() => window.__pilotdeckG3LifecycleSnapshot?.() ?? null);
      currentProbe = 'lifecycle-mount';
      const workflowButtons = page.locator('nav.primary-actions button[aria-pressed]').filter({ hasText: /工作流|Workflow/ });
      assert.ok(await workflowButtons.count() >= 2, `${state.id}: StaffDeck workflow navigation controls were not rendered`);
      await workflowButtons.last().click();
      await page.waitForURL((url) => url.pathname === '/sop/distill', { timeout: 5_000 });
      await page.waitForTimeout(700);
      assert.equal(new URL(page.url()).pathname, '/sop/distill', `${state.id}: lifecycle probe route did not mount`);
      assert.ok(await page.locator('textarea').count() > 0, `${state.id}: StaffDeck Distill component did not mount in the existing document`);
      const mounted = await page.evaluate(() => window.__pilotdeckG3LifecycleSnapshot?.() ?? null);
      assert.equal(lifecycleMounted(before, mounted), true, `${state.id}: lifecycle mount did not create a distinct resource identity`);
      const mountRequests = requests.filter((item) => item.probe === 'lifecycle-mount' && item.path.startsWith('/api/modules/sop/'));
      assert.ok(mountRequests.some((item) => item.path.includes('/definitions') || item.path.includes('/management/')), `${state.id}: lifecycle mount did not issue a StaffDeck-specific follow-up request`);
      currentProbe = 'lifecycle-unmount';
      await page.locator('nav.primary-actions button').filter({ hasText: /新对话|New conversation/ }).first().click();
      await page.waitForURL((url) => ['/','/p/general'].includes(url.pathname), { timeout: 5_000 });
      await page.waitForTimeout(900);
      const after = await page.evaluate(() => window.__pilotdeckG3LifecycleSnapshot?.() ?? null);
      const restored = Boolean(before && mounted && after && lifecycleRestored(before, after));
      assert.equal(restored, true, `${state.id}: StaffDeck Distill timers/subscriptions were not restored after unmount. before=${JSON.stringify(before)} mounted=${JSON.stringify(mounted)} after=${JSON.stringify(after)}`);
      const unmountRequests = requests.filter((item) => item.probe === 'lifecycle-unmount' && item.path.startsWith('/api/modules/sop/'));
      assert.equal(unmountRequests.length, 0, `${state.id}: StaffDeck-specific requests continued after Distill unmount`);
      lifecycle = { status: 'passed', navigation: 'same-document-sidebar-controls', probePath: '/sop/distill', before, mounted, after, restored, mountRequests, unmountRequests };
    }

    const assertions = {
      routingRuntimeSwitch: state.routingInstalled && mode === 'real' ? state.routingEnabled : null,
      forbiddenOptionalRequests,
      settingsEffects,
      settingsOptionalRequests: { count: settingsOptionalRequests.length, passed: settingsOptionalRequests.length === 0 },
      lifecycle,
    };
    const settingsBySection = Object.fromEntries(settingsEffects.map((item) => [item.section, item]));

    const report = {
      id: state.id,
      result: 'passed',
      mode,
      mockBoundary: mode === 'mock'
        ? 'Only the shell API and runtime projection are mocked; browser routing, composition, Settings, legacy redirects, and request observation are real.'
        : null,
      build: { outDir: distDir, selectedImports: imports },
      browser: {
        baseURL,
        chatSurface,
        settings: {
          routingSettings: settingsBySection['agent-route']?.settingsPresent ? 1 : 0,
          routingUnavailable: settingsBySection['agent-route']?.unavailablePresent ? 1 : 0,
          permissionSettings: settingsBySection['tools-permissions']?.settingsPresent ? 1 : 0,
          permissionUnavailable: settingsBySection['tools-permissions']?.unavailablePresent ? 1 : 0,
        },
        legacy,
      },
      requests,
      requestPaths: [...new Set(requests.map((item) => item.path))].sort(),
      assertions,
      runtimeExpected: expectedRuntime,
      runtimeProjection,
      runtimeMismatches,
    };
    await page.screenshot({ path: resolve(stateRoot, 'g3-browser.png'), fullPage: true });
    await writeFile(resolve(stateRoot, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
    await context.close();
    await stop(service);
    for (const auxiliary of auxiliaryServices.reverse()) await stop(auxiliary);
    return report;
  } catch (error) {
    await stop(service);
    for (const auxiliary of auxiliaryServices.reverse()) await stop(auxiliary);
    throw error;
  }
}

const original = await readFile(generatedPath, 'utf8');
await rm(artifactRoot, { recursive: true, force: true });
await mkdir(artifactRoot, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
});
const reports = [];
try {
  for (let index = 0; index < matrixStates.length; index += 1) {
    reports.push(await runState(matrixStates[index], index, browser));
    console.log(`G3 browser state ${index + 1}/${matrixStates.length} (${mode}): ${matrixStates[index].id} PASS`);
  }
  await writeFile(resolve(artifactRoot, 'report.json'), `${JSON.stringify({ stateCount: reports.length, states: reports }, null, 2)}\n`);
  console.log(`G3 browser matrix (${mode}): ${reports.length}/${matrixStates.length} PASS`);
} finally {
  await browser.close();
  await writeFile(generatedPath, original, 'utf8');
}
