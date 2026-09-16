import { applyConfigToProcessEnv, resolveModel } from './pilotdeckConfig.js';
import { closeMemoryServices, startMemoryScheduler } from './memoryService.js';

// Applies a validated config to every running subsystem (env, memory) and
// returns a per-subsystem summary so the UI can show what actually reloaded.
// CCR router / EdgeClaw IM gateway reload paths were removed — both retired
// during the PilotDeck-only migration and the schema no longer carries them.
export async function reloadPilotDeckConfig(config) {
  const result = {
    processEnv: { reloaded: false },
    memory: { reloaded: false },
  };

  applyConfigToProcessEnv(config);
  result.processEnv.reloaded = true;

  closeMemoryServices();
  const memoryEnabled = Boolean(config.memory?.enabled && resolveModel(config, config.memory?.model || config.agent?.model, { allowMissing: true }));
  if (memoryEnabled) {
    startMemoryScheduler();
  }
  result.memory.reloaded = true;
  result.memory.scheduler = memoryEnabled ? 'started' : 'stopped';

  return result;
}
