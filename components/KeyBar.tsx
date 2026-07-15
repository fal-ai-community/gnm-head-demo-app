'use client';

import { useId } from 'react';

interface KeyBarProps {
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  remember: boolean;
  onRememberChange: (remember: boolean) => void;
}

export default function KeyBar({
  apiKey,
  onApiKeyChange,
  remember,
  onRememberChange,
}: KeyBarProps) {
  const keyId = useId();
  const hasKey = apiKey.trim().length > 0;

  return (
    <div className="keybar">
      <div className="keybar-row">
        <label htmlFor={keyId} className="keybar-label">
          fal API key
        </label>
        <input
          id={keyId}
          type="password"
          className="keybar-input"
          placeholder="Paste your fal key (kept in the browser only)"
          value={apiKey}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onApiKeyChange(e.target.value)}
        />
        <span className={`keybar-status ${hasKey ? 'ok' : ''}`}>
          {hasKey ? 'Key set' : 'No key'}
        </span>
      </div>
      <div className="keybar-row keybar-meta">
        <label className="keybar-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => onRememberChange(e.target.checked)}
          />
          Remember in this browser tab (sessionStorage)
        </label>
        <p className="keybar-warn" role="note">
          ⚠ Browser credentials are visible to anyone who can read this page&apos;s memory or
          network traffic. Use a{' '}
          <a href="https://docs.fal.ai/authentication/key-based" target="_blank" rel="noreferrer">
            scoped or temporary key
          </a>
          , not your primary secret.
        </p>
      </div>
    </div>
  );
}
