import { describe, expect, it } from 'vitest';
import { startCronDaemonDetached } from './cron-daemon-startup.js';

function withPlatform(platform, fn) {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
}

function createSpawnRecorder() {
  const calls = [];
  const child = {
    on: () => child,
    unref: () => {},
  };
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  return { calls, spawnFn };
}

describe('cron daemon startup process options', () => {
  it('hides but does not detach the daemon on Windows', () => {
    withPlatform('win32', () => {
      const { calls, spawnFn } = createSpawnRecorder();

      startCronDaemonDetached({
        spawnFn,
        buildCronDaemonSpawnCommandFn: () => ({ command: 'pilotdeck', args: ['daemon', 'serve'] }),
        openLogFdFn: () => ({ fd: null, logPath: 'cron.log' }),
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].options.detached).toBe(false);
      expect(calls[0].options.windowsHide).toBe(true);
      expect(calls[0].options.stdio).toBe('ignore');
    });
  });

  it('keeps the daemon detached on non-Windows platforms', () => {
    withPlatform('linux', () => {
      const { calls, spawnFn } = createSpawnRecorder();

      startCronDaemonDetached({
        spawnFn,
        buildCronDaemonSpawnCommandFn: () => ({ command: 'pilotdeck', args: ['daemon', 'serve'] }),
        openLogFdFn: () => ({ fd: null, logPath: 'cron.log' }),
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].options.detached).toBe(true);
      expect(calls[0].options.windowsHide).toBeUndefined();
      expect(calls[0].options.stdio).toBe('ignore');
    });
  });
});
