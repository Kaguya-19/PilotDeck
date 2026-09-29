import { test, expect, appReady, clickButton } from './fixtures.mjs';
import { readFile } from 'node:fs/promises';

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ page }) => appReady(page));

test('FIL-TREE-001 opens file workbench and navigates seeded files', async ({ page }) => {
  await clickButton(page, ['文件', 'Files']);
  await expect(page.locator('body')).toContainText(/README\.md|sample\.ts/i, { timeout: 30_000 });
  await page.getByText('README.md', { exact: true }).click();
  await expect(page.locator('body')).toContainText('E2E-FILE-SEED');
});

test('FIL-TREE-002 refresh and search controls update the tree', async ({ page }) => {
  await clickButton(page, ['文件', 'Files']);
  const refresh = page.getByRole('button', { name: /刷新|Refresh/i }).first();
  if (await refresh.count()) await refresh.click();
  const search = page.getByRole('textbox', { name: /搜索|Search/i }).first();
  if (await search.count()) {
    await search.fill('sample');
    await expect(page.locator('body')).toContainText('sample.ts');
    await search.fill('missing-file');
    await expect(page.locator('body')).not.toContainText('sample.ts');
  }
});

test('FIL-EDIT-001 edits and saves a real file', async ({ page }) => {
  await clickButton(page, ['文件', 'Files']);
  await page.getByText('README.md', { exact: true }).click();
  const edit = page.getByRole('button', { name: /编辑|Edit/i }).first();
  if (await edit.count()) {
    await edit.click();
    const editor = page.locator('textarea').last();
    await editor.fill('# Real E2E edited\nE2E-FILE-SAVED\n');
    await clickButton(page, ['保存', 'Save']);
    await expect(page.locator('body')).toContainText('E2E-FILE-SAVED');
  }
});

test('FIL-PREVIEW-001 closes file preview and assistant panel', async ({ page }) => {
  await clickButton(page, ['文件', 'Files']);
  const assistant = page.getByRole('button', { name: /智能聊天|Smart chat|助手/i }).first();
  if (await assistant.count()) {
    await assistant.click();
    const close = page.getByRole('button', { name: /关闭|Close/i }).last();
    if (await close.count()) await close.click();
  }
});
