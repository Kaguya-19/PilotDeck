/** Read-only, sanitized preparation for one G3-G6 seven-slot runtime profile. */
const SLOTS = Object.freeze(['agentLoop', 'skills', 'tools', 'context', 'modelProvider', 'sop', 'knowledge']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const version = item => nonempty(item?.version) ? item.version : undefined;
const sopId = item => nonempty(item?.skill_id) ? item.skill_id : item?.id;

function configuredSlot(value) {
  if (!record(value)) return 'absent';
  if (value.enabled === false) return 'installed-off';
  if (value.enabled === true) return 'configured-on';
  return 'invalid-enabled-state';
}

function publicEndpoint(value) {
  if (!nonempty(value)) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return undefined; }
}

/**
 * Input is a trusted server-side profile/readback projection. This function never
 * contacts StaffDeck, reads definitions, calls a model or claims a live runtime.
 * Keep the returned object free of API keys, bearer tokens and private paths.
 */
export function prepareStaffDeckRuntimeReadiness({ profile, bundle, receipts, persistedSessions = [] } = {}) {
  const modules = record(profile?.modules) ? profile.modules : {};
  const slots = Object.fromEntries(SLOTS.map(name => [name, configuredSlot(modules[name])]));
  const sop = record(modules.sop) ? modules.sop : {};
  const discovery = nonempty(sop.discoveryEndpoint) && nonempty(sop.discoveryAgentId)
    && nonempty(sop.discoveryApiKey);
  const management = record(sop.management) && sop.management.enabled === true
    && nonempty(sop.management.endpoint) && nonempty(sop.management.agentId);
  const discoveredEndpoint = publicEndpoint(sop.discoveryEndpoint);
  const ownerEndpoint = publicEndpoint(sop.management?.endpoint);
  const bindingIssues = [];
  if (slots.sop === 'configured-on') {
    if (!nonempty(sop.definitionsPath)) bindingIssues.push('definitions-path-missing');
    if (!nonempty(sop.defaultSopId)) bindingIssues.push('default-sop-missing');
    if (!discovery) bindingIssues.push('discovery-incomplete');
    if (!management) bindingIssues.push('management-incomplete');
    if (discovery && management && (sop.discoveryAgentId !== sop.management.agentId || discoveredEndpoint !== ownerEndpoint)) {
      bindingIssues.push('management-discovery-owner-mismatch');
    }
  }
  const definitions = Array.isArray(bundle?.sops) ? bundle.sops : [];
  const bundleVersions = definitions.filter(record).map(item => ({ sopId: sopId(item), version: version(item) }));
  if (slots.sop === 'configured-on' && !definitions.some(item => record(item) && sopId(item) === sop.defaultSopId)) {
    bindingIssues.push('default-sop-not-in-bundle');
  }
  if (bundleVersions.some(item => !nonempty(item.sopId) || !nonempty(item.version)) ||
      new Set(bundleVersions.map(item => item.sopId)).size !== bundleVersions.length) {
    bindingIssues.push('bundle-id-version-invalid');
  }
  const ownerReceipts = Array.isArray(receipts?.receipts) ? receipts.receipts : [];
  const publishReceipts = ownerReceipts.filter(record).map(item => ({
    sopId: item.sopId,
    version: item.version,
    status: item.status,
    ownerPublished: item.ownerPublished === true,
    snapshotWritten: item.snapshotWritten === true,
    refreshRequested: item.refreshRequested === true,
    receiptPersisted: item.receiptPersisted === true,
    // A refresh acknowledgement is never runtime observation.
    runtimeObserved: false,
    failure: record(item.failure) && nonempty(item.failure.code)
      ? { phase: item.failure.phase, code: item.failure.code } : undefined,
  }));
  const sessions = Array.isArray(persistedSessions) ? persistedSessions : [];
  const declaredPins = sessions.filter(record).map(session => {
    const selected = session.state?.selected_skill_id ?? session.state?.active_skill_id;
    const definitions = Array.isArray(session.bundle?.sops) ? session.bundle.sops : [];
    const selectedDefinition = definitions.find(item => record(item) && sopId(item) === selected);
    return {
      sessionId: session.sessionId,
      selectedSopId: selected,
      declaredVersion: version(selectedDefinition),
      waitKind: session.wait?.kind,
      snapshotPresent: Boolean(selectedDefinition),
      resumedAfterReload: false,
    };
  });
  const model = profile?.agent?.model;
  const modelProvider = typeof model === 'string' ? model.split('/')[0] : undefined;
  const modelDeclaration = {
    selected: nonempty(model) ? model : undefined,
    providerDeclared: Boolean(modelProvider && record(profile?.model?.providers?.[modelProvider])),
    effective: 'unverified',
  };
  return {
    slots,
    modelDeclaration,
    discovery: {
      configured: Boolean(discovery),
      managementConfigured: Boolean(management),
      ownerBindingConsistent: bindingIssues.every(issue => issue !== 'management-discovery-owner-mismatch'),
      routeObserved: false,
    },
    bundleVersions,
    publishReceipts,
    declaredPins,
    bindingIssues,
    requiredEvidence: [
      'effective-seven-slot-config-and-module-graph',
      'staffdeck-model-for-agent-and-real-route-modelwire',
      'owner-publish-response-and-scoped-readback',
      'gateway-refresh-ack-and-next-runtime-bundle-observation',
      'new-run-new-pin-and-existing-run-old-pin',
      'same-wait-reload-approval-resume-and-completion',
      'disabled-off-absent-replacement-profiles',
    ],
  };
}

export { SLOTS as STAFFDECK_RUNTIME_SLOTS };
