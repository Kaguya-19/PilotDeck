import { describe, expect, it } from 'vitest';
import {
  getOpenUrlSpawnCommand,
  prepareBackgroundSpawnOptions,
  prepareCliSpawn,
  resolveWindowsCliCommand,
} from './processSpawn.js';

describe('Windows-safe process spawn helpers', () => {
  it('resolves Windows command shims without using cmd.exe shell', () => {
    expect(resolveWindowsCliCommand('npm', 'win32')).toBe('npm.cmd');
    expect(resolveWindowsCliCommand('npx', 'win32')).toBe('npx.cmd');
    expect(resolveWindowsCliCommand('task-master', 'win32')).toBe('task-master.cmd');
    expect(resolveWindowsCliCommand('claude', 'win32')).toBe('claude.cmd');
    expect(resolveWindowsCliCommand('which', 'win32')).toBe('where.exe');
    expect(resolveWindowsCliCommand('npm.cmd', 'win32')).toBe('npm.cmd');
  });

  it('keeps non-Windows commands unchanged', () => {
    expect(resolveWindowsCliCommand('npm', 'darwin')).toBe('npm');
    expect(resolveWindowsCliCommand('which', 'linux')).toBe('which');
  });

  it('forces hidden non-shell CLI spawns on Windows only', () => {
    expect(prepareCliSpawn('npx', ['task-master'], { shell: true }, 'win32')).toEqual({
      command: 'npx.cmd',
      args: ['task-master'],
      options: {
        shell: false,
        windowsHide: true,
      },
    });

    expect(prepareCliSpawn('npx', ['task-master'], { shell: true }, 'darwin')).toEqual({
      command: 'npx',
      args: ['task-master'],
      options: {
        shell: true,
        windowsHide: undefined,
      },
    });
  });

  it('does not detach background spawns on Windows', () => {
    expect(prepareBackgroundSpawnOptions({ detached: true, stdio: 'ignore' }, 'win32')).toEqual({
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    });

    expect(prepareBackgroundSpawnOptions({ detached: true, stdio: 'ignore' }, 'linux')).toEqual({
      detached: true,
      stdio: 'ignore',
      windowsHide: undefined,
    });
  });

  it('opens URLs without the Windows start shell builtin', () => {
    expect(getOpenUrlSpawnCommand('http://localhost:3001', 'win32')).toEqual({
      command: 'explorer.exe',
      args: ['http://localhost:3001'],
    });
    expect(getOpenUrlSpawnCommand('http://localhost:3001', 'darwin')).toEqual({
      command: 'open',
      args: ['http://localhost:3001'],
    });
    expect(getOpenUrlSpawnCommand('http://localhost:3001', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['http://localhost:3001'],
    });
  });
});
