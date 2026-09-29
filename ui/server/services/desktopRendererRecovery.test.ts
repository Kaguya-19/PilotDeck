// @vitest-environment node
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { installRendererRecovery } from '../../../apps/desktop/src/rendererRecovery';

function setup() {
  const webContents = Object.assign(new EventEmitter(), { reload: vi.fn() });
  const window = Object.assign(new EventEmitter(), { webContents, isDestroyed: () => false });
  const showDialog = vi.fn(async (_options: unknown) => ({ response: 1, checkboxChecked: false }));
  const log = vi.fn();
  installRendererRecovery(window as never, { isQuitting: () => false, isChinese: () => true, showDialog, log });
  return { window, webContents, showDialog, log };
}
it('offers recovery after a crash, does not auto-reload, and ignores clean exits', async () => {
  const { webContents, showDialog, log } = setup();
  webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  await Promise.resolve();
  expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['重新加载界面', '暂不处理'], defaultId: 1 }));
  expect(log).toHaveBeenCalledWith('render-process-gone', { reason: 'crashed', exitCode: 1 });
  expect(webContents.reload).not.toHaveBeenCalled();
  webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
  expect(showDialog).toHaveBeenCalledTimes(1);
});
it('reloads only after the user chooses recovery and provides shortcuts outside IME composition', async () => {
  const { window, webContents, showDialog } = setup();
  showDialog.mockResolvedValue({ response: 0, checkboxChecked: false });
  window.emit('unresponsive');
  await Promise.resolve();
  expect(webContents.reload).toHaveBeenCalledTimes(1);
  const event = { preventDefault: vi.fn() };
  webContents.emit('before-input-event', event, { type: 'keyDown', key: 'r', control: true, isComposing: true });
  expect(webContents.reload).toHaveBeenCalledTimes(1);
  webContents.emit('before-input-event', event, { type: 'keyDown', key: 'F5' });
  expect(webContents.reload).toHaveBeenCalledTimes(2);
  expect(event.preventDefault).toHaveBeenCalledOnce();
});
