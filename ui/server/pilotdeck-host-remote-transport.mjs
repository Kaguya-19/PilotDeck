import { PUBLIC_HOST_WIRE_OPERATIONS } from '../../src/composition/publicHostWire.js';

/** Uses the existing Gateway origin/token; no new runtime or browser secret. */
export async function createRemoteHostCapabilities({ url, token, principal, signal }) {
  if (!token) throw Object.assign(new Error('Gateway token unavailable.'), { status: 503, code: 'PUBLIC_HOST_TRANSPORT_UNAVAILABLE' });
  const origin = new URL(url);
  origin.protocol = origin.protocol === 'wss:' ? 'https:' : origin.protocol === 'ws:' ? 'http:' : origin.protocol;
  const request = (path, body, requestSignal) => fetch(new URL(path, origin), {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, principal }), signal: requestSignal,
  });
  const description = await request('/api/module-host/describe', {}, signal);
  if (!description.ok) throw Object.assign(new Error('Runtime host binding unavailable.'), { status: description.status, code: 'PUBLIC_HOST_TRANSPORT_UNAVAILABLE' });
  const data = await description.json();
  if (!Array.isArray(data.operations) || data.operations.some(operation => !PUBLIC_HOST_WIRE_OPERATIONS.includes(operation))) {
    throw Object.assign(new Error('Invalid runtime operation declaration.'), { status: 502, code: 'PILOTDECK_HOST_RESPONSE_INVALID' });
  }
  return Object.freeze({ operations: Object.freeze([...data.operations]), call: async (operation, input, options = {}) => {
    if (!data.operations.includes(operation)) throw Object.assign(new Error('Runtime operation unavailable.'), { status: 409, code: 'PILOTDECK_HOST_CAPABILITY_UNAVAILABLE' });
    const response = await request('/api/module-host/call', { operation, input }, options.signal);
    const headers = Object.fromEntries(response.headers);
    const contentType = response.headers.get('content-type');
    if (contentType?.startsWith('text/event-stream') || contentType?.startsWith('application/x-ndjson')) return { status: response.status, headers, body: response.body };
    const rawBody = await response.text();
    let body = rawBody; try { body = JSON.parse(rawBody); } catch { /* Preserve original non-JSON body. */ }
    return { status: response.status, headers, body, rawBody };
  } });
}
