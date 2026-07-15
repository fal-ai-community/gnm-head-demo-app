'use client';

import {
  ETHNICITIES,
  GENDERS,
  SAMPLER_EXPRESSIONS,
  type BlendInput,
} from '@/lib/gnm';
import CollapsibleGroup from './CollapsibleGroup';
import { Select, Slider } from './Field';
import { PoseControls, SeedControls } from './SharedControls';

interface BlendControlsProps {
  value: BlendInput;
  onChange: (patch: Partial<BlendInput>) => void;
  onCommit: () => void;
}

export default function BlendControls({ value, onChange, onCommit }: BlendControlsProps) {
  return (
    <div className="controls">
      <CollapsibleGroup title="Identity blend">
        <Select
          label="Gender"
          value={value.gender}
          options={GENDERS}
          onChange={(gender) => {
            onChange({ gender });
            onCommit();
          }}
        />
        <Select
          label="Ethnicity 1"
          value={value.ethnicity_1}
          options={ETHNICITIES}
          onChange={(ethnicity_1) => {
            onChange({ ethnicity_1 });
            onCommit();
          }}
        />
        <Select
          label="Ethnicity 2"
          value={value.ethnicity_2}
          options={ETHNICITIES}
          onChange={(ethnicity_2) => {
            onChange({ ethnicity_2 });
            onCommit();
          }}
        />
        <Slider
          label="Ethnicity mix (→ 2)"
          min={0}
          max={1}
          step={0.01}
          value={value.ethnicity_mix}
          onChange={(ethnicity_mix) => onChange({ ethnicity_mix })}
          onCommit={onCommit}
        />
      </CollapsibleGroup>

      <CollapsibleGroup title="Expression blend">
        <Select
          label="Expression 1"
          value={value.expression_1}
          options={SAMPLER_EXPRESSIONS}
          onChange={(expression_1) => {
            onChange({ expression_1 });
            onCommit();
          }}
        />
        <Select
          label="Expression 2"
          value={value.expression_2}
          options={SAMPLER_EXPRESSIONS}
          onChange={(expression_2) => {
            onChange({ expression_2 });
            onCommit();
          }}
        />
        <Slider
          label="Expression mix (→ 2)"
          min={0}
          max={1}
          step={0.01}
          value={value.expression_mix}
          onChange={(expression_mix) => onChange({ expression_mix })}
          onCommit={onCommit}
        />
        <SeedControls
          seed={value.seed}
          onChange={(seed) => onChange({ seed })}
          onCommit={onCommit}
        />
      </CollapsibleGroup>

      <CollapsibleGroup title="Head pose">
        <PoseControls value={value} onChange={onChange} onCommit={onCommit} />
      </CollapsibleGroup>
    </div>
  );
}
