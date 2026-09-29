import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
const rendererPath = pathToFileURL(join(process.cwd(), 'products/pilotdeck-staffdeck-sop/profiles/render-limited-20260928.mjs')).href;
const { renderLimitedProfile } = await import(rendererPath);
import { loadPilotConfig } from '../../src/pilot/config/loadPilotConfig.js';
import { parseModulesConfig } from '../../src/pilot/config/parseModulesConfig.js';
import type { PilotConfigDiagnostic } from '../../src/pilot/config/types.js';

test('rendered limited profile selects authenticated Knowledge query and native PD model', () => {
  const root = mkdtempSync(join(tmpdir(), 'limited-profile-'));
  try {
    const bundle = join(root, 'published.json'); writeFileSync(bundle, '{"sops":[]}');
    const env = {
      PILOT_HOME: root, PILOTDECK_REAL_MODEL_PROVIDER_ID: 'actual', PILOTDECK_REAL_MODEL_ID: 'm',
      PILOTDECK_REAL_MODEL_BASE_URL: 'https://model.example/v1', PILOTDECK_REAL_MODEL_API_KEY: 'test-key',
      STAFFDECK_PUBLIC_ORIGIN: 'http://127.0.0.1:8900', STAFFDECK_KNOWLEDGE_READ_KEY: 'test-account-key',
      STAFFDECK_FIXED_TARGET_AGENT_ID: 'target', STAFFDECK_SOP_RUNTIME_ORIGIN: 'http://127.0.0.1:8901',
      STAFFDECK_PUBLISHED_SOP_BUNDLE_PATH: bundle, STAFFDECK_PUBLISHED_SOP_ID: 'published',
    };
    const configPath = join(root, 'pilotdeck.json');
    writeFileSync(configPath, JSON.stringify(renderLimitedProfile(env)));
    const snapshot = loadPilotConfig({ configPath, env });
    assert.equal(snapshot.config.agent.model.id, 'actual/m');
    const knowledge = snapshot.config.modules?.knowledge;
    assert.equal(knowledge?.enabled, true);
    assert.equal(knowledge && 'credentialEnv' in knowledge && knowledge.credentialEnv, 'STAFFDECK_KNOWLEDGE_READ_KEY');
    assert.equal(knowledge && 'callPath' in knowledge && knowledge.callPath,
      '/api/v1/agents/target/knowledge-module/v2/module/call');
    assert.deepEqual(knowledge && 'methods' in knowledge && knowledge.methods, ['query']);
    const sop = snapshot.config.modules?.sop;
    assert.ok(sop && 'provider' in sop);
    assert.equal(sop.provider, 'staffdeck');
    assert.equal(sop.defaultSopId, 'published');
    assert.equal(sop.definitionsPath, realpathSync(bundle));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('profile refuses missing real inputs', () => {
  assert.throws(() => renderLimitedProfile({}), /LIMITED_PROFILE_INPUT_MISSING/);
});

test('authenticated Knowledge binding cannot point at the legacy module route', () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  parseModulesConfig({ knowledge: { enabled: true, implementationId: 'staffdeck.knowledge',
    contract: 'staffdeck.knowledge/v1', transport: 'module-http-v2',
    endpoint: 'http://127.0.0.1:8900', manifestPath: '/module-manifest',
    callPath: '/v2/module/call', methods: ['query'], agentId: 'target',
    credentialEnv: 'STAFFDECK_KNOWLEDGE_READ_KEY' } }, '/tmp', diagnostics);
  assert.ok(diagnostics.some(item => item.code === 'MODULE_AUTHENTICATED_KNOWLEDGE_BINDING_INVALID'));
});
