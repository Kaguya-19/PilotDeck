import type { ChatMessage } from '../chat/types/types';

export type ChatHistorySearchMatch = {
  /** Index in the rendered message list. */
  messageIndex: number;
  /** Stable key used on `.chat-message[data-message-key]`. */
  messageKey: string;
  /** Character offset of the match within the message's searchable text. */
  offset: number;
  /** Match length in characters. */
  length: number;
};

export type SearchableChatMessage = {
  message: ChatMessage;
  messageKey: string;
  messageIndex: number;
  text: string;
};

const HIGHLIGHT_CLASS = 'chat-history-search-highlight';
const ACTIVE_HIGHLIGHT_CLASS = 'chat-history-search-highlight-active';

/** Collect plain text from a chat message for in-page search. */
export function extractSearchableText(message: ChatMessage): string {
  const parts: string[] = [];

  if (typeof message.content === 'string' && message.content.trim()) {
    parts.push(message.content);
  }
  if (typeof message.toolInput === 'string' && message.toolInput.trim()) {
    parts.push(message.toolInput);
  }
  const toolContent = message.toolResult?.content;
  if (typeof toolContent === 'string' && toolContent.trim()) {
    parts.push(toolContent);
  }
  if (typeof message.toolName === 'string' && message.toolName.trim()) {
    parts.push(message.toolName);
  }

  return parts.join('\n');
}

export function buildSearchableMessages(
  items: Array<{ message: ChatMessage; messageKey: string }>,
): SearchableChatMessage[] {
  return items
    .map(({ message, messageKey }, messageIndex) => ({
      message,
      messageKey,
      messageIndex,
      text: extractSearchableText(message),
    }))
    .filter((entry) => entry.text.trim().length > 0);
}

/** Find all case-insensitive substring matches across searchable messages. */
export function findChatHistoryMatches(
  items: SearchableChatMessage[],
  query: string,
): ChatHistorySearchMatch[] {
  const needle = query.trim();
  if (!needle) return [];

  const lowerNeedle = needle.toLowerCase();
  const matches: ChatHistorySearchMatch[] = [];

  items.forEach((entry) => {
    const haystack = entry.text;
    const lowerHaystack = haystack.toLowerCase();
    let fromIndex = 0;

    while (fromIndex < lowerHaystack.length) {
      const found = lowerHaystack.indexOf(lowerNeedle, fromIndex);
      if (found < 0) break;
      matches.push({
        messageIndex: entry.messageIndex,
        messageKey: entry.messageKey,
        offset: found,
        length: needle.length,
      });
      fromIndex = found + Math.max(1, needle.length);
    }
  });

  return matches;
}

/** Scroll the messages container so a virtualized row is brought into view. */
export function scrollToMessageIndex(
  container: HTMLElement,
  itemHeights: number[],
  messageIndex: number,
): void {
  if (messageIndex < 0 || messageIndex >= itemHeights.length) return;

  let offset = 0;
  for (let index = 0; index < messageIndex; index += 1) {
    offset += Math.max(1, itemHeights[index] ?? 0);
  }

  const targetTop = Math.max(0, offset - container.clientHeight * 0.25);
  container.scrollTop = targetTop;
}

export function clearSearchHighlights(container: HTMLElement): void {
  container.querySelectorAll(`mark.${HIGHLIGHT_CLASS}`).forEach((node) => {
    const mark = node as HTMLElement;
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
    parent.normalize();
  });
}

function findNthMatchOffset(text: string, query: string, occurrence: number): number {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let fromIndex = 0;
  let seen = 0;

  while (fromIndex < lowerText.length) {
    const found = lowerText.indexOf(lowerQuery, fromIndex);
    if (found < 0) return -1;
    if (seen === occurrence) return found;
    seen += 1;
    fromIndex = found + Math.max(1, lowerQuery.length);
  }

  return -1;
}

function highlightTextNode(
  node: Text,
  query: string,
  occurrence: number,
): { highlighted: boolean; nextOccurrence: number } {
  const text = node.textContent || '';
  const offset = findNthMatchOffset(text, query, occurrence);
  if (offset < 0) {
    return { highlighted: false, nextOccurrence: occurrence };
  }

  const before = text.slice(0, offset);
  const match = text.slice(offset, offset + query.length);
  const after = text.slice(offset + query.length);

  const fragment = document.createDocumentFragment();
  if (before) fragment.appendChild(document.createTextNode(before));

  const mark = document.createElement('mark');
  mark.className = `${HIGHLIGHT_CLASS} ${ACTIVE_HIGHLIGHT_CLASS}`;
  mark.textContent = match;
  fragment.appendChild(mark);

  if (after) fragment.appendChild(document.createTextNode(after));

  const parent = node.parentNode;
  if (!parent) {
    return { highlighted: false, nextOccurrence: occurrence };
  }
  parent.replaceChild(fragment, node);

  return { highlighted: true, nextOccurrence: occurrence + 1 };
}

function countOccurrencesBeforeOffset(text: string, query: string, offset: number): number {
  const lowerText = text.slice(0, offset).toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery) return 0;

  let count = 0;
  let fromIndex = 0;
  while (fromIndex < lowerText.length) {
    const found = lowerText.indexOf(lowerQuery, fromIndex);
    if (found < 0) break;
    count += 1;
    fromIndex = found + Math.max(1, lowerQuery.length);
  }
  return count;
}

/** Highlight the active match inside a message element and scroll it into view. */
export function highlightActiveMatch(
  container: HTMLElement,
  messageKey: string,
  messageText: string,
  query: string,
  offset: number,
): boolean {
  clearSearchHighlights(container);

  const messageEl = container.querySelector<HTMLElement>(
    `.chat-message[data-message-key="${CSS.escape(messageKey)}"]`,
  );
  if (!messageEl) return false;

  const occurrence = countOccurrencesBeforeOffset(messageText, query, offset);
  const walker = document.createTreeWalker(messageEl, NodeFilter.SHOW_TEXT);
  let currentOccurrence = 0;
  let highlighted = false;

  while (walker.nextNode()) {
    const textNode = walker.currentNode as Text;
    if (!textNode.textContent?.trim()) continue;
    if (textNode.parentElement?.closest('mark')) continue;

    const result = highlightTextNode(textNode, query, currentOccurrence - occurrence);
    if (result.highlighted) {
      highlighted = true;
      break;
    }
    currentOccurrence = result.nextOccurrence;
  }

  const activeMark = messageEl.querySelector(`mark.${ACTIVE_HIGHLIGHT_CLASS}`);
  activeMark?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (!activeMark) {
    messageEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  return highlighted;
}
