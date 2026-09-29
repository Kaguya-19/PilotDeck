#!/usr/bin/env node

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const runDir = process.env.PILOTDECK_E2E_RUN_DIR || join('/tmp', 'pilotdeck-real-e2e');
const mode = process.env.PILOTDECK_E2E_MODE === 'onboarding' ? 'onboarding' : 'ready';
const ports = {
  server: Number(process.env.PILOTDECK_E2E_SERVER_PORT || (mode === 'onboarding' ? 3011 : 3010)),
  vite: Number(process.env.PILOTDECK_E2E_VITE_PORT || (mode === 'onboarding' ? 5181 : 5180)),
  gateway: Number(process.env.PILOTDECK_E2E_GATEWAY_PORT || (mode === 'onboarding' ? 18799 : 18798)),
};

if (!process.env.PILOTDECK_E2E_LLM_CENTER_URL || !process.env.PILOTDECK_E2E_API_KEY) {
  throw new Error('Real E2E requires PILOTDECK_E2E_LLM_CENTER_URL and PILOTDECK_E2E_API_KEY');
}

await rm(runDir, { recursive: true, force: true });
await mkdir(join(runDir, 'workspace', 'e2e-project'), { recursive: true });
await mkdir(join(runDir, 'home'), { recursive: true });

const configPath = join(runDir, 'pilotdeck.yaml');
const workspacePath = join(runDir, 'workspace');
const openaiUrl = process.env.PILOTDECK_E2E_OPENAI_URL || `${process.env.PILOTDECK_E2E_LLM_CENTER_URL}/v1`;
const anthropicUrl = process.env.PILOTDECK_E2E_ANTHROPIC_URL || `${process.env.PILOTDECK_E2E_LLM_CENTER_URL}/v1`;
const googleUrl = process.env.PILOTDECK_E2E_GEMINI_URL || process.env.PILOTDECK_E2E_LLM_CENTER_URL;
const openaiModel = process.env.PILOTDECK_E2E_OPENAI_MODEL || 'gpt-4.1';
const anthropicModel = process.env.PILOTDECK_E2E_ANTHROPIC_MODEL || 'claude-sonnet-4.6';
const geminiModel = process.env.PILOTDECK_E2E_GEMINI_MODEL || 'gemini-2.5-flash';
const activeProvider = process.env.PILOTDECK_E2E_PROVIDER || 'e2e-openai';
const activeModel = activeProvider === 'e2e-anthropic'
  ? anthropicModel
  : activeProvider === 'e2e-google' ? geminiModel : openaiModel;

const modelConfig = mode === 'onboarding' ? `model:
  providers: {}
` : `agent:
  model: ${activeProvider}/${activeModel}
model:
  providers:
    e2e-openai:
      protocol: openai
      url: ${openaiUrl}
      apiKey: "\${PILOTDECK_E2E_API_KEY}"
      models:
        ${openaiModel}: {}
    e2e-anthropic:
      protocol: anthropic
      url: ${anthropicUrl}
      apiKey: "\${PILOTDECK_E2E_API_KEY}"
      models:
        ${anthropicModel}: {}
    e2e-google:
      protocol: google
      url: ${googleUrl}
      apiKey: "\${PILOTDECK_E2E_API_KEY}"
      models:
        ${geminiModel}: {}
`;

const config = `schemaVersion: 1
${modelConfig}
webui:
  runtime:
    serverPort: ${ports.server}
    vitePort: ${ports.vite}
    workspacesRoot: ${workspacePath}
`;
await writeFile(configPath, config, 'utf8');
await writeFile(join(workspacePath, 'e2e-project', 'README.md'), '# Real E2E workspace\nE2E-FILE-SEED\n', 'utf8');
await writeFile(join(workspacePath, 'e2e-project', 'sample.ts'), 'export const e2eMarker = "E2E-FILE-SEED";\n', 'utf8');
await writeFile(join(workspacePath, 'e2e-project', 'SKILL.md'), '---\nname: e2e-seed\ndescription: Real E2E seed skill\n---\n\n# E2E seed\n', 'utf8');
await writeFile(join(runDir, 'runtime.json'), JSON.stringify({ runDir, configPath, workspacePath, mode, ports }, null, 2));

const child = spawn(process.execPath, [join(repoRoot, 'ui/server/webRuntimeSupervisor.js'), 'dev'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    PILOT_HOME: join(runDir, 'home'),
    DATABASE_PATH: join(runDir, 'auth.db'),
    PILOTDECK_CONFIG_PATH: configPath,
    PILOTDECK_DISABLE_LOCAL_AUTH: '0',
    SERVER_PORT: String(ports.server),
    VITE_PORT: String(ports.vite),
    PILOTDECK_GATEWAY_PORT: String(ports.gateway),
    PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${ports.gateway}/ws`,
  },
});

const stop = () => {
  if (!child.killed) child.kill('SIGTERM');
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
child.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
