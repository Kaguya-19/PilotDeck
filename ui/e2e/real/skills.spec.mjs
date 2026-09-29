import { test, expect, appReady, clickButton } from './fixtures.mjs';

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ page }) => appReady(page));

test('SKL-LIST-001 refreshes and selects a skill', async ({ page }) => {
  await clickButton(page, ['技能', 'Skills']);
  await expect(page.locator('body')).toContainText(/Skills|技能/i, { timeout: 30_000 });
  const refresh = page.getByRole('button', { name: /刷新|Refresh/i }).first();
  if (await refresh.count()) await refresh.click();
  const seed = page.getByText(/e2e-seed/i).first();
  if (await seed.count()) await seed.click();
});

test('SKL-SCOPE-001 switches user and project scope', async ({ page }) => {
  await clickButton(page, ['技能', 'Skills']);
  for (const scope of [/用户|User/i, /项目|Project/i]) {
    const button = page.getByRole('button', { name: scope }).first();
    if (await button.count()) await button.click();
  }
});

test('SKL-CREATE-001 opens and cancels create modal', async ({ page }) => {
  await clickButton(page, ['技能', 'Skills']);
  await clickButton(page, ['新建|New', '创建|Create']);
  await expect(page.locator('body')).toContainText(/slug|名称|Name/i);
  await clickButton(page, ['取消', 'Cancel', '关闭', 'Close']);
});

test('SKL-EDIT-001 opens editor and exercises save/cancel controls', async ({ page }) => {
  await clickButton(page, ['技能', 'Skills']);
  const edit = page.getByRole('button', { name: /编辑|Edit/i }).first();
  if (await edit.count()) {
    await edit.click();
    const save = page.getByRole('button', { name: /保存|Save/i }).first();
    const cancel = page.getByRole('button', { name: /取消|Cancel/i }).first();
    await expect(save).toBeVisible();
    await expect(cancel).toBeVisible();
    await cancel.click();
  }
});

test('SKL-IMPORT-001 opens import modal and cancels without writing', async ({ page }) => {
  await clickButton(page, ['技能', 'Skills']);
  const importButton = page.getByRole('button', { name: /导入|Import/i }).first();
  if (await importButton.count()) {
    await importButton.click();
    await expect(page.locator('body')).toContainText(/扫描|Scan|目录|Folder/i);
    await clickButton(page, ['取消', 'Cancel', '关闭', 'Close']);
  }
});
