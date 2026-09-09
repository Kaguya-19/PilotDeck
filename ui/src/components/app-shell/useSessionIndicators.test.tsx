// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionIndicatorStore, useSessionIndicators } from './useSessionIndicators';
const completed = (id = 's1', runId = 'r1') => ({type:'session-activity',activity:{sessionId:id,processing:false,completedRunId:runId}});
afterEach(() => {cleanup(); localStorage.clear(); vi.restoreAllMocks();});
it('persists unread completions, deduplicates replays and restores running state from snapshots', () => {
  const store = createSessionIndicatorStore('test', localStorage);
  store.receive({type:'session-activity',activity:{sessionId:'s1',processing:true}}, null);
  expect(store.getSnapshot().processingSessions.has('s1')).toBe(true);
  store.receive(completed(), null);
  expect(store.getSnapshot().unreadSessionIds.has('s1')).toBe(true);
  const restored = createSessionIndicatorStore('test', localStorage);
  expect(restored.getSnapshot().unreadSessionIds.has('s1')).toBe(true);
  restored.markRead('s1');
  restored.receive(completed(), null);
  expect(restored.getSnapshot().unreadSessionIds.size).toBe(0);
  restored.receive({type:'session-activity-snapshot',activities:[{sessionId:'s1',processing:true,completedRunId:'r1'}]}, null);
  expect(restored.getSnapshot().processingSessions.has('s1')).toBe(true);
  restored.receive({type:'session-activity-snapshot',activities:[]}, null);
  expect(restored.getSnapshot().processingSessions.size).toBe(0);
  restored.receive(completed('s1','r2'), null);
  expect(restored.getSnapshot().unreadSessionIds.has('s1')).toBe(true);
});
it('marks read only when the loaded conversation is actually foreground, including refocus', () => {
  let listener: (message:any) => void = () => {};
  const subscribe = (fn: typeof listener) => {listener = fn; return () => {};};
  const sendMessage = vi.fn();
  let focused = true;
  let visible: DocumentVisibilityState = 'visible';
  vi.spyOn(document,'hasFocus').mockImplementation(() => focused);
  vi.spyOn(document,'visibilityState','get').mockImplementation(() => visible);
  const {result,rerender} = renderHook(({viewedSessionId}: {viewedSessionId:string|null}) => useSessionIndicators({scope:'user',viewedSessionId,subscribe,sendMessage,isConnected:true}),{initialProps:{viewedSessionId:null as string | null}});
  expect(sendMessage).toHaveBeenCalledWith({type:'get-session-activity'});
  act(() => listener(completed()));
  expect(result.current.unreadSessionIds.has('s1')).toBe(true);
  // Selecting a row does not count until the chat reports its contents ready.
  act(() => window.dispatchEvent(new Event('focus')));
  expect(result.current.unreadSessionIds.has('s1')).toBe(true);
  rerender({viewedSessionId:'s1'});
  expect(result.current.unreadSessionIds.size).toBe(0);
  act(() => listener(completed('s1','r2')));
  expect(result.current.unreadSessionIds.size).toBe(0);
  focused = false;
  act(() => listener(completed('s1','r3')));
  expect(result.current.unreadSessionIds.has('s1')).toBe(true);
  focused = true; visible = 'hidden';
  act(() => window.dispatchEvent(new Event('focus')));
  expect(result.current.unreadSessionIds.has('s1')).toBe(true);
  visible = 'visible';
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(result.current.unreadSessionIds.size).toBe(0);
  // Settings/another page hides the still-mounted chat.
  rerender({viewedSessionId:null});
  act(() => listener(completed('s1','r4')));
  expect(result.current.unreadSessionIds.has('s1')).toBe(true);
});
it('reconciles a completion missed during refresh, and isolates accounts', () => {
  const store = createSessionIndicatorStore('user-a', localStorage);
  store.receive({type:'session-activity-snapshot',activities:[completed().activity]},null);
  expect(store.getSnapshot().unreadSessionIds.has('s1')).toBe(true);
  expect(createSessionIndicatorStore('user-b',localStorage).getSnapshot().unreadSessionIds.size).toBe(0);
  expect(() => createSessionIndicatorStore('no-storage',undefined).receive(completed(),null)).not.toThrow();
});
