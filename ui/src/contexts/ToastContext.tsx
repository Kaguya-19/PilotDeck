import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export type ToastKind = 'success' | 'error' | 'info';

export type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
};

type ToastContextType = {
  toasts: Toast[];
  addToast: (kind: ToastKind, message: string) => void;
  removeToast: (id: number) => void;
};

const ToastContext = createContext<ToastContextType | null>(null);

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
};

const TOAST_DURATION_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const addToast = useCallback((kind: ToastKind, message: string) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_DURATION_MS);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { kind?: ToastKind; message?: string } | undefined;
      if (detail?.message) {
        addToast(detail.kind ?? 'error', detail.message);
      }
    };
    window.addEventListener('pilotdeck:toast', handler);
    return () => window.removeEventListener('pilotdeck:toast', handler);
  }, [addToast]);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
}

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="alert"
          className={`animate-in slide-in-from-right fade-in min-w-[280px] max-w-sm rounded-lg px-4 py-3 text-[13px] font-medium shadow-lg backdrop-blur-sm ${
            toast.kind === 'error'
              ? 'bg-red-500/90 text-white'
              : toast.kind === 'success'
                ? 'bg-emerald-500/90 text-white'
                : 'bg-neutral-800/90 text-neutral-100'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 break-words">{toast.message}</span>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="shrink-0 text-white/70 hover:text-white"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
