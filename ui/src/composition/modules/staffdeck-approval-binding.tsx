import { createContext, useContext, type ReactNode } from 'react';
import type { createPublicApprovalClient } from './staffdeck/public-approval-client';

export type StaffDeckApprovalClient = ReturnType<typeof createPublicApprovalClient>;

// The normal StaffDeck approver login owns this credential. A missing binding
// cannot be replaced with the PilotDeck login or a management account key.
const ApprovalClientContext = createContext<StaffDeckApprovalClient | null>(null);

export function StaffDeckApprovalClientProvider({ client, children }: {
  client: StaffDeckApprovalClient;
  children: ReactNode;
}) {
  return <ApprovalClientContext.Provider value={client}>{children}</ApprovalClientContext.Provider>;
}

export function useStaffDeckApprovalClient() {
  return useContext(ApprovalClientContext);
}
