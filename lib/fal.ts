import { fal } from '@fal-ai/client';

import type {
  AdvancedInput,
  BlendInput,
  GnmResult,
  Mode,
  SemanticInput,
} from './gnm';

/**
 * Base model endpoint (app id). Mapped from the environment so the same UI can
 * target a fork or a different deployment without a code change.
 */
export const MODEL_ENDPOINT = (
  process.env.NEXT_PUBLIC_FAL_MODEL_ENDPOINT || 'google/gnm-head'
).trim();

/**
 * Build the endpoint id for a given mode, joining sub-paths without ever
 * producing a doubled or trailing slash. The semantic mode is the base "/"
 * endpoint (no suffix); blend/advanced append their sub-path.
 */
export function endpointFor(mode: Mode, base: string = MODEL_ENDPOINT): string {
  const clean = base.replace(/\/+$/, '');
  switch (mode) {
    case 'semantic':
      return clean;
    case 'blend':
      return `${clean}/blend`;
    case 'advanced':
      return `${clean}/advanced`;
  }
}

let configuredKey: string | null = null;

/**
 * Configure the fal client with the user's key. Runs in the browser only, so
 * the credentials never touch a server of ours.
 */
export function configureFal(key: string): void {
  const trimmed = key.trim();
  if (trimmed === configuredKey) return;
  fal.config({ credentials: trimmed });
  configuredKey = trimmed;
}

export type QueueUpdate = {
  status: string;
  logs?: { message: string }[];
};

export interface GenerateOptions {
  mode: Mode;
  input: SemanticInput | BlendInput | AdvancedInput;
  base?: string;
  signal?: AbortSignal;
  onQueueUpdate?: (update: QueueUpdate) => void;
}

/**
 * Call the GNM Head endpoint and return its parsed output. Always runs in
 * sync mode (the caller sets `sync_mode: true`), so `model_mesh.url` is a
 * `data:model/gltf-binary;base64,...` URI decoded directly by the viewer.
 */
export async function generate({
  mode,
  input,
  base,
  signal,
  onQueueUpdate,
}: GenerateOptions): Promise<GnmResult> {
  const endpoint = endpointFor(mode, base);
  const result = await fal.subscribe(endpoint, {
    input: input as unknown as Record<string, unknown>,
    logs: true,
    abortSignal: signal,
    onQueueUpdate: (update) => {
      onQueueUpdate?.(update as QueueUpdate);
    },
  });
  return result.data as GnmResult;
}
