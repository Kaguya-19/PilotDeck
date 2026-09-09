import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId } from '../../src/pilot/index.js';
import { createRegisteredWebProjectResolver, listRegisteredWebProjects } from '../../src/web/server/listProjects.js';
import { createDialogProjectRegistry } from '../../src/gateway/dialog/projectRegistry.js';

test('registration lookup supports current and legacy IDs and revalidates cached locations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilotdeck-registration-'));
  try {
    const pilotHome = join(root, 'home');
    const workspace = join(root, 'workspace');
    const other = join(root, 'other');
    await mkdir(workspace); await mkdir(other);
    const direct = join(pilotHome, 'projects', createProjectId(workspace));
    await mkdir(direct, {recursive: true});
    await writeFile(join(direct, '.cwd'), workspace);
    // A directory where a transcript should be cannot be read as a session.
    // Identity validation is independent of even corrupt/unreadable history.
    await mkdir(join(direct, 'chats', 'broken.jsonl'), {recursive: true});
    const resolveProject = createRegisteredWebProjectResolver({pilotHome});
    const registry = createDialogProjectRegistry({pilotHome, resolveProject, listProjects: async () => {
      throw new Error('Sending must not enumerate project summaries');
    }});
    assert.equal(await registry.resolveProjectKey(workspace), workspace);
    assert.equal(await registry.resolveProjectKey(pilotHome), pilotHome);
    assert.deepEqual(await listRegisteredWebProjects({pilotHome}), [{projectKey: workspace}]);
    await rm(direct, {recursive: true});
    await assert.rejects(registry.resolveProjectKey(workspace), {code: 'PROJECT_NOT_FOUND'});
    const legacy = join(pilotHome, 'projects', 'collision-resistant-id');
    await mkdir(legacy);
    await writeFile(join(legacy, '.cwd'), workspace);
    assert.equal(await registry.resolveProjectKey(workspace), workspace);
    assert.equal(await registry.resolveProjectKey(workspace), workspace);
    await writeFile(join(legacy, '.cwd'), other);
    await assert.rejects(registry.resolveProjectKey(workspace), {code: 'PROJECT_NOT_FOUND'});
    assert.equal(await registry.resolveProjectKey(other), other);
    await rm(other, {recursive: true});
    await assert.rejects(registry.resolveProjectKey(other), {code: 'PROJECT_NOT_FOUND'});
    await rm(legacy, {recursive: true});

  } finally { await rm(root, {recursive: true, force: true}); }
});
