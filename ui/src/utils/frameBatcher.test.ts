import { afterEach, expect, it, vi } from 'vitest';
import { createFrameBatcher } from './frameBatcher';

afterEach(() => vi.unstubAllGlobals());
it('applies only the newest sample per frame and flushes the final pointer before release', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  const apply = vi.fn();
  const batch = createFrameBatcher(apply);
  for (let i = 0; i < 100; i++) batch.schedule(i);
  expect(frames.size).toBe(1);
  expect(apply).not.toHaveBeenCalled();
  [...frames.values()][0](16);
  expect(apply.mock.calls).toEqual([[99]]);
  batch.schedule(100); batch.schedule(101);
  batch.flush();
  expect(apply.mock.calls).toEqual([[99], [101]]);
  expect(frames.size).toBe(0);
  batch.schedule(102); batch.cancel(); batch.flush();
  expect(apply).toHaveBeenCalledTimes(2);
});
