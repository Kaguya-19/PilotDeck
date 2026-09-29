import { afterEach, expect, it, vi } from 'vitest';
import { recordUiDiagnostic, registerUiDiagnostics } from './uiDiagnostics';
afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });
it('keeps a bounded history and never stores the message body of thrown errors', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (let i = 0; i < 30; i++) recordUiDiagnostic('layout', { messages: i });
  const unregister = registerUiDiagnostics();
  window.dispatchEvent(new ErrorEvent('error', { error: new TypeError('private prompt and secret'), lineno: 12 }));
  unregister();
  const stored = sessionStorage.getItem('pilotdeck:ui-diagnostics')!;
  const entries = JSON.parse(stored);
  expect(entries).toHaveLength(20);
  expect(entries.at(-1).metrics).toEqual({ errorName: 'TypeError', line: 12, column: 0 });
  expect(stored).not.toContain('private prompt');
});
