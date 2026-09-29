import { createStaffDeckRequestContext } from './adapters/staffdeck-request-context.js';

export function bindModuleRequestAbort(req, res) {
  const context = createStaffDeckRequestContext(req, res);
  const cleanup = () => {
    context.dispose();
    res.off('close', cleanup);
    res.off('finish', cleanup);
  };
  res.once('close', cleanup);
  res.once('finish', cleanup);
  return context.signal;
}

export function moduleUpstreamSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
