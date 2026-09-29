import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderLimitedProfile } from '../products/pilotdeck-staffdeck-sop/profiles/render-limited-20260928.mjs';

const requireMatch = (actual, expected, code) => {
  if (!actual || actual !== expected) throw Object.assign(new Error(code), { code });
};

/** Combine the verified private identity tuple with the real enabled runtime profile. */
export function composeLimitedStaffDeckProfile(prepared, environment = process.env) {
  const binding = prepared?.configPatch;
  const privateEnv = prepared?.env;
  const identity = prepared?.identity;
  if (!binding?.webui?.staffdeckCopy || !binding?.modules?.sop?.management || !privateEnv || !identity
      || prepared?.readiness?.recordedTupleConsistent !== true) {
    throw Object.assign(new Error('PRIVATE_BINDING_REQUIRED'), { code: 'PRIVATE_BINDING_REQUIRED' });
  }
  for (const name of ['STAFFDECK_PUBLIC_ORIGIN', 'STAFFDECK_KNOWLEDGE_READ_KEY',
    'STAFFDECK_FIXED_TARGET_AGENT_ID', 'STAFFDECK_PUBLISHED_SOP_BUNDLE_PATH', 'STAFFDECK_PUBLISHED_SOP_ID']) {
    if (environment[name] !== undefined && environment[name] !== privateEnv[name]) {
      throw Object.assign(new Error('PRIVATE_BINDING_ENV_MISMATCH'), { code: 'PRIVATE_BINDING_ENV_MISMATCH' });
    }
  }
  const env = { ...environment, ...privateEnv };
  requireMatch(env.STAFFDECK_PUBLIC_ORIGIN, privateEnv.STAFFDECK_FORMAL_API_ORIGIN, 'PUBLIC_ORIGIN_MISMATCH');
  requireMatch(env.STAFFDECK_KNOWLEDGE_READ_KEY, privateEnv.STAFFDECK_SOP_MANAGEMENT_API_KEY, 'PUBLIC_CREDENTIAL_MISMATCH');
  requireMatch(env.STAFFDECK_FIXED_TARGET_AGENT_ID, identity.targetAgentId, 'TARGET_ID_MISMATCH');
  requireMatch(env.STAFFDECK_PUBLISHED_SOP_BUNDLE_PATH, binding.modules.sop.definitionsPath, 'SOP_BUNDLE_MISMATCH');
  if (!isAbsolute(binding.modules.sop.definitionsPath)) {
    throw Object.assign(new Error('SOP_BUNDLE_ABSOLUTE_PATH_REQUIRED'), { code: 'SOP_BUNDLE_ABSOLUTE_PATH_REQUIRED' });
  }
  requireMatch(env.STAFFDECK_PUBLISHED_SOP_ID, binding.modules.sop.defaultSopId, 'SOP_ID_MISMATCH');
  requireMatch(binding.modules.knowledge?.agentId, identity.targetAgentId, 'KNOWLEDGE_TARGET_MISMATCH');
  requireMatch(binding.modules.sop.discoveryAgentId, identity.targetAgentId, 'SOP_DISCOVERY_TARGET_MISMATCH');
  const profile = renderLimitedProfile(env);
  if (new URL(profile.modules.sop.endpoint).origin === new URL(env.STAFFDECK_PUBLIC_ORIGIN).origin) {
    throw Object.assign(new Error('SOP_RUNTIME_ORIGIN_COLLIDES_WITH_STAFFDECK_API'),
      { code: 'SOP_RUNTIME_ORIGIN_COLLIDES_WITH_STAFFDECK_API' });
  }
  return {
    ...profile,
    webui: { ...profile.webui, ...binding.webui },
    modules: {
      ...profile.modules,
      knowledge: { ...profile.modules.knowledge },
      sop: { ...profile.modules.sop, ...binding.modules.sop,
        endpoint: profile.modules.sop.endpoint,
        definitionsPath: profile.modules.sop.definitionsPath,
        defaultSopId: profile.modules.sop.defaultSopId },
    },
  };
}

/** Require the portable SOP runtime's protocol manifest before writing an enabled profile. */
export async function verifyPortableSopRuntime(profile, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${profile.modules.sop.endpoint}/healthz`, {
      method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw Object.assign(new Error('SOP_RUNTIME_MANIFEST_UNAVAILABLE'), { code: 'SOP_RUNTIME_MANIFEST_UNAVAILABLE' });
  }
  if (!response.ok) {
    throw Object.assign(new Error('SOP_RUNTIME_MANIFEST_UNAVAILABLE'), { code: 'SOP_RUNTIME_MANIFEST_UNAVAILABLE' });
  }
  let manifest;
  try { manifest = await response.json(); } catch { /* handled below */ }
  if (manifest?.status !== 'ok' || manifest?.moduleId !== 'sop.runtime'
      || manifest?.contract !== 'sop.lifecycle/v2' || manifest?.protocolVersion !== '2.0'
      || !Array.isArray(manifest?.operations)
      || !['prepare', 'submit'].every(operation => manifest.operations.includes(operation))) {
    throw Object.assign(new Error('SOP_RUNTIME_MANIFEST_INVALID'), { code: 'SOP_RUNTIME_MANIFEST_INVALID' });
  }
  return manifest;
}

export async function composeVerifiedLimitedStaffDeckProfile(prepared, environment = process.env, fetchImpl = fetch) {
  const profile = composeLimitedStaffDeckProfile(prepared, environment);
  await verifyPortableSopRuntime(profile, fetchImpl);
  return profile;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw Object.assign(new Error('USAGE'), { code: 'USAGE' });
    const prepared = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const profile = await composeVerifiedLimitedStaffDeckProfile(prepared);
    await writeFile(process.argv[3], `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write('Private limited profile written; runtime and business evidence remain required.\n');
  } catch (error) {
    process.stderr.write(`${error.code ?? 'LIMITED_PROFILE_INPUT_INVALID'}\n`);
    process.exitCode = 1;
  }
}
