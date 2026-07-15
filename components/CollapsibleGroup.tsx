'use client';

import { useState, type ReactNode } from 'react';

interface CollapsibleGroupProps {
  title: string;
  defaultOpen?: boolean;
  onReset?: () => void;
  children: ReactNode;
}

export default function CollapsibleGroup({
  title,
  defaultOpen = true,
  onReset,
  children,
}: CollapsibleGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="group">
      <div className="group-head">
        <button
          type="button"
          className="group-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`chevron ${open ? 'open' : ''}`} aria-hidden>
            ▸
          </span>
          {title}
        </button>
        {onReset && (
          <button type="button" className="group-reset" onClick={onReset}>
            Reset
          </button>
        )}
      </div>
      {open && <div className="group-body">{children}</div>}
    </section>
  );
}
