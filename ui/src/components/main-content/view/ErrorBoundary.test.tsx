import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ErrorBoundary from './ErrorBoundary';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); });
it('contains a message rendering error while keeping the composer and its draft usable', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let fail = true;
  function Messages() { if (fail) throw new TypeError('render failed'); return <div>restored messages</div>; }
  render(<div><ErrorBoundary showDetails><Messages /></ErrorBoundary><textarea aria-label="composer" defaultValue="unsent draft" /></div>);
  expect((screen.getByLabelText('composer') as HTMLTextAreaElement).value).toBe('unsent draft');
  fireEvent.change(screen.getByLabelText('composer'), { target: { value: 'still editable' } });
  expect((screen.getByLabelText('composer') as HTMLTextAreaElement).value).toBe('still editable');
  expect(screen.getByText('uiText.reloadInterface')).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByText('common:uiText.tryAgain'));
  expect(screen.getByText('restored messages')).toBeTruthy();
  expect((screen.getByLabelText('composer') as HTMLTextAreaElement).value).toBe('still editable');
});
