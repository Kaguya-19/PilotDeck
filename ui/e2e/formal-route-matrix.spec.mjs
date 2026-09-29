import { expect, test } from '@playwright/test';

const profile = process.env.FORMAL_ROUTE_PROFILE;

test.skip(!profile || !process.env.FORMAL_COMPOSITION_URL, 'Set FORMAL_ROUTE_PROFILE and FORMAL_COMPOSITION_URL for a formal route-matrix run.');

test(`formal ${profile} routes follow the generated composition`, async ({ page }, testInfo) => {
  // The shared StaffDeck assertions below intentionally cover the Chinese
  // production copy; make the browser locale deterministic for clean profiles.
  await page.addInitScript(() => localStorage.setItem('userLanguage', 'zh-CN'));
  if (process.env.FORMAL_ROUTE_AUTH === '1') {
    const credentials = { username: 'browser-evidence', password: 'browser-evidence-password' };
    const registration = await page.request.post('/api/auth/register', { data: credentials });
    const account = registration.ok()
      ? await registration.json()
      : await (await page.request.post('/api/auth/login', { data: credentials })).json();
    await page.addInitScript((token) => localStorage.setItem('auth-token', token), account.token);
    await page.request.post('/api/user/complete-onboarding', { headers: { authorization: `Bearer ${account.token}` } });
  }
  await page.goto('/');
  const skills = page.getByRole('button', { name: 'Skills', exact: true });
  if (profile === 'native') {
    await page.goto('/skills');
    await expect(page.getByRole('heading', { name: /Skills/i })).toBeVisible();
  } else {
    await expect(skills).toHaveCount(0);
    await page.goto('/skills');
    await expect(page.getByPlaceholder('搜索 SOP 名称、ID、业务域')).toHaveCount(0);
  }
  for (const path of ['/sop', '/knowledge']) {
    await page.goto(path);
    await expect(page.getByPlaceholder(path === '/sop' ? '搜索 SOP 名称、ID、业务域' : '输入知识问题')).toHaveCount(0);
  }
  await page.screenshot({ path: testInfo.outputPath(`${profile}-route-matrix.png`), fullPage: true });
});
