// Public consumer glue. The selected Gateway/provider owns all capability state.
export { encodeHostCapabilityStream, isHostCapabilityStreamBody } from '../../src/composition/publicHostWire.js';
export const PILOTDECK_HOST_UI_OPERATIONS = Object.freeze([
  'list_tools', 'create_tool', 'update_tool', 'test_tool', 'probe_unsaved_tool', 'remove_tool',
  'list_general_skills', 'import_general_skill', 'publish_general_skill', 'archive_general_skill', 'test_general_skill',
  'list_model_catalog', 'extract_sop_text',
]);
export const PILOTDECK_HOST_CALLBACK_OPERATIONS = Object.freeze([
  'model_prepare', 'model_stream', 'file_parse', 'task_start', 'task_status', 'task_result', 'task_cancel', 'task_events',
]);
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

/** Provider contract: call(operation,input,{signal,principal}) -> HTTP envelope.
 * moduleHostCapabilities must be composed from the same runtime Port instances.
 * It is not a second model/catalog registry or a domain job store.
 */
export function createPilotDeckHostCapabilityGateway({ gateway, port = gateway?.moduleHostCapabilities, principal }) {
  return Object.freeze({
    async call(operation, input = {}, { signal, callback = false } = {}) {
      signal?.throwIfAborted();
      const operations = callback ? PILOTDECK_HOST_CALLBACK_OPERATIONS : PILOTDECK_HOST_UI_OPERATIONS;
      if (!operations.includes(operation)) throw failure(400, 'PILOTDECK_HOST_OPERATION_UNSUPPORTED', 'A named host capability is required.');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure(400, 'PUBLIC_INPUT_INVALID', 'Input must be an object.');
      if (['tenantId', 'tenant_id', 'actorUserId', 'actor_user_id', 'credentialId', 'agentId', 'agent_id'].some(key => Object.hasOwn(input, key))) {
        throw failure(400, 'PUBLIC_SCOPE_OVERRIDE', 'Host identity is supplied by the authenticated composition.');
      }
      if (port) {
        if (typeof port.call !== 'function' || !Array.isArray(port.operations) || !port.operations.includes(operation)) {
          throw failure(409, 'PILOTDECK_HOST_CAPABILITY_UNAVAILABLE', 'The selected host binding does not declare this operation.');
        }
        const response = await port.call(operation, input, { signal, principal });
        signal?.throwIfAborted();
        if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) {
          throw failure(502, 'PILOTDECK_HOST_RESPONSE_INVALID', 'Host capability response must preserve status and body.');
        }
        return response;
      }
      // These are existing public projections of the same Gateway's runtime
      // catalog. No second provider is created and no failed call is retried.
      if (!callback && operation === 'list_model_catalog' && typeof gateway?.modelCatalogList === 'function') {
        const result = await gateway.modelCatalogList({ includeAuto: false });
        signal?.throwIfAborted();
        if (!Array.isArray(result?.items)) throw failure(502, 'PILOTDECK_HOST_RESPONSE_INVALID', 'Model catalog is missing items.');
        return { status: 200, body: { data: result.items.map(item => ({
          ...item, name: item.displayName, enabled: item.available,
          is_default: result.defaultSelection?.provider === item.provider && result.defaultSelection?.model === item.model,
        })) } };
      }
      if (!callback && operation === 'list_general_skills' && typeof gateway?.skillsList === 'function') {
        const result = await gateway.skillsList({});
        signal?.throwIfAborted();
        if (!Array.isArray(result?.items)) throw failure(502, 'PILOTDECK_HOST_RESPONSE_INVALID', 'Skill catalog is missing items.');
        return { status: 200, body: { data: result.items.map(item => ({ ...item, id: item.slug })) } };
      }
      throw failure(501, 'PILOTDECK_HOST_CAPABILITY_UNAVAILABLE', 'The runtime host Port has not been composed for this operation.');
    },
  });
}
