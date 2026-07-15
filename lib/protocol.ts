/**
 * Pure protocol helpers shared by the HTTP (`fal.run`) and realtime
 * (WebSocket `/realtime`) transports: endpoint joining, realtime request
 * building, little-endian wire decoding, request-id ordering, and the
 * client-side inactivity dead-man timer.
 *
 * Everything here is deliberately free of DOM, three.js, and @fal-ai/client
 * imports so it can be unit-tested with the Node test runner (`npm test`).
 */

import type { GnmInput, Mode } from './gnm';

// --- Endpoint joining --------------------------------------------------------

/**
 * Build the HTTP endpoint id for a given mode, joining sub-paths without ever
 * producing a doubled or trailing slash. The semantic mode is the base "/"
 * endpoint (no suffix); blend/advanced append their sub-path.
 */
export function endpointForMode(mode: Mode, base: string): string {
  const clean = base.trim().replace(/\/+$/, '');
  switch (mode) {
    case 'semantic':
      return clean;
    case 'blend':
      return `${clean}/blend`;
    case 'advanced':
      return `${clean}/advanced`;
  }
}

// --- Realtime request --------------------------------------------------------

/**
 * Fields that only exist on the HTTP endpoints. The realtime payload carries
 * the same mode fields but never these.
 */
const HTTP_ONLY_FIELDS = ['output_format', 'sync_mode'] as const;

export interface RealtimeRequest {
  payload: Record<string, unknown> & { mode: Mode };
  include_topology: boolean;
  request_id: string;
}

/**
 * Build one realtime wire request: the mode discriminator plus that mode's
 * input fields nested under `payload`, with the HTTP-only fields stripped.
 * The input object is not mutated.
 */
export function buildRealtimeRequest(
  mode: Mode,
  input: GnmInput,
  includeTopology: boolean,
  requestId: string,
): RealtimeRequest {
  const fields: Record<string, unknown> = { ...input };
  for (const field of HTTP_ONLY_FIELDS) delete fields[field];
  return {
    payload: { mode, ...fields },
    include_topology: includeTopology,
    request_id: requestId,
  };
}

// --- Realtime response shape ---------------------------------------------------

export interface RealtimeTimings {
  handler_total_ms?: number;
  payload_bytes?: number;
  [key: string]: number | undefined;
}

/** One msgpack-decoded frame from the server; bytes fields still raw. */
export interface RealtimeWireResult {
  request_id: string;
  mode: Mode;
  /** Contiguous little-endian float32, shape [num_vertices, 3]. */
  vertices: Uint8Array;
  /**
   * Contiguous little-endian uint32, shape [num_faces, 3]. Topology is static
   * per mesh, so the server sends it only when `include_topology` was set;
   * otherwise null.
   */
  faces: Uint8Array | null;
  num_vertices: number;
  num_faces: number;
  seed: number | null;
  timings?: RealtimeTimings;
}

// --- Little-endian byte decoding ----------------------------------------------

const HOST_IS_LITTLE_ENDIAN =
  new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Copy a view's bytes into a fresh, offset-0 buffer. This solves two problems
 * at once: typed-array constructors require element-size alignment (msgpack
 * hands out views at arbitrary byteOffsets into its decode buffer), and the
 * decoder may reuse that underlying buffer for later frames.
 */
function copyToAlignedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Decode contiguous little-endian float32 values, correct on any host endianness. */
export function decodeFloat32LE(bytes: Uint8Array, expectedCount: number): Float32Array {
  if (bytes.byteLength !== expectedCount * 4) {
    throw new Error(
      `Expected ${expectedCount * 4} bytes for ${expectedCount} float32 values, got ${bytes.byteLength}.`,
    );
  }
  const buffer = copyToAlignedBuffer(bytes);
  if (HOST_IS_LITTLE_ENDIAN) return new Float32Array(buffer);
  const view = new DataView(buffer);
  const out = new Float32Array(expectedCount);
  for (let i = 0; i < expectedCount; i += 1) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Decode contiguous little-endian uint32 values, correct on any host endianness. */
export function decodeUint32LE(bytes: Uint8Array, expectedCount: number): Uint32Array {
  if (bytes.byteLength !== expectedCount * 4) {
    throw new Error(
      `Expected ${expectedCount * 4} bytes for ${expectedCount} uint32 values, got ${bytes.byteLength}.`,
    );
  }
  const buffer = copyToAlignedBuffer(bytes);
  if (HOST_IS_LITTLE_ENDIAN) return new Uint32Array(buffer);
  const view = new DataView(buffer);
  const out = new Uint32Array(expectedCount);
  for (let i = 0; i < expectedCount; i += 1) out[i] = view.getUint32(i * 4, true);
  return out;
}

export interface RealtimeGeometry {
  /** Flat xyz positions, length num_vertices * 3. */
  positions: Float32Array;
  /** Flat triangle indices, length num_faces * 3; null when the frame carried no topology. */
  indices: Uint32Array | null;
}

/** Normalize whatever the msgpack layer produced for a binary field. */
function asBytes(value: unknown, field: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error(`Realtime field "${field}" is not binary data.`);
}

/**
 * Decode one frame's geometry, validating byte lengths against the declared
 * vertex/face counts and every face index against the vertex count.
 */
export function decodeRealtimeGeometry(
  result: Pick<RealtimeWireResult, 'vertices' | 'faces' | 'num_vertices' | 'num_faces'>,
): RealtimeGeometry {
  const { num_vertices: numVertices, num_faces: numFaces } = result;
  if (!Number.isInteger(numVertices) || numVertices <= 0) {
    throw new Error(`Invalid num_vertices in realtime frame: ${numVertices}.`);
  }
  if (!Number.isInteger(numFaces) || numFaces <= 0) {
    throw new Error(`Invalid num_faces in realtime frame: ${numFaces}.`);
  }
  const positions = decodeFloat32LE(asBytes(result.vertices, 'vertices'), numVertices * 3);
  let indices: Uint32Array | null = null;
  if (result.faces != null) {
    indices = decodeUint32LE(asBytes(result.faces, 'faces'), numFaces * 3);
    for (let i = 0; i < indices.length; i += 1) {
      if (indices[i] >= numVertices) {
        throw new Error(
          `Face index ${indices[i]} out of range for ${numVertices} vertices.`,
        );
      }
    }
  }
  return { positions, indices };
}

// --- Request-id ordering -------------------------------------------------------

export interface RequestTracker {
  /** Allocate the next monotonically-unique request id and record its send time. */
  begin(mode: Mode): string;
  /**
   * Resolve a result. Returns the round-trip latency, or null when the frame
   * must be dropped: unknown/duplicate id, superseded by an already-accepted
   * newer request, or sent/answered for a mode other than the active one.
   */
  accept(requestId: string, resultMode: Mode, activeMode: Mode): { latencyMs: number } | null;
  /** Invalidate everything in flight (connection closed or recreated). */
  invalidate(): void;
}

/** The server drops buffered frames, so some entries never resolve; keep the map bounded. */
const MAX_PENDING_REQUESTS = 64;

export function createRequestTracker(now: () => number = () => Date.now()): RequestTracker {
  let seq = 0;
  let lastAcceptedSeq = 0;
  const pending = new Map<string, { seq: number; sentAt: number; mode: Mode }>();
  return {
    begin(mode) {
      seq += 1;
      const id = `r${seq}`;
      pending.set(id, { seq, sentAt: now(), mode });
      while (pending.size > MAX_PENDING_REQUESTS) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      return id;
    },
    accept(requestId, resultMode, activeMode) {
      const entry = pending.get(requestId);
      if (!entry) return null;
      pending.delete(requestId);
      // An older frame must never replace an already-accepted newer one.
      if (entry.seq <= lastAcceptedSeq) return null;
      if (resultMode !== activeMode || entry.mode !== activeMode) return null;
      lastAcceptedSeq = entry.seq;
      return { latencyMs: Math.max(0, now() - entry.sentAt) };
    },
    invalidate() {
      pending.clear();
      lastAcceptedSeq = seq;
    },
  };
}

// --- Inactivity dead-man timer ---------------------------------------------------

export interface DeadmanTimer {
  /** (Re)arm the timer; call on any activity. */
  touch(): void;
  /** Disarm without firing. */
  stop(): void;
  /** Epoch-ms deadline while armed, null when idle. */
  readonly deadlineAt: number | null;
}

export interface DeadmanTimerOptions {
  timeoutMs: number;
  onExpire: () => void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/**
 * A resettable one-shot timer: `touch()` pushes the deadline out, `stop()`
 * disarms it, and `onExpire` fires once when the deadline elapses untouched.
 * The clock and scheduler are injectable for tests.
 */
export function createDeadmanTimer({
  timeoutMs,
  onExpire,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: DeadmanTimerOptions): DeadmanTimer {
  let handle: unknown = null;
  let deadline: number | null = null;
  const disarm = () => {
    if (handle != null) {
      cancel(handle);
      handle = null;
    }
    deadline = null;
  };
  return {
    touch() {
      disarm();
      deadline = now() + timeoutMs;
      handle = schedule(() => {
        handle = null;
        deadline = null;
        onExpire();
      }, timeoutMs);
    },
    stop: disarm,
    get deadlineAt() {
      return deadline;
    },
  };
}
