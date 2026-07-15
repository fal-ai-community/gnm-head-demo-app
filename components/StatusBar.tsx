'use client';

import type { GnmResult } from '@/lib/gnm';

export type RequestStatus = 'idle' | 'running' | 'done' | 'error';

interface StatusBarProps {
  endpoint: string;
  status: RequestStatus;
  latencyMs: number | null;
  result: GnmResult | null;
  error: string | null;
  onDownload: () => void;
  canDownload: boolean;
}

const STATUS_LABEL: Record<RequestStatus, string> = {
  idle: 'Idle',
  running: 'Generating…',
  done: 'Done',
  error: 'Error',
};

export default function StatusBar({
  endpoint,
  status,
  latencyMs,
  result,
  error,
  onDownload,
  canDownload,
}: StatusBarProps) {
  return (
    <div className="statusbar">
      <div className="status-grid">
        <Stat label="Endpoint" value={endpoint} mono />
        <Stat
          label="Status"
          value={STATUS_LABEL[status]}
          className={`status-${status}`}
        />
        <Stat label="Latency" value={latencyMs != null ? `${latencyMs} ms` : '—'} />
        <Stat
          label="Vertices"
          value={result ? result.num_vertices.toLocaleString() : '—'}
        />
        <Stat label="Faces" value={result ? result.num_faces.toLocaleString() : '—'} />
        <Stat
          label="Seed"
          value={result?.seed != null ? String(result.seed) : '—'}
          mono
        />
      </div>
      <div className="status-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onDownload}
          disabled={!canDownload}
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
