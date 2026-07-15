'use client';

import {
  ADVANCED_COEFF_GROUPS,
  ADVANCED_GAZE_FIELDS,
  ADVANCED_NECK_HEAD_FIELDS,
  ADVANCED_TRANSLATION_FIELDS,
  COEFF_LIMIT,
  TRANSLATION_LIMIT,
  defaultAdvancedInput,
  type AdvancedInput,
} from '@/lib/gnm';
import CollapsibleGroup from './CollapsibleGroup';
import { Slider } from './Field';

interface AdvancedControlsProps {
  value: AdvancedInput;
  onChange: (patch: Partial<AdvancedInput>) => void;
  onCommit: () => void;
}

export default function AdvancedControls({ value, onChange, onCommit }: AdvancedControlsProps) {
  const defaults = defaultAdvancedInput();

  const resetAll = () => {
    onChange(defaults);
    onCommit();
  };

  return (
    <div className="controls">
      <div className="controls-toolbar">
        <span className="controls-hint">Deterministic — no seed. All coefficients in [-3, 3].</span>
        <button type="button" className="btn btn-ghost" onClick={resetAll}>
          Reset all
        </button>
      </div>

      {ADVANCED_COEFF_GROUPS.map((group) => (
        <CollapsibleGroup
          key={group.key}
          title={group.label}
          defaultOpen={group.key === 'head_identity'}
          onReset={() => {
            onChange({ [group.key]: [...defaults[group.key]] } as Partial<AdvancedInput>);
            onCommit();
          }}
        >
          {value[group.key].map((coeff, i) => (
            <Slider
              key={`${group.key}-${i}`}
              label={group.itemLabel(i)}
              min={-COEFF_LIMIT}
              max={COEFF_LIMIT}
              step={0.01}
              value={coeff}
              onChange={(v) => {
                const next = [...value[group.key]];
                next[i] = v;
                onChange({ [group.key]: next } as Partial<AdvancedInput>);
              }}
              onCommit={onCommit}
            />
          ))}
        </CollapsibleGroup>
      ))}

      <CollapsibleGroup
        title="Neck & head rotation"
        onReset={() => {
          onChange({
            neck_rotation_x: 0,
            neck_rotation_y: 0,
            neck_rotation_z: 0,
            head_rotation_x: 0,
            head_rotation_y: 0,
            head_rotation_z: 0,
          });
          onCommit();
        }}
      >
        {ADVANCED_NECK_HEAD_FIELDS.map((f) => (
          <Slider
            key={f.key}
            label={f.label}
            unit={f.unit}
            min={f.min}
            max={f.max}
            step={1}
            value={value[f.key]}
            onChange={(v) => onChange({ [f.key]: v } as Partial<AdvancedInput>)}
            onCommit={onCommit}
          />
        ))}
      </CollapsibleGroup>

      <CollapsibleGroup
        title="Gaze"
        onReset={() => {
          onChange({ gaze_x: 0, gaze_y: 0, gaze_vergence: 0 });
          onCommit();
        }}
      >
        {ADVANCED_GAZE_FIELDS.map((f) => (
          <Slider
            key={f.key}
            label={f.label}
            unit={f.unit}
            min={f.min}
            max={f.max}
            step={1}
            value={value[f.key]}
            onChange={(v) => onChange({ [f.key]: v } as Partial<AdvancedInput>)}
            onCommit={onCommit}
          />
        ))}
      </CollapsibleGroup>

      <CollapsibleGroup
        title="Root translation"
        defaultOpen={false}
        onReset={() => {
          onChange({ translation_x: 0, translation_y: 0, translation_z: 0 });
          onCommit();
        }}
      >
        {ADVANCED_TRANSLATION_FIELDS.map((f) => (
          <Slider
            key={f.key}
            label={f.label}
            unit=" m"
            min={-TRANSLATION_LIMIT}
            max={TRANSLATION_LIMIT}
            step={0.005}
            value={value[f.key]}
            onChange={(v) => onChange({ [f.key]: v } as Partial<AdvancedInput>)}
            onCommit={onCommit}
          />
        ))}
      </CollapsibleGroup>
    </div>
  );
}
