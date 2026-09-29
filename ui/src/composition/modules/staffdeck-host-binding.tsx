import type { ReactNode } from 'react';
import { createPublicModuleClient } from './staffdeck/public-module-client';
import { PilotDeckHostCapabilityProvider } from './staffdeck/pilotdeck-host-capabilities';

// One stable browser projection; the server resolves the active runtime Ports.
// This client does not choose or cache a provider, model or catalog.
const hostPort = createPublicModuleClient('/api/modules/host-capabilities/call');
export function StaffDeckHostBinding({ children }: { children: ReactNode }) {
  return <PilotDeckHostCapabilityProvider port={hostPort}>{children}</PilotDeckHostCapabilityProvider>;
}
