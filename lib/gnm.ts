/**
 * GNM Head API constants and input shapes.
 *
 * Field names, enum values, and numeric bounds here mirror the fal registry app
 * (`registry/three_d/gnm_head.py`) exactly. Keep them in sync with that schema.
 *
 * The realtime WebSocket transport reuses these same shapes, minus the
 * HTTP-only `output_format` / `sync_mode` fields, which `lib/protocol.ts`
 * strips when building the wire request.
 */

export type Mode = 'semantic' | 'blend' | 'advanced';

export const GENDERS = ['female', 'male'] as const;
export type Gender = (typeof GENDERS)[number];

export const ETHNICITIES = ['middle_eastern', 'asian', 'white', 'black'] as const;
export type Ethnicity = (typeof ETHNICITIES)[number];

/** The 20 sampler expressions, in the registry's enum order. */
export const SAMPLER_EXPRESSIONS = [
  'surprise',
  'disgust',
  'suck',
  'compress_face',
  'stretch_face',
  'happy',
  'squint',
  'platysma',
  'blow',
  'funneler',
  'smile_wide',
  'corners_down',
  'pucker',
  'wink_left',
  'wink_right',
  'mouth_left',
  'mouth_right',
  'lips_roll_in',
  'snarl',
  'tongue_center',
] as const;
export type SamplerExpression = (typeof SAMPLER_EXPRESSIONS)[number];

/** The basic endpoint additionally accepts "neutral" (zero expression). */
export const SEMANTIC_EXPRESSIONS = ['neutral', ...SAMPLER_EXPRESSIONS] as const;
export type SemanticExpression = (typeof SEMANTIC_EXPRESSIONS)[number];

/** Seeds are uint32 in the registry (0 .. 2^32 - 1). */
export const SEED_MIN = 0;
export const SEED_MAX = 2 ** 32 - 1;

/** Head yaw/pitch/roll bounds shared by the semantic and blend endpoints. */
export const HEAD_POSE_LIMIT = 90;

export function randomSeed(): number {
  // uint32, inclusive of SEED_MAX.
  return Math.floor(Math.random() * (SEED_MAX + 1));
}

// --- Input payloads (exact registry field names) ----------------------------

export interface SemanticInput {
  gender: Gender;
  ethnicity: Ethnicity;
  expression: SemanticExpression;
  head_yaw: number;
  head_pitch: number;
  head_roll: number;
  output_format: 'glb';
  seed: number | null;
  sync_mode: true;
}

export interface BlendInput {
  gender: Gender;
  ethnicity_1: Ethnicity;
  ethnicity_2: Ethnicity;
  ethnicity_mix: number;
  expression_1: SamplerExpression;
  expression_2: SamplerExpression;
  expression_mix: number;
  head_yaw: number;
  head_pitch: number;
  head_roll: number;
  output_format: 'glb';
  seed: number | null;
  sync_mode: true;
}

export interface AdvancedInput {
  head_identity: number[]; // len 10, each [-3, 3]
  left_eye_expression: number[]; // len 3
  right_eye_expression: number[]; // len 3
  lower_face_expression: number[]; // len 7
  tongue_expression: number[]; // len 4
  pupils_expression: number[]; // len 1
  neck_rotation_x: number;
  neck_rotation_y: number;
  neck_rotation_z: number;
  head_rotation_x: number;
  head_rotation_y: number;
  head_rotation_z: number;
  gaze_x: number;
  gaze_y: number;
  gaze_vergence: number;
  translation_x: number;
  translation_y: number;
  translation_z: number;
  output_format: 'glb';
  sync_mode: true;
}

/** Any of the three modes' inputs. */
export type GnmInput = SemanticInput | BlendInput | AdvancedInput;

// --- Result shape ------------------------------------------------------------

export interface GnmFile {
  url: string;
  content_type?: string;
  file_name?: string;
  file_size?: number;
}

export interface GnmResult {
  model_mesh: GnmFile;
  num_vertices: number;
  num_faces: number;
  seed?: number; // present on semantic + blend, absent on advanced
}

// --- Defaults ----------------------------------------------------------------

export function defaultSemanticInput(): SemanticInput {
  return {
    gender: 'female',
    ethnicity: 'white',
    expression: 'neutral',
    head_yaw: 0,
    head_pitch: 0,
    head_roll: 0,
    output_format: 'glb',
    seed: null,
    sync_mode: true,
  };
}

export function defaultBlendInput(): BlendInput {
  return {
    gender: 'female',
    ethnicity_1: 'white',
    ethnicity_2: 'black',
    ethnicity_mix: 0.5,
    expression_1: 'happy',
    expression_2: 'surprise',
    expression_mix: 0.5,
    head_yaw: 0,
    head_pitch: 0,
    head_roll: 0,
    output_format: 'glb',
    seed: null,
    sync_mode: true,
  };
}

export function defaultAdvancedInput(): AdvancedInput {
  return {
    head_identity: Array(10).fill(0),
    left_eye_expression: Array(3).fill(0),
    right_eye_expression: Array(3).fill(0),
    lower_face_expression: Array(7).fill(0),
    tongue_expression: Array(4).fill(0),
    pupils_expression: Array(1).fill(0),
    neck_rotation_x: 0,
    neck_rotation_y: 0,
    neck_rotation_z: 0,
    head_rotation_x: 0,
    head_rotation_y: 0,
    head_rotation_z: 0,
    gaze_x: 0,
    gaze_y: 0,
    gaze_vergence: 0,
    translation_x: 0,
    translation_y: 0,
    translation_z: 0,
    output_format: 'glb',
    sync_mode: true,
  };
}

// --- Advanced slider group metadata (for building the UI) --------------------

export interface CoeffGroup {
  key:
    | 'head_identity'
    | 'left_eye_expression'
    | 'right_eye_expression'
    | 'lower_face_expression'
    | 'tongue_expression'
    | 'pupils_expression';
  label: string;
  count: number;
  itemLabel: (i: number) => string;
}

/** Coefficient groups; every entry is in [-3, 3] standard deviations. */
export const ADVANCED_COEFF_GROUPS: CoeffGroup[] = [
  {
    key: 'head_identity',
    label: 'Head identity',
    count: 10,
    itemLabel: (i) => `Identity ${i + 1}`,
  },
  {
    key: 'left_eye_expression',
    label: 'Left eye',
    count: 3,
    itemLabel: (i) => `Left eye ${i + 1}`,
  },
  {
    key: 'right_eye_expression',
    label: 'Right eye',
    count: 3,
    itemLabel: (i) => `Right eye ${i + 1}`,
  },
  {
    key: 'lower_face_expression',
    label: 'Lower face',
    count: 7,
    itemLabel: (i) => `Lower face ${i + 1}`,
  },
  {
    key: 'tongue_expression',
    label: 'Tongue',
    count: 4,
    itemLabel: (i) => (i === 0 ? 'Tongue mean' : `Tongue ${i}`),
  },
  {
    key: 'pupils_expression',
    label: 'Pupils',
    count: 1,
    itemLabel: () => 'Pupil dilation',
  },
];

export const COEFF_LIMIT = 3;

export interface AngleField {
  key:
    | 'neck_rotation_x'
    | 'neck_rotation_y'
    | 'neck_rotation_z'
    | 'head_rotation_x'
    | 'head_rotation_y'
    | 'head_rotation_z'
    | 'gaze_x'
    | 'gaze_y'
    | 'gaze_vergence';
  label: string;
  min: number;
  max: number;
  unit: string;
}

export const ADVANCED_NECK_HEAD_FIELDS: AngleField[] = [
  { key: 'neck_rotation_x', label: 'Neck X', min: -90, max: 90, unit: '°' },
  { key: 'neck_rotation_y', label: 'Neck Y', min: -90, max: 90, unit: '°' },
  { key: 'neck_rotation_z', label: 'Neck Z', min: -90, max: 90, unit: '°' },
  { key: 'head_rotation_x', label: 'Head X', min: -45, max: 45, unit: '°' },
  { key: 'head_rotation_y', label: 'Head Y', min: -45, max: 45, unit: '°' },
  { key: 'head_rotation_z', label: 'Head Z', min: -15, max: 15, unit: '°' },
];

export const ADVANCED_GAZE_FIELDS: AngleField[] = [
  { key: 'gaze_x', label: 'Gaze X', min: -25, max: 25, unit: '°' },
  { key: 'gaze_y', label: 'Gaze Y', min: -30, max: 30, unit: '°' },
  { key: 'gaze_vergence', label: 'Vergence', min: -10, max: 10, unit: '°' },
];

export interface TranslationField {
  key: 'translation_x' | 'translation_y' | 'translation_z';
  label: string;
}

export const ADVANCED_TRANSLATION_FIELDS: TranslationField[] = [
  { key: 'translation_x', label: 'Translate X' },
  { key: 'translation_y', label: 'Translate Y' },
  { key: 'translation_z', label: 'Translate Z' },
];

export const TRANSLATION_LIMIT = 0.2;
