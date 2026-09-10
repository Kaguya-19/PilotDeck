const STORAGE_KEY = 'pilotdeck:ui-diagnostics';
const LIMIT = 20;

type Diagnostic = { at: string; event: string; metrics: Record<string, number | boolean | string> };
// Deliberately exclude prompts, model replies, paths, credentials and session IDs.
export function recordUiDiagnostic(event: string, metrics: Diagnostic['metrics'] = {}) {
  const item: Diagnostic = { at: new Date().toISOString(), event, metrics };
  console.warn('[PilotDeck UI]', item);
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
    const entries = Array.isArray(saved) ? saved.slice(-(LIMIT - 1)) : [];
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...entries, item]));
  } catch { /* Diagnostics must never break recovery. */ }
}

export function reloadUi() {
  window.dispatchEvent(new Event('pilotdeck:flush-drafts'));
  recordUiDiagnostic('manual-reload');
  window.location.reload();
}

export function registerUiDiagnostics() {
  const onError = (event: ErrorEvent) => recordUiDiagnostic('window-error', {
    errorName: event.error instanceof Error ? event.error.name : 'Error',
    line: event.lineno || 0, column: event.colno || 0,
  });
  const onRejection = (event: PromiseRejectionEvent) => recordUiDiagnostic('unhandled-rejection', {
    errorName: event.reason instanceof Error ? event.reason.name : 'Unknown',
  });
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
