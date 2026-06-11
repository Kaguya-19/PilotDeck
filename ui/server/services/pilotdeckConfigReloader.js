import { applyConfigToProcessEnv } from './pilotdeckConfig.js';
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
  if (config.memory?.enabled) {
    startMemoryScheduler();
  }
  result.memory.reloaded = true;
  result.memory.scheduler = config.memory?.enabled ? 'started' : 'stopped';

  return result;
}
