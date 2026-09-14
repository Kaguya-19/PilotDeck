import type { SessionCatalogPort } from "../session/index.js";
import type { ListSessionsInput, ListSessionsResult } from "./protocol/types.js";

export type GatewaySessionCatalogStorage = {
  projectRoot: string;
  pilotHome: string;
};

export type CreateGatewaySessionCatalogConsumerOptions = {
  catalog: SessionCatalogPort;
  resolveStorage(input: ListSessionsInput): GatewaySessionCatalogStorage;
};

/**
 * Adapts a provider-neutral session catalog to Gateway's cursor protocol.
 *
 * Cursor parsing and next-cursor construction live here so the generic
 * Gateway factory and the multi-project local Gateway cannot drift.
 */
export function createGatewaySessionCatalogConsumer(
  options: CreateGatewaySessionCatalogConsumerOptions,
): (input: ListSessionsInput) => Promise<ListSessionsResult> {
  return async (input) => {
    const parsedOffset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
    const offset = Number.isFinite(parsedOffset) ? parsedOffset : 0;
    const { projectRoot, pilotHome } = options.resolveStorage(input);
    const sessions = await options.catalog.list({
      projectRoot,
      pilotHome,
      limit: input.limit,
      offset,
    });
    return {
      sessions,
      nextCursor: input.limit && sessions.length === input.limit ? String(offset + sessions.length) : undefined,
    };
  };
}
