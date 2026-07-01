import { describe, expect, it } from 'vitest';
import { getParentPath, WINDOWS_DRIVES_PATH } from './pathUtils';

describe('project creation path utilities', () => {
  it('moves from Windows drive roots to the virtual drives view', () => {
    expect(getParentPath('C:\\')).toBe(WINDOWS_DRIVES_PATH);
    expect(getParentPath('D:')).toBe(WINDOWS_DRIVES_PATH);
  });

  it('stops at filesystem roots', () => {
    expect(getParentPath(WINDOWS_DRIVES_PATH)).toBeNull();
    expect(getParentPath('/')).toBeNull();
  });

  it('keeps normal Windows parent navigation under a drive', () => {
    expect(getParentPath('D:\\Projects\\PilotDeck')).toBe('D:\\Projects');
    expect(getParentPath('D:\\Projects')).toBe('D:\\');
  });
});
