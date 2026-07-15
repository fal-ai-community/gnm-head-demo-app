'use client';

import {
  ETHNICITIES,
  GENDERS,
  SEMANTIC_EXPRESSIONS,
  type SemanticInput,
} from '@/lib/gnm';
import CollapsibleGroup from './CollapsibleGroup';
import { Select } from './Field';
import { PoseControls, SeedControls } from './SharedControls';

interface SemanticControlsProps {
  value: SemanticInput;
  onChange: (patch: Partial<SemanticInput>) => void;
  onCommit: () => void;
}

export default function SemanticControls({ value, onChange, onCommit }: SemanticControlsProps) {
  return (
    <div className="controls">
      <CollapsibleGroup title="Identity & expression">
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
          label="Ethnicity"
          value={value.ethnicity}
          options={ETHNICITIES}
          onChange={(ethnicity) => {
            onChange({ ethnicity });
            onCommit();
          }}
        />
        <Select
          label="Expression"
          value={value.expression}
          options={SEMANTIC_EXPRESSIONS}
          onChange={(expression) => {
            onChange({ expression });
            onCommit();
          }}
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
