import config from './playwright.real.config.mjs';

export default {
  ...config,
  testMatch: /onboarding\.spec\.mjs$/,
  use: { ...config.use, baseURL: 'http://127.0.0.1:5181', viewport: { width: 1440, height: 900 } },
  webServer: {
    ...config.webServer,
    url: 'http://127.0.0.1:5181/',
    env: { ...config.webServer.env, PILOTDECK_E2E_MODE: 'onboarding' },
  },
};
