/** Render one enabled minimum profile from deployment inputs; no placeholder IDs. */
import { realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const required = [
  'PILOTDECK_REAL_MODEL_PROVIDER_ID', 'PILOTDECK_REAL_MODEL_ID',
  'PILOTDECK_REAL_MODEL_BASE_URL', 'PILOTDECK_REAL_MODEL_API_KEY',
  'STAFFDECK_PUBLIC_ORIGIN', 'STAFFDECK_KNOWLEDGE_READ_KEY',
  'STAFFDECK_FIXED_TARGET_AGENT_ID', 'STAFFDECK_SOP_RUNTIME_ORIGIN',
  'STAFFDECK_PUBLISHED_SOP_BUNDLE_PATH', 'STAFFDECK_PUBLISHED_SOP_ID',
];

export function renderLimitedProfile(env = process.env) {
  const missing = required.filter(name => !env[name]?.trim());
  if (missing.length) throw Error(`LIMITED_PROFILE_INPUT_MISSING: ${missing.join(', ')}`);
  const provider = env.PILOTDECK_REAL_MODEL_PROVIDER_ID.trim();
  const model = env.PILOTDECK_REAL_MODEL_ID.trim();
  const target = env.STAFFDECK_FIXED_TARGET_AGENT_ID.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(provider) || !/^[A-Za-z0-9._/-]+$/.test(model)
      || !/^[A-Za-z0-9._-]+$/.test(target)) {
    throw Error('LIMITED_PROFILE_ID_INVALID');
  }
  const publicOrigin = new URL(env.STAFFDECK_PUBLIC_ORIGIN.trim());
  const sopOrigin = new URL(env.STAFFDECK_SOP_RUNTIME_ORIGIN.trim());
  const modelOrigin = new URL(env.PILOTDECK_REAL_MODEL_BASE_URL.trim());
  if (!['http:', 'https:'].includes(publicOrigin.protocol) || !['http:', 'https:'].includes(sopOrigin.protocol)
      || !['http:', 'https:'].includes(modelOrigin.protocol)
      || publicOrigin.username || publicOrigin.password || sopOrigin.username || sopOrigin.password
      || modelOrigin.username || modelOrigin.password || publicOrigin.pathname !== '/'
      || sopOrigin.pathname !== '/') {
    throw Error('LIMITED_PROFILE_ORIGIN_INVALID');
  }
  const bundle = realpathSync(env.STAFFDECK_PUBLISHED_SOP_BUNDLE_PATH.trim());
  if (!statSync(bundle).isFile()) throw Error('LIMITED_PROFILE_BUNDLE_NOT_FILE');
  return {
    schemaVersion: 1,
    agent: { model: `${provider}/${model}` },
    model: { providers: { [provider]: {
      protocol: 'openai', url: env.PILOTDECK_REAL_MODEL_BASE_URL.trim(),
      apiKey: '${PILOTDECK_REAL_MODEL_API_KEY}',
      models: { [model]: { capabilities: { supportsToolUse: true } } },
    } } },
    modules: {
      agentLoop: { enabled: true, provider: 'pilotdeck' },
      skills: { enabled: true, provider: 'pilotdeck' },
      tools: { enabled: true, provider: 'pilotdeck' },
      context: { enabled: true, provider: 'pilotdeck' },
      modelProvider: { enabled: true, provider: 'pilotdeck' },
      knowledge: {
        enabled: true, implementationId: 'staffdeck.knowledge', contract: 'staffdeck.knowledge/v1',
        transport: 'module-http-v2', endpoint: publicOrigin.origin,
        manifestPath: '/api/v1/knowledge-module/module-manifest',
        callPath: `/api/v1/agents/${encodeURIComponent(target)}/knowledge-module/v2/module/call`,
        methods: ['query'], agentId: target,
        credentialEnv: 'STAFFDECK_KNOWLEDGE_READ_KEY',
      },
      sop: { enabled: true, provider: 'staffdeck', endpoint: sopOrigin.origin,
        definitionsPath: bundle, defaultSopId: env.STAFFDECK_PUBLISHED_SOP_ID.trim(), timeoutMs: 30000 },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2];
  if (!output) throw Error('Usage: node render-limited-20260928.mjs OUTPUT_PATH');
  const profile = renderLimitedProfile();
  writeFileSync(output, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${resolve(output)}\n`);
}
