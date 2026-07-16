/**
 * A pure leading+trailing throttle for the realtime auto-generate path.
 *
 * A plain trailing debounce is wrong for a slider drag: continuous `input`
 * events keep pushing the deadline out, so nothing fires until release. This
 * throttle instead guarantees periodic invocations during sustained calls —
 * the first call fires immediately (leading edge), further calls inside the
 * interval coalesce into exactly one invocation at the interval boundary
 * (trailing edge). Because `fn` takes no arguments and reads current state
 * when invoked, the trailing edge always sees the latest value, and a drag
 * release needs no extra send.
 *
 * Like the dead-man timer in `protocol.ts`, the clock and scheduler are
 * injectable so the timing behavior is unit-testable with the Node runner.
 */

export interface Throttle {
  /** Request an invocation. Extra calls inside the interval coalesce into one trailing invocation. */
  call(): void;
  /** Drop any pending trailing invocation. */
  cancel(): void;
}

export interface ThrottleOptions {
  intervalMs: number;
  fn: () => void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export function createThrottle({
  intervalMs,
  fn,
  now = () => Date.now(),
  schedule = (f, ms) => setTimeout(f, ms),
  cancel: cancelSchedule = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: ThrottleOptions): Throttle {
  let lastInvokedAt = -Infinity;
  let pending: unknown = null;

  const invoke = () => {
    lastInvokedAt = now();
    fn();
  };

  return {
    call() {
      // A trailing invocation is already scheduled; it will read the state
      // current at fire time, so this call is fully covered by it.
      if (pending != null) return;
      const waitMs = lastInvokedAt + intervalMs - now();
      if (waitMs <= 0) {
        invoke();
        return;
      }
      pending = schedule(() => {
        pending = null;
        invoke();
      }, waitMs);
    },
    cancel() {
      if (pending != null) {
        cancelSchedule(pending);
        pending = null;
      }
    },
  };
}
