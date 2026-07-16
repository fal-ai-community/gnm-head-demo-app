'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import AdvancedControls from '@/components/AdvancedControls';
import BlendControls from '@/components/BlendControls';
import KeyBar from '@/components/KeyBar';
import SemanticControls from '@/components/SemanticControls';
import StatusBar, { type RequestStatus } from '@/components/StatusBar';
import { MODEL_ENDPOINT, configureFal, endpointFor, generate } from '@/lib/fal';
import {
  defaultAdvancedInput,
  defaultBlendInput,
  defaultSemanticInput,
  type AdvancedInput,
  type BlendInput,
  type GnmInput,
  type GnmResult,
  type Mode,
  type SemanticInput,
} from '@/lib/gnm';
import { decodeDataUri, downloadBytes, type ViewerMesh } from '@/lib/mesh';
import {
  REALTIME_INACTIVITY_MS,
  RealtimeSession,
  type RealtimeConnectionState,
} from '@/lib/realtimeSession';
import { useDebouncedCallback } from '@/lib/useDebouncedCallback';
import { useThrottledCallback } from '@/lib/useThrottledCallback';

// The viewer touches WebGL/DOM, so it must never run during static prerender.
const Viewer = dynamic(() => import('@/components/Viewer'), {
  ssr: false,
  loading: () => <div className="viewer-canvas viewer-loading">Initializing viewer…</div>,
});

const SESSION_KEY = 'gnm-head-demo:fal-key';
const SESSION_REMEMBER = 'gnm-head-demo:remember';

const TABS: { id: Mode; label: string }[] = [
  { id: 'semantic', label: 'Semantic' },
  { id: 'blend', label: 'Blend' },
  { id: 'advanced', label: 'Advanced' },
];

/**
 * Auto-generate pacing per transport. fal.run pays a full HTTP round-trip per
 * request, so it waits for a pause in committed changes (trailing debounce on
 * slider release / discrete change). Realtime frames are cheap and should
 * track the drag itself, so every slider movement feeds a leading+trailing
 * throttle: steady ~100 ms sends while the thumb moves, plus one final
 * trailing send carrying the released value.
 */
const HTTP_DEBOUNCE_MS = 450;
const REALTIME_LIVE_INTERVAL_MS = 100;

const MAX_TRANSPORT_EVENTS = 20;

/** Telemetry from the most recent successful generation, on either transport. */
interface MeshStats {
  vertices: number;
  faces: number;
  seed: number | null;
  handlerMs: number | null;
}

export default function Home() {
  const [apiKey, setApiKey] = useState('');
  const [remember, setRemember] = useState(false);
  const [mode, setMode] = useState<Mode>('semantic');

  const [semantic, setSemantic] = useState<SemanticInput>(defaultSemanticInput);
  const [blend, setBlend] = useState<BlendInput>(defaultBlendInput);
  const [advanced, setAdvanced] = useState<AdvancedInput>(defaultAdvancedInput);

  const [autoGenerate, setAutoGenerate] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [realtime, setRealtime] = useState(false);

  const [status, setStatus] = useState<RequestStatus>('idle');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [stats, setStats] = useState<MeshStats | null>(null);
  const [viewerMesh, setViewerMesh] = useState<ViewerMesh | null>(null);
  const [glbResult, setGlbResult] = useState<GnmResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>('idle');
  const [deadlineAt, setDeadlineAt] = useState<number | null>(null);
  const [closesInS, setClosesInS] = useState<number | null>(null);

  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<RealtimeSession | null>(null);
  const modeRef = useRef<Mode>(mode);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Latest control values, updated synchronously by the appliers below.
  // React state alone lands only after the next render, so a same-tick
  // generate (the throttle's leading edge, fired inside the slider's input
  // event) would otherwise send the previous value on every movement.
  const semanticRef = useRef(semantic);
  const blendRef = useRef(blend);
  const advancedRef = useRef(advanced);

  const applySemantic = useCallback((patch: Partial<SemanticInput>) => {
    semanticRef.current = { ...semanticRef.current, ...patch };
    setSemantic(semanticRef.current);
  }, []);

  const applyBlend = useCallback((patch: Partial<BlendInput>) => {
    blendRef.current = { ...blendRef.current, ...patch };
    setBlend(blendRef.current);
  }, []);

  const applyAdvanced = useCallback((patch: Partial<AdvancedInput>) => {
    advancedRef.current = { ...advancedRef.current, ...patch };
    setAdvanced(advancedRef.current);
  }, []);

  // --- Restore a remembered key (opt-in, sessionStorage only) ---
  useEffect(() => {
    try {
      if (sessionStorage.getItem(SESSION_REMEMBER) === '1') {
        setRemember(true);
        const stored = sessionStorage.getItem(SESSION_KEY);
        if (stored) setApiKey(stored);
      }
    } catch {
      /* sessionStorage may be unavailable; ignore. */
    }
  }, []);

  const handleRememberChange = useCallback(
    (next: boolean) => {
      setRemember(next);
      try {
        if (next) {
          sessionStorage.setItem(SESSION_REMEMBER, '1');
          if (apiKey.trim()) sessionStorage.setItem(SESSION_KEY, apiKey);
        } else {
          sessionStorage.removeItem(SESSION_REMEMBER);
          sessionStorage.removeItem(SESSION_KEY);
        }
      } catch {
        /* ignore */
      }
    },
    [apiKey],
  );

  const handleApiKeyChange = useCallback(
    (next: string) => {
      setApiKey(next);
      if (remember) {
        try {
          sessionStorage.setItem(SESSION_KEY, next);
        } catch {
          /* ignore */
        }
      }
    },
    [remember],
  );

  // --- Realtime session management ---

  const pushEvent = useCallback((message: string) => {
    const time = new Date().toLocaleTimeString();
    setEvents((prev) => [...prev.slice(-(MAX_TRANSPORT_EVENTS - 1)), `${time}  ${message}`]);
  }, []);

  const teardownSession = useCallback(() => {
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setConnectionState('idle');
    setDeadlineAt(null);
  }, []);

  const ensureSession = useCallback((): RealtimeSession => {
    if (sessionRef.current) return sessionRef.current;
    const session = new RealtimeSession({
      endpoint: MODEL_ENDPOINT,
      getActiveMode: () => modeRef.current,
      onFrame: (frame) => {
        setViewerMesh({ kind: 'geometry', positions: frame.positions, indices: frame.indices });
        setStats({
          vertices: frame.numVertices,
          faces: frame.numFaces,
          seed: frame.seed,
          handlerMs: frame.handlerMs,
        });
        setLatencyMs(frame.latencyMs);
        setStatus('done');
        setError(null);
      },
      onError: (message) => {
        setError(message);
        setStatus('error');
      },
      onStateChange: (state, deadline) => {
        setConnectionState(state);
        setDeadlineAt(deadline);
        if (state === 'idle') {
          // A close mid-generate would otherwise leave the status spinning.
          setStatus((prev) => (prev === 'running' ? 'idle' : prev));
        }
      },
      onEvent: pushEvent,
    });
    sessionRef.current = session;
    return session;
  }, [pushEvent]);

  // The realtime session authenticated with the key configured when it
  // connected; close it immediately whenever the key changes or clears.
  useEffect(() => {
    teardownSession();
  }, [apiKey, teardownSession]);

  // Close the socket when the tab is hidden or unloading, and dispose on
  // unmount. It reopens on the next generate/control action.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') sessionRef.current?.close('page hidden');
    };
    const handleBeforeUnload = () => sessionRef.current?.close('page unload');
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, []);

  // Tick the dead-man countdown shown while the session is open.
  useEffect(() => {
    if (deadlineAt == null) {
      setClosesInS(null);
      return;
    }
    const update = () =>
      setClosesInS(Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [deadlineAt]);

  // --- Generation ---

  const runGenerate = useCallback(async () => {
    const key = apiKey.trim();
    if (!key) {
      setError('Enter your fal API key to generate.');
      setStatus('error');
      return;
    }

    // Snapshot the newest input for the currently active mode from the refs:
    // a same-tick call out of a slider event must see the value just applied.
    const activeMode = modeRef.current;
    const input: GnmInput =
      activeMode === 'semantic'
        ? semanticRef.current
        : activeMode === 'blend'
          ? blendRef.current
          : advancedRef.current;

    configureFal(key);

    if (realtime) {
      // A fal.run response from before the transport toggle must not clobber
      // newer realtime frames: kill any in-flight request and retire its id.
      abortRef.current?.abort();
      abortRef.current = null;
      requestIdRef.current += 1;
      // One realtime frame. The session handles (re)connecting, request-id
      // ordering, stale-frame suppression, topology caching, and the
      // inactivity dead-man.
      setStatus('running');
      setError(null);
      ensureSession().send(activeMode, input);
      return;
    }

    // Direct fal.run request. Abort any in-flight one and mark this one
    // current; the id guard also drops stale responses that abort misses.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setStatus('running');
    setError(null);
    const started = performance.now();

    try {
      const data = await generate({ mode: activeMode, input, signal: controller.signal });

      // Ignore stale responses (a newer request superseded this one).
      if (requestId !== requestIdRef.current) return;

      const url = data.model_mesh?.url;
      if (!url) throw new Error('Response did not include model_mesh.url.');

      setGlbResult(data);
      setViewerMesh({ kind: 'glb', dataUri: url });
      setStats({
        vertices: data.num_vertices,
        faces: data.num_faces,
        seed: data.seed ?? null,
        handlerMs: null,
      });
      setLatencyMs(Math.round(performance.now() - started));
      setStatus('done');
    } catch (err) {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      setError(errorMessage(err));
      setStatus('error');
    }
  }, [apiKey, realtime, ensureSession]);

  const httpDebounce = useDebouncedCallback(runGenerate, HTTP_DEBOUNCE_MS);
  const liveThrottle = useThrottledCallback(runGenerate, REALTIME_LIVE_INTERVAL_MS);

  // Realtime live path: every control change (each slider `input` event, not
  // just the release) feeds the throttle, so frames flow at a steady
  // ~REALTIME_LIVE_INTERVAL_MS cadence during a sustained drag and the
  // trailing edge sends the final value.
  const handleLiveChange = useCallback(() => {
    if (!realtime) return;
    sessionRef.current?.touch(); // control activity keeps the session alive
    if (!autoGenerate) return;
    if (!apiKey.trim()) return;
    liveThrottle.call();
  }, [realtime, autoGenerate, apiKey, liveThrottle]);

  // Committed changes (slider release, discrete control, seed blur). On
  // fal.run this is the only auto-generate trigger — a trailing debounce so
  // dragging costs one HTTP request per pause, not one per movement. On
  // realtime the live path above already generated for the change itself
  // (its trailing edge covers the released value), so a commit only counts
  // as session activity; generating here too would duplicate the send.
  const handleCommit = useCallback(() => {
    sessionRef.current?.touch();
    if (realtime) return;
    if (!autoGenerate) return;
    if (!apiKey.trim()) return;
    httpDebounce.call();
  }, [realtime, autoGenerate, apiKey, httpDebounce]);

  const handleGenerateNow = useCallback(() => {
    httpDebounce.cancel();
    liveThrottle.cancel();
    void runGenerate();
  }, [httpDebounce, liveThrottle, runGenerate]);

  const handleModeChange = useCallback(
    (next: Mode) => {
      setMode(next);
      // Synchronous so a same-tick generate below targets the new tab.
      modeRef.current = next;
      sessionRef.current?.touch();
      // On realtime the tab switch itself regenerates, so the viewer follows
      // the active tab's payload without an extra click.
      if (realtime && autoGenerate && apiKey.trim()) liveThrottle.call();
    },
    [realtime, autoGenerate, apiKey, liveThrottle],
  );

  const handleRealtimeChange = useCallback(
    (next: boolean) => {
      // Drop anything scheduled under the old transport so it cannot fire
      // as a late send on the new one.
      httpDebounce.cancel();
      liveThrottle.cancel();
      setRealtime(next);
      if (!next) teardownSession();
    },
    [httpDebounce, liveThrottle, teardownSession],
  );

  const handleSemanticChange = useCallback(
    (patch: Partial<SemanticInput>) => {
      applySemantic(patch);
      handleLiveChange();
    },
    [applySemantic, handleLiveChange],
  );

  const handleBlendChange = useCallback(
    (patch: Partial<BlendInput>) => {
      applyBlend(patch);
      handleLiveChange();
    },
    [applyBlend, handleLiveChange],
  );

  const handleAdvancedChange = useCallback(
    (patch: Partial<AdvancedInput>) => {
      applyAdvanced(patch);
      handleLiveChange();
    },
    [applyAdvanced, handleLiveChange],
  );

  const handleDownload = useCallback(() => {
    if (!glbResult?.model_mesh?.url) return;
    try {
      const { bytes, contentType } = decodeDataUri(glbResult.model_mesh.url);
      const name = glbResult.model_mesh.file_name || 'gnm_head.glb';
      downloadBytes(bytes, name, contentType);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [glbResult]);

  const endpoint = useMemo(
    () => (realtime ? `${MODEL_ENDPOINT}/realtime` : endpointFor(mode)),
    [mode, realtime],
  );

  const hasKey = apiKey.trim().length > 0;
  // Realtime frames are raw geometry — only a fal.run result yields a GLB.
  const canDownload = viewerMesh?.kind === 'glb' && Boolean(glbResult?.model_mesh?.url);

  return (
    <main className="app">
      <header className="app-header">
        <div className="brand">
          <h1>GNM Head Studio</h1>
          <p className="tagline">
            Google&apos;s parametric 3D head model, driven live through the fal API.
          </p>
        </div>
        <KeyBar
          apiKey={apiKey}
          onApiKeyChange={handleApiKeyChange}
          remember={remember}
          onRememberChange={handleRememberChange}
        />
      </header>

      <div className="layout">
        <section className="viewer-pane">
          <Viewer mesh={viewerMesh} wireframe={wireframe} />
          <div className="viewer-overlay">
            <label className="toggle">
              <input
                type="checkbox"
                checked={wireframe}
                onChange={(e) => setWireframe(e.target.checked)}
              />
              Wireframe
            </label>
            {realtime && connectionState === 'open' && closesInS != null && (
              <span className="viewer-badge">Realtime · closes in {closesInS}s</span>
            )}
          </div>
          {!viewerMesh && status !== 'running' && (
            <div className="viewer-empty">
              <p>No mesh yet — set your key and generate a head.</p>
            </div>
          )}
        </section>

        <aside className="control-pane">
          <div className="tabs" role="tablist" aria-label="Generation mode">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={mode === tab.id}
                className={`tab ${mode === tab.id ? 'active' : ''}`}
                onClick={() => handleModeChange(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="control-scroll">
            {mode === 'semantic' && (
              <SemanticControls
                value={semantic}
                onChange={handleSemanticChange}
                onCommit={handleCommit}
              />
            )}
            {mode === 'blend' && (
              <BlendControls
                value={blend}
                onChange={handleBlendChange}
                onCommit={handleCommit}
              />
            )}
            {mode === 'advanced' && (
              <AdvancedControls
                value={advanced}
                onChange={handleAdvancedChange}
                onCommit={handleCommit}
              />
            )}
          </div>

          <div className={`transport-bar ${realtime ? 'realtime-on' : ''}`}>
            <label className="toggle toggle-realtime">
              <input
                type="checkbox"
                checked={realtime}
                onChange={(e) => handleRealtimeChange(e.target.checked)}
              />
              <span>
                <strong>Realtime</strong> (WebSocket)
              </span>
            </label>
            <p className="transport-hint">
              {realtime
                ? `The socket opens on your next generate, is billed as a session while open, and auto-closes after ${
                    REALTIME_INACTIVITY_MS / 1000
                  }s without activity (the server enforces its own 10s cutoff).`
                : 'Each generate is one direct fal.run HTTP request.'}
            </p>
          </div>

          <div className="action-bar">
            <label className="toggle">
              <input
                type="checkbox"
                checked={autoGenerate}
                onChange={(e) => setAutoGenerate(e.target.checked)}
              />
              Auto-generate on change
            </label>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleGenerateNow}
              disabled={!hasKey || (!realtime && status === 'running')}
            >
              {!realtime && status === 'running' ? 'Generating…' : 'Generate'}
            </button>
          </div>
        </aside>
      </div>

      <StatusBar
        endpoint={endpoint}
        transport={realtime ? 'realtime' : 'fal.run'}
        connection={realtime ? { state: connectionState, closesInS } : null}
        status={status}
        latencyMs={latencyMs}
        handlerMs={stats?.handlerMs ?? null}
        vertices={stats?.vertices ?? null}
        faces={stats?.faces ?? null}
        seed={stats?.seed ?? null}
        error={error}
        onDownload={handleDownload}
        canDownload={canDownload}
        downloadHint={
          viewerMesh?.kind === 'geometry'
            ? 'Realtime frames are raw geometry — turn Realtime off and generate to get a GLB.'
            : undefined
        }
      />

      {events.length > 0 && (
        <details className="logs">
          <summary>Transport events ({events.length})</summary>
          <pre>{events.join('\n')}</pre>
        </details>
      )}

      <footer className="app-footer">
        <span>
          Model endpoint: <code>{MODEL_ENDPOINT}</code>
        </span>
        <span>
          fal.run requests use <code>sync_mode: true</code> + GLB; realtime streams raw
          vertex buffers over WebSocket.
        </span>
      </footer>
    </main>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return 'Unknown error.';
  }
}
