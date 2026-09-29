// ToastProvider is the host's visible notification surface.
function emit(kind: 'success' | 'warning' | 'error' | 'info', message: string): void {
  window.dispatchEvent(new CustomEvent('pilotdeck:toast', { detail: { kind, message } }));
}
export const staffDeckNotify = {
  success: (message: string) => emit('success', message),
  warning: (message: string) => emit('warning', message),
  error: (message: string) => emit('error', message),
  info: (message: string) => emit('info', message),
};
