// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ToastProvider } from './ToastContext';

afterEach(cleanup);

it('shows the original warning tone from the adapter event', () => {
  render(<ToastProvider><span>App</span></ToastProvider>);
  act(() => window.dispatchEvent(new CustomEvent('pilotdeck:toast', { detail: { kind: 'warning', message: 'Draft needs attention' } })));
  const toast = screen.getByRole('alert');
  expect(toast.textContent).toContain('Draft needs attention');
  expect(toast.className).toContain('bg-amber-500/90');
  expect(toast.className).not.toContain('bg-emerald-500/90');
});
