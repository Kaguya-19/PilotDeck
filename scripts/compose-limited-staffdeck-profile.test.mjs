import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeLimitedStaffDeckProfile, composeVerifiedLimitedStaffDeckProfile,
  verifyPortableSopRuntime } from './compose-limited-staffdeck-profile.mjs';

test('limited profile consumes one verified target, credential and published bundle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'staffdeck-limited-'));
  try {
    const bundle = join(root, 'published.json');
    writeFileSync(bundle, '{"sops":[{"id":"published"}]}');
    const key = 'fixture-account-public-key';
    const prepared = {
      readiness: { recordedTupleConsistent: true }, identity: { targetAgentId: 'target' },
      env: { STAFFDECK_FORMAL_API_ORIGIN: 'http://127.0.0.1:16400', STAFFDECK_PUBLIC_ORIGIN: 'http://127.0.0.1:16400',
        STAFFDECK_SOP_MANAGEMENT_API_KEY: key, STAFFDECK_KNOWLEDGE_READ_KEY: key,
        STAFFDECK_FIXED_TARGET_AGENT_ID: 'target', STAFFDECK_PUBLISHED_SOP_BUNDLE_PATH: bundle,
        STAFFDECK_PUBLISHED_SOP_ID: 'published', STAFFDECK_SOP_MANAGEMENT_ENDPOINT: 'http://127.0.0.1:16400/api/v1' },
      configPatch: {
        webui: { staffdeckCopy: { enabled: true, contract: 'staffdeck.enterprise-copy/v1', targetAgentIdEnv: 'STAFFDECK_COPY_TARGET_AGENT_ID' } },
        modules: { knowledge: { agentId: 'target' }, sop: { definitionsPath: bundle,
          defaultSopId: 'published', discoveryAgentId: 'target', discoveryApiKey: key,
          discoveryEndpoint: 'http://127.0.0.1:16400/api/v1',
          management: { enabled: true, agentIdEnv: 'STAFFDECK_COPY_TARGET_AGENT_ID' } } },
      },
    };
    const env = { PILOTDECK_REAL_MODEL_PROVIDER_ID: 'real', PILOTDECK_REAL_MODEL_ID: 'model',
      PILOTDECK_REAL_MODEL_BASE_URL: 'https://model.example/v1', PILOTDECK_REAL_MODEL_API_KEY: 'fixture-model-key',
      STAFFDECK_PUBLIC_ORIGIN: 'http://127.0.0.1:16400', STAFFDECK_KNOWLEDGE_READ_KEY: key,
      STAFFDECK_FIXED_TARGET_AGENT_ID: 'target', STAFFDECK_SOP_RUNTIME_ORIGIN: 'http://127.0.0.1:16401',
      STAFFDECK_PUBLISHED_SOP_BUNDLE_PATH: bundle, STAFFDECK_PUBLISHED_SOP_ID: 'published' };
    const profile = composeLimitedStaffDeckProfile(prepared, env);
    assert.equal(profile.webui.staffdeckCopy.targetAgentIdEnv, 'STAFFDECK_COPY_TARGET_AGENT_ID');
    assert.equal(profile.modules.knowledge.callPath, '/api/v1/agents/target/knowledge-module/v2/module/call');
    assert.equal(profile.modules.sop.management.agentIdEnv, 'STAFFDECK_COPY_TARGET_AGENT_ID');
    assert.equal(profile.modules.sop.discoveryAgentId, 'target');
    assert.equal(profile.modules.sop.endpoint, 'http://127.0.0.1:16401');
    assert.equal(profile.modules.knowledge.credentialEnv, 'STAFFDECK_KNOWLEDGE_READ_KEY');
    assert.equal(profile.modules.sop.discoveryApiKey, key);
    const verified = await composeVerifiedLimitedStaffDeckProfile(prepared, env, async () => ({
      ok: true, json: async () => ({ status: 'ok', moduleId: 'sop.runtime',
        contract: 'sop.lifecycle/v2', protocolVersion: '2.0', operations: ['prepare', 'submit'] }),
    }));
    assert.deepEqual(verified, profile);
    assert.throws(() => composeLimitedStaffDeckProfile(prepared, {
      ...env, STAFFDECK_SOP_RUNTIME_ORIGIN: 'http://127.0.0.1:16400',
    }), /SOP_RUNTIME_ORIGIN_COLLIDES_WITH_STAFFDECK_API/);
    assert.throws(() => composeLimitedStaffDeckProfile(prepared, { ...env, STAFFDECK_FIXED_TARGET_AGENT_ID: 'other' }), /PRIVATE_BINDING_ENV_MISMATCH/);
    assert.throws(() => composeLimitedStaffDeckProfile(prepared, { ...env, STAFFDECK_KNOWLEDGE_READ_KEY: 'another' }), /PRIVATE_BINDING_ENV_MISMATCH/);
    assert.throws(() => composeLimitedStaffDeckProfile({ ...prepared,
      configPatch: { ...prepared.configPatch, modules: { ...prepared.configPatch.modules,
        sop: { ...prepared.configPatch.modules.sop, definitionsPath: 'relative.json' } } },
      env: { ...prepared.env, STAFFDECK_PUBLISHED_SOP_BUNDLE_PATH: 'relative.json' },
    }, { ...env, STAFFDECK_PUBLISHED_SOP_BUNDLE_PATH: 'relative.json' }), /SOP_BUNDLE_ABSOLUTE_PATH_REQUIRED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('enabled profile requires the portable SOP runtime manifest at its own origin', async () => {
  const profile = { modules: { sop: { endpoint: 'http://127.0.0.1:16401' } } };
  const calls = [];
  const manifest = { status: 'ok', protocolVersion: '2.0', moduleId: 'sop.runtime',
    contract: 'sop.lifecycle/v2', operations: ['prepare', 'submit'] };
  const fetchManifest = async (url, options) => {
    calls.push({ url, method: options.method });
    return { ok: true, json: async () => manifest };
  };
  assert.equal(await verifyPortableSopRuntime(profile, fetchManifest), manifest);
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:16401/healthz', method: 'GET' }]);
  await assert.rejects(() => verifyPortableSopRuntime(profile, async () => ({ ok: false })),
    /SOP_RUNTIME_MANIFEST_UNAVAILABLE/);
  await assert.rejects(() => verifyPortableSopRuntime(profile, async () => ({ ok: true,
    json: async () => ({ status: 'ok' }),
  })), /SOP_RUNTIME_MANIFEST_INVALID/);
});
