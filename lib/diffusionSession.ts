import { fal } from '@fal-ai/client';

import { base64ToBytes } from './mesh';
import { createDeadmanTimer, type DeadmanTimer } from './protocol';

/** The FLUX.2 [klein] realtime image-to-image endpoint (app id). */
export const DIFFUSION_ENDPOINT = 'fal-ai/flux-2/klein/realtime';

/**
 * Close the WebSocket after this long without activity. Mirrors
 * REALTIME_INACTIVITY_MS on the geometry session so both transports share the
 * same "streams while you interact, closes when you stop" behavior.
 */
export const DIFFUSION_INACTIVITY_MS = 8_000;

/** Client-side throttle for outgoing frames (the fal client buffers at most 2). */
export const DIFFUSION_THROTTLE_MS = 125;

export type DiffusionConnectionState = 'idle' | 'connecting' | 'open';

/**
 * One outgoing frame. `image_url` must be a base64 data URI — the endpoint
 * does not accept CDN URLs in realtime mode — ideally 704x704 JPEG at 50%
 * quality per the model's own guidance.
 */
export interface DiffusionRequest {
  image_url: string;
  prompt: string;
  image_size: 'square' | 'square_hd';
  num_inference_steps: number;
}

/** One msgpack-decoded result from the server; image bytes still raw. */
export interface DiffusionWireResult {
  seed?: number;
  images?: {
    content?: unknown;
    content_type?: string;
  }[];
}

/** One decoded diffusion frame, ready to display. */
export interface DiffusionFrame {
  /** Encoded image bytes (JPEG unless contentType says otherwise). */
  bytes: Uint8Array;
  contentType: string;
  seed: number | null;
  /** Approximate round-trip from the most recent send to this result. */
  latencyMs: number;
}

export interface DiffusionSessionOptions {
  onFrame: (frame: DiffusionFrame) => void;
  onError: (message: string) => void;
  onStateChange: (state: DiffusionConnectionState) => void;
  /** Minimal transport event log (connects, closes, errors). */
  onEvent?: (message: string) => void;
  endpoint?: string;
  inactivityTimeoutMs?: number;
  throttleIntervalMs?: number;
}

let connectionSerial = 0;

/**
 * Normalize whatever the msgpack layer produced for the image `content`
 * field: raw bytes on the binary protocol, or a base64 string if the server
 * ever falls back to JSON encoding.
 */
function decodeImageContent(content: unknown): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (typeof content === 'string' && content.length > 0) return base64ToBytes(content);
  throw new Error('Diffusion result image has no decodable content.');
}

/**
 * One realtime session against the FLUX.2 [klein] realtime endpoint.
 *
 * Same lifecycle as `RealtimeSession` (geometry): nothing touches the network
 * until the first `send()`; after any close the next `send()` reconnects
 * transparently; an inactivity dead-man closes the socket when the user stops
 * interacting. Unlike the geometry protocol there are no request ids on the
 * wire, so ordering relies on the WebSocket itself and latency is measured
 * from the most recent send (an approximation when frames pipeline).
 */
export class DiffusionSession {
  private readonly opts: DiffusionSessionOptions;
  private readonly deadman: DeadmanTimer;
  private connection: { send: (request: DiffusionRequest) => void; close: () => void } | null =
    null;
  private state: DiffusionConnectionState = 'idle';
  private lastSentAt: number | null = null;
  private disposed = false;

  constructor(opts: DiffusionSessionOptions) {
    this.opts = opts;
    this.deadman = createDeadmanTimer({
      timeoutMs: opts.inactivityTimeoutMs ?? DIFFUSION_INACTIVITY_MS,
      onExpire: () => this.close('inactive'),
    });
  }

  /** Send one frame, opening/reopening the connection if needed. */
  send(request: DiffusionRequest): void {
    if (this.disposed) return;
    const connection = this.ensureConnection();
    if (this.state === 'idle') {
      this.opts.onEvent?.('diffusion connecting');
      this.setState('connecting');
    }
    this.lastSentAt = performance.now();
    connection.send(request);
    this.touch();
  }

  /** Reset the inactivity dead-man (user control activity). No-op while closed. */
  touch(): void {
    if (this.disposed || this.state === 'idle') return;
    this.deadman.touch();
  }

  /** Close the WebSocket now. The next send() reopens it. */
  close(reason: string): void {
    if (this.state !== 'idle') this.opts.onEvent?.(`diffusion connection closed (${reason})`);
    // The fal client reports auth failures silently, so a session that idles
    // out without ever receiving a frame is the observable symptom of a bad
    // key — say so instead of closing quietly.
    if (reason === 'inactive' && this.state === 'connecting') {
      this.opts.onError(
        'Diffusion connection did not respond — check your fal key and try again.',
      );
    }
    this.deadman.stop();
    this.lastSentAt = null;
    this.connection?.close();
    // Always recreate the fal client connection on the next send (see
    // RealtimeSession: a close while authenticating can strand a token the
    // cached connection never expires).
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

  get connectionState(): DiffusionConnectionState {
    return this.state;
  }

  private setState(state: DiffusionConnectionState): void {
    this.state = state;
    this.opts.onStateChange(state);
  }

  private ensureConnection(): { send: (request: DiffusionRequest) => void; close: () => void } {
    if (this.connection) return this.connection;
    connectionSerial += 1;
    this.connection = fal.realtime.connect<DiffusionRequest, DiffusionWireResult>(
      this.opts.endpoint ?? DIFFUSION_ENDPOINT,
      {
        // A unique key per session so a stale cached connection (e.g. one
        // authorized with a previous API key) is never reused.
        connectionKey: `gnm-head-diffusion-${connectionSerial}`,
        throttleInterval: this.opts.throttleIntervalMs ?? DIFFUSION_THROTTLE_MS,
        maxBuffering: 2,
        clientOnly: true,
        onResult: (result) => this.handleResult(result),
        onError: (error) => this.handleTransportError(error.message),
      },
    );
    return this.connection;
  }

  /** Any transport failure — including a server-side close — lands here. */
  private handleTransportError(message: string): void {
    if (this.disposed) return;
    this.deadman.stop();
    this.lastSentAt = null;
    // Discard the connection entirely so the next send re-authenticates from
    // scratch (see RealtimeSession for the cached-token failure mode).
    this.connection?.close();
    this.connection = null;
    this.setState('idle');
    this.opts.onEvent?.(`diffusion connection lost: ${message}`);
    this.opts.onError(
      `Diffusion connection lost (${message}). It reopens on the next update.`,
    );
  }

  private handleResult(result: DiffusionWireResult): void {
    if (this.disposed) return;
    if (this.state !== 'open') {
      this.state = 'open';
      this.opts.onEvent?.('diffusion connection open');
      this.opts.onStateChange('open');
    }
    this.deadman.touch(); // results count as activity

    try {
      const image = result.images?.[0];
      if (!image) throw new Error('Diffusion result contained no images.');
      const bytes = decodeImageContent(image.content);
      const latencyMs =
        this.lastSentAt != null ? Math.max(0, performance.now() - this.lastSentAt) : 0;
      this.opts.onFrame({
        bytes,
        contentType: image.content_type || 'image/jpeg',
        seed: typeof result.seed === 'number' ? result.seed : null,
        latencyMs: Math.round(latencyMs),
      });
    } catch (err) {
      this.opts.onError(err instanceof Error ? err.message : String(err));
    }
  }
}
