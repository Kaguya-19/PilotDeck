import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { InstructionDiscovery, scopeDescription } from "../../src/context/instructions/InstructionDiscovery.js";

test("InstructionDiscovery loads managed, user, project and local layers in priority order", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-instructions-"));
  const managed = join(root, "managed");
  const home = join(root, "home");
  const project = join(root, "project");
  const nested = join(project, "packages", "app");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(managed), { recursive: true });
  await mkdir(join(home, "rules"), { recursive: true });
  await mkdir(join(project, ".pilotdeck", "rules"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(join(managed, "PILOTDECK.md"), "managed\n");
  await writeFile(join(home, "PILOTDECK.md"), "user\n");
  await writeFile(join(home, "rules", "20-second.md"), "second\n");
  await writeFile(join(home, "rules", "10-first.md"), "first\n");
  await writeFile(join(home, "rules", "SKILL.md"), "ignored skill\n");
  await writeFile(join(home, "rules", "notes.txt"), "ignored extension\n");
  await writeFile(join(project, "PILOTDECK.md"), "project root\n");
  await writeFile(join(project, ".pilotdeck", "PILOTDECK.md"), "hidden project\n");
  await writeFile(join(project, ".pilotdeck", "rules", "rule.md"), "project rule\n");
  await writeFile(join(nested, "PILOTDECK.md"), "nested\n");
  await writeFile(join(nested, "PILOTDECK.local.md"), "local\n");

  const previous = process.env.PILOTDECK_MANAGED_CONFIG;
  process.env.PILOTDECK_MANAGED_CONFIG = managed;
  t.after(() => {
    if (previous === undefined) delete process.env.PILOTDECK_MANAGED_CONFIG;
    else process.env.PILOTDECK_MANAGED_CONFIG = previous;
  });

  const layers = await new InstructionDiscovery(project, nested, home).discover();
  assert.deepEqual(layers.map((layer) => [layer.scope, layer.content]), [
    ["managed", "managed"],
    ["user", "user"],
    ["user", "first"],
    ["user", "second"],
    ["project", "project root"],
    ["project", "hidden project"],
    ["project-rules", "project rule"],
    ["project", "nested"],
    ["local", "local"],
  ]);
});

test("InstructionDiscovery ignores empty files, missing directories and duplicate paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-instructions-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "home", "rules"), { recursive: true });
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(join(root, "home", "PILOTDECK.md"), "   \n");
  await writeFile(join(root, "home", "rules", "empty.md"), "\n\n");
  await writeFile(join(root, "project", "PILOTDECK.md"), "root\n");
  const layers = await new InstructionDiscovery(root + "/project", root + "/project", root + "/home").discover();
  assert.deepEqual(layers.map((layer) => layer.content), ["root"]);
});

test("InstructionDiscovery handles root cwd and exposes all scope descriptions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-instructions-root-"));
  try {
    await writeFile(join(root, "PILOTDECK.md"), "root instructions");
    const layers = await new InstructionDiscovery(root, root, join(root, "missing-home")).discover();
    assert.deepEqual(layers.map((layer) => layer.content), ["root instructions"]);
    for (const scope of ["managed", "user", "project", "project-rules", "local"] as const) {
      assert.notEqual(scopeDescription(scope), "");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
