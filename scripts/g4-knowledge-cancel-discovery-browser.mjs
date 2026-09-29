import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const staffRoot = process.env.STAFFDECK_ROOT || resolve(root, '../StaffDeck-g4-knowledge-sd');
const python = process.env.STAFFDECK_PYTHON || '/tmp/staffdeck-shared-venv/bin/python';
const harnessRoot = process.env.HARNESS_V3_ROOT || '/Users/a1/Desktop/claw/openbmb/deepseek-harness-dsh-v0.1.2-alpha.2';
const ports = { staffApi: 16124, staffVite: 16125, pilotApi: 16126, pilotVite: 16127, gateway: 16128, model: 16129 };
const artifactRoot = process.env.G4_KNOWLEDGE_ARTIFACT_ROOT || resolve(root, 'test-results/g4-knowledge-cancel-discovery-browser');
const tempRoot = await mkdtemp(join(tmpdir(), 'pilotdeck-g4-knowledge-cancel-discovery-'));
const database = join(tempRoot, 'staffdeck-knowledge.sqlite');
const blockFile = join(tempRoot, 'block-ingest');
const fixtureDir = join(tempRoot, 'fixture-python');
const pilotHome = join(tempRoot, 'pilot-home');
const configPath = join(tempRoot, 'pilotdeck.yaml');
const output = {
  ports,
  startup: 'formal_app_main_with_harness_v3',
  modelFixture: 'local_openai_compatible_discovery_response',
  actions: [],
  coverage: {
    staffdeck_native_cancel: 'not_run',
    staffdeck_native_discoveries_confirm_reject: 'not_run',
    pilotdeck_adapter_cancel: 'not_run',
    pilotdeck_adapter_discoveries_confirm_reject: 'not_run',
  },
  staffdeck: { actions: [], requests: [], persistence: {} },
  pilotdeck: { actions: [], requests: [], persistence: {} },
  cleanup: { tempRoot },
};

function start(command, args, env, cwd) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  return { child, logs: () => logs };
}

async function waitFor(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stop(handle) {
  if (!handle?.child || handle.child.exitCode !== null) return;
  try { process.kill(-handle.child.pid, 'SIGTERM'); } catch {}
  try { process.kill(handle.child.pid, 'SIGTERM'); } catch {}
  await new Promise((resolveStop) => setTimeout(resolveStop, 800));
  if (handle.child.exitCode === null) {
    try { process.kill(-handle.child.pid, 'SIGKILL'); } catch {}
    try { process.kill(handle.child.pid, 'SIGKILL'); } catch {}
  }
}

async function waitUntil(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(message);
}

async function findBase(page, name) {
  await page.waitForFunction(() => !document.body.innerText.includes('Loading...'), undefined, { timeout: 20_000 });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const search = page.getByPlaceholder(/搜索知识库名称(?:、描述、状态或版本)?|Search knowledge bases/i);
    if (await search.count() && attempt === 0) await search.fill(name);
    const row = page.locator('tr').filter({ hasText: name }).first();
    if (await row.count() && await row.isVisible()) return row;
    const next = page.getByRole('button', { name: /下一页|Next Page/i }).last();
    if (await next.count() && !(await next.isDisabled())) await next.click();
    await page.waitForTimeout(400);
  }
  throw new Error(`Knowledge base ${name} not visible`);
}

async function writeFixture() {
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(join(fixtureDir, 'sitecustomize.py'), `import os\nimport time\nfrom app.knowledge.service import KnowledgeService\n_original = KnowledgeService._run_ingest_job\ndef _fixture_delay(self, job_id):\n    marker = os.environ.get('G4_INGEST_BLOCK_FILE', '')\n    deadline = time.time() + 120\n    while marker and os.path.exists(marker) and time.time() < deadline:\n        time.sleep(0.1)\n    return _original(self, job_id)\nKnowledgeService._run_ingest_job = _fixture_delay\n`, 'utf8');
}

const modelResponses = { discovery: 0 };
const modelServer = createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
    response.writeHead(404); response.end(); return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body || '{}');
  const system = String(parsed.messages?.[0]?.content || '');
  let payload;
  if (system.includes('知识自发现助手')) {
    modelResponses.discovery += 1;
    const suffix = modelResponses.discovery;
    payload = { discoveries: [{ suggestion_type: 'tool', title: `Fixture discovery ${suffix}`, reason: 'Generated by the isolated model fixture from a traceable document upload.', payload: { name: `fixture.discovery.${suffix}`, display_name: `Fixture discovery ${suffix}`, description: 'Deterministic model-simulation payload for UI persistence evidence.', method: 'POST', url: `http://127.0.0.1:16129/fixture/${suffix}`, headers: {}, auth: {}, input_schema: {}, output_schema: {} }, source_refs: [{ filename: `g4-discovery-${suffix}.md` }] }] };
  } else if (system.includes('PageIndex 分桶助手')) {
    payload = { buckets: [] };
  } else {
    payload = {};
  }
  const result = JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] });
  response.writeHead(200, { 'content-type': 'application/json' }); response.end(result);
});

await mkdir(artifactRoot, { recursive: true });
await mkdir(pilotHome, { recursive: true });
await writeFixture();
await writeFile(blockFile, 'hold ingest worker until UI cancellation\n', 'utf8');
await writeFile(configPath, `schemaVersion: 1\nagent:\n  model: smoke/operator\nmodel:\n  providers:\n    smoke:\n      protocol: openai\n      url: http://127.0.0.1:19992/v1\n      apiKey: local-only\n      models:\n        operator:\n          capabilities:\n            supportsToolUse: true\nwebui:\n  runtime:\n    serverPort: ${ports.pilotApi}\n    vitePort: ${ports.pilotVite}\n    databasePath: ${join(pilotHome, 'auth.db')}\n    workspacesRoot: ${join(pilotHome, 'workspaces')}\nmodules:\n  knowledge:\n    enabled: true\n    implementationId: staffdeck.knowledge\n    frontendModule: staffdeck.knowledge\n    contract: staffdeck.knowledge/v1\n    transport: module-http-v2\n    endpoint: http://127.0.0.1:${ports.staffApi}\n    callPath: /v2/module/call\n    tenantId: tenant_demo\n    actorUserId: admin\n    methods: [list_bases, get_base, list_documents, get_document, import_document, get_job, list_jobs, cancel_job, list_discoveries, confirm_discovery, reject_discovery]\nrouter:\n  enabled: false\nfrontend:\n  businessModules:\n    agent.routing:\n      enabled: false\n`, 'utf8');
await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('reject_discovery]', 'reject_discovery, query]'), 'utf8');

let staffService; let staffFrontend; let pilotService; let browser;
try {
  await new Promise((resolveListen) => modelServer.listen(ports.model, '127.0.0.1', resolveListen));
  const env = {
    PYTHONPATH: `${fixtureDir}:${join(staffRoot, 'backend')}:${join(staffRoot, 'backend/src')}:${join(staffRoot, 'portable_sop/src')}`,
    DATABASE_URL: `sqlite:///${database}`, APP_SECRET: 'g4-cancel-discovery-secret', DEMO_SEED_ENABLED: 'true',
    STARTUP_ORPHAN_CLEANUP_ENABLED: 'false', HARNESS_V3_ROOT: harnessRoot, HARNESS_V3_HOME: join(tempRoot, 'harness-home'),
    HARNESS_RUNTIME_CONFIG_PATH: join(tempRoot, 'harness-runtime.json'), HARNESS_V3_ENABLED: 'true', HARNESS_ADMIN_API_ENABLED: 'true',
    DEMO_MODEL_API_KEY: 'fixture-key', DEMO_MODEL_BASE_URL: `http://127.0.0.1:${ports.model}/v1`, DEMO_MODEL_NAME: 'fixture-model',
    G4_INGEST_BLOCK_FILE: blockFile,
  };
  staffService = start(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(ports.staffApi), '--log-level', 'warning'], env, tempRoot);
  await waitFor(`http://127.0.0.1:${ports.staffApi}/api/health`);
  staffFrontend = start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(ports.staffVite), '--strictPort'], { NODE_OPTIONS: '', VITE_PROXY_TARGET: `http://127.0.0.1:${ports.staffApi}`, VITE_TENANT_ID: 'tenant_demo' }, join(staffRoot, 'frontend-enterprise'));
  await waitFor(`http://127.0.0.1:${ports.staffVite}/enterprise/knowledge`);
  pilotService = start(process.execPath, ['scripts/dev-launcher.mjs'], { NODE_OPTIONS: '', PILOT_HOME: pilotHome, PILOTDECK_CONFIG_PATH: configPath, PILOTDECK_FRONTEND_PROFILE: configPath, PILOTDECK_DISABLE_LOCAL_AUTH: '0', SERVER_PORT: String(ports.pilotApi), VITE_PORT: String(ports.pilotVite), PILOTDECK_GATEWAY_PORT: String(ports.gateway), PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${ports.gateway}/ws`, PILOTDECK_MODULE_ADMIN: '1' }, root);
  await waitFor(`http://127.0.0.1:${ports.pilotVite}/api/auth/status`);
  browser = await chromium.launch({ headless: process.env.HEADED !== '1', executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  const nativeContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const native = await nativeContext.newPage();
  native.on('request', (request) => { const url = new URL(request.url()); if (url.pathname.includes('/api/enterprise/knowledge')) output.staffdeck.requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON?.() ?? null }); });
  native.on('response', async (response) => { const url = new URL(response.url()); if (url.pathname.includes('/api/enterprise/knowledge')) output.staffdeck.requests.push({ method: response.request().method(), path: url.pathname, responseStatus: response.status(), responseBody: await response.text().catch(() => '') }); });
  const login = await nativeContext.request.post(`http://127.0.0.1:${ports.staffVite}/api/auth/login`, { data: { tenant_id: 'tenant_demo', username: 'admin', password: 'admin' } });
  assert.equal(login.ok(), true); const account = await login.json();
  const agentsResponse = await nativeContext.request.get(`http://127.0.0.1:${ports.staffVite}/api/enterprise/agents?tenant_id=tenant_demo`, { headers: { authorization: `Bearer ${account.token}` } });
  assert.equal(agentsResponse.ok(), true); const agents = await agentsResponse.json(); const branch = agents.find((item) => !item.is_overall)?.id; assert.ok(branch);
  await native.addInitScript((session) => { localStorage.setItem('ultrarag_auth', JSON.stringify(session.account)); localStorage.setItem('ultrarag_enterprise_agent_scope', session.agentId); localStorage.setItem('staffdeck_onboarding_guide_seen', '1'); localStorage.setItem('staffdeck_quick_start_guide_seen', '1'); }, { account, agentId: branch });

  await native.goto(`http://127.0.0.1:${ports.staffVite}/enterprise/knowledge/new`, { waitUntil: 'domcontentloaded' });
  await native.locator('input[type=file]').first().setInputFiles(await (async () => { const path = join(tempRoot, 'g4-native-cancel.md'); await writeFile(path, '# Native cancel fixture\n\nThis upload is intentionally held by an isolated worker-delay fixture.\n', 'utf8'); return path; })());
  await native.getByRole('button', { name: /^取消$/ }).waitFor({ state: 'visible', timeout: 20_000 });
  output.staffdeck.actions.push('wait for persisted queued native job and click native cancel');
  await native.getByRole('button', { name: /^取消$/ }).click();
  await native.getByText(/已取消|Cancelled/i).last().waitFor({ timeout: 15_000 });
  output.staffdeck.persistence.cancelBeforeReload = await native.locator('body').innerText();
  await native.reload({ waitUntil: 'domcontentloaded' });
  await native.getByText(/已取消|Cancelled/i).last().waitFor({ timeout: 15_000 });
  output.staffdeck.persistence.cancelAfterReload = await native.locator('body').innerText();
  assert.doesNotMatch(output.staffdeck.persistence.cancelAfterReload, /正在取消|取消中/);
  output.coverage.staffdeck_native_cancel = 'real_ui_persisted_cancel_and_reload';
  output.staffdeck.actions.push('reload native page and verify terminal cancelled state persists');

  await rm(blockFile, { force: true });
  async function nativeDiscovery(fileName, mode) {
    const path = join(tempRoot, fileName); await writeFile(path, `# Traceable discovery input\n\nThe fixture exposes POST http://127.0.0.1:16129/${mode} with a JSON response field.\n`, 'utf8');
    await native.goto(`http://127.0.0.1:${ports.staffVite}/enterprise/knowledge/new`, { waitUntil: 'domcontentloaded' });
    await native.locator('input[type=file]').first().setInputFiles(path);
    await native.getByText('发现可新增资源', { exact: true }).waitFor({ timeout: 45_000 });
    const card = native.locator('.knowledge-discovery').last(); await card.waitFor({ state: 'visible' });
    if (mode === 'confirm') await card.getByRole('button').nth(0).click(); else await card.getByRole('button').nth(1).click();
    await native.waitForTimeout(1_000);
    await native.reload({ waitUntil: 'domcontentloaded' });
  }
  await nativeDiscovery('g4-native-discovery-confirm.md', 'confirm');
  await nativeDiscovery('g4-native-discovery-reject.md', 'reject');
  const allDiscoveries = await nativeContext.request.get(`http://127.0.0.1:${ports.staffVite}/api/enterprise/knowledge/discoveries?tenant_id=tenant_demo&agent_id=${encodeURIComponent(branch)}`, { headers: { authorization: `Bearer ${account.token}` } });
  assert.equal(allDiscoveries.ok(), true); const discoveryRows = await allDiscoveries.json();
  const confirmedRows = discoveryRows.filter((row) => row.status === 'confirmed'); const rejectedRows = discoveryRows.filter((row) => row.status === 'rejected');
  assert.ok(confirmedRows.some((row) => row.title.includes('Fixture discovery'))); assert.ok(rejectedRows.some((row) => row.title.includes('Fixture discovery')));
  output.staffdeck.persistence.discoveryAfterReload = { confirmed: confirmedRows, rejected: rejectedRows };
  output.coverage.staffdeck_native_discoveries_confirm_reject = 'real_ui_model_fixture_pending_confirm_reject_and_reload_readback';
  output.staffdeck.actions.push('confirm and reject model-fixture discoveries in native UI and read back persisted statuses after reload');

  const pilotContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const pilot = await pilotContext.newPage();
  pilot.on('request', (request) => { const url = new URL(request.url()); if (url.pathname.includes('/api/modules/knowledge')) output.pilotdeck.requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON?.() ?? null }); });
  pilot.on('response', async (response) => { const url = new URL(response.url()); if (url.pathname === '/api/modules/knowledge/call') output.pilotdeck.requests.push({ operation: response.request().postDataJSON?.().operation, responseStatus: response.status(), responseBody: await response.text().catch(() => '') }); });
  const credentials = { username: 'g4-cancel-discovery-owner', password: 'g4-cancel-discovery-owner-password' };
  const registration = await pilotContext.request.post(`http://127.0.0.1:${ports.pilotVite}/api/auth/register`, { data: credentials });
  const pilotAccount = registration.ok() ? await registration.json() : await (await pilotContext.request.post(`http://127.0.0.1:${ports.pilotVite}/api/auth/login`, { data: credentials })).json();
  assert.equal(typeof pilotAccount.token, 'string'); await pilotContext.request.post(`http://127.0.0.1:${ports.pilotVite}/api/user/complete-onboarding`, { headers: { authorization: `Bearer ${pilotAccount.token}` } });
  await pilot.addInitScript((token) => localStorage.setItem('auth-token', token), pilotAccount.token);
  await writeFile(blockFile, 'hold PilotDeck ingest until adapter cancel\n', 'utf8');
  await pilot.goto(`http://127.0.0.1:${ports.pilotVite}/knowledge/new`, { waitUntil: 'domcontentloaded' });
  await pilot.waitForTimeout(1_500);
  if (!(await pilot.locator('input[type=file]').count())) {
    output.pilotdeck.pageBodyBeforeFallback = (await pilot.locator('body').innerText().catch(() => '')).slice(0, 2400);
    await pilot.goto(`http://127.0.0.1:${ports.pilotVite}/knowledge`, { waitUntil: 'domcontentloaded' });
    await pilot.getByRole('button', { name: /新建知识库|New knowledge/i }).first().click();
    await pilot.locator('input[type=file]').first().waitFor({ state: 'attached', timeout: 15_000 });
  }
  const pilotCancelFile = join(tempRoot, 'g4-pilot-cancel.md'); await writeFile(pilotCancelFile, '# PilotDeck cancel fixture\n\nAdapter cancellation must persist.\n', 'utf8');
  await pilot.locator('input[type=file]').first().setInputFiles(pilotCancelFile);
  try { await pilot.getByRole('button', { name: /^(取消|Cancel)$/ }).waitFor({ state: 'visible', timeout: 20_000 }); } catch (error) { output.pilotdeck.cancelPageBody = (await pilot.locator('body').innerText().catch(() => '')).slice(-5000); throw error; }
  await pilot.getByRole('button', { name: /^(取消|Cancel)$/ }).click();
  await pilot.getByText(/已取消|Cancelled/i).last().waitFor({ timeout: 15_000 }); await pilot.reload({ waitUntil: 'domcontentloaded' }); await pilot.getByText(/已取消|Cancelled/i).last().waitFor({ timeout: 15_000 });
  output.pilotdeck.persistence.cancelAfterReload = await pilot.locator('body').innerText(); output.coverage.pilotdeck_adapter_cancel = 'real_shared_page_adapter_persisted_cancel_and_reload'; output.pilotdeck.actions.push('cancel queued job through PilotDeck shared Knowledge page and verify after reload');
  await rm(blockFile, { force: true });
  async function pilotDiscovery(fileName, mode) {
    const path = join(tempRoot, fileName); await writeFile(path, `# PilotDeck traceable discovery ${mode}\n\nThe fixture exposes POST http://127.0.0.1:16129/${mode}.\n`, 'utf8');
    await pilot.goto(`http://127.0.0.1:${ports.pilotVite}/knowledge/new`, { waitUntil: 'domcontentloaded' });
    await pilot.waitForTimeout(500);
    if (!(await pilot.locator('input[type=file]').count())) { await pilot.goto(`http://127.0.0.1:${ports.pilotVite}/knowledge`, { waitUntil: 'domcontentloaded' }); await pilot.getByRole('button', { name: /新建知识库|New knowledge/i }).first().click(); await pilot.locator('input[type=file]').first().waitFor({ state: 'attached', timeout: 15_000 }); }
    await pilot.locator('input[type=file]').first().setInputFiles(path); await pilot.getByText(/发现可新增资源|Discover Resources to Add/i).waitFor({ timeout: 20_000 });
    const card = pilot.locator('.knowledge-discovery').last(); if (mode === 'confirm') await card.getByRole('button').nth(0).click(); else await card.getByRole('button').nth(1).click(); await pilot.waitForTimeout(800); await pilot.reload({ waitUntil: 'domcontentloaded' });
  }
  try {
    await pilotDiscovery('g4-pilot-discovery-confirm.md', 'confirm'); await pilotDiscovery('g4-pilot-discovery-reject.md', 'reject');
    const pdConfirmed = await pilotContext.request.post(`http://127.0.0.1:${ports.pilotVite}/api/modules/knowledge/call`, { headers: { authorization: `Bearer ${pilotAccount.token}` }, data: { operation: 'list_discoveries', input: { status: 'confirmed' } } });
    const pdRejected = await pilotContext.request.post(`http://127.0.0.1:${ports.pilotVite}/api/modules/knowledge/call`, { headers: { authorization: `Bearer ${pilotAccount.token}` }, data: { operation: 'list_discoveries', input: { status: 'rejected' } } });
    assert.equal(pdConfirmed.ok(), true); assert.equal(pdRejected.ok(), true); output.pilotdeck.persistence.discoveryAfterReload = { confirmed: await pdConfirmed.json(), rejected: await pdRejected.json() }; output.coverage.pilotdeck_adapter_discoveries_confirm_reject = 'real_shared_page_adapter_model_fixture_pending_confirm_reject_and_reload_readback'; output.pilotdeck.actions.push('confirm and reject through PilotDeck shared adapter and read back persisted statuses');
  } catch (error) {
    output.coverage.pilotdeck_adapter_discoveries_confirm_reject = 'blocked_ui_modal_not_rendered_after_pending_row_returned_by_adapter';
    output.requiredFailures = ['pilotdeck_adapter_discoveries_confirm_reject'];
    process.exitCode = 1;
    output.pilotdeck.persistence.discoveryBoundary = { status: 'BLOCKED', reason: 'PilotDeck adapter list_discoveries returned a pending model-fixture row, but the shared page did not render the discovery modal after the job reached succeeded; no confirm/reject click or terminal status is claimed.', error: error instanceof Error ? error.message : String(error) };
  }
  await native.screenshot({ path: join(artifactRoot, 'g4-knowledge-cancel-discovery-staffdeck.png'), fullPage: true }).catch(() => undefined); await pilot.screenshot({ path: join(artifactRoot, 'g4-knowledge-cancel-discovery-pilotdeck.png'), fullPage: true }).catch(() => undefined);
  await nativeContext.close(); await pilotContext.close();
} catch (error) {
  output.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  await stop(pilotService); await stop(staffFrontend); await stop(staffService); await new Promise((resolveClose) => modelServer.close(resolveClose));
  output.cleanup.blockFileRemoved = !existsSync(blockFile); output.cleanup.processesStopped = true;
  await mkdir(artifactRoot, { recursive: true }); await writeFile(join(artifactRoot, 'report.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  if (browser) await browser.close().catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
}
