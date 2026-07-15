import { fal } from '@fal-ai/client';

import type { GnmInput, GnmResult, Mode } from './gnm';
import { endpointForMode } from './protocol';

/**
 * Base model endpoint (app id). Mapped from the environment so the same UI can
 * target a fork or a different deployment without a code change.
 */
export const MODEL_ENDPOINT = (
  process.env.NEXT_PUBLIC_FAL_MODEL_ENDPOINT || 'google/gnm-head'
).trim();

/** See {@link endpointForMode}; defaults the base to {@link MODEL_ENDPOINT}. */
export function endpointFor(mode: Mode, base: string = MODEL_ENDPOINT): string {
  return endpointForMode(mode, base);
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

export interface GenerateOptions {
  mode: Mode;
  input: GnmInput;
  base?: string;
  signal?: AbortSignal;
}

/**
 * Call a GNM Head HTTP endpoint with one direct `fal.run` request — no queue,
 * no log streaming — and return its parsed output. Always runs in sync mode
 * (the caller sets `sync_mode: true`), so `model_mesh.url` is a
 * `data:model/gltf-binary;base64,...` URI decoded directly by the viewer.
 * `fal.run` supports `abortSignal` natively, so an aborted `signal` cancels
 * the underlying fetch.
 */
export async function generate({
  mode,
  input,
  base,
  signal,
}: GenerateOptions): Promise<GnmResult> {
  const endpoint = endpointFor(mode, base);
  const result = await fal.run(endpoint, {
    input: input as unknown as Record<string, unknown>,
    abortSignal: signal,
  });
  return result.data as GnmResult;
}
