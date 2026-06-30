import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { PilotDeckLoadedPlugin } from "../protocol/plugin.js";
import { parsePluginManifest } from "../config/parsePluginManifest.js";
import { loadPluginCommandsSync } from "../loading/PluginCommandLoader.js";

const __filename = fileURLToPath(import.meta.url);
const BUILTIN_DIR = resolve(__filename, "..");

let _cache: PilotDeckLoadedPlugin[] | undefined;

export function loadBuiltinPlugins(): PilotDeckLoadedPlugin[] {
  if (_cache) return _cache;
  _cache = [];
  try {
    for (const name of readdirSync(BUILTIN_DIR)) {
      const pluginPath = resolve(BUILTIN_DIR, name);
      if (!statSync(pluginPath).isDirectory()) continue;
      const manifestPath = resolve(pluginPath, "plugin.json");
      try {
        statSync(manifestPath);
      } catch {
        continue;
      }
      const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
      const manifest = parsePluginManifest(raw);
      const commands = loadConfiguredMarkdownSync(pluginPath, manifest.commands, "commands");
      const skills = loadConfiguredMarkdownSync(pluginPath, manifest.skills, "skills");
      const outputStyles = loadConfiguredMarkdownSync(pluginPath, manifest.outputStyles, "output-styles");
      _cache.push({
        name: manifest.name,
        path: pluginPath,
        source: "builtin",
        manifest,
        commands: commands.length > 0 ? commands : undefined,
        skills: skills.length > 0 ? skills : undefined,
        outputStyles: outputStyles.length > 0 ? outputStyles : undefined,
        mcpServers: manifest.mcpServers,
      });
    }
  } catch { /* builtin dir scan failed — fine, no builtins */ }
  return _cache;
}

function loadConfiguredMarkdownSync(
  pluginPath: string,
  configured: string | string[] | undefined,
  fallbackDir: "commands" | "skills" | "output-styles",
) {
  const dirs = configured === undefined ? [fallbackDir] : Array.isArray(configured) ? configured : [configured];
  const pluginName = pluginPath.split(/[\\/]/u).at(-1) ?? "";
  return dirs
    .flatMap((dir) => loadPluginCommandsSync({ pluginName: "", baseDir: resolve(pluginPath, dir) }))
    .map((command) => ({
      ...command,
      name: command.name.startsWith(":")
        ? `${pluginName}${command.name}`
        : command.name.replace(/^:/u, `${pluginName}:`),
    }));
}
