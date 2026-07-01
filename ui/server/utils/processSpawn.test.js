import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prepareCliSpawn, resolveWindowsCliCommand } from './processSpawn.js';

describe('processSpawn Windows CLI shims', () => {
  it('resolves clawhub to the Windows command shim', () => {
    assert.equal(resolveWindowsCliCommand('clawhub', 'win32'), 'clawhub.cmd');
  });

  it('runs Windows command shims through cmd.exe', () => {
    const prepared = prepareCliSpawn('clawhub', ['search', 'browser'], {}, 'win32');

    assert.equal(prepared.command, 'cmd.exe');
    assert.deepEqual(prepared.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(prepared.args[3], /clawhub\.cmd/);
    assert.match(prepared.args[3], /search/);
    assert.match(prepared.args[3], /browser/);
    assert.equal(prepared.options.windowsHide, true);
    assert.equal(prepared.options.windowsVerbatimArguments, true);
  });
});
