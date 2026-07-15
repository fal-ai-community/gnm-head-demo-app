import { fal } from '@fal-ai/client';

import type { GnmInput, Mode } from './gnm';
import {
  buildRealtimeRequest,
  createDeadmanTimer,
  createRequestTracker,
  decodeRealtimeGeometry,
  type DeadmanTimer,
  type RealtimeRequest,
  type RealtimeWireResult,
  type RequestTracker,
} from './protocol';

/**
 * Close the WebSocket after this long without activity (sends, results, or
 * user control activity). Kept below the server's own 10 s dead-man timeout
 * so under normal operation the client closes first and never depends on the
 * server-side cutoff.
 */
export const REALTIME_INACTIVITY_MS = 8_000;

/** Client-side throttle for outgoing frames (the server buffers at most 2). */
export const REALTIME_THROTTLE_MS = 125;

export type RealtimeConnectionState = 'idle' | 'connecting' | 'open';

/** One decoded, validated, topology-resolved realtime frame, ready to render. */
export interface RealtimeFrame {
  /** Flat xyz positions, length numVertices * 3. */
  positions: Float32Array;
  /** Flat triangle indices, length numFaces * 3 (from this frame or the session cache). */
  indices: Uint32Array;
  numVertices: number;
  numFaces: number;
  seed: number | null;
  /** Server-reported handler time when present in timings. */
  handlerMs: number | null;
  /** Client round-trip from send to result. */
  latencyMs: number;
  mode: Mode;
}

export interface RealtimeSessionOptions {
  endpoint: string;
  onFrame: (frame: RealtimeFrame) => void;
  onError: (message: string) => void;
  onStateChange: (state: RealtimeConnectionState, deadlineAt: number | null) => void;
  /** Minimal transport event log (connects, closes, errors). */
  onEvent?: (message: string) => void;
  /** The mode whose controls are on screen; results for other modes are dropped. */
  getActiveMode: () => Mode;
  inactivityTimeoutMs?: number;
  throttleIntervalMs?: number;
}

let connectionSerial = 0;

/**
 * One realtime session against the registry `/realtime` endpoint.
 *
 * Lifecycle: nothing touches the network until the first `send()` — the fal
 * client then authenticates and opens the WebSocket. After any close (this
 * inactivity dead-man, the server's 10 s dead-man, a network error, or an
 * explicit `close()`), the next `send()` reconnects transparently; there is
 * no reconnect loop and no heartbeat. Topology (`faces`) is static per mesh,
 * so it is requested until actually received, cached for the connection, and
 * re-requested from scratch whenever the connection closes for any reason.
 */
export class RealtimeSession {
  private readonly opts: RealtimeSessionOptions;
  private readonly tracker: RequestTracker;
  private readonly deadman: DeadmanTimer;
  private connection: { send: (request: RealtimeRequest) => void; close: () => void } | null =
    null;
  private state: RealtimeConnectionState = 'idle';
  private topology: Uint32Array | null = null;
  private topologyFaceCount = 0;
  private topologyVertexCount = 0;
  private disposed = false;

  constructor(opts: RealtimeSessionOptions) {
    this.opts = opts;
    this.tracker = createRequestTracker(() => performance.now());
    this.deadman = createDeadmanTimer({
      timeoutMs: opts.inactivityTimeoutMs ?? REALTIME_INACTIVITY_MS,
      onExpire: () => this.close('inactive'),
    });
  }

  /** Send the active mode's input as one frame, opening/reopening the connection if needed. */
  send(mode: Mode, input: GnmInput): void {
    if (this.disposed) return;
    const connection = this.ensureConnection();
    const request = buildRealtimeRequest(
      mode,
      input,
      this.topology === null,
      this.tracker.begin(mode),
    );
    if (this.state === 'idle') {
      this.opts.onEvent?.('connecting');
      this.setState('connecting');
    }
    connection.send(request);
    this.touch();
  }

  /** Reset the inactivity dead-man (user control activity). No-op while closed. */
  touch(): void {
    if (this.disposed || this.state === 'idle') return;
    this.deadman.touch();
    this.emitState();
  }

  /** Close the WebSocket now. The next send() reopens it. */
  close(reason: string): void {
    if (this.state !== 'idle') this.opts.onEvent?.(`connection closed (${reason})`);
    // The fal client reports auth failures silently, so a session that idles
    // out without ever receiving a frame is the observable symptom of a bad
    // key (or an unreachable endpoint) — say so instead of closing quietly.
    if (reason === 'inactive' && this.state === 'connecting') {
      this.opts.onError(
        'Realtime connection did not respond — check your fal key and try again.',
      );
    }
    this.resetSessionState();
    this.connection?.close();
    // Always recreate the fal client connection on the next send. In
    // particular, closing while authentication is still in progress can leave
    // that SDK state machine holding a token it never gets a chance to expire.
    this.connection = null;
    this.setState('idle');
  }

  /** Close permanently; the instance cannot be reused. */
  dispose(): void {
    if (this.disposed) return;
    this.close('disposed');
    this.disposed = true;
    this.connection = null;
  }

  get connectionState(): RealtimeConnectionState {
    return this.state;
  }

  private resetSessionState(): void {
    this.deadman.stop();
    this.tracker.invalidate();
    this.topology = null;
    this.topologyFaceCount = 0;
    this.topologyVertexCount = 0;
  }

  private setState(state: RealtimeConnectionState): void {
    this.state = state;
    this.emitState();
  }

  private emitState(): void {
    this.opts.onStateChange(this.state, this.deadman.deadlineAt);
  }

  private ensureConnection(): { send: (request: RealtimeRequest) => void; close: () => void } {
    if (this.connection) return this.connection;
    connectionSerial += 1;
    this.connection = fal.realtime.connect<RealtimeRequest, RealtimeWireResult>(
      this.opts.endpoint,
      {
        // A unique key per session so a stale cached connection (e.g. one
        // authorized with a previous API key) is never reused.
        connectionKey: `gnm-head-realtime-${connectionSerial}`,
        path: '/realtime',
        throttleInterval: this.opts.throttleIntervalMs ?? REALTIME_THROTTLE_MS,
        maxBuffering: 2,
        clientOnly: true,
        onResult: (result) => this.handleResult(result),
        onError: (error) => this.handleTransportError(error.message),
      },
    );
    return this.connection;
  }

  /** Any transport failure — including the server's 10 s dead-man close — lands here. */
  private handleTransportError(message: string): void {
    if (this.disposed) return;
    // Drop all per-connection state; the next send() reconnects and
    // re-requests topology.
    this.resetSessionState();
    // App-level error frames arrive with the socket still open — close it so
    // no socket outlives the inactivity dead-man. Discard the connection too:
    // the fal client only expires its cached auth token when a fully-open
    // connection closes, so after a close-while-connecting the machine can
    // hold an expired token that would make every reconnect fail; a fresh
    // connection re-authenticates from scratch.
    this.connection?.close();
    this.connection = null;
    this.setState('idle');
    this.opts.onEvent?.(`connection lost: ${message}`);
    this.opts.onError(
      `Realtime connection lost (${message}). It reopens on the next update.`,
    );
  }

  private handleResult(result: RealtimeWireResult & { request_id: string }): void {
    if (this.disposed) return;
    if (this.state !== 'open') {
      this.state = 'open';
      this.opts.onEvent?.('connection open');
    }
    this.deadman.touch(); // results count as activity
    this.emitState();

    const accepted = this.tracker.accept(
      result.request_id,
      result.mode,
      this.opts.getActiveMode(),
    );
    if (!accepted) return; // stale, superseded, or out-of-mode frame

    try {
      const geometry = decodeRealtimeGeometry(result);
      if (geometry.indices) {
        this.topology = geometry.indices;
        this.topologyFaceCount = result.num_faces;
        this.topologyVertexCount = result.num_vertices;
      } else if (
        this.topology &&
        (this.topologyFaceCount !== result.num_faces ||
          this.topologyVertexCount !== result.num_vertices)
      ) {
        // The cached indices were validated against the counts they arrived
        // with; either count changing makes them unusable (indices could point
        // past the new vertex range), so drop them and re-request.
        this.topology = null;
        this.topologyFaceCount = 0;
        this.topologyVertexCount = 0;
        throw new Error('Mesh size changed mid-session; topology is being re-requested.');
      }
      const indices = geometry.indices ?? this.topology;
      if (!indices) {
        throw new Error('Realtime frame arrived without topology; it will be re-requested.');
      }
      this.opts.onFrame({
        positions: geometry.positions,
        indices,
        numVertices: result.num_vertices,
        numFaces: result.num_faces,
        seed: result.seed ?? null,
        handlerMs:
          typeof result.timings?.handler_total_ms === 'number'
            ? result.timings.handler_total_ms
            : null,
        latencyMs: Math.round(accepted.latencyMs),
        mode: result.mode,
      });
    } catch (err) {
      this.opts.onError(err instanceof Error ? err.message : String(err));
    }
  }
}
