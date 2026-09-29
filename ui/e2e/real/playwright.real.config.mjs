import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runDir = process.env.PILOTDECK_E2E_RUN_DIR || '/tmp/pilotdeck-real-e2e';
const onboardingMode = process.env.PILOTDECK_E2E_MODE === 'onboarding';
const port = Number(process.env.PILOTDECK_E2E_VITE_PORT || (onboardingMode ? 5181 : 5180));

export default defineConfig({
  testDir: resolve(root, 'e2e/real'),
  testMatch: /^(?!.*onboarding).*\.spec\.mjs$/,
  outputDir: resolve(runDir, 'results'),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['line'], ['html', { outputFolder: resolve(runDir, 'report'), open: 'never' }]] : 'line',
  globalSetup: resolve(root, 'e2e/real/global-setup.mjs'),
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    storageState: resolve(runDir, 'storage-state.json'),
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: `node ${resolve(root, 'e2e/real/launch.mjs')}`,
    cwd: root,
    url: `http://127.0.0.1:${port}/`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      PILOTDECK_E2E_MODE: 'ready',
      PILOTDECK_E2E_RUNTIME_FILE: resolve(runDir, 'runtime.json'),
    },
  },
});
