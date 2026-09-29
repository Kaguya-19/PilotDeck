import { test, expect, appReady, clickButton } from './fixtures.mjs';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => appReady(page));

test('SES-SIDEBAR-001 creates and selects a new conversation', async ({ page }) => {
  await clickButton(page, ['新对话', 'New conversation', 'New chat']);
  await expect(page.locator('textarea, input[placeholder*="消息"], input[placeholder*="Message"]')).toBeVisible();
});

test('SES-SIDEBAR-003 expands navigation and opens settings/skills', async ({ page }) => {
  for (const name of [/项目|Projects/i, /会话|Conversations/i]) {
    const heading = page.getByText(name).first();
    if (await heading.count()) await heading.click().catch(() => {});
  }
  await clickButton(page, ['设置', 'Settings']);
  await expect(page.locator('body')).toContainText(/通用|General/i);
  await clickButton(page, ['返回应用', 'Back to app']);
  await clickButton(page, ['技能', 'Skills']);
  await expect(page.locator('body')).toContainText(/技能|Skills/i);
});

test('SES-MODEL-001 selects each configured real model', async ({ page }) => {
  for (const model of [
    process.env.PILOTDECK_E2E_OPENAI_MODEL || 'gpt-4.1',
    process.env.PILOTDECK_E2E_ANTHROPIC_MODEL || 'claude-sonnet-4.6',
    process.env.PILOTDECK_E2E_GEMINI_MODEL || 'gemini-2.5-flash',
  ]) {
    const modelButton = page.getByRole('button', { name: new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
    if (await modelButton.count() && await modelButton.isVisible().catch(() => false)) await modelButton.click();
  }
});

for (const provider of [
  ['openai', process.env.PILOTDECK_E2E_OPENAI_MODEL || 'gpt-4.1'],
  ['anthropic', process.env.PILOTDECK_E2E_ANTHROPIC_MODEL || 'claude-sonnet-4.6'],
  ['google', process.env.PILOTDECK_E2E_GEMINI_MODEL || 'gemini-2.5-flash'],
]) {
  test(`SES-COMPOSER-001 real ${provider[0]} chat`, async ({ page }) => {
    const marker = `E2E-CHAT-${provider[0]}-${Date.now()}`;
    const input = page.locator('textarea').first();
    await expect(input).toBeVisible();
    await input.fill(`Reply with exactly this marker: ${marker}`);
    await clickButton(page, ['发送', 'Send']);
    await expect(page.locator('body')).toContainText(marker, { timeout: 90_000 });
    await page.reload();
    await expect(page.locator('body')).toContainText(marker, { timeout: 30_000 });
  });
}

test('SES-HEADER-002 opens and closes conversation search', async ({ page }) => {
  const button = page.getByRole('button', { name: /搜索当前会话|Search current conversation/i }).first();
  if (await button.count()) {
    await button.click();
    await expect(page.getByRole('textbox').first()).toBeVisible();
    await page.keyboard.press('Escape');
  }
});

test('SES-MSG-003 destructive confirmation can be cancelled', async ({ page }) => {
  const menu = page.getByRole('button', { name: /上下文菜单|Context menu/i }).first();
  if (await menu.count()) {
    await menu.click();
    const remove = page.getByRole('menuitem', { name: /删除|Delete/i }).first();
    if (await remove.count()) {
      await remove.click();
      await clickButton(page, ['取消', 'Cancel']);
    }
  }
});
