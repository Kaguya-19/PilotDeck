import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PilotDeckLoadedPlugin } from "../protocol/plugin.js";
import { loadPluginCommandsSync } from "../loading/PluginCommandLoader.js";

const __filename = fileURLToPath(import.meta.url);
const MODULE_DIR = dirname(__filename);

let _cache: PilotDeckLoadedPlugin[] | undefined;

export function loadBundledSkills(): PilotDeckLoadedPlugin[] {
  if (_cache) return _cache;
  _cache = [];
  const skillsRoot = findBundledSkillsRoot();
  if (!skillsRoot) return _cache;

  for (const entry of safeReadDir(skillsRoot)) {
    const skillDir = resolve(skillsRoot, entry);
    if (!safeIsDirectory(skillDir) || !existsSync(resolve(skillDir, "SKILL.md"))) continue;
    const skills = loadPluginCommandsSync({ pluginName: entry, baseDir: skillDir })
      .filter((skill) => skill.isSkill);
    if (skills.length === 0) continue;
    _cache.push({
      name: entry,
      path: skillDir,
      source: "builtin",
      manifest: { name: entry, version: "0.0.0" },
      skills,
    });
  }
  return _cache;
}

function findBundledSkillsRoot(): string | undefined {
  const candidates = [
    resolve(MODULE_DIR, "..", "..", "..", "..", "..", "skills"),
    resolve(MODULE_DIR, "..", "..", "..", "..", "..", "..", "skills"),
  ];
  return candidates.find((candidate) => safeIsDirectory(candidate));
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
