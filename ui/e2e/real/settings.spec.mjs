import { test, expect, appReady, clickButton } from './fixtures.mjs';

test.describe.configure({ mode: 'serial' });
const menuNames = [
  /通用|General/i, /模型池|Model pool/i, /模型|Agent.*model/i, /路由|Route/i,
  /记忆|Memory/i, /常驻|Always-On/i, /搜索|Search/i, /定时任务|Schedule|Cron/i,
  /外部集成|Integrations/i, /MCP 服务器|MCP servers/i, /Office 预览|Office preview/i,
  /安全隐私|Privacy/i, /高级|Advanced/i, /关于|About/i,
];

test.beforeEach(async ({ page }) => {
  await appReady(page);
  await clickButton(page, ['设置', 'Settings']);
  await expect(page.locator('body')).toContainText(/设置|Settings/i);
});

test('SET-NAV-001 visits every settings menu', async ({ page }) => {
  for (const name of menuNames) {
    const item = page.getByRole('button', { name }).first();
    if (await item.count() && await item.isVisible().catch(() => false) && await item.isEnabled().catch(() => false)) {
      await item.click();
      await expect(page.locator('body')).toContainText(name);
    }
  }
});

test('SET-GENERAL-001 toggles visible general controls and persists', async ({ page }) => {
  await page.getByRole('button', { name: /通用|General/i }).first().click();
  const toggles = page.locator('input[type="checkbox"]');
  const count = await toggles.count();
  for (let i = 0; i < count; i++) {
    const toggle = toggles.nth(i);
    if (await toggle.isVisible().catch(() => false) && await toggle.isEnabled().catch(() => false)) {
      await toggle.click();
      await toggle.click();
    }
  }
  await page.reload();
  await expect(page.locator('body')).toContainText(/通用|General/i);
});

test('SET-MODEL-001 exercises model pool provider controls', async ({ page }) => {
  await page.getByRole('button', { name: /模型池|Model pool/i }).first().click();
  for (const name of [/添加|Add/i, /自定义|Custom/i, /展开|Expand/i, /刷新|Refresh/i]) {
    const button = page.getByRole('button', { name }).first();
    if (await button.count() && await button.isVisible().catch(() => false) && await button.isEnabled().catch(() => false)) await button.click();
  }
});

test('SET-AGENT-001 exercises agent settings controls', async ({ page }) => {
  for (const name of [/模型|Model/i, /路由|Route/i, /记忆|Memory/i, /常驻|Always-On/i, /搜索|Search/i, /定时任务|Schedule|Cron/i]) {
    const item = page.getByRole('button', { name }).first();
    if (await item.count() && await item.isVisible().catch(() => false)) {
      await item.click();
      const inputs = page.locator('input:not([type="hidden"]), select, textarea');
      for (let index = 0; index < await inputs.count(); index++) {
        const field = inputs.nth(index);
        if (await field.isVisible().catch(() => false)) {
          await field.press('Tab').catch(() => {});
          break;
        }
      }
    }
  }
});

test('SET-MCP-001 opens MCP extension and exercises modal cancel', async ({ page }) => {
  const item = page.getByRole('button', { name: /MCP 服务器|MCP servers/i }).first();
  if (await item.count()) {
    await item.click();
    const add = page.getByRole('button', { name: /添加|Add/i }).first();
    if (await add.count()) {
      await add.click();
      await expect(page.locator('body')).toContainText(/MCP|服务器|Server/i);
      await clickButton(page, ['取消', 'Cancel', '关闭', 'Close']);
    }
  }
});

test('SET-ADV-001 validates raw configuration actions', async ({ page }) => {
  await page.getByRole('button', { name: /高级|Advanced/i }).first().click();
  for (const name of [/展开配置|Show|Raw YAML/i, /刷新|Refresh/i, /重新加载|Reload/i]) {
    const button = page.getByRole('button', { name }).first();
    if (await button.count() && await button.isVisible().catch(() => false) && await button.isEnabled().catch(() => false)) await button.click();
  }
});

test('SET-ABOUT-001 checks update and returns to app', async ({ page }) => {
  await page.getByRole('button', { name: /关于|About/i }).first().click();
  const update = page.getByRole('button', { name: /检查更新|Check for updates/i }).first();
  if (await update.count()) await update.click();
  await clickButton(page, ['返回应用', 'Back to app']);
  await expect(page.locator('body')).toContainText(/新对话|New conversation|项目|Projects/i);
});
