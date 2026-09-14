import type { PilotDeckHooksSettings } from "../../hooks/protocol/settings.js";
import type { PilotDeckLoadedPlugin } from "../protocol/plugin.js";

export function loadPluginHooks(plugins: PilotDeckLoadedPlugin[]): PilotDeckHooksSettings {
  const settings: PilotDeckHooksSettings = {};
  for (const plugin of plugins) {
    const sources = [
      plugin.hooksConfig,
      ...(plugin.hookContributions ?? []).map((contribution) => contribution.hooks),
    ];
    for (const source of sources) {
      for (const [event, matchers] of Object.entries(source ?? {}) as Array<
        [keyof PilotDeckHooksSettings, NonNullable<PilotDeckHooksSettings[keyof PilotDeckHooksSettings]>]
      >) {
        settings[event] = [
          ...(settings[event] ?? []),
          ...matchers.map((matcher) => ({
            ...matcher,
            pluginName: plugin.name,
            pluginId: `${plugin.name}@${plugin.source}`,
            pluginRoot: plugin.path,
          })),
        ];
      }
    }
  }
  return settings;
}
