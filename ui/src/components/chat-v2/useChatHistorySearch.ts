import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ChatMessage } from '../chat/types/types';
import {
  buildSearchableMessages,
  clearSearchHighlights,
  findChatHistoryMatches,
  highlightActiveMatch,
  scrollToMessageIndex,
  type ChatHistorySearchMatch,
} from './chatHistorySearchUtils';

type UseChatHistorySearchOptions = {
  scrollContainerRef: RefObject<HTMLElement | null>;
  keyedMessages: Array<{ message: ChatMessage; messageKey: string }>;
  measuredItemHeights: number[];
  allMessagesLoaded: boolean;
  hasMoreMessages: boolean;
  loadAllMessages: () => void;
  sessionId: string | null;
};

export function useChatHistorySearch({
  scrollContainerRef,
  keyedMessages,
  measuredItemHeights,
  allMessagesLoaded,
  hasMoreMessages,
  loadAllMessages,
  sessionId,
}: UseChatHistorySearchOptions) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const searchableMessages = useMemo(
    () => buildSearchableMessages(keyedMessages),
    [keyedMessages],
  );

  const matches = useMemo(
    () => findChatHistoryMatches(searchableMessages, query),
    [query, searchableMessages],
  );

  const activeMatch: ChatHistorySearchMatch | null = matches[activeMatchIndex] ?? null;

  const closeSearch = useCallback(() => {
    setIsOpen(false);
    setQuery('');
    setActiveMatchIndex(0);
    const container = scrollContainerRef.current;
    if (container) clearSearchHighlights(container);
  }, [scrollContainerRef]);

  const openSearch = useCallback(() => {
    setIsOpen(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const ensureAllMessagesLoaded = useCallback(async () => {
    if (!hasMoreMessages || allMessagesLoaded) return;
    loadAllMessages();
    await new Promise((resolve) => setTimeout(resolve, 350));
  }, [allMessagesLoaded, hasMoreMessages, loadAllMessages]);

  const revealMatch = useCallback(async (match: ChatHistorySearchMatch) => {
    await ensureAllMessagesLoaded();

    const container = scrollContainerRef.current;
    if (!container) return;

    scrollToMessageIndex(container, measuredItemHeights, match.messageIndex);

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });

    const entry = searchableMessages.find((item) => item.messageKey === match.messageKey);
    if (!entry) return;

    highlightActiveMatch(
      container,
      match.messageKey,
      entry.text,
      query.trim(),
      match.offset,
    );
  }, [
    ensureAllMessagesLoaded,
    measuredItemHeights,
    query,
    scrollContainerRef,
    searchableMessages,
  ]);

  const goToMatch = useCallback((index: number) => {
    if (matches.length === 0) return;
    const wrapped = ((index % matches.length) + matches.length) % matches.length;
    setActiveMatchIndex(wrapped);
  }, [matches.length]);

  const goToNext = useCallback(() => {
    goToMatch(activeMatchIndex + 1);
  }, [activeMatchIndex, goToMatch]);

  const goToPrevious = useCallback(() => {
    goToMatch(activeMatchIndex - 1);
  }, [activeMatchIndex, goToMatch]);

  useEffect(() => {
    setActiveMatchIndex(0);
  }, [query]);

  useEffect(() => {
    closeSearch();
  }, [closeSearch, sessionId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isFindShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f';
      if (isFindShortcut) {
        if (document.querySelector('[data-modal-overlay]')) return;
        event.preventDefault();
        event.stopPropagation();
        if (isOpen) {
          inputRef.current?.focus();
          inputRef.current?.select();
        } else {
          openSearch();
        }
        return;
      }

      if (!isOpen) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeSearch();
        return;
      }

      if (event.key === 'Enter' && document.activeElement === inputRef.current) {
        event.preventDefault();
        if (event.shiftKey) {
          goToPrevious();
        } else {
          goToNext();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [closeSearch, goToNext, goToPrevious, isOpen, openSearch]);

  useEffect(() => {
    if (!isOpen || !activeMatch || !query.trim()) return;
    void revealMatch(activeMatch);
  }, [activeMatch, isOpen, query, revealMatch]);

  useEffect(() => {
    if (matches.length === 0) {
      setActiveMatchIndex(0);
      return;
    }
    if (activeMatchIndex >= matches.length) {
      setActiveMatchIndex(0);
    }
  }, [activeMatchIndex, matches.length]);

  useEffect(() => {
    if (!isOpen) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    return () => clearSearchHighlights(container);
  }, [isOpen, scrollContainerRef]);

  return {
    isOpen,
    query,
    setQuery,
    matches,
    activeMatchIndex,
    inputRef,
    openSearch,
    closeSearch,
    goToNext,
    goToPrevious,
  };
}
