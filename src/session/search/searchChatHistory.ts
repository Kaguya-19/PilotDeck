import { parseChatSearchArgs } from "./ChatSearchArgs.js";
import { searchNodeSessionHistory } from "./NodeSessionSearchPort.js";
import type {
  SessionSearchInput,
  SessionSearchMatch,
  SessionSearchResult,
  SessionSearchRole,
} from "./SessionSearchPort.js";

/** @deprecated Use SessionSearchRole from SessionSearchPort. */
export type ChatHistorySearchRole = SessionSearchRole;
/** @deprecated Use SessionSearchMatch from SessionSearchPort. */
export type ChatHistorySearchMatch = SessionSearchMatch;
/** @deprecated Use SessionSearchInput from SessionSearchPort. */
export type SearchChatHistoryOptions = SessionSearchInput;
/** @deprecated Use SessionSearchResult from SessionSearchPort. */
export type SearchChatHistoryResult = SessionSearchResult;
export { parseChatSearchArgs };
export type { ParsedChatSearchArgs } from "./ChatSearchArgs.js";

/**
 * @deprecated Application consumers must receive SessionSearchPort through
 * composition. This facade preserves existing direct embeddings.
 */
export function searchChatHistory(options: SearchChatHistoryOptions): Promise<SearchChatHistoryResult> {
  return searchNodeSessionHistory(options);
}
