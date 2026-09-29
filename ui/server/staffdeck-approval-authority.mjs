/** Server-only identity guard; no key, identity or approval state is stored. */
export class ApprovalAuthorityError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const reject = (status, code, message) => { throw new ApprovalAuthorityError(status, code, message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

/**
 * Authenticate the approver against SD's normal current-user endpoint.
 * Both hosts must use the approver's own bearer, never the management actor's
 * account credential. Binding is private server configuration derived from
 * the recorded bootstrap responses, not request input.
 */
export function createFixedApprovalAuthority({ origin, tenantId, approverUserId, fetch: request = globalThis.fetch }) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    reject(400, 'APPROVAL_CONFIG_INVALID', 'A formal StaffDeck origin is required.');
  }
  if (!nonempty(tenantId) || !nonempty(approverUserId)) reject(400, 'APPROVAL_CONFIG_INVALID', 'Recorded tenant and approver IDs are required.');
  async function authenticate({ bearer, signal }) {
    if (!nonempty(bearer)) reject(401, 'APPROVAL_AUTH_REQUIRED', 'The approver must sign in.');
    const response = await request(new URL('/api/auth/me', base), {
      method: 'GET', headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
      redirect: 'error', signal,
    });
    if (!response.ok) reject(response.status, 'APPROVAL_AUTH_REJECTED', 'StaffDeck rejected the approver identity.');
    const user = await response.json();
    if (user.tenant_id !== tenantId || user.id !== approverUserId || user.source !== 'web' || user.disabled === true || !['admin', 'member'].includes(user.role)) {
      reject(403, 'APPROVAL_SUBJECT_MISMATCH', 'This identity is not the configured native approver.');
    }
    return Object.freeze({ tenantId, userId: user.id, source: user.source, role: user.role, disabled: user.disabled === true });
  }
  return Object.freeze({
    authenticate,
    async authorize({ bearer, wait, sessionKey = wait?.sessionId, waitId = wait?.wait?.id, requestId, message, expectedRevision, signal }) {
      if (!nonempty(bearer)) reject(401, 'APPROVAL_AUTH_REQUIRED', 'The approver must sign in.');
      if (!nonempty(requestId) || !nonempty(message)) reject(400, 'APPROVAL_INPUT_INVALID', 'An original request ID and reply are required.');
      if (!nonempty(sessionKey) || !nonempty(waitId) || (wait?.wait && wait.wait.kind !== 'handoff')) {
        reject(400, 'APPROVAL_INPUT_INVALID', 'The original human wait ID and session key are required.');
      }
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        reject(400, 'APPROVAL_INPUT_INVALID', 'The original revision is required.');
      }
      // Do not GET pending/revision here. A successful original reply has
      // cleared the wait; the authenticated duplicate belongs to the store.
      const subject = await authenticate({ bearer, signal });
      // This is an authorized command, not an execution or approval receipt.
      // The host must also verify session access and the pinned SOP assignee,
      // then call original resume with this same wait ID/revision/request ID.
      return Object.freeze({
        subject,
        command: Object.freeze({ sessionKey, requestId, waitId,
          source: 'human', message, expectedRevision }),
      });
    },
  });
}
