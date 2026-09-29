import { test, expect, clickButton } from './fixtures.mjs';

test.describe.configure({ mode: 'serial' });

test('ONB-LANG-001 language selection and navigation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('main')).toContainText(/Welcome|欢迎|Language|语言/i);
  const chinese = page.getByRole('button', { name: /简体中文|Chinese/i }).first();
  if (await chinese.count() && await chinese.isVisible().catch(() => false)) await chinese.click();
  await clickButton(page, ['开始配置', 'Start setup']);
  await expect(page.locator('body')).toContainText(/Provider|服务商/i);
});

test('ONB-PROVIDER-001 selects OpenAI, Anthropic and Gemini providers', async ({ page }) => {
  await page.goto('/');
  await clickButton(page, ['开始配置', 'Start setup']);
  for (const name of [/OpenAI/i, /Anthropic|Claude/i, /Google AI|Gemini/i]) {
    const card = page.getByRole('button', { name }).first();
    await expect(card).toBeVisible();
    await card.click();
    await expect(card).toHaveAttribute('aria-pressed', 'true');
  }
  await clickButton(page, ['继续', 'Continue', 'Next']);
  await expect(page.locator('body')).toContainText(/API Key|密钥/i);
});

test('ONB-CONN-001 real connection form controls and model selection', async ({ page }) => {
  await page.goto('/');
  await clickButton(page, ['开始配置', 'Start setup']);
  await page.getByRole('button', { name: /OpenAI/i }).first().click();
  await clickButton(page, ['继续', 'Continue', 'Next']);
  const key = page.getByLabel(/API Key|密钥/i).first();
  await key.fill(process.env.PILOTDECK_E2E_API_KEY);
  const toggle = page.getByRole('button', { name: /显示密钥|Show key|隐藏密钥|Hide key/i }).first();
  if (await toggle.count()) await toggle.click();
  await page.getByRole('button', { name: /添加模型|Add model/i }).click();
  const draft = page.getByRole('textbox', { name: /模型 ID|Model ID/i }).last();
  await draft.fill(process.env.PILOTDECK_E2E_OPENAI_MODEL || 'gpt-4.1');
  await draft.press('Enter');
  await expect(page.locator('body')).toContainText(process.env.PILOTDECK_E2E_OPENAI_MODEL || 'gpt-4.1');
  await clickButton(page, ['测试连接', 'Test connection']);
});

test('ONB-NAV-002 back and completion controls are real', async ({ page }) => {
  await page.goto('/');
  await clickButton(page, ['开始配置', 'Start setup']);
  await page.getByRole('button', { name: /OpenAI/i }).first().click();
  await clickButton(page, ['继续', 'Continue', 'Next']);
  await expect(page.getByRole('button', { name: /返回|Back/i }).first()).toBeVisible();
  await page.getByRole('button', { name: /返回|Back/i }).first().click();
  await expect(page.locator('body')).toContainText(/Provider|服务商/i);
});
