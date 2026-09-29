import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';

type RecoveryOptions = {
  isQuitting: () => boolean;
  isChinese: () => boolean;
  showDialog: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  log: (event: string, details: Record<string, string | number>) => void;
};

/** Recovery lives in the main process so it also works when the UI is frozen. */
export function installRendererRecovery(window: BrowserWindow, options: RecoveryOptions) {
  let showingRecovery = false;
  const recover = async (crashed: boolean) => {
    if (showingRecovery || options.isQuitting() || window.isDestroyed()) return;
    showingRecovery = true;
    const zh = options.isChinese();
    try {
      const { response } = await options.showDialog({
        type: 'warning', title: 'PilotDeck',
        message: zh
          ? (crashed ? '界面意外关闭' : '界面暂时没有响应')
          : (crashed ? 'The interface closed unexpectedly' : 'The interface is not responding'),
        detail: zh
          ? '可以重新加载界面。后台任务不会因此停止，最近保存的草稿会保留。'
          : 'You can reload the interface. Background tasks will continue and recently saved drafts will be retained.',
        buttons: zh ? ['重新加载界面', crashed ? '暂不处理' : '继续等待']
          : ['Reload interface', crashed ? 'Not now' : 'Keep waiting'],
        defaultId: 1, cancelId: 1,
      });
      if (response === 0 && !options.isQuitting() && !window.isDestroyed()) window.webContents.reload();
    } finally {
      showingRecovery = false;
    }
  };
  window.webContents.on('render-process-gone', (_event, details) => {
    if (options.isQuitting() || details.reason === 'clean-exit') return;
    options.log('render-process-gone', { reason: details.reason, exitCode: details.exitCode });
    void recover(true).catch(() => {});
  });
  window.on('unresponsive', () => {
    options.log('unresponsive', {});
    void recover(false).catch(() => {});
  });
  // Keep F5 and reload shortcuts available while the native menu is hidden.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat || input.isComposing || input.alt) return;
    if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')) {
      event.preventDefault();
      window.webContents.reload();
    }
  });
}
