/**
 * The app is fully client-side (the user's fal key stays in the browser and all
 * calls go straight to the fal API), so it can be exported as a static site.
 * `output: 'export'` produces a self-hostable `out/` bundle with `next build`.
 * Set `NEXT_OUTPUT=standalone` (or anything non-"export") to opt out.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const staticExport = process.env.NEXT_OUTPUT !== 'server';
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: projectRoot,
  ...(staticExport ? { output: 'export' } : {}),
  images: { unoptimized: true },
};

export default nextConfig;
