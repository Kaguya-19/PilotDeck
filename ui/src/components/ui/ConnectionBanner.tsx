import { useWebSocket } from '../../contexts/WebSocketContext';
import { WifiOff } from 'lucide-react';

export function ConnectionBanner() {
  const { reconnectInfo } = useWebSocket();

  if (reconnectInfo.status === 'connected') return null;

  const seconds = Math.ceil(reconnectInfo.nextRetryMs / 1000);

  return (
    <div className="flex items-center justify-center gap-2 bg-amber-500/90 px-3 py-1.5 text-[12px] font-medium text-white backdrop-blur-sm">
      <WifiOff className="h-3.5 w-3.5" strokeWidth={2} />
      <span>
        {reconnectInfo.status === 'reconnecting'
          ? 'Reconnecting...'
          : `Connection lost — retrying in ${seconds}s (attempt ${reconnectInfo.attempt})`}
      </span>
    </div>
  );
}
