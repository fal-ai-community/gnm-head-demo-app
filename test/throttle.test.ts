/**
 * Unit tests for the pure leading+trailing throttle behind realtime
 * auto-generate, run with the Node test runner: `npm test`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createThrottle } from '../lib/throttle.ts';

interface FakeTimer {
  fn: () => void;
  at: number;
  cancelled: boolean;
}

/** A throttle wired to a fake clock and scheduler the test advances by hand. */
function createHarness(intervalMs: number) {
  let clock = 0;
  const timers: FakeTimer[] = [];
  const invokedAt: number[] = [];
  const throttle = createThrottle({
    intervalMs,
    fn: () => invokedAt.push(clock),
    now: () => clock,
    schedule: (fn, ms) => {
      const timer: FakeTimer = { fn, at: clock + ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (handle) => {
      (handle as FakeTimer).cancelled = true;
    },
  });
  /** Move the clock to `t`, firing due timers in order along the way. */
  const advanceTo = (t: number) => {
    for (;;) {
      const due = timers
        .filter((timer) => !timer.cancelled && timer.at <= t)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      clock = due.at;
      due.fn();
    }
    clock = t;
  };
  return { throttle, advanceTo, invokedAt, timers };
}

test('first call invokes immediately (leading edge)', () => {
  const { throttle, invokedAt } = createHarness(100);
  throttle.call();
  assert.deepEqual(invokedAt, [0]);
});

test('calls inside the interval coalesce into one trailing invocation at the boundary', () => {
  const { throttle, advanceTo, invokedAt } = createHarness(100);
  throttle.call(); // leading, t=0
  for (const t of [10, 20, 30, 90]) {
    advanceTo(t);
    throttle.call();
  }
  assert.deepEqual(invokedAt, [0]); // nothing yet
  advanceTo(250);
  assert.deepEqual(invokedAt, [0, 100]); // exactly one trailing fire, on time
});

test('a sustained drag produces periodic invocations, never a postponed-forever debounce', () => {
  const { throttle, advanceTo, invokedAt } = createHarness(100);
  // Slider input events every 16 ms for half a second.
  for (let t = 0; t <= 480; t += 16) {
    advanceTo(t);
    throttle.call();
  }
  advanceTo(1000); // release: only the already-scheduled trailing send fires
  assert.deepEqual(invokedAt, [0, 100, 200, 300, 400, 500]);
});

test('goes quiet after the trailing edge, then leads again once the interval has passed', () => {
  const { throttle, advanceTo, invokedAt } = createHarness(100);
  throttle.call();
  advanceTo(50);
  throttle.call();
  advanceTo(2000);
  assert.deepEqual(invokedAt, [0, 100]); // no extra fires while idle
  throttle.call(); // long after lastInvokedAt + interval
  assert.deepEqual(invokedAt, [0, 100, 2000]);
});

test('cancel drops the pending trailing invocation and is a no-op when idle', () => {
  const { throttle, advanceTo, invokedAt } = createHarness(100);
  throttle.cancel(); // nothing pending
  throttle.call(); // leading, t=0
  advanceTo(40);
  throttle.call(); // schedules trailing at t=100
  throttle.cancel();
  advanceTo(1000);
  assert.deepEqual(invokedAt, [0]);
  throttle.call(); // still works after a cancel
  assert.deepEqual(invokedAt, [0, 1000]);
});

test('the trailing invocation reads state at fire time, not at call time', () => {
  let clock = 0;
  let value = 'old';
  const seen: string[] = [];
  const timers: FakeTimer[] = [];
  const throttle = createThrottle({
    intervalMs: 100,
    fn: () => seen.push(value),
    now: () => clock,
    schedule: (fn, ms) => {
      const timer: FakeTimer = { fn, at: clock + ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (handle) => {
      (handle as FakeTimer).cancelled = true;
    },
  });
  throttle.call(); // leading sees 'old'
  clock = 10;
  value = 'mid';
  throttle.call(); // schedules trailing
  value = 'new'; // the thumb kept moving
  clock = 100;
  timers[0].fn();
  assert.deepEqual(seen, ['old', 'new']);
});
