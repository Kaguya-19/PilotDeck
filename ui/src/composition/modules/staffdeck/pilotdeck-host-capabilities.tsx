import { createContext, useContext, useRef, type ReactNode } from 'react';
import type { PublicCapabilityResponse } from './public-capability-adapter';

/** Browser projection of the selected PilotDeck host Port binding.
 * Composition supplies this client; it neither stores a second catalog nor
 * chooses a model/provider or an AgentLoop implementation.
 */
export type PilotDeckHostCapabilityPort = {
  call(operation: string, input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<PublicCapabilityResponse>;
};
const CapabilityContext = createContext<PilotDeckHostCapabilityPort | undefined>(undefined);
export function PilotDeckHostCapabilityProvider({ port, children }: { port: PilotDeckHostCapabilityPort; children: ReactNode }) {
  const mountedPort = useRef(port);
  if (mountedPort.current !== port) throw new Error('PilotDeck host capability binding cannot change during a mounted editor lifecycle.');
  return <CapabilityContext.Provider value={port}>{children}</CapabilityContext.Provider>;
}
export const usePilotDeckHostCapabilities = () => useContext(CapabilityContext);

export const PILOTDECK_HOST_OPERATIONS = new Set([
  'list_tools', 'create_tool', 'update_tool', 'test_tool', 'probe_unsaved_tool', 'remove_tool',
  'list_general_skills', 'import_general_skill', 'publish_general_skill', 'archive_general_skill', 'test_general_skill',
  'list_model_catalog', 'extract_sop_text',
]);
