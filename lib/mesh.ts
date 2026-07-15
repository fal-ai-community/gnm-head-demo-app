/**
 * Helpers for turning the API's `model_mesh.url` data URI into bytes the
 * GLTFLoader can parse, and for triggering a download of the raw GLB.
 */

/**
 * What the viewer should display: a GLB blob from the HTTP API, or raw
 * realtime geometry rendered directly (never converted back to GLB/base64).
 */
export type ViewerMesh =
  | { kind: 'glb'; dataUri: string }
  | { kind: 'geometry'; positions: Float32Array; indices: Uint32Array };

export interface DecodedDataUri {
  contentType: string;
  bytes: Uint8Array;
}

/**
 * Decode a `data:<mime>;base64,<payload>` URI to its bytes. Throws on any URI
 * that is not a base64 data URI (the app always requests sync mode, so a hosted
 * https URL would indicate an unexpected response shape).
 */
export function decodeDataUri(uri: string): DecodedDataUri {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
  if (!match) {
    throw new Error('model_mesh.url is not a data URI (expected sync_mode output).');
  }
  const contentType = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3];

  if (!isBase64) {
    // Percent-encoded text payload — decode to UTF-8 bytes.
    const text = decodeURIComponent(payload);
    return { contentType, bytes: new TextEncoder().encode(text) };
  }
  return { contentType, bytes: base64ToBytes(payload) };
}

/** Robust base64 → Uint8Array decode that tolerates whitespace/newlines. */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Trigger a browser download of the mesh bytes. Uses a temporary object URL and
 * revokes it immediately after the click so nothing leaks.
 */
export function downloadBytes(bytes: Uint8Array, filename: string, contentType: string): void {
  // Copy into a fresh ArrayBuffer so Blob gets a plain ArrayBuffer, not a view.
  const buffer = bytes.slice().buffer;
  const blob = new Blob([buffer], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
