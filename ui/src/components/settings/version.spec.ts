import { describe, expect, it } from 'vitest';
import { normalizeDesktopVersionResult, normalizeWebVersionResult } from './version';
describe('settings release protocol', () => {
  it('preserves clean Git eligibility and release identity', () => {
    expect(normalizeWebVersionResult({ hasUpdate: true, canUpdate: true, current: { tagName: 'v2026.09.07' }, latest: { tagName: 'v2026.09.08', sourceSha: 'release-sha' } })).toMatchObject({ mode: 'web', hasUpdate: true, canUpdate: true, currentVersion: 'v2026.09.07', latestVersion: 'v2026.09.08', latestSourceSha: 'release-sha' });
  });
  it('keeps development workspaces disabled and shows their commit', () => {
    expect(normalizeWebVersionResult({ hasUpdate: true, canUpdate: false, reason: 'dirtyWorktree', current: { sourceSha: '123456789abcdef' } })).toMatchObject({ canUpdate: false, webReason: 'dirtyWorktree', currentVersion: '12345678' });
  });
  it('preserves native download eligibility and reason', () => {
    expect(normalizeDesktopVersionResult({ hasUpdate: true, canDownload: false, reason: 'noCompatibleInstaller', current: { version: '2026.907.0' }, latest: { version: '2026.908.0' } })).toMatchObject({ mode: 'desktop', canDownload: false, desktopReason: 'noCompatibleInstaller', latestVersion: '2026.908.0' });
  });
});
