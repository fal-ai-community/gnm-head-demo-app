import { useEffect, useMemo, useRef } from 'react';

import { createThrottle, type Throttle } from './throttle';

/**
 * Returns a stable leading+trailing throttled wrapper around `fn` plus a
 * `cancel` to drop the pending trailing invocation (used when an explicit
 * action pre-empts it, or when the transport is switched). Always invokes
 * the latest `fn`.
 */
export function useThrottledCallback(fn: () => void, intervalMs: number): Throttle {
  const fnRef = useRef(fn);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  const throttle = useMemo(
    () => createThrottle({ intervalMs, fn: () => fnRef.current() }),
    [intervalMs],
  );

  useEffect(() => () => throttle.cancel(), [throttle]);

  return throttle;
}
