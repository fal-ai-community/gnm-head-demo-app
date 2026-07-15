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
  type GnmResult,
  type Mode,
  type SemanticInput,
} from '@/lib/gnm';
import { decodeDataUri, downloadBytes } from '@/lib/mesh';
import { useDebouncedCallback } from '@/lib/useDebouncedCallback';

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

export default function Home() {
  const [apiKey, setApiKey] = useState('');
  const [remember, setRemember] = useState(false);
  const [mode, setMode] = useState<Mode>('semantic');

  const [semantic, setSemantic] = useState<SemanticInput>(defaultSemanticInput);
  const [blend, setBlend] = useState<BlendInput>(defaultBlendInput);
  const [advanced, setAdvanced] = useState<AdvancedInput>(defaultAdvancedInput);

  const [autoGenerate, setAutoGenerate] = useState(true);
  const [wireframe, setWireframe] = useState(false);

  const [status, setStatus] = useState<RequestStatus>('idle');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [result, setResult] = useState<GnmResult | null>(null);
  const [meshDataUri, setMeshDataUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);

  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

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

  const endpoint = useMemo(() => endpointFor(mode), [mode]);

  const runGenerate = useCallback(async () => {
    const key = apiKey.trim();
    if (!key) {
      setError('Enter your fal API key to generate.');
      setStatus('error');
      return;
    }

    // Snapshot the input for the currently active mode.
    const input =
      mode === 'semantic' ? semantic : mode === 'blend' ? blend : advanced;

    configureFal(key);

    // Cancel any in-flight request and mark this one current.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setStatus('running');
    setError(null);
    setLogLines([]);
    const started = performance.now();

    try {
      const data = await generate({
        mode,
        input,
        signal: controller.signal,
        onQueueUpdate: (update) => {
          if (requestId !== requestIdRef.current) return;
          if (update.logs?.length) {
            setLogLines(update.logs.map((l) => l.message));
          }
        },
      });

      // Ignore stale responses (a newer request superseded this one).
      if (requestId !== requestIdRef.current) return;

      const url = data.model_mesh?.url;
      if (!url) throw new Error('Response did not include model_mesh.url.');

      setResult(data);
      setMeshDataUri(url);
      setLatencyMs(Math.round(performance.now() - started));
      setStatus('done');
    } catch (err) {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      setError(errorMessage(err));
      setStatus('error');
    }
  }, [apiKey, mode, semantic, blend, advanced]);

  const debounced = useDebouncedCallback(runGenerate, 450);

  // Auto-generate on committed control changes (debounced) once a key is set.
  const handleCommit = useCallback(() => {
    if (!autoGenerate) return;
    if (!apiKey.trim()) return;
    debounced.call();
  }, [autoGenerate, apiKey, debounced]);

  const handleGenerateNow = useCallback(() => {
    debounced.cancel();
    void runGenerate();
  }, [debounced, runGenerate]);

  const handleDownload = useCallback(() => {
    if (!result?.model_mesh?.url) return;
    try {
      const { bytes, contentType } = decodeDataUri(result.model_mesh.url);
      const name = result.model_mesh.file_name || 'gnm_head.glb';
      downloadBytes(bytes, name, contentType);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [result]);

  const hasKey = apiKey.trim().length > 0;

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
          <Viewer meshDataUri={meshDataUri} wireframe={wireframe} />
          <div className="viewer-overlay">
            <label className="toggle">
              <input
                type="checkbox"
                checked={wireframe}
                onChange={(e) => setWireframe(e.target.checked)}
              />
              Wireframe
            </label>
          </div>
          {!meshDataUri && status !== 'running' && (
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
                onClick={() => setMode(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="control-scroll">
            {mode === 'semantic' && (
              <SemanticControls
                value={semantic}
                onChange={(patch) => setSemantic((s) => ({ ...s, ...patch }))}
                onCommit={handleCommit}
              />
            )}
            {mode === 'blend' && (
              <BlendControls
                value={blend}
                onChange={(patch) => setBlend((s) => ({ ...s, ...patch }))}
                onCommit={handleCommit}
              />
            )}
            {mode === 'advanced' && (
              <AdvancedControls
                value={advanced}
                onChange={(patch) => setAdvanced((s) => ({ ...s, ...patch }))}
                onCommit={handleCommit}
              />
            )}
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
              disabled={!hasKey || status === 'running'}
            >
              {status === 'running' ? 'Generating…' : 'Generate'}
            </button>
          </div>
        </aside>
      </div>

      <StatusBar
        endpoint={endpoint}
        status={status}
        latencyMs={latencyMs}
        result={result}
        error={error}
        onDownload={handleDownload}
        canDownload={Boolean(result?.model_mesh?.url)}
      />

      {logLines.length > 0 && (
        <details className="logs">
          <summary>Request logs ({logLines.length})</summary>
          <pre>{logLines.join('\n')}</pre>
        </details>
      )}

      <footer className="app-footer">
        <span>
          Model endpoint: <code>{MODEL_ENDPOINT}</code>
        </span>
        <span>
          Always requested with <code>sync_mode: true</code> and GLB output.
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
