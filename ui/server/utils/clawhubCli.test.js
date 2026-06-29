import { describe, expect, it } from 'vitest';
import {
  buildClawhubInvocation,
  isClawhubNotFoundError,
  resolveBundledClawhubScript,
} from './clawhubCli.js';

describe('clawhub CLI resolution', () => {
  it('runs the bundled package through the current node runtime', () => {
    const invocation = buildClawhubInvocation(['--no-input', 'search', 'pdf'], {
      bundledScript: '/app/node_modules/clawhub/bin/clawdhub.js',
      nodePath: '/usr/bin/node',
    });

    expect(invocation).toEqual({
      file: '/usr/bin/node',
      args: ['/app/node_modules/clawhub/bin/clawdhub.js', '--no-input', 'search', 'pdf'],
      source: 'bundled',
    });
  });

  it('falls back to PATH when the bundled package is unavailable', () => {
    const invocation = buildClawhubInvocation(['--version'], { bundledScript: null });

    expect(invocation).toEqual({
      file: 'clawhub',
      args: ['--version'],
      source: 'path',
    });
  });

  it('marks only missing PATH fallback errors as unavailable', () => {
    expect(
      isClawhubNotFoundError({
        code: 'ENOENT',
        clawhubInvocation: { source: 'path' },
      }),
    ).toBe(true);
    expect(
      isClawhubNotFoundError({
        code: 'ENOENT',
        clawhubInvocation: { source: 'bundled' },
      }),
    ).toBe(false);
  });

  it('resolves the packaged clawhub CLI script from dependencies', () => {
    const script = resolveBundledClawhubScript();

    expect(script?.replace(/\\/g, '/')).toMatch(/clawhub.*\/bin\/clawdhub\.js$/);
  });
});
