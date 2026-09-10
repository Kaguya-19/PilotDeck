import express from 'express';
import { getModelConfigurationState } from '../services/modelConfigurationState.js';
import { getAcceptedModelSelection, recordAcceptedModelSelection, getPilotDeckGateway } from '../pilotdeck-bridge.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    if (getModelConfigurationState({ validateGateway: false }).state === 'empty') {
      return res.json({ items: [], defaultSelection: null, router: { enabled: false, autoAvailable: false } });
    }
    const gateway = await getPilotDeckGateway();
    if (!(await hasCapability(gateway, 'model_catalog_list'))) return unavailable(res, 'model_catalog_list');
    return res.json(await gateway.modelCatalogList({
      query: optionalString(req.query.query),
      provider: optionalString(req.query.provider),
      includeAuto: req.query.includeAuto === undefined ? undefined : String(req.query.includeAuto) !== 'false',
    }));
  } catch (error) { return sendError(res, error, req.id); }
});

export function createSessionModelHandlers() {
  return {
    async get(req, res) {
      try {
        const gateway = await getPilotDeckGateway();
        if (!(await hasCapability(gateway, 'session_model_get'))) return unavailable(res, 'session_model_get');
        const result = await gateway.sessionModelGet({
          projectKey: stringParam(req.query.projectKey), sessionKey: stringParam(req.query.sessionKey),
        });
        // `saved` is execution history for legacy sessions; acceptedSelection is
        // the composer's last successful send, which can still be queued.
        return res.json({...result, acceptedSelection: getAcceptedModelSelection(result.projectKey, result.sessionKey)});
      } catch (error) { return sendError(res, error, req.id); }
    },
    async set(req, res) {
      try {
        const gateway = await getPilotDeckGateway();
        if (!(await hasCapability(gateway, 'session_model_set'))) return unavailable(res, 'session_model_set');
        const result = await gateway.sessionModelSet({
          projectKey: stringParam(req.body?.projectKey), sessionKey: stringParam(req.body?.sessionKey), selection: req.body?.selection,
        });
        recordAcceptedModelSelection(result.projectKey, result.sessionKey, req.body?.selection, 'explicit-model-setting');
        return res.json(result);
      } catch (error) { return sendError(res, error, req.id); }
    },
    async clear(req, res) {
      try {
        const gateway = await getPilotDeckGateway();
        if (!(await hasCapability(gateway, 'session_model_clear'))) return unavailable(res, 'session_model_clear');
        await gateway.sessionModelClear({
          projectKey: stringParam(req.query.projectKey), sessionKey: stringParam(req.query.sessionKey),
        });
        recordAcceptedModelSelection(stringParam(req.query.projectKey), stringParam(req.query.sessionKey), null, 'explicit-model-clear');
        return res.status(204).end();
      } catch (error) { return sendError(res, error, req.id); }
    },
  };
}

function stringParam(value) { return typeof value === 'string' ? value.trim() : ''; }
function optionalString(value) { const result = stringParam(value); return result || undefined; }
async function hasCapability(gateway, capability) { return (await gateway.describeServer()).capabilities?.includes(capability) === true; }
function unavailable(res, capability) { return res.status(501).json({ error: { code: 'CAPABILITY_UNAVAILABLE', message: `${capability} is unavailable.` } }); }
function sendError(res, error, requestId) {
  const code = typeof error?.code === 'string' ? error.code : 'gateway_request_failed';
  const statuses = {
    PROJECT_NOT_FOUND: 404, INVALID_SESSION_KEY: 400, INVALID_MODEL_OVERRIDE: 400, UNSUPPORTED_MODEL_PARAMETER: 422,
    ROUTER_AUTO_UNAVAILABLE: 409, SESSION_BUSY: 409, CAPABILITY_UNAVAILABLE: 501,
  };
  return res.status(statuses[code] || 500).json({ error: {
    code, message: error instanceof Error ? error.message : String(error),
    ...(error?.details ? { details: error.details } : {}), ...(requestId ? { requestId } : {}),
  } });
}

export default router;
