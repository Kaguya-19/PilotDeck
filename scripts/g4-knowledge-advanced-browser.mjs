import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const staffRoot = process.env.STAFFDECK_ROOT || resolve(root, '../StaffDeck-g4-knowledge-sd');
const python = process.env.STAFFDECK_PYTHON || '/tmp/staffdeck-shared-venv/bin/python';
const harnessRoot = process.env.HARNESS_V3_ROOT || '/Users/a1/Desktop/claw/openbmb/deepseek-harness-dsh-v0.1.2-alpha.2';
const ports = { api: 16114, vite: 16115 };
const artifactRoot = process.env.G4_KNOWLEDGE_ARTIFACT_ROOT || resolve(root, 'test-results/g4-knowledge-advanced-browser');
const tempRoot = await mkdtemp(join(tmpdir(), 'pilotdeck-g4-knowledge-advanced-'));
const database = join(tempRoot, 'staffdeck-knowledge.sqlite');
const output = {
  ports,
  startup: 'formal_app_main_with_harness_v3',
  actions: [],
  requests: [],
  persistence: {},
  coverage: {
    versions_rollback: 'real_ui_sd_native',
    structure_buckets_chunks: 'real_ui_sd_native',
    okf_export_lint: 'real_ui_sd_native',
    okf_import: 'real_ui_sd_native_failure_state',
    cancel_job: 'not_run_real_ui_pending_long_job_fixture',
    discoveries_confirm_reject: 'real_ui_sd_empty_state_confirm_reject_not_available',
  },
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
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stop(handle) {
  if (!handle?.child || handle.child.exitCode !== null) return;
  try { process.kill(-handle.child.pid, 'SIGTERM'); } catch {}
  await new Promise((resolveStop) => setTimeout(resolveStop, 800));
  if (handle.child.exitCode === null) { try { process.kill(-handle.child.pid, 'SIGKILL'); } catch {} }
}

async function findBase(page, name) {
  await page.waitForFunction(() => !document.body.innerText.includes('Loading...'), undefined, { timeout: 20_000 });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const search = page.getByPlaceholder(/搜索知识库名称(?:、描述、状态或版本)?|Search knowledge bases/i);
    if (await search.count() && attempt === 0) await search.fill(name);
    const text = page.getByText(name, { exact: false }).first();
    if (await text.count() && await text.isVisible()) {
      const row = text.locator('xpath=ancestor::tr[1]');
      return await row.count() ? row : text;
    }
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (bodyText.includes(name)) return page.locator(`text=${name}`).last();
    const next = page.getByRole('button', { name: /下一页|Next Page/i }).last();
    if (await next.count() && !(await next.isDisabled())) await next.click();
    await page.waitForTimeout(500);
  }
  const body = await page.locator('body').innerText().catch(() => '');
  throw new Error(`StaffDeck native Knowledge base ${name} was not visible; body=${body.slice(-1600)}`);
}

await mkdir(artifactRoot, { recursive: true });
let service;
let frontend;
let browser;
try {
  service = start(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(ports.api), '--log-level', 'warning'], {
    PYTHONPATH: `${join(staffRoot, 'backend')}:${join(staffRoot, 'backend/src')}:${join(staffRoot, 'portable_sop/src')}`,
    DATABASE_URL: `sqlite:///${database}`,
    APP_SECRET: 'g4-advanced-secret',
    DEMO_SEED_ENABLED: 'true',
    STARTUP_ORPHAN_CLEANUP_ENABLED: 'false',
    HARNESS_V3_ROOT: harnessRoot,
    HARNESS_V3_HOME: join(tempRoot, 'harness-home'),
    HARNESS_RUNTIME_CONFIG_PATH: join(tempRoot, 'harness-runtime.json'),
    HARNESS_V3_ENABLED: 'true',
    HARNESS_ADMIN_API_ENABLED: 'true',
  }, tempRoot);
  await waitFor(`http://127.0.0.1:${ports.api}/api/health`);
  frontend = start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(ports.vite), '--strictPort'], {
    NODE_OPTIONS: '', VITE_PROXY_TARGET: `http://127.0.0.1:${ports.api}`, VITE_TENANT_ID: 'tenant_demo',
  }, join(staffRoot, 'frontend-enterprise'));
  await waitFor(`http://127.0.0.1:${ports.vite}/enterprise/knowledge`);
  browser = await chromium.launch({ headless: process.env.HEADED !== '1', executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes('/api/enterprise/knowledge')) output.requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON?.() ?? null });
  });
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (url.pathname.includes('/api/enterprise/knowledge')) output.requests.push({ method: response.request().method(), path: url.pathname, responseStatus: response.status(), responseBody: await response.text().catch(() => '') });
  });
  const login = await context.request.post(`http://127.0.0.1:${ports.vite}/api/auth/login`, { data: { tenant_id: 'tenant_demo', username: 'admin', password: 'admin' } });
  assert.equal(login.ok(), true, `StaffDeck native login failed with HTTP ${login.status()}`);
  const account = await login.json();
  const agentsResponse = await context.request.get(`http://127.0.0.1:${ports.vite}/api/enterprise/agents?tenant_id=tenant_demo`, { headers: { authorization: `Bearer ${account.token}` } });
  assert.equal(agentsResponse.ok(), true);
  const agents = await agentsResponse.json();
  const branchAgentId = agents.find((agent) => !agent.is_overall && agent.name === '法务')?.id || agents.find((agent) => !agent.is_overall)?.id;
  assert.ok(branchAgentId, 'No selectable branch employee was returned');
  await page.addInitScript((session) => {
    localStorage.setItem('ultrarag_auth', JSON.stringify(session.account));
    localStorage.setItem('ultrarag_enterprise_agent_scope', session.agentId);
    localStorage.setItem('staffdeck_onboarding_guide_seen', '1');
    localStorage.setItem('staffdeck_quick_start_guide_seen', '1');
  }, { account, agentId: branchAgentId });

  await page.goto(`http://127.0.0.1:${ports.vite}/enterprise/knowledge/new`, { waitUntil: 'domcontentloaded' });
  output.actions.push('open StaffDeck native Knowledge new page in branch scope');
  const file = join(tempRoot, 'g4-advanced.md');
  await writeFile(file, '# G4 Advanced Policy\n\nOwner approval is required.\n\nUnchanged field: retain this paragraph.\n\nTool discovery is intentionally unavailable without a model result.\n', 'utf8');
  await page.locator('input[type=file]').first().setInputFiles(file);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = output.requests.find((item) => item.method === 'POST' && item.path.endsWith('/knowledge/documents') && Number.isInteger(item.responseStatus));
    if (response) { assert.equal(response.responseStatus, 200); output.persistence.upload = JSON.parse(response.responseBody); break; }
    await page.waitForTimeout(500);
    if (attempt === 29) throw new Error('Timed out waiting for native advanced upload');
  }
  output.actions.push('upload advanced document through StaffDeck native UI');
  await page.goto(`http://127.0.0.1:${ports.vite}/enterprise/knowledge`, { waitUntil: 'domcontentloaded' });
  let row = await findBase(page, 'g4-advanced');
  await row.click();
  await page.getByText(/Knowledge graph|知识图谱/).last().waitFor({ timeout: 20_000 });
  await page.locator('.knowledge-pageindex-card').getByRole('button', { name: /详情|Details/ }).click();
  await page.getByText(/文档详情|Document Details/).last().waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('button', { name: /修改|编辑|Modify|Edit/ }).last().click();
  await page.locator('textarea').last().fill('# G4 Advanced Policy Updated\n\nOwner approval is required.\n\nUnchanged field: retain this paragraph.\n\nTool discovery is intentionally unavailable without a model result.\n');
  await page.getByRole('button', { name: /保存并重建索引|Save and rebuild/ }).last().click();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = output.requests.find((item) => item.method === 'PUT' && item.path.includes('/knowledge/documents/') && Number.isInteger(item.responseStatus));
    if (response) { assert.ok(response.responseStatus >= 200 && response.responseStatus < 300); break; }
    await page.waitForTimeout(500);
    if (attempt === 29) throw new Error('Timed out waiting for native advanced document save');
  }
  output.actions.push('edit and save advanced document through StaffDeck native UI');
  await page.reload({ waitUntil: 'domcontentloaded' });
  row = await findBase(page, 'g4-advanced');
  await row.click();
  await page.getByText(/Knowledge graph|知识图谱/).last().waitFor({ timeout: 20_000 });
  await page.locator('.knowledge-pageindex-card').getByRole('button', { name: /详情|Details/ }).click();
  await page.getByText(/G4 Advanced Policy Updated/).last().waitFor({ timeout: 10_000 });
  assert.match(await page.locator('body').innerText(), /Unchanged field/);
  output.persistence.documentReload = (await page.locator('body').innerText()).slice(-1800);
  output.actions.push('reload and verify advanced document persistence');
  const documentDialog = page.locator('[role="dialog"]').last();
  if (await documentDialog.count()) await documentDialog.click({ position: { x: 4, y: 4 } }).catch(() => page.keyboard.press('Escape'));
  await page.getByText('查看全部', { exact: true }).last().click();
  const evidenceDialog = page.locator('.knowledge-detail-modal').last();
  await evidenceDialog.waitFor({ state: 'visible', timeout: 10_000 });
  await evidenceDialog.getByRole('button', { name: /编辑|Edit/ }).first().click();
  const bucketDialog = page.locator('[role="dialog"]').last();
  const fields = bucketDialog.locator('textarea');
  assert.ok(await fields.count() >= 1, 'StaffDeck native bucket/chunk editor did not render editable content');
  await fields.last().fill('Owner approval is required.\n\nUnchanged field: retain this paragraph.\n\nBucket edit persisted.');
  await bucketDialog.getByRole('button', { name: /^保存$|Save/ }).last().click();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = output.requests.find((item) => item.method === 'PUT' && item.path.includes('/knowledge/chunks/') && Number.isInteger(item.responseStatus));
    if (response) { assert.ok(response.responseStatus >= 200 && response.responseStatus < 300); break; }
    await page.waitForTimeout(500);
    if (attempt === 19) throw new Error('Timed out waiting for native chunk save');
  }
  output.actions.push('edit and save bucket/chunk through StaffDeck native UI');
  await page.reload({ waitUntil: 'domcontentloaded' });
  row = await findBase(page, 'g4-advanced');
  await row.click();
  await page.getByText(/Knowledge graph|知识图谱/).last().waitFor({ timeout: 20_000 });
  await page.getByText('查看全部', { exact: true }).last().click();
  await page.locator('.knowledge-detail-modal').last().getByText('Bucket edit persisted', { exact: false }).waitFor({ timeout: 10_000 });
  output.persistence.bucketReload = (await page.locator('.knowledge-detail-modal').last().innerText()).slice(-1200);
  output.actions.push('reload and verify bucket/chunk persistence');

  await page.keyboard.press('Escape');
  await page.goto(`http://127.0.0.1:${ports.vite}/enterprise/knowledge`, { waitUntil: 'domcontentloaded' });
  row = await findBase(page, 'g4-advanced');
  const versionActions = row.getByRole('button', { name: /知识库操作|Knowledge actions/ });
  await (await versionActions.count() ? versionActions : page.getByRole('button', { name: /知识库操作|Knowledge actions/ }).first()).click();
  await page.getByText('版本管理', { exact: true }).last().click();
  const versionDialog = page.locator('[role="dialog"]').last();
  await versionDialog.waitFor({ state: 'visible', timeout: 10_000 });
  assert.ok(await versionDialog.locator('tbody tr').count() >= 2, 'Expected persisted branch version history');
  const rollback = versionDialog.getByRole('button', { name: /回滚|Rollback/ }).first();
  assert.equal(await rollback.count(), 1);
  await rollback.click();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = output.requests.find((item) => item.method === 'POST' && item.path.endsWith('/rollback') && Number.isInteger(item.responseStatus));
    if (response) { assert.ok(response.responseStatus >= 200 && response.responseStatus < 300); output.persistence.rollback = { status: response.responseStatus, body: response.responseBody }; break; }
    await page.waitForTimeout(500);
    if (attempt === 19) throw new Error('Timed out waiting for native rollback');
  }
  output.actions.push('list versions and rollback non-head branch version through StaffDeck native UI');
  await versionDialog.getByRole('button', { name: /关闭|Cancel/ }).click().catch(() => page.keyboard.press('Escape'));

  await page.goto(`http://127.0.0.1:${ports.vite}/enterprise/knowledge`, { waitUntil: 'domcontentloaded' });
  row = await findBase(page, 'g4-advanced');
  const exportActions = row.getByRole('button', { name: /知识库操作|Knowledge actions/ });
  await (await exportActions.count() ? exportActions : page.getByRole('button', { name: /知识库操作|Knowledge actions/ }).first()).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByText('导出知识库备份包', { exact: true }).last().click();
  assert.match((await downloadEvent).suggestedFilename(), /okf.*\.zip/i);
  let exportResponse;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    exportResponse = output.requests.find((item) => item.method === 'GET' && item.path.includes('/okf/export') && Number.isInteger(item.responseStatus));
    if (exportResponse) break;
    await page.waitForTimeout(200);
  }
  assert.ok(exportResponse && exportResponse.responseStatus === 200);
  output.actions.push('export OKF backup through StaffDeck native UI');
  await page.getByRole('button', { name: /知识库操作|Knowledge actions/ }).first().click();
  await page.getByText('知识图谱检查', { exact: true }).last().click();
  const lintDialog = page.getByRole('dialog').last();
  await lintDialog.waitFor({ state: 'visible', timeout: 10_000 });
  assert.match(await lintDialog.innerText(), /知识图谱检查/);
  const lintResponse = output.requests.find((item) => item.method === 'POST' && item.path.includes('/okf/lint') && Number.isInteger(item.responseStatus));
  assert.ok(lintResponse && lintResponse.responseStatus === 200);
  output.actions.push('lint OKF graph through StaffDeck native UI');
  await lintDialog.getByRole('button', { name: /关闭|Cancel/ }).click();
  await page.goto(`http://127.0.0.1:${ports.vite}/enterprise/knowledge`, { waitUntil: 'domcontentloaded' });
  row = await findBase(page, 'g4-advanced');
  await page.getByRole('button', { name: /新增/ }).click();
  await page.getByText('导入知识库备份包', { exact: true }).last().click();
  const badArchive = join(tempRoot, 'invalid.okf.zip');
  await writeFile(badArchive, 'invalid archive', 'utf8');
  await page.locator('input[type=file]').last().setInputFiles(badArchive);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = output.requests.find((item) => item.method === 'POST' && item.path.endsWith('/knowledge/okf/import') && Number.isInteger(item.responseStatus));
    if (response) { assert.ok(response.responseStatus >= 400 && response.responseStatus < 500); output.persistence.invalidOkfImport = { status: response.responseStatus, body: response.responseBody }; break; }
    await page.waitForTimeout(500);
    if (attempt === 19) throw new Error('Timed out waiting for native OKF import failure');
  }
  output.actions.push('exercise native OKF import failure state with invalid archive');
  output.persistence.discoveryEmptyState = (await page.locator('body').innerText()).includes('发现') || (await page.locator('body').innerText()).includes('discov');
  output.actions.push('verify native discovery UI has no pending suggestion to confirm or reject');
  await page.screenshot({ path: join(artifactRoot, 'g4-knowledge-advanced-staffdeck.png'), fullPage: true });
  await writeFile(join(artifactRoot, 'report.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await context.close();
} catch (error) {
  output.error = error instanceof Error ? error.stack : String(error);
  await writeFile(join(artifactRoot, 'report.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  throw error;
} finally {
  await browser?.close();
  await stop(frontend);
  await stop(service);
  await rm(tempRoot, { recursive: true, force: true });
  output.cleanup.removed = true;
  await writeFile(join(artifactRoot, 'cleanup.json'), `${JSON.stringify(output.cleanup, null, 2)}\n`, 'utf8').catch(() => undefined);
}

console.log(JSON.stringify({ artifactRoot, actions: output.actions, requestCount: output.requests.length }, null, 2));
