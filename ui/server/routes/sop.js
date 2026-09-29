import express from 'express';

import {
  getPilotDeckGateway,
  isGatewayUnavailableError,
  withPilotDeckGatewayReadRetry,
} from '../pilotdeck-bridge.js';

const STATUS_BY_CODE = Object.freeze({
  CAPABILITY_UNAVAILABLE: 501,
  SESSION_BUSY: 409,
  SOP_MODULE_DISABLED: 501,
  SOP_NOT_WAITING: 409,
  SOP_RESUME_SOURCE_INVALID: 409,
  SOP_REVISION_CONFLICT: 409,
  SOP_SESSION_NOT_FOUND: 404,
  SOP_WAIT_STALE: 409,
  APPROVAL_AUTH_REQUIRED: 401,
  APPROVAL_AUTH_REJECTED: 401,
  APPROVAL_AUTHORITY_OVERRIDE: 400,
  APPROVAL_SUBJECT_MISMATCH: 403,
  APPROVAL_BINDING_UNAVAILABLE: 503,
  SOP_APPROVAL_SESSION_MAPPING_UNAVAILABLE: 503,
  SOP_APPROVAL_SESSION_FORBIDDEN: 403,
  SOP_APPROVAL_AUTH_REQUIRED: 401,
  SOP_APPROVAL_FORBIDDEN: 403,
  SOP_APPROVAL_PIN_INVALID: 409,
  SOP_APPROVAL_ASSIGNEE_REQUIRED: 409,
  SOP_APPROVAL_LEGACY_RECEIPT: 409,
  SOP_RESUME_REQUEST_CONFLICT: 409,
  SOP_REVISION_REQUIRED: 428,
});

export function createSopRouter({
  getGateway = getPilotDeckGateway,
  readRetry = withPilotDeckGatewayReadRetry,
  boundPilotDeckUserId = () => process.env.STAFFDECK_COPY_PILOTDECK_USER_ID,
} = {}) {
  const router = express.Router();
  const requireBoundUser = (req) => {
    const bound = boundPilotDeckUserId();
    if (!nonEmptyString(bound)) throw Object.assign(new Error('Approval binding unavailable.'), { code: 'APPROVAL_BINDING_UNAVAILABLE' });
    if (String(req.user?.id ?? '') !== String(bound)) throw Object.assign(new Error('This user is not bound to the approval host.'), { code: 'SOP_APPROVAL_SESSION_FORBIDDEN' });
  };

  router.get('/status', async (req, res) => {
    const sessionKey = nonEmptyString(req.query.sessionKey);
    if (!sessionKey) return validationError(res, 'sessionKey is required.');
    if (Object.hasOwn(req.query, 'authority') || Object.hasOwn(req.query, 'subject')) return validationError(res, 'Approval identity cannot be supplied in input.');

    try {
      requireBoundUser(req);
      const status = await readRetry((gateway) => {
        if (typeof gateway.sopStatus !== 'function') {
          throw codedError('CAPABILITY_UNAVAILABLE', 'StaffDeck SOP status is unavailable.');
        }
        return gateway.sopStatus({
          sessionKey,
          ...(typeof req.headers['x-staffdeck-approver-authorization'] === 'string'
            ? { approverAuthorization: req.headers['x-staffdeck-approver-authorization'] } : {}),
          ...(nonEmptyString(req.query.projectKey) ? { projectKey: String(req.query.projectKey) } : {}),
        });
      });
      return res.json({ status });
    } catch (error) {
      return sendGatewayError(res, error, 'SOP_STATUS_FAILED');
    }
  });

  router.post('/resume', async (req, res) => {
    const sessionKey = nonEmptyString(req.body?.sessionKey);
    const requestId = nonEmptyString(req.body?.requestId);
    const waitId = nonEmptyString(req.body?.waitId);
    const message = nonEmptyString(req.body?.message);
    const source = req.body?.source;
    if (Object.hasOwn(req.body ?? {}, 'authority') || Object.hasOwn(req.body ?? {}, 'subject')) return validationError(res, 'Approval identity cannot be supplied in input.');
    if (!sessionKey || !requestId || !waitId || !message) {
      return validationError(res, 'sessionKey, requestId, waitId and message are required.');
    }
    if (source !== 'human' && source !== 'external_task') {
      return validationError(res, "source must be 'human' or 'external_task'.");
    }
    if ((source === 'human' && req.body?.expectedRevision === undefined)
      || (req.body?.expectedRevision !== undefined
        && (!Number.isSafeInteger(req.body.expectedRevision) || req.body.expectedRevision < (source === 'human' ? 0 : 1)))) {
      return validationError(res, 'The original valid expectedRevision is required for human approval.');
    }
    if (req.body?.slotUpdates !== undefined && !isRecord(req.body.slotUpdates)) {
      return validationError(res, 'slotUpdates must be an object.');
    }

    try {
      if (source === 'human') requireBoundUser(req);
      const gateway = await getGateway();
      if (typeof gateway.resumeSop !== 'function') {
        throw codedError('CAPABILITY_UNAVAILABLE', 'StaffDeck SOP resume is unavailable.');
      }
      const result = await gateway.resumeSop({
        sessionKey,
        requestId,
        waitId,
        source,
        ...(source === 'human' ? { approverAuthorization: req.headers['x-staffdeck-approver-authorization'] } : {}),
        message,
        ...(nonEmptyString(req.body?.projectKey) ? { projectKey: req.body.projectKey } : {}),
        ...(req.body?.expectedRevision === undefined ? {} : { expectedRevision: req.body.expectedRevision }),
        ...(req.body?.slotUpdates === undefined ? {} : { slotUpdates: req.body.slotUpdates }),
      });
      return res.json(result);
    } catch (error) {
      return sendGatewayError(res, error, 'SOP_RESUME_FAILED');
    }
  });

  return router;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function validationError(res, message) {
  return res.status(400).json({ error: { code: 'INVALID_REQUEST', message } });
}

function sendGatewayError(res, error, fallbackCode) {
  const code = typeof error?.code === 'string'
    ? error.code
    : isGatewayUnavailableError(error)
      ? 'GATEWAY_UNAVAILABLE'
      : fallbackCode;
  const originalStatus = error?.status ?? error?.details?.httpStatus;
  const status = Number.isInteger(originalStatus) && originalStatus >= 400 && originalStatus <= 599
    ? originalStatus : code === 'GATEWAY_UNAVAILABLE' ? 503 : (STATUS_BY_CODE[code] ?? 500);
  return res.status(status).json({
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      ...(error?.details ? { details: error.details } : {}),
    },
  });
}

export default createSopRouter();
