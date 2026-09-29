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
const ports = { staffApi: 16134, pilotApi: 16136, pilotVite: 16137, gateway: 16138 };
const artifactRoot = process.env.G4_KNOWLEDGE_ARTIFACT_ROOT || resolve(root, 'test-results/g4-knowledge-pd-advanced-browser');
const tempRoot = await mkdtemp(join(tmpdir(), 'pilotdeck-g4-knowledge-pd-advanced-'));
const database = join(tempRoot, 'staffdeck-knowledge.sqlite');
const pilotHome = join(tempRoot, 'pilot-home');
const configPath = join(tempRoot, 'pilotdeck.yaml');
const branchAgentId = 'agent_7d062081c03b4e16';
const output = { ports, startup: 'formal_app_main_with_harness_v3', scope: branchAgentId, actions: [], requests: [], persistence: {}, coverage: { versions_rollback: 'not_run', structure_buckets_chunks: 'not_run', okf_export_lint: 'not_run', okf_import_failure: 'not_run' }, cleanup: { tempRoot } };

function start(command, args, env, cwd) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  return { child };
}
async function waitFor(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((resolveDelay) => setTimeout(resolveDelay, 250)); }
  throw new Error(`Timed out waiting for ${url}`);
}
async function stop(handle) {
  if (!handle?.child || handle.child.exitCode !== null) return;
  try { process.kill(-handle.child.pid, 'SIGTERM'); } catch {}
  try { process.kill(handle.child.pid, 'SIGTERM'); } catch {}
  await new Promise((resolveStop) => setTimeout(resolveStop, 800));
  if (handle.child.exitCode === null) { try { process.kill(-handle.child.pid, 'SIGKILL'); } catch {} try { process.kill(handle.child.pid, 'SIGKILL'); } catch {} }
}
async function findBase(page, name) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const search = page.getByPlaceholder(/Search knowledge base|搜索知识库名称/);
    if (await search.count() && attempt === 0) await search.fill(name);
    const row = page.locator('tr').filter({ hasText: name }).first();
    if (await row.count() && await row.isVisible()) return row;
    const exactNames = page.getByText(name, { exact: true });
    for (let index = 0; index < await exactNames.count(); index += 1) {
      const exactName = exactNames.nth(index);
      if (await exactName.isVisible()) return exactName;
    }
    const next = page.getByRole('button', { name: /Next Page|下一页/ }).last();
    if (await next.count() && !(await next.isDisabled())) await next.click();
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: join(artifactRoot, `find-base-failure-${Date.now()}.png`), fullPage: true }).catch(() => undefined);
  output.findBaseDebug = { url: page.url(), body: (await page.locator('body').innerText().catch(() => '')).slice(0, 5000) };
  throw new Error(`PilotDeck Knowledge base ${name} not visible`);
}
async function selectBase(page, name) {
  const search = page.getByPlaceholder(/Search knowledge base|搜索知识库名称/);
  if (await search.count()) await search.fill(name);
  const names = page.getByText(name, { exact: true });
  const deadline = Date.now() + 45_000;
  let attempts = 0;
  while (Date.now() < deadline) {
    for (let index = 0; index < await names.count(); index += 1) {
      const candidate = names.nth(index);
      if (await candidate.isVisible()) {
        await candidate.click();
        return;
      }
    }
    attempts += 1;
    if (attempts % 8 === 0) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const refreshedSearch = page.getByPlaceholder(/Search knowledge base|搜索知识库名称/);
      if (await refreshedSearch.count()) await refreshedSearch.fill(name);
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`PilotDeck Knowledge base ${name} not visible`);
}
async function visibleBaseName(page, name) {
  const search = page.getByPlaceholder(/Search knowledge base|搜索知识库名称/);
  if (await search.count()) await search.fill(name);
  const names = page.getByText(name, { exact: true });
  const deadline = Date.now() + 45_000;
  let attempts = 0;
  while (Date.now() < deadline) {
    for (let index = 0; index < await names.count(); index += 1) {
      const candidate = names.nth(index);
      if (await candidate.isVisible()) return candidate;
    }
    attempts += 1;
    if (attempts % 8 === 0) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const refreshedSearch = page.getByPlaceholder(/Search knowledge base|搜索知识库名称/);
      if (await refreshedSearch.count()) await refreshedSearch.fill(name);
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`PilotDeck Knowledge base ${name} not visible`);
}
async function forceSelectBase(page, name) {
  const search = page.getByPlaceholder(/Search knowledge base|搜索知识库名称/);
  if (await search.count()) await search.fill(name);
  const names = page.getByText(name, { exact: true });
  const deadline = Date.now() + 45_000;
  let attempts = 0;
  while (Date.now() < deadline) {
    if (await names.count()) {
      await names.first().evaluate((element) => (element.closest('tr') || element).dispatchEvent(new MouseEvent('click', { bubbles: true })));
      return;
    }
    attempts += 1;
    if (attempts % 8 === 0) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const refreshedSearch = page.getByPlaceholder(/Search knowledge base|搜索知识库名称/);
      if (await refreshedSearch.count()) await refreshedSearch.fill(name);
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`PilotDeck Knowledge base ${name} not attached`);
}
async function openBaseActionsFor(page, name) {
  const names = page.getByText(name, { exact: true });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (let index = 0; index < await names.count(); index += 1) {
      const nameCell = names.nth(index);
      if (!(await nameCell.isVisible())) continue;
      const ancestor = nameCell.locator('xpath=ancestor::*[.//button[contains(@aria-label, "Knowledge Base Actions")]][1]');
      const action = ancestor.getByRole('button', { name: /Knowledge Base Actions|知识库操作/i }).first();
      if (await action.count()) {
        await action.evaluate((element) => element.click());
        return;
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`Knowledge base actions trigger not found for ${name}`);
}
function responseFor(operation) { return output.requests.find((item) => item.operation === operation && Number.isInteger(item.responseStatus)); }
async function waitResponse(operation, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const response = responseFor(operation); if (response) return response; await new Promise((resolveDelay) => setTimeout(resolveDelay, 300)); }
  throw new Error(`Timed out waiting for ${operation} response`);
}

await mkdir(artifactRoot, { recursive: true });
await mkdir(pilotHome, { recursive: true });
await writeFile(configPath, `schemaVersion: 1\nagent:\n  model: smoke/operator\nmodel:\n  providers:\n    smoke:\n      protocol: openai\n      url: http://127.0.0.1:19992/v1\n      apiKey: local-only\n      models:\n        operator:\n          capabilities:\n            supportsToolUse: true\nwebui:\n  runtime:\n    serverPort: ${ports.pilotApi}\n    vitePort: ${ports.pilotVite}\n    databasePath: ${join(pilotHome, 'auth.db')}\n    workspacesRoot: ${join(pilotHome, 'workspaces')}\nmodules:\n  knowledge:\n    enabled: true\n    implementationId: staffdeck.knowledge\n    frontendModule: staffdeck.knowledge\n    contract: staffdeck.knowledge/v1\n    transport: module-http-v2\n    endpoint: http://127.0.0.1:${ports.staffApi}\n    callPath: /v2/module/call\n    tenantId: tenant_demo\n    actorUserId: admin\n    methods: [list_bases, create_base, get_base, update_base, delete_base, list_versions, sync_base, publish_version, rollback_version, list_documents, get_document, import_document, import_okf, update_document, delete_document, list_document_buckets, update_bucket, list_bucket_chunks, update_chunk, get_job, list_jobs, cancel_job, list_okf_concepts, get_okf_concept, upsert_okf_concept, export_okf, lint_okf, list_discoveries, confirm_discovery, reject_discovery, query, resolve_citation]\nrouter:\n  enabled: false\nfrontend:\n  businessModules:\n    agent.routing:\n      enabled: false\n`, 'utf8');

let service; let pilot; let browser; let page;
try {
  service = start(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(ports.staffApi), '--log-level', 'warning'], { PYTHONPATH: `${join(staffRoot, 'backend')}:${join(staffRoot, 'backend/src')}:${join(staffRoot, 'portable_sop/src')}`, DATABASE_URL: `sqlite:///${database}`, APP_SECRET: 'g4-pd-advanced-secret', DEMO_SEED_ENABLED: 'true', STARTUP_ORPHAN_CLEANUP_ENABLED: 'false', HARNESS_V3_ROOT: harnessRoot, HARNESS_V3_HOME: join(tempRoot, 'harness-home'), HARNESS_RUNTIME_CONFIG_PATH: join(tempRoot, 'harness-runtime.json'), HARNESS_V3_ENABLED: 'true', HARNESS_ADMIN_API_ENABLED: 'true' }, tempRoot);
  await waitFor(`http://127.0.0.1:${ports.staffApi}/api/health`);
  pilot = start(process.execPath, ['scripts/dev-launcher.mjs'], { NODE_OPTIONS: '', PILOT_HOME: pilotHome, PILOTDECK_CONFIG_PATH: configPath, PILOTDECK_FRONTEND_PROFILE: configPath, PILOTDECK_DISABLE_LOCAL_AUTH: '0', SERVER_PORT: String(ports.pilotApi), VITE_PORT: String(ports.pilotVite), PILOTDECK_GATEWAY_PORT: String(ports.gateway), PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${ports.gateway}/ws`, PILOTDECK_MODULE_ADMIN: '1' }, root);
  await waitFor(`http://127.0.0.1:${ports.pilotVite}/api/auth/status`);
  browser = await chromium.launch({ headless: process.env.HEADED !== '1', executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on('request', (request) => { const url = new URL(request.url()); if (url.pathname === '/api/modules/knowledge/call') output.requests.push({ operation: request.postDataJSON?.().operation, input: request.postDataJSON?.().input || {} }); });
  page.on('response', async (response) => { const url = new URL(response.url()); if (url.pathname === '/api/modules/knowledge/call') output.requests.push({ operation: response.request().postDataJSON?.().operation, responseStatus: response.status(), responseBody: await response.text().catch(() => '') }); });
  const credentials = { username: 'g4-pd-advanced-owner', password: 'g4-pd-advanced-owner-password' };
  const registration = await context.request.post(`http://127.0.0.1:${ports.pilotVite}/api/auth/register`, { data: credentials });
  const account = registration.ok() ? await registration.json() : await (await context.request.post(`http://127.0.0.1:${ports.pilotVite}/api/auth/login`, { data: credentials })).json();
  assert.equal(typeof account.token, 'string');
  await context.request.post(`http://127.0.0.1:${ports.pilotVite}/api/user/complete-onboarding`, { headers: { authorization: `Bearer ${account.token}` } });
  await page.addInitScript((session) => { localStorage.setItem('auth-token', session.token); localStorage.setItem('ultrarag_enterprise_agent_scope', session.agentId); }, { token: account.token, agentId: branchAgentId });

  await page.goto(`http://127.0.0.1:${ports.pilotVite}/knowledge/new`, { waitUntil: 'domcontentloaded' });
  const source = join(tempRoot, 'g4-pd-advanced.md'); await writeFile(source, '# PilotDeck Advanced Policy\n\nOwner approval is required.\n\nUnchanged field: retain this paragraph.\n', 'utf8');
  await page.locator('input[type=file]').first().setInputFiles(source);
  const upload = await waitResponse('import_document', 30_000); assert.equal(upload.responseStatus, 200); output.actions.push('upload branch-scoped advanced document through PilotDeck shared UI');
  await page.waitForTimeout(4_000);
  await page.getByRole('button', { name: /Manage Existing Knowledge Base|管理已有知识库/i }).click();
  await selectBase(page, 'g4-pd-advanced'); await page.getByText(/Knowledge graph|知识图谱/).last().waitFor({ timeout: 30_000 });
  await page.getByText(/View All|查看全部/i).last().click(); const evidenceDetail = page.locator('.knowledge-detail-modal').last(); await evidenceDetail.waitFor({ state: 'visible', timeout: 10_000 });
  await evidenceDetail.getByRole('button', { name: /Edit|编辑|修改/ }).first().click(); const bucketDialog = page.locator('[role=dialog]').last(); await bucketDialog.locator('textarea').nth(2).waitFor({ state: 'visible', timeout: 15_000 }); await bucketDialog.locator('textarea').last().fill('Owner approval is required.\n\nUnchanged field: retain this paragraph.\n\nPD bucket edit persisted.'); await bucketDialog.getByRole('button', { name: /Save|保存/ }).last().click();
  const chunkSave = await waitResponse('update_chunk'); assert.equal(chunkSave.responseStatus, 200); output.actions.push('edit and save bucket/chunk through PilotDeck shared UI');
  await page.goto(`http://127.0.0.1:${ports.pilotVite}/knowledge/new`, { waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: /Manage Existing Knowledge Base|管理已有知识库/i }).click(); await forceSelectBase(page, 'g4-pd-advanced'); await page.getByText(/Knowledge graph|知识图谱/).last().waitFor({ timeout: 30_000 }); await page.getByText(/View All|查看全部/i).last().click(); await page.locator('.knowledge-detail-modal').last().getByText('PD bucket edit persisted', { exact: false }).waitFor({ timeout: 15_000 }); output.persistence.bucketReload = (await page.locator('.knowledge-detail-modal').last().innerText()).slice(-1800); output.coverage.structure_buckets_chunks = 'real_ui_pd_shared_adapter_edit_reload';

  await page.locator('.knowledge-detail-modal').last().press('Escape').catch(() => page.keyboard.press('Escape')); await page.mouse.click(10, 10); await page.locator('.knowledge-detail-modal').last().waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);

  // Export/lint/import use the populated branch head. A rollback to the
  // initial empty upload version is intentionally hidden by the shared page,
  // so perform these row-scoped actions before the final rollback check.
  await page.getByText(/^Knowledge$/, { exact: true }).last().click(); await page.getByText(/Knowledge base list|知识库列表/).waitFor({ timeout: 30_000 }); await openBaseActionsFor(page, 'g4-pd-advanced'); const downloadEvent = page.waitForEvent('download'); await page.getByText(/Export knowledge base backup|导出知识库备份包/i, { exact: true }).last().click(); const download = await downloadEvent; assert.match(download.suggestedFilename(), /g4-pd-advanced.*okf.*\.zip/i); const exportResponse = await waitResponse('export_okf'); assert.equal(exportResponse.responseStatus, 200); output.persistence.export = { filename: download.suggestedFilename(), status: exportResponse.responseStatus }; await openBaseActionsFor(page, 'g4-pd-advanced'); await page.getByText(/Check knowledge graph|知识图谱检查/i, { exact: true }).last().click(); await page.getByRole('dialog').last().waitFor({ state: 'visible', timeout: 10_000 }); const lint = await waitResponse('lint_okf'); assert.equal(lint.responseStatus, 200); output.persistence.lint = { status: lint.responseStatus }; output.coverage.okf_export_lint = 'real_ui_pd_shared_adapter_export_lint'; output.actions.push('export and lint OKF through PilotDeck shared UI'); await page.getByRole('dialog').last().getByRole('button', { name: /Close|关闭/i }).click().catch(() => page.keyboard.press('Escape'));

  await page.keyboard.press('Escape').catch(() => undefined); await page.goto(`http://127.0.0.1:${ports.pilotVite}/knowledge`, { waitUntil: 'domcontentloaded' }); await page.getByText(/Knowledge base list|知识库列表/).waitFor({ timeout: 30_000 }); await page.getByRole('button', { name: /^(New|新增|Add)$/i }).first().click(); await page.getByText(/Import Knowledge Base Backup|导入知识库备份包/i, { exact: true }).last().click(); const invalid = join(tempRoot, 'invalid.okf.zip'); await writeFile(invalid, 'not a zip archive', 'utf8'); await page.locator('input[type=file]').last().setInputFiles(invalid); const importFailure = await waitResponse('import_okf'); assert.ok(importFailure.responseStatus >= 400 && importFailure.responseStatus < 500); output.persistence.invalidImport = { status: importFailure.responseStatus, body: importFailure.responseBody }; output.coverage.okf_import_failure = 'real_ui_pd_shared_adapter_invalid_archive_failure'; output.actions.push('exercise invalid OKF import failure through PilotDeck shared UI');

  await page.keyboard.press('Escape').catch(() => undefined); await page.goto(`http://127.0.0.1:${ports.pilotVite}/knowledge`, { waitUntil: 'domcontentloaded' }); await page.getByText(/Knowledge base list|知识库列表/).waitFor({ timeout: 30_000 }); await openBaseActionsFor(page, 'g4-pd-advanced'); await page.getByText(/Version Management|版本管理/i, { exact: true }).last().click(); const versionDialog = page.locator('[role=dialog]').last(); await versionDialog.waitFor({ state: 'visible', timeout: 10_000 }); assert.ok(await versionDialog.locator('tbody tr').count() >= 2); await versionDialog.getByRole('button', { name: /Roll back|回滚/i }).first().click(); const rollback = await waitResponse('rollback_version'); assert.equal(rollback.responseStatus, 200); output.persistence.rollback = rollback.responseBody; output.coverage.versions_rollback = 'real_ui_pd_shared_adapter_branch_version_list_and_rollback'; output.actions.push('list branch versions and rollback through PilotDeck shared UI'); await versionDialog.getByRole('button', { name: /Close|关闭/i }).click(); await versionDialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
  await page.screenshot({ path: join(artifactRoot, 'g4-knowledge-pd-advanced.png'), fullPage: true }).catch(() => undefined); await context.close();
} catch (error) {
  output.error = error instanceof Error ? error.stack : String(error);
  if (page) {
    output.failureDiagnostics = {
      url: page.url(),
      dialogs: await page.locator('[role=dialog]').evaluateAll((nodes) => nodes.map((node) => ({ className: node.className, text: (node.textContent || '').slice(0, 2500), html: node.outerHTML.slice(0, 5000) }))).catch(() => []),
      visibleButtons: await page.getByRole('button').evaluateAll((nodes) => nodes.filter((node) => { const style = window.getComputedStyle(node); return style.display !== 'none' && style.visibility !== 'hidden'; }).map((node) => ({ aria: node.getAttribute('aria-label'), text: (node.textContent || '').trim() })).slice(-80)).catch(() => []),
      body: (await page.locator('body').innerText().catch(() => '')).slice(-8000),
    };
  }
  throw error;
}
finally { await stop(pilot); await stop(service); await browser?.close(); output.cleanup.processesStopped = true; await mkdir(artifactRoot, { recursive: true }); await writeFile(join(artifactRoot, 'report.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8'); await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined); }

console.log(JSON.stringify({ artifactRoot, coverage: output.coverage }, null, 2));
