import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStaffDeckRuntimeReadiness, STAFFDECK_RUNTIME_SLOTS } from './staffdeck-runtime-readiness.mjs';

const profile = {
  agent: { model: 'provider/model' },
  model: { providers: { provider: { apiKey: 'super-secret' } } },
  modules: Object.fromEntries(STAFFDECK_RUNTIME_SLOTS.map(name => [name, { enabled: true }])),
};
profile.modules.sop = {
  enabled: true, defaultSopId: 's', definitionsPath: '/private/path',
  discoveryEndpoint: 'https://owner.test/api/v1', discoveryAgentId: 'agent', discoveryApiKey: 'secret-key',
  management: { enabled: true, endpoint: 'https://owner.test/api/v1/', agentId: 'agent', apiKey: 'other-secret' },
};
const bundle = { sops: [{ id: 's', skill_id: 's', version: '2', content: {} }] };

test('seven-slot profile and owner binding stay config-only; secrets and paths are absent', () => {
  const result = prepareStaffDeckRuntimeReadiness({ profile, bundle });
  assert.deepEqual(Object.keys(result.slots), STAFFDECK_RUNTIME_SLOTS);
  assert.equal(result.discovery.configured, true);
  assert.equal(result.discovery.ownerBindingConsistent, true);
  assert.equal(result.discovery.routeObserved, false);
  assert.equal(result.modelDeclaration.providerDeclared, true);
  assert.equal(result.modelDeclaration.effective, 'unverified');
  assert.deepEqual(result.bindingIssues, []);
  const publicOutput = JSON.stringify(result);
  for (const secret of ['super-secret', 'secret-key', 'other-secret', '/private/path']) assert.equal(publicOutput.includes(secret), false);
});

test('publish receipt and persisted old pin remain claims pending runtime observation', () => {
  const result = prepareStaffDeckRuntimeReadiness({
    profile, bundle,
    receipts: { receipts: [{ sopId: 's', version: '2', status: 'awaiting-runtime-observation', ownerPublished: true, snapshotWritten: true, refreshRequested: true, receiptPersisted: true, effective: true }] },
    persistedSessions: [{ sessionId: 'existing', state: { selected_skill_id: 's' }, bundle: { sops: [{ id: 's', version: '1' }] }, wait: { kind: 'handoff' } }],
  });
  assert.equal(result.publishReceipts[0].runtimeObserved, false);
  assert.equal(result.declaredPins[0].declaredVersion, '1');
  assert.equal(result.declaredPins[0].waitKind, 'handoff');
  assert.equal(result.declaredPins[0].resumedAfterReload, false);
  assert.equal(result.requiredEvidence.includes('new-run-new-pin-and-existing-run-old-pin'), true);
});

test('off, absent, mismatch and incomplete bundle are reported without inventing readiness', () => {
  const changed = structuredClone(profile);
  changed.modules.knowledge.enabled = false;
  delete changed.modules.tools;
  changed.modules.sop.discoveryAgentId = 'other';
  const result = prepareStaffDeckRuntimeReadiness({ profile: changed, bundle: { sops: [] } });
  assert.equal(result.slots.knowledge, 'installed-off');
  assert.equal(result.slots.tools, 'absent');
  assert.equal(result.discovery.ownerBindingConsistent, false);
  assert.deepEqual(result.bindingIssues, ['management-discovery-owner-mismatch', 'default-sop-not-in-bundle']);
});

test('malformed bundle IDs and versions are visible as configuration issues', () => {
  const result = prepareStaffDeckRuntimeReadiness({ profile, bundle: { sops: [{ id: 's' }, { id: 's', version: '3' }] } });
  assert.equal(result.bindingIssues.includes('bundle-id-version-invalid'), true);
});
