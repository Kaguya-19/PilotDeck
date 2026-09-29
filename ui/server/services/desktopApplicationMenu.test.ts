// @vitest-environment node
import { expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { buildApplicationMenu } from '../../../apps/desktop/src/applicationMenu';

for (const platform of ['darwin', 'win32', 'linux'] as const) {
  for (const language of ['en', 'zh-CN'] as const) {
    it(`provides localized native reload and editing roles on ${platform}/${language}`, () => {
      const menu = buildApplicationMenu(platform, language);
      const items = menu.flatMap(section => section.submenu as MenuItemConstructorOptions[]);
      expect(items.find(item => item.role === 'reload')).toMatchObject({
        label: language === 'zh-CN' ? '重新加载界面' : 'Reload Interface', accelerator: 'CmdOrCtrl+R',
      });
      expect(items.filter(item => item.role === 'reload')).toHaveLength(1);
      for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'quit']) {
        expect(items.some(item => item.role === role)).toBe(true);
      }
      expect(menu.some(item => item.label === 'PilotDeck')).toBe(platform === 'darwin');
    });
  }
}
