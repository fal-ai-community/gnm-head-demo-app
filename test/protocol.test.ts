/**
 * Unit tests for the pure protocol helpers, run with the Node test runner:
 * `npm test` (uses `node --experimental-strip-types --test`).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultBlendInput, defaultSemanticInput } from '../lib/gnm.ts';
import {
  buildRealtimeRequest,
  createDeadmanTimer,
  createRequestTracker,
  decodeFloat32LE,
  decodeRealtimeGeometry,
  decodeUint32LE,
  endpointForMode,
} from '../lib/protocol.ts';

// --- Endpoint joining --------------------------------------------------------

test('endpointForMode joins sub-paths without doubled or trailing slashes', () => {
  assert.equal(endpointForMode('semantic', 'google/gnm-head'), 'google/gnm-head');
  assert.equal(endpointForMode('blend', 'google/gnm-head'), 'google/gnm-head/blend');
  assert.equal(endpointForMode('advanced', 'google/gnm-head/'), 'google/gnm-head/advanced');
  assert.equal(endpointForMode('blend', ' google/gnm-head/// '), 'google/gnm-head/blend');
});

// --- Realtime request building -----------------------------------------------

test('buildRealtimeRequest strips HTTP-only fields and nests the payload', () => {
  const input = defaultSemanticInput();
  const request = buildRealtimeRequest('semantic', input, true, 'r1');
  assert.equal(request.request_id, 'r1');
  assert.equal(request.include_topology, true);
  assert.equal(request.payload.mode, 'semantic');
  assert.equal(request.payload.gender, 'female');
  assert.ok(!('output_format' in request.payload));
  assert.ok(!('sync_mode' in request.payload));
  // The input object must not be mutated.
  assert.equal(input.output_format, 'glb');
  assert.equal(input.sync_mode, true);
});

test('buildRealtimeRequest keeps every mode-specific field', () => {
  const input = defaultBlendInput();
  const request = buildRealtimeRequest('blend', input, false, 'r2');
  assert.equal(request.include_topology, false);
  assert.equal(request.payload.ethnicity_mix, 0.5);
  assert.equal(request.payload.expression_1, 'happy');
  const expectedKeys = Object.keys(input).filter(
    (key) => key !== 'output_format' && key !== 'sync_mode',
  );
  assert.deepEqual(
    new Set(Object.keys(request.payload)),
    new Set([...expectedKeys, 'mode']),
  );
});

// --- Little-endian byte decoding -----------------------------------------------

/** Serialize float32 values little-endian, optionally at an unaligned byteOffset. */
function float32LEBytes(values: number[], offset = 0): Uint8Array {
  const buffer = new ArrayBuffer(values.length * 4 + offset);
  const view = new DataView(buffer);
  values.forEach((value, i) => view.setFloat32(offset + i * 4, value, true));
  return new Uint8Array(buffer, offset, values.length * 4);
}

/** Serialize uint32 values little-endian, optionally at an unaligned byteOffset. */
function uint32LEBytes(values: number[], offset = 0): Uint8Array {
  const buffer = new ArrayBuffer(values.length * 4 + offset);
  const view = new DataView(buffer);
  values.forEach((value, i) => view.setUint32(offset + i * 4, value, true));
  return new Uint8Array(buffer, offset, values.length * 4);
}

test('decodeFloat32LE decodes aligned little-endian bytes', () => {
  const decoded = decodeFloat32LE(float32LEBytes([0, -1.5, 3.25]), 3);
  assert.deepEqual(Array.from(decoded), [0, -1.5, 3.25]);
});

test('decodeFloat32LE decodes views with an unaligned byteOffset', () => {
  const bytes = float32LEBytes([1.5, -2.5], 1);
  assert.equal(bytes.byteOffset % 4, 1); // genuinely unaligned
  assert.deepEqual(Array.from(decodeFloat32LE(bytes, 2)), [1.5, -2.5]);
});

test('decodeUint32LE decodes unaligned little-endian bytes including uint32 max', () => {
  const bytes = uint32LEBytes([0, 1, 4294967295], 3);
  assert.equal(bytes.byteOffset % 4, 3);
  assert.deepEqual(Array.from(decodeUint32LE(bytes, 3)), [0, 1, 4294967295]);
});

test('decoded arrays are copies, detached from the source buffer', () => {
  const bytes = float32LEBytes([1]);
  const decoded = decodeFloat32LE(bytes, 1);
  bytes.fill(0); // simulate the msgpack decoder reusing its buffer
  assert.equal(decoded[0], 1);
});

test('decode*LE reject byte-length mismatches', () => {
  assert.throws(() => decodeFloat32LE(new Uint8Array(10), 3));
  assert.throws(() => decodeUint32LE(new Uint8Array(11), 3));
});

// --- Frame geometry validation ---------------------------------------------------

test('decodeRealtimeGeometry decodes positions and indices', () => {
  const vertices = float32LEBytes([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const faces = uint32LEBytes([0, 1, 2]);
  const geometry = decodeRealtimeGeometry({
    vertices,
    faces,
    num_vertices: 3,
    num_faces: 1,
  });
  assert.equal(geometry.positions.length, 9);
  assert.deepEqual(Array.from(geometry.indices ?? []), [0, 1, 2]);
});

test('decodeRealtimeGeometry returns null indices for vertex-only frames', () => {
  const vertices = float32LEBytes([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const geometry = decodeRealtimeGeometry({
    vertices,
    faces: null,
    num_vertices: 3,
    num_faces: 1,
  });
  assert.equal(geometry.indices, null);
});

test('decodeRealtimeGeometry validates counts and index bounds', () => {
  const vertices = float32LEBytes([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  // Byte length disagrees with the declared vertex count.
  assert.throws(() =>
    decodeRealtimeGeometry({ vertices, faces: null, num_vertices: 4, num_faces: 1 }),
  );
  // A face index points past the vertex range.
  assert.throws(() =>
    decodeRealtimeGeometry({
      vertices,
      faces: uint32LEBytes([0, 1, 3]),
      num_vertices: 3,
      num_faces: 1,
    }),
  );
  assert.throws(() =>
    decodeRealtimeGeometry({ vertices, faces: null, num_vertices: 0, num_faces: 1 }),
  );
});

// --- Request-id ordering -----------------------------------------------------------

test('request tracker assigns unique monotonic ids and measures latency', () => {
  let clock = 100;
  const tracker = createRequestTracker(() => clock);
  const first = tracker.begin('semantic');
  clock = 130;
  const second = tracker.begin('semantic');
  assert.notEqual(first, second);
  clock = 150;
  assert.deepEqual(tracker.accept(first, 'semantic', 'semantic'), { latencyMs: 50 });
  assert.deepEqual(tracker.accept(second, 'semantic', 'semantic'), { latencyMs: 20 });
});

test('request tracker never lets an older frame replace a newer one', () => {
  const tracker = createRequestTracker(() => 0);
  const older = tracker.begin('semantic');
  const newer = tracker.begin('semantic');
  assert.ok(tracker.accept(newer, 'semantic', 'semantic'));
  assert.equal(tracker.accept(older, 'semantic', 'semantic'), null); // late frame
  assert.equal(tracker.accept(newer, 'semantic', 'semantic'), null); // duplicate
  assert.equal(tracker.accept('unknown', 'semantic', 'semantic'), null);
});

test('request tracker drops out-of-mode results', () => {
  const tracker = createRequestTracker(() => 0);
  const sentInBlend = tracker.begin('blend');
  // The user switched tabs before the result arrived.
  assert.equal(tracker.accept(sentInBlend, 'blend', 'advanced'), null);
  // The server answered with a different mode than the active one.
  const next = tracker.begin('blend');
  assert.equal(tracker.accept(next, 'semantic', 'blend'), null);
});

test('request tracker invalidate() drops everything in flight', () => {
  const tracker = createRequestTracker(() => 0);
  const inFlight = tracker.begin('semantic');
  tracker.invalidate(); // connection closed / recreated
  assert.equal(tracker.accept(inFlight, 'semantic', 'semantic'), null);
  const fresh = tracker.begin('semantic');
  assert.ok(tracker.accept(fresh, 'semantic', 'semantic')); // new requests still work
});

// --- Dead-man timer -------------------------------------------------------------

test('dead-man timer arms on touch, reschedules on activity, and fires once', () => {
  let clock = 1000;
  const scheduled: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  let expired = 0;
  const timer = createDeadmanTimer({
    timeoutMs: 8000,
    onExpire: () => {
      expired += 1;
    },
    now: () => clock,
    schedule: (fn, ms) => {
      const handle = { fn, ms, cancelled: false };
      scheduled.push(handle);
      return handle;
    },
    cancel: (handle) => {
      (handle as { cancelled: boolean }).cancelled = true;
    },
  });

  assert.equal(timer.deadlineAt, null);
  timer.touch();
  assert.equal(timer.deadlineAt, 9000);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 8000);

  clock = 4000;
  timer.touch(); // activity pushes the deadline out and cancels the old timer
  assert.equal(timer.deadlineAt, 12000);
  assert.equal(scheduled[0].cancelled, true);
  assert.equal(scheduled.length, 2);

  scheduled[1].fn(); // the deadline elapses untouched
  assert.equal(expired, 1);
  assert.equal(timer.deadlineAt, null);

  timer.touch();
  timer.stop(); // explicit close disarms without firing
  assert.equal(scheduled[2].cancelled, true);
  assert.equal(timer.deadlineAt, null);
  assert.equal(expired, 1);
});
