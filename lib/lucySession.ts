import { fal } from '@fal-ai/client';

/** The Decart Lucy 2.5 realtime video-to-video endpoint (app id). */
export const LUCY_ENDPOINT = 'decart/lucy-2-5/realtime';

export type LucyConnectionState = 'idle' | 'connecting' | 'open';

/** ICE server entry as delivered over the signaling channel. */
interface WireIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * One signaling message from the server. Field names follow the published
 * Lucy realtime schema (the decart/lucy2-vton/realtime docs): the ICE server
 * list has been observed under three different casings, so all are accepted.
 */
interface LucyWireMessage {
  type?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  iceservers?: WireIceServer[];
  iceServers?: WireIceServer[];
  ice_servers?: WireIceServer[];
  turn_config?: { server_url: string; username: string; credential: string };
  success?: boolean;
  error?: string;
}

type LucyOutboundMessage = Record<string, unknown>;

export interface LucySessionOptions {
  /** The live video feed to transform (the rendered head, canvas-captured). */
  getInputStream: () => MediaStream | null;
  /** Receives the transformed remote video stream once WebRTC connects. */
  onRemoteStream: (stream: MediaStream) => void;
  onError: (message: string) => void;
  onStateChange: (state: LucyConnectionState) => void;
  /** Minimal transport event log (connects, closes, errors). */
  onEvent?: (message: string) => void;
  endpoint?: string;
}

let connectionSerial = 0;

/**
 * One Lucy 2.5 realtime session.
 *
 * Unlike `DiffusionSession` (FLUX klein), the fal realtime WebSocket here is
 * only a signaling channel: the client sends the prompt and an SDP offer, and
 * the video itself flows over a WebRTC peer connection — the input track goes
 * up, the transformed track comes back. The session is billed per second
 * while connected, so it is one-shot and explicitly owned: `start()` once,
 * `setPrompt()` to steer it mid-session, `dispose()` to end it. The owner
 * recreates a session to reconnect — renegotiating WebRTC from a half-dead
 * state is less reliable than starting fresh.
 */
export class LucySession {
  private readonly opts: LucySessionOptions;
  private connection: {
    send: (message: LucyOutboundMessage) => void;
    close: () => void;
  } | null = null;
  private pc: RTCPeerConnection | null = null;
  private state: LucyConnectionState = 'idle';
  private started = false;
  private disposed = false;

  constructor(opts: LucySessionOptions) {
    this.opts = opts;
  }

  /** Open the signaling channel and send the initial prompt. One-shot. */
  start(prompt: string): void {
    if (this.disposed || this.started) return;
    this.started = true;
    connectionSerial += 1;
    this.setState('connecting');
    this.opts.onEvent?.('lucy connecting');
    this.connection = fal.realtime.connect<LucyOutboundMessage, LucyWireMessage>(
      this.opts.endpoint ?? LUCY_ENDPOINT,
      {
        // A unique key per session so a stale cached connection (e.g. one
        // authorized with a previous API key) is never reused.
        connectionKey: `gnm-head-lucy-${connectionSerial}`,
        // Signaling must not be throttled: every ICE candidate and SDP
        // message is individually load-bearing.
        throttleInterval: 0,
        clientOnly: true,
        onResult: (message) => void this.handleMessage(message),
        onError: (error) => this.fail(`Lucy connection error: ${error.message}`),
      },
    );
    this.connection.send({ prompt });
  }

  /** Steer the running session with a new prompt. */
  setPrompt(prompt: string): void {
    if (this.disposed || !this.connection) return;
    this.connection.send({ prompt });
  }

  get connectionState(): LucyConnectionState {
    return this.state;
  }

  /** End the session permanently: closes the peer connection and signaling. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.state !== 'idle') this.opts.onEvent?.('lucy session closed');
    this.pc?.close();
    this.pc = null;
    this.connection?.close();
    this.connection = null;
    this.state = 'idle';
    this.opts.onStateChange('idle');
  }

  private setState(state: LucyConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange(state);
  }

  /** Any unrecoverable failure: surface it and end the session. */
  private fail(message: string): void {
    if (this.disposed) return;
    this.opts.onEvent?.(`lucy session lost: ${message}`);
    this.opts.onError(message);
    this.dispose();
  }

  private async handleMessage(message: LucyWireMessage): Promise<void> {
    if (this.disposed) return;
    try {
      switch (message.type) {
        case 'iceservers':
        case 'iceServers':
          await this.setupPeer(message);
          break;
        case 'answer':
          if (!this.pc || !message.sdp) return;
          await this.pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
          break;
        case 'icecandidate':
          if (!this.pc || !message.candidate) return;
          await this.pc.addIceCandidate(new RTCIceCandidate(message.candidate));
          break;
        case 'ice-restart': {
          const pc = this.pc;
          const turn = message.turn_config;
          if (!pc || !turn) return;
          pc.setConfiguration({
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              {
                urls: turn.server_url,
                username: turn.username,
                credential: turn.credential,
              },
            ],
          });
          const offer = await pc.createOffer({ iceRestart: true });
          if (this.disposed || this.pc !== pc) return;
          await pc.setLocalDescription(offer);
          if (this.disposed || this.pc !== pc) return;
          this.connection?.send({ type: 'offer', sdp: offer.sdp });
          break;
        }
        case 'prompt_ack':
          if (message.success === false) {
            this.opts.onError(
              `Lucy rejected the prompt: ${message.error ?? 'unknown error'}`,
            );
          }
          break;
        case 'set_image_ack':
          if (message.success === false) {
            this.opts.onError(
              `Lucy rejected the reference image: ${message.error ?? 'unknown error'}`,
            );
          }
          break;
        case 'generation_started':
          this.opts.onEvent?.('lucy generating frames');
          break;
        case 'error':
          this.fail(`Lucy server error: ${message.error ?? 'unknown error'}`);
          break;
        default:
          // Unknown message types are ignored (forward-compatible).
          break;
      }
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private async setupPeer(message: LucyWireMessage): Promise<void> {
    if (this.pc) return; // duplicate iceservers message
    const stream = this.opts.getInputStream();
    if (!stream) {
      this.fail('Lucy session has no input video stream to transform.');
      return;
    }
    const entries = message.iceservers ?? message.iceServers ?? message.ice_servers ?? [];
    const iceServers: RTCIceServer[] = entries.map((server) => ({
      urls: server.urls,
      username: server.username,
      credential: server.credential,
    }));
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    for (const track of stream.getTracks()) pc.addTrack(track, stream);

    pc.ontrack = (event) => {
      if (this.disposed || this.pc !== pc) return;
      const remote = event.streams[0];
      if (!remote) return;
      if (this.state !== 'open') {
        this.setState('open');
        this.opts.onEvent?.('lucy stream open');
      }
      this.opts.onRemoteStream(remote);
    };
    pc.onicecandidate = (event) => {
      if (this.disposed || this.pc !== pc || !event.candidate) return;
      this.connection?.send({
        type: 'icecandidate',
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        },
      });
    };

    const offer = await pc.createOffer();
    if (this.disposed || this.pc !== pc) return;
    await pc.setLocalDescription(offer);
    if (this.disposed || this.pc !== pc) return;
    this.connection?.send({ type: 'offer', sdp: offer.sdp });
  }
}
