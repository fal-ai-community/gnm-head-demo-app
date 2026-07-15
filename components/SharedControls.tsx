'use client';

import { HEAD_POSE_LIMIT, SEED_MAX, SEED_MIN, randomSeed } from '@/lib/gnm';
import { Slider } from './Field';

interface PoseValue {
  head_yaw: number;
  head_pitch: number;
  head_roll: number;
}

interface PoseControlsProps<T extends PoseValue> {
  value: T;
  onChange: (patch: Partial<T>) => void;
  onCommit: () => void;
}

export function PoseControls<T extends PoseValue>({
  value,
  onChange,
  onCommit,
}: PoseControlsProps<T>) {
  return (
    <div className="control-block">
      <Slider
        label="Yaw"
        unit="°"
        min={-HEAD_POSE_LIMIT}
        max={HEAD_POSE_LIMIT}
        step={1}
        value={value.head_yaw}
        onChange={(v) => onChange({ head_yaw: v } as Partial<T>)}
        onCommit={onCommit}
      />
      <Slider
        label="Pitch"
        unit="°"
        min={-HEAD_POSE_LIMIT}
        max={HEAD_POSE_LIMIT}
        step={1}
        value={value.head_pitch}
        onChange={(v) => onChange({ head_pitch: v } as Partial<T>)}
        onCommit={onCommit}
      />
      <Slider
        label="Roll"
        unit="°"
        min={-HEAD_POSE_LIMIT}
        max={HEAD_POSE_LIMIT}
        step={1}
        value={value.head_roll}
        onChange={(v) => onChange({ head_roll: v } as Partial<T>)}
        onCommit={onCommit}
      />
    </div>
  );
}

interface SeedControlsProps {
  seed: number | null;
  onChange: (seed: number | null) => void;
  onCommit: () => void;
}

export function SeedControls({ seed, onChange, onCommit }: SeedControlsProps) {
  return (
    <div className="seed-row">
      <div className="field seed-field">
        <label htmlFor="seed-input">Seed</label>
        <input
          id="seed-input"
          type="number"
          min={SEED_MIN}
          max={SEED_MAX}
          placeholder="random"
          value={seed ?? ''}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') {
              onChange(null);
              return;
            }
            const n = Math.min(SEED_MAX, Math.max(SEED_MIN, Math.floor(Number(raw))));
            onChange(Number.isNaN(n) ? null : n);
          }}
          onBlur={onCommit}
        />
      </div>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          onChange(randomSeed());
          onCommit();
        }}
      >
        Randomize
      </button>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          onChange(null);
          onCommit();
        }}
      >
        Clear
      </button>
    </div>
  );
}
