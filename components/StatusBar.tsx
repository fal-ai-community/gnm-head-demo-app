'use client';

import type { RealtimeConnectionState } from '@/lib/realtimeSession';

export type RequestStatus = 'idle' | 'running' | 'done' | 'error';
export type Transport = 'fal.run' | 'realtime';

export interface ConnectionInfo {
  state: RealtimeConnectionState;
  closesInS: number | null;
}

interface StatusBarProps {
  endpoint: string;
  transport: Transport;
  /** Realtime session state + dead-man countdown; null on the fal.run transport. */
  connection: ConnectionInfo | null;
  status: RequestStatus;
  latencyMs: number | null;
  /** Server-reported handler time (realtime timings), when available. */
  handlerMs: number | null;
  vertices: number | null;
  faces: number | null;
  seed: number | null;
  error: string | null;
  onDownload: () => void;
  canDownload: boolean;
  downloadHint?: string;
}

const STATUS_LABEL: Record<RequestStatus, string> = {
  idle: 'Idle',
  running: 'Generating…',
  done: 'Done',
  error: 'Error',
};

function connectionLabel(connection: ConnectionInfo): string {
  switch (connection.state) {
    case 'idle':
      return 'Closed · opens on generate';
    case 'connecting':
      return 'Connecting…';
    case 'open':
      return connection.closesInS != null
        ? `Open · closes in ${connection.closesInS}s`
        : 'Open';
  }
}

function connectionClass(state: RealtimeConnectionState): string {
  if (state === 'open') return 'status-done';
  if (state === 'connecting') return 'status-running';
  return '';
}

export default function StatusBar({
  endpoint,
  transport,
  connection,
  status,
  latencyMs,
  handlerMs,
  vertices,
  faces,
  seed,
  error,
  onDownload,
  canDownload,
  downloadHint,
}: StatusBarProps) {
  return (
    <div className="statusbar">
      <div className="status-grid">
        <Stat label="Endpoint" value={endpoint} mono />
        <Stat
          label="Transport"
          value={transport === 'realtime' ? 'Realtime (WebSocket)' : 'fal.run'}
          className={transport === 'realtime' ? 'status-running' : ''}
        />
        {connection && (
          <Stat
            label="Session"
            value={connectionLabel(connection)}
            className={connectionClass(connection.state)}
          />
        )}
        <Stat
          label="Status"
          value={STATUS_LABEL[status]}
          className={`status-${status}`}
        />
        <Stat label="Latency" value={latencyMs != null ? `${latencyMs} ms` : '—'} />
        {transport === 'realtime' && (
          <Stat
            label="Server"
            value={handlerMs != null ? `${Math.round(handlerMs)} ms` : '—'}
          />
        )}
        <Stat
          label="Vertices"
          value={vertices != null ? vertices.toLocaleString() : '—'}
        />
        <Stat label="Faces" value={faces != null ? faces.toLocaleString() : '—'} />
        <Stat label="Seed" value={seed != null ? String(seed) : '—'} mono />
      </div>
      <div className="status-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onDownload}
          disabled={!canDownload}
          title={!canDownload && downloadHint ? downloadHint : undefined}
        >
          Download GLB
        </button>
      </div>
      {error && (
        <p className="status-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  mono = false,
  className = '',
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${mono ? 'mono' : ''} ${className}`} title={value}>
        {value}
      </span>
    </div>
  );
}
