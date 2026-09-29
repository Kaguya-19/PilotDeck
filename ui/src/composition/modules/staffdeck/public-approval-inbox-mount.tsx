import type { ComponentType } from 'react';
import { usePublicApprovalInbox } from './public-approval-consumer';
import type { ApprovalScope, ApprovalStatus, PinnedApproval } from './public-approval-client';

export type PublicApprovalInboxView = ComponentType<{
  status: ApprovalStatus | null;
  loading?: boolean;
  submitting?: boolean;
  error?: string;
  onReply: (approval: PinnedApproval, message: string) => void | Promise<void>;
}>;

export type PublicApprovalInboxMountProps = {
  scope: ApprovalScope | null;
  readApproverBearer?: () => string;
  Inbox?: PublicApprovalInboxView;
  refreshKey?: string;
  disabled?: boolean;
  hidden?: boolean;
  onPrepared?: (message: string) => void;
  onError?: (message: string) => void;
};

export type PublicApprovalHost = Pick<PublicApprovalInboxMountProps, 'Inbox' | 'readApproverBearer'>;

/** Browser adapter mount; the root injects the single canonical view and normal approver login. */
export function PublicApprovalInboxMount({ scope, readApproverBearer, Inbox, refreshKey, disabled, hidden, onPrepared, onError }: PublicApprovalInboxMountProps) {
  const consumer = usePublicApprovalInbox({ scope, readApproverBearer, refreshKey, onPrepared, onError });
  if (hidden) return null;
  const hasApproval = Boolean(consumer.status?.approval || consumer.status?.approvalError || consumer.status?.wait?.kind === 'handoff');
  if (!Inbox && hasApproval) return <div role="alert">SOP_APPROVAL_INBOX_UNAVAILABLE</div>;
  if (!Inbox || !hasApproval) return consumer.error ? <div role="alert">{consumer.error}</div> : null;
  return <Inbox status={consumer.status} loading={consumer.loading} submitting={consumer.submitting || disabled}
    error={consumer.error} onReply={async (approval, message) => { if (!disabled) await consumer.onReply(approval, message); }} />;
}
