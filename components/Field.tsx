'use client';

import { useId } from 'react';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
  onCommit?: () => void;
}

/** A labeled range slider with a live numeric readout. */
export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  unit = '',
  onChange,
  onCommit,
}: SliderProps) {
  const id = useId();
  return (
    <div className="field">
      <div className="field-head">
        <label htmlFor={id}>{label}</label>
        <span className="field-value" aria-hidden>
          {formatNumber(value)}
          {unit}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
    </div>
  );
}

interface SelectProps<T extends string> {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  format?: (value: T) => string;
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  format = humanize,
}: SelectProps<T>) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {format(opt)}
          </option>
        ))}
      </select>
    </div>
  );
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

export function humanize(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
