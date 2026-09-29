import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';

export default async function globalSetup(config) {
  const runtimePath = process.env.PILOTDECK_E2E_RUNTIME_FILE || '/tmp/pilotdeck-real-e2e/runtime.json';
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
  const baseURL = config.projects[0].use.baseURL;
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });

  const setup = page.getByRole('button', { name: 'Create Account' });
  const login = page.getByRole('button', { name: /Sign in|登录|Log in/i });
  await Promise.race([
    setup.waitFor({ state: 'visible', timeout: 30_000 }),
    login.waitFor({ state: 'visible', timeout: 30_000 }),
  ]).catch(() => {});
  if (await setup.isVisible().catch(() => false)) {
    await page.getByLabel('Username').fill(process.env.PILOTDECK_E2E_USERNAME || 'e2e-user');
    await page.getByLabel('Password', { exact: true }).fill(process.env.PILOTDECK_E2E_PASSWORD || 'e2e-password-123');
    await page.getByLabel('Confirm Password').fill(process.env.PILOTDECK_E2E_PASSWORD || 'e2e-password-123');
    await setup.click();
  } else {
    if (await login.isVisible().catch(() => false)) {
      await page.getByLabel(/Username|用户名/i).fill(process.env.PILOTDECK_E2E_USERNAME || 'e2e-user');
      await page.getByLabel(/Password|密码/i).fill(process.env.PILOTDECK_E2E_PASSWORD || 'e2e-password-123');
      await login.click();
    }
  }

  await page.waitForLoadState('networkidle').catch(() => {});
  await context.storageState({ path: config.projects[0].use.storageState });
  await browser.close();
  return runtime;
}
