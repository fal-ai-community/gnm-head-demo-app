import { useCallback, useEffect, useRef } from 'react';

/**
 * Returns a stable debounced wrapper around `fn` plus a `cancel` to drop any
 * pending call (used when an explicit action should pre-empt the debounce).
 */
export function useDebouncedCallback<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delayMs: number,
): { call: (...args: Args) => void; cancel: () => void } {
  const fnRef = useRef(fn);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const call = useCallback(
    (...args: Args) => {
      cancel();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        fnRef.current(...args);
      }, delayMs);
    },
    [cancel, delayMs],
  );

  useEffect(() => cancel, [cancel]);

  return { call, cancel };
}
