// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '../../i18n/locales/en/common.json';
import zh from '../../i18n/locales/zh-CN/common.json';
import { ConfirmDialog, ConfirmProvider, useConfirm } from './ConfirmDialog';

afterEach(cleanup);
async function language(locale: string) {
  const i18n = createInstance();
  await i18n.init({ lng: locale, fallbackLng: 'en', resources: { en: { common: en }, 'zh-CN': { common: zh } }, defaultNS: 'common', interpolation: { escapeValue: false } });
  return i18n;
}
function Requester({ onResult }: { onResult: (accepted: boolean) => void }) {
  const confirm = useConfirm();
  return <button onClick={async () => onResult(await confirm({ title: 'Delete fixture?', message: 'fixture.txt', destructive: true }))}>Launch</button>;
}

describe('shared confirmations', () => {
  it.each([['en', 'Cancel', 'Confirm'], ['zh-CN', '取消', '确定']])('uses %s labels, cancels with Escape, restores focus and confirms once', async (locale, cancelLabel, confirmLabel) => {
    const i18n = await language(locale);
    const result = vi.fn();
    render(<I18nextProvider i18n={i18n}><ConfirmProvider><Requester onResult={result} /></ConfirmProvider></I18nextProvider>);
    const launch = screen.getByText('Launch');
    launch.focus();
    fireEvent.click(launch);
    expect(document.activeElement).toBe(screen.getByText(cancelLabel));
    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => {});
    expect(result).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).toBe(launch);
    fireEvent.click(launch);
    fireEvent.click(screen.getByText(confirmLabel));
    await act(async () => {});
    expect(result.mock.calls.map(call => call[0])).toEqual([false, true]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('rejects a duplicate request and cancels a pending request when its owner unmounts', async () => {
    const i18n = await language('en');
    const result = vi.fn();
    function Page() {
      const [visible, setVisible] = useState(true);
      return <><button onClick={() => setVisible(false)}>Navigate</button>{visible && <Requester onResult={result} />}</>;
    }
    render(<I18nextProvider i18n={i18n}><ConfirmProvider><Page /></ConfirmProvider></I18nextProvider>);
    fireEvent.click(screen.getByText('Launch'));
    fireEvent.click(screen.getByText('Launch'));
    await act(async () => {});
    expect(result).toHaveBeenLastCalledWith(false);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(screen.getByText('Navigate'));
    await act(async () => {});
    expect(result.mock.calls.map(call => call[0])).toEqual([false, false]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a busy operation open and traps keyboard focus', async () => {
    const i18n = await language('en');
    const cancel = vi.fn();
    const confirm = vi.fn();
    const view = render(<I18nextProvider i18n={i18n}><ConfirmDialog onCancel={cancel} onConfirm={confirm}>fixture</ConfirmDialog></I18nextProvider>);
    const last = screen.getByText('Confirm');
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('Close'));
    view.rerender(<I18nextProvider i18n={i18n}><ConfirmDialog busy onCancel={cancel} onConfirm={confirm}>fixture</ConfirmDialog></I18nextProvider>);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByText('Working…'));
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(cancel).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
