// @vitest-environment node
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { browseDirectories } from './browseDirectories.js';
let root;
afterEach(async () => { if (root) await rm(root, {recursive:true,force:true}); });
it('lists immediate folders including build directories without descending into them', async () => {
  root = await mkdtemp(path.join(os.tmpdir(),'pilotdeck-picker-'));
  await Promise.all(['dist','nested/child','.hidden'].map(name => mkdir(path.join(root,name),{recursive:true})));
  await writeFile(path.join(root,'file.txt'),'file');
  expect((await browseDirectories(root)).map(f=>f.name)).toEqual(['dist','nested']);
  expect((await browseDirectories(root,true)).map(f=>f.name)).toEqual(['.hidden','dist','nested']);
});
it.skipIf(process.platform === 'win32')('includes directory symlinks and ignores broken links', async () => {
  root = await mkdtemp(path.join(os.tmpdir(),'pilotdeck-picker-'));
  await mkdir(path.join(root,'target'));await symlink(path.join(root,'target'),path.join(root,'link'));await symlink(path.join(root,'missing'),path.join(root,'broken'));
  expect((await browseDirectories(root)).map(f=>f.name)).toEqual(['link','target']);
});
