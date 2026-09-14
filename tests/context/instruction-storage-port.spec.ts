import assert from "node:assert/strict";
import test from "node:test";

import {
  InstructionDiscovery,
  type InstructionStoragePort,
} from "../../src/context/index.js";

test("instruction discovery consumes an injected storage provider while preserving layer order", async () => {
  const reads: string[] = [];
  const directories: string[] = [];
  const storage: InstructionStoragePort = {
    async readText(path) {
      reads.push(path);
      const content: Record<string, string> = {
        "/managed/PILOTDECK.md": "managed",
        "/home/PILOTDECK.md": "user",
        "/project/PILOTDECK.md": "project",
        "/project/.pilotdeck/rules/a.md": "project rule",
        "/project/sub/PILOTDECK.local.md": "local",
      };
      if (!(path in content)) throw new Error("ENOENT");
      return content[path]!;
    },
    async readDirectory(path) {
      directories.push(path);
      if (path === "/project/.pilotdeck/rules") {
        return [
          { name: "z.md", kind: "file" },
          { name: "a.md", kind: "file" },
          { name: "SKILL.md", kind: "file" },
          { name: "nested", kind: "directory" },
        ];
      }
      throw new Error("ENOENT");
    },
  };
  const previous = process.env.PILOTDECK_MANAGED_CONFIG;
  process.env.PILOTDECK_MANAGED_CONFIG = "/managed";
  try {
    const layers = await new InstructionDiscovery("/project", "/project/sub", "/home", storage).discover();
    assert.deepEqual(layers.map((layer) => [layer.scope, layer.path, layer.content]), [
      ["managed", "/managed/PILOTDECK.md", "managed"],
      ["user", "/home/PILOTDECK.md", "user"],
      ["project", "/project/PILOTDECK.md", "project"],
      ["project-rules", "/project/.pilotdeck/rules/a.md", "project rule"],
      ["local", "/project/sub/PILOTDECK.local.md", "local"],
    ]);
    assert.equal(directories.includes("/project/.pilotdeck/rules"), true);
    assert.equal(reads.includes("/project/.pilotdeck/rules/z.md"), true);
  } finally {
    if (previous === undefined) delete process.env.PILOTDECK_MANAGED_CONFIG;
    else process.env.PILOTDECK_MANAGED_CONFIG = previous;
  }
});
