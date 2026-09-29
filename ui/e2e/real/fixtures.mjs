import { test as base, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await use(page);
    if (consoleErrors.length) {
      await testInfo.attach('browser-console-errors', { body: consoleErrors.join('\n'), contentType: 'text/plain' });
    }
  },
});

export { expect };

export const runtime = async () => JSON.parse(await readFile(
  process.env.PILOTDECK_E2E_RUNTIME_FILE || '/tmp/pilotdeck-real-e2e/runtime.json',
  'utf8',
));

export const clickIfVisible = async (page, locator) => {
  if (await locator.count() && await locator.first().isVisible()) {
    await locator.first().click();
    return true;
  }
  return false;
};

export const clickButton = async (page, names) => {
  const pattern = names instanceof RegExp ? names : new RegExp(names.map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  const button = page.getByRole('button', { name: pattern }).first();
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await button.click();
  return button;
};

export const appReady = async (page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toContainText(/PilotDeck|项目|Projects|会话|Conversations/i, { timeout: 30_000 });
};

export const dismissDialogs = async (page) => {
  for (const name of [/取消|Cancel/i, /关闭|Close/i]) {
    const button = page.getByRole('button', { name }).last();
    if (await button.count() && await button.isVisible().catch(() => false)) await button.click().catch(() => {});
  }
};

export const assertNoMocking = async (page) => {
  const requests = [];
  const listener = (request) => requests.push(request.url());
  page.on('request', listener);
  return () => {
    page.off('request', listener);
    expect(requests.some((url) => url.includes('/api/'))).toBeTruthy();
    expect(requests.some((url) => url.includes('fixture'))).toBeFalsy();
  };
};
