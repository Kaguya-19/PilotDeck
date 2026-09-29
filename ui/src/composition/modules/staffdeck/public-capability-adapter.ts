import { moduleApiError } from './clients';

// The integration owner supplies a facade over the already-authorized module
// gateway contract. Both ui/server helpers remain server-only: no browser
// import/injection of those helpers or direct StaffDeck transport is allowed.
// The event decoder consumes the gateway's public stream, not SD transport.
// This module never obtains credentials,
// registers a route, advertises a method or grants an operation.
export type PublicCapabilityResponse = { status: number; body: unknown; headers?: unknown };
export type PublicCapabilityClient = {
  call(operation: string, input?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<PublicCapabilityResponse>;
};
export type PublicJobEvent = { id?: string; event: string; data: string };
export type PublicJobEventDecoder = (chunks: unknown, options?: { signal?: AbortSignal }) => AsyncIterable<PublicJobEvent>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function rawBody(body: unknown): string {
  return typeof body === 'string' ? body : JSON.stringify(body) ?? '';
}
function checked(response: PublicCapabilityResponse): unknown {
  if (!response || !Number.isInteger(response.status)) throw new Error('Public capability response has no HTTP status.');
  if (response.status < 200 || response.status >= 300) {
    throw moduleApiError(response.status, rawBody(response.body), `HTTP ${response.status}`);
  }
  return response.body;
}

export function createPublicCapabilityAdapter({ client, decodeEvents }: {
  client: PublicCapabilityClient;
  decodeEvents: PublicJobEventDecoder;
}) {
  const call = async (operation: string, input: Record<string, unknown>, signal?: AbortSignal) => {
    try { return await client.call(operation, input, { signal }); } catch (cause) {
      const error = cause as { status?: unknown; code?: unknown; body?: unknown; message?: unknown };
      if (!Number.isInteger(error?.status)) throw cause;
      const adapted = moduleApiError(error.status as number, typeof error.body === 'string' ? error.body : '', typeof error.message === 'string' ? error.message : '');
      if (typeof error.code === 'string') adapted.code = error.code;
      Object.assign(adapted, { cause });
      throw adapted;
    }
  };
  // Keep cursor state request-local: one stream's cancellation or cleanup must
  // never clear another stream's consumed event ID.
  return Object.freeze({
    async collection(operation: 'list_tools' | 'list_general_skills', input: Record<string, unknown> = {}, signal?: AbortSignal) {
      const body = checked(await call(operation, input, signal));
      signal?.throwIfAborted();
      if (!object(body) || !Array.isArray(body.data) || body.data.some(item => !object(item))) {
        throw new Error('Public capability collection is missing its formal data array.');
      }
      return body.data;
    },
    async response(operation: string, input: Record<string, unknown> = {}, signal?: AbortSignal) {
      const response = await call(operation, input, signal);
      checked(response);
      signal?.throwIfAborted();
      return response; // Includes actual HTTP status and untouched ETag headers.
    },
    async operation(operation: string, input: Record<string, unknown> = {}, signal?: AbortSignal) {
      const body = checked(await call(operation, input, signal));
      signal?.throwIfAborted();
      // Raw job/result/draft fields remain unchanged. Snapshot acceptance is an
      // explicit editor lifecycle action, never an automatic second create.
      return body;
    },
    async acceptedJob(operation: 'generate_sop' | 'rewrite_saved_sop', input: Record<string, unknown>, signal?: AbortSignal) {
      const response = await call(operation, input, signal);
      const body = checked(response);
      signal?.throwIfAborted();
      if (response.status !== 202 || !object(body) || typeof body.id !== 'string' || typeof body.status !== 'string') {
        throw new Error('Public capability did not return a formal 202 job.');
      }
      // No notify-success, synthetic token stream, snapshot update or save here:
      // a job acceptance is distinct from completion and persistence observation.
      return { status: response.status, body, headers: response.headers };
    },
    async events({ jobId, lastEventId, signal, onEvent, onConsumedId }: {
      jobId: string;
      lastEventId?: string;
      signal?: AbortSignal;
      onEvent(event: PublicJobEvent): void | Promise<void>;
      onConsumedId?(id: string): void | Promise<void>;
    }) {
      const response = await call('job_events', {
        jobId, ...(lastEventId === undefined || lastEventId === '' ? {} : { lastEventId }),
      }, signal);
      const chunks = checked(response);
      signal?.throwIfAborted();
      let consumedId = lastEventId;
      for await (const event of decodeEvents(chunks, { signal })) {
        signal?.throwIfAborted();
        // Preserve event names and original SSE data text. The caller chooses
        // the matching public job UI; native preview/job namespaces differ.
        await onEvent(event);
        signal?.throwIfAborted();
        if (event.id !== undefined) {
          await onConsumedId?.(event.id);
          consumedId = event.id;
        }
      }
      return { lastEventId: consumedId };
    },
  });
}
