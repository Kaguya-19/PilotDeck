import type { MenuItemConstructorOptions } from 'electron';
import type { DesktopAppearance } from './appearance';

/** Native roles preserve platform editing, window management and shortcuts. */
export function buildApplicationMenu(
  platform: NodeJS.Platform,
  language: DesktopAppearance['language'],
): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const text = (zh: string, en: string) => language === 'zh-CN' ? zh : en;
  const item = (role: MenuItemConstructorOptions['role'], zh: string, en: string): MenuItemConstructorOptions => (
    { role, label: text(zh, en) }
  );
  const separator: MenuItemConstructorOptions = { type: 'separator' };
  return [
    ...(mac ? [{
      label: 'PilotDeck',
      submenu: [
        item('about', '关于 PilotDeck', 'About PilotDeck'), separator,
        item('services', '服务', 'Services'), separator,
        item('hide', '隐藏 PilotDeck', 'Hide PilotDeck'),
        item('hideOthers', '隐藏其他', 'Hide Others'),
        item('unhide', '显示全部', 'Show All'), separator,
        item('quit', '退出 PilotDeck', 'Quit PilotDeck'),
      ],
    }] : []),
    {
      label: text('文件', mac ? 'File' : '&File'),
      submenu: [mac ? item('close', '关闭窗口', 'Close Window') : item('quit', '退出', 'Exit')],
    },
    {
      label: text('编辑', mac ? 'Edit' : '&Edit'),
      submenu: [
        item('undo', '撤销', 'Undo'), item('redo', '重做', 'Redo'), separator,
        item('cut', '剪切', 'Cut'), item('copy', '复制', 'Copy'),
        item('paste', '粘贴', 'Paste'), item('selectAll', '全选', 'Select All'),
      ],
    },
    {
      label: text('查看', mac ? 'View' : '&View'),
      submenu: [
        // Normal reload runs the page's beforeunload draft flush. The native
        // role remains available independently of the React message tree.
        { ...item('reload', '重新加载界面', 'Reload Interface'), accelerator: 'CmdOrCtrl+R' },
        separator,
        item('resetZoom', '实际大小', 'Actual Size'),
        item('zoomIn', '放大', 'Zoom In'), item('zoomOut', '缩小', 'Zoom Out'), separator,
        item('togglefullscreen', '切换全屏', 'Toggle Full Screen'),
      ],
    },
    {
      label: text('窗口', mac ? 'Window' : '&Window'),
      role: 'windowMenu',
      submenu: [
        item('minimize', '最小化', 'Minimize'),
        ...(mac ? [item('zoom', '缩放', 'Zoom'), separator, item('front', '全部置于前面', 'Bring All to Front')]
          : [item('close', '关闭窗口', 'Close Window')]),
      ],
    },
  ];
}
