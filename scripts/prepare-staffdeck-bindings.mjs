import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const required = (condition, code) => {
  if (!condition) throw Object.assign(new Error(code), { code });
};
const text = value => typeof value === 'string' && value.trim().length > 0;

/** Offline consistency only. Production routes still authenticate each request. */
export function prepareStaffDeckBindings(input, { now = Date.now() } = {}) {
  const { actorLogin, actorMe, credentialCreated, credentials, target, pilotDeckLogin, pilotDeckMe, approverLogin, approverMe } = input;
  const tenant = actorMe?.tenant_id;
  const actorId = actorMe?.id;
  required(text(tenant) && text(actorId) && actorMe.disabled !== true, 'ACTOR_REQUIRED');
  required(text(actorLogin?.token) && actorLogin.user?.id === actorId && actorLogin.user?.tenant_id === tenant, 'ACTOR_LOGIN_MISMATCH');
  required(pilotDeckLogin?.success === true && text(pilotDeckLogin.token)
    && (text(pilotDeckLogin.user?.id) || Number.isSafeInteger(pilotDeckLogin.user?.id))
    && pilotDeckLogin.user.id === pilotDeckMe?.user?.id, 'PILOTDECK_LOGIN_MISMATCH');
  const pdUserId = String(pilotDeckMe.user.id);
  required(text(pdUserId) && target?.tenant_id === tenant && text(target.id)
    && target.status === 'active' && target.is_overall === false, 'TARGET_MISMATCH');
  required(Array.isArray(credentials), 'CREDENTIAL_METADATA_REQUIRED');
  const credential = credentials.find(row => row.id === credentialCreated?.id);
  const prefix = credential?.key_prefix?.endsWith('…') ? credential.key_prefix.slice(0, -1) : '';
  required(text(credentialCreated?.api_key) && credential?.user_id === actorId
    && credentialCreated.user_id === actorId && prefix.length === 20
    && credentialCreated.api_key.startsWith(prefix), 'OWNED_CREDENTIAL_MISMATCH');
  required(credential.status === 'active' && !credential.revoked_at
    && (!credential.expires_at || (Number.isFinite(Date.parse(credential.expires_at)) && Date.parse(credential.expires_at) > now)), 'CREDENTIAL_INACTIVE');
  required(credential.access === 'user_full_access'
    && ['sops:read', 'sops:write', 'sops:publish', 'sops:cancel', 'knowledge:read', 'knowledge:write'].every(scope => credential.scopes?.includes(scope)), 'CREDENTIAL_SCOPE_MISSING');
  const hasApprover = approverLogin !== undefined || approverMe !== undefined;
  if (hasApprover) required(approverMe?.tenant_id === tenant && text(approverMe.id) && approverMe.source === 'web'
    && ['admin', 'member'].includes(approverMe.role) && approverMe.disabled !== true
    && text(approverLogin?.token) && approverLogin.user?.id === approverMe.id
    && approverLogin.user?.tenant_id === tenant, 'NATIVE_APPROVER_MISMATCH');
  const origin = new URL(input.staffDeckOrigin);
  required(['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password
    && origin.pathname === '/' && !origin.search && !origin.hash, 'FORMAL_ORIGIN_INVALID');
  const endpoint = `${origin.origin}/api/v1`;
  required(text(input.pilotDeckGatewayUrl) && text(input.pilotDeckGatewayTokenPath), 'PILOTDECK_GATEWAY_BINDING_REQUIRED');
  let gateway;
  try { gateway = new URL(input.pilotDeckGatewayUrl); } catch { required(false, 'PILOTDECK_GATEWAY_URL_INVALID'); }
  required(['http:', 'https:', 'ws:', 'wss:'].includes(gateway.protocol) && gateway.hostname
    && !gateway.username && !gateway.password && !gateway.search && !gateway.hash
    && (gateway.pathname === '/' || gateway.pathname === '/ws')
    && isAbsolute(input.pilotDeckGatewayTokenPath), 'PILOTDECK_GATEWAY_BINDING_INVALID');
  required(text(input.definitionsPath) && text(input.defaultSopId), 'SOP_BINDING_REQUIRED');
  const env = {
    STAFFDECK_FORMAL_API_ORIGIN: origin.origin,
    STAFFDECK_PUBLIC_ORIGIN: origin.origin,
    STAFFDECK_FIXED_TARGET_AGENT_ID: target.id,
    STAFFDECK_KNOWLEDGE_READ_KEY: credentialCreated.api_key,
    STAFFDECK_COPY_TENANT_ID: tenant,
    STAFFDECK_COPY_ACTOR_USER_ID: actorId,
    STAFFDECK_COPY_TARGET_AGENT_ID: target.id,
    STAFFDECK_COPY_PILOTDECK_USER_ID: pdUserId,
    PILOTDECK_DOMAIN_HOST_ENABLED: 'true',
    PILOTDECK_USER_ID: pdUserId,
    PILOTDECK_GATEWAY_URL: gateway.href,
    PILOTDECK_GATEWAY_TOKEN_PATH: input.pilotDeckGatewayTokenPath,
    STAFFDECK_COPY_USER_TOKEN: actorLogin.token,
    STAFFDECK_SOP_MANAGEMENT_ENDPOINT: endpoint,
    STAFFDECK_SOP_MANAGEMENT_API_KEY: credentialCreated.api_key,
    STAFFDECK_SOP_MANAGEMENT_CREDENTIAL_ID: credential.id,
    STAFFDECK_PUBLISHED_SOP_BUNDLE_PATH: input.definitionsPath,
    STAFFDECK_PUBLISHED_SOP_ID: input.defaultSopId,
    ...(hasApprover ? { STAFFDECK_APPROVAL_USER_ID: approverMe.id } : {}),
  };
  return {
    env,
    // A partial binding patch, never a complete/effective deployment profile.
    configPatch: {
      webui: { staffdeckCopy: {
        enabled: true, contract: 'staffdeck.enterprise-copy/v1',
        methods: ['list_agents', 'list_knowledge_bases', 'list_skills', 'import_resources'],
        endpointEnv: 'STAFFDECK_FORMAL_API_ORIGIN', tenantIdEnv: 'STAFFDECK_COPY_TENANT_ID',
        actorUserIdEnv: 'STAFFDECK_COPY_ACTOR_USER_ID', targetAgentIdEnv: 'STAFFDECK_COPY_TARGET_AGENT_ID',
        pilotDeckUserIdEnv: 'STAFFDECK_COPY_PILOTDECK_USER_ID', userTokenEnv: 'STAFFDECK_COPY_USER_TOKEN',
      } },
      modules: {
        knowledge: { tenantId: tenant, actorUserId: actorId, agentId: target.id },
        sop: {
          definitionsPath: input.definitionsPath, defaultSopId: input.defaultSopId,
          discoveryEndpoint: endpoint, discoveryAgentId: target.id, discoveryApiKey: credentialCreated.api_key,
          management: {
            enabled: true, endpointEnv: 'STAFFDECK_SOP_MANAGEMENT_ENDPOINT',
            apiKeyEnv: 'STAFFDECK_SOP_MANAGEMENT_API_KEY', credentialIdEnv: 'STAFFDECK_SOP_MANAGEMENT_CREDENTIAL_ID',
            agentIdEnv: 'STAFFDECK_COPY_TARGET_AGENT_ID',
            methods: ['list', 'create', 'get_draft', 'replace_draft', 'validate', 'publish', 'archive', 'list_versions', 'get_version', 'rollback'],
          },
        },
      },
    },
    identity: { tenantId: tenant, actorUserId: actorId, targetAgentId: target.id, pilotDeckUserId: pdUserId,
      credentialId: credential.id,
      ...(hasApprover ? { approverUserId: approverMe.id, memberIdentitySource: 'web', assigneeNotifyChannel: 'web' } : {}) },
    readiness: { recordedTupleConsistent: true, activeAuthenticationObserved: false, effectiveProfile: false,
      runtimeObserved: false, approvalPrincipalMapping: 'NOT_CONFIGURED' },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    required(process.argv.length === 4, 'USAGE: node scripts/prepare-staffdeck-bindings.mjs private-input.json new-private-output.json');
    const result = prepareStaffDeckBindings(JSON.parse(await readFile(process.argv[2], 'utf8')));
    await writeFile(process.argv[3], JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write('Private binding preparation written; effective profile remains required.\n');
  } catch (error) {
    // Report fixed codes only; malformed input may itself contain credentials.
    process.stderr.write(`${error.code ?? 'PREPARATION_INPUT_INVALID'}\n`);
    process.exitCode = 1;
  }
}
