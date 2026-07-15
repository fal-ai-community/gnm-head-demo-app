# GNM Head Studio

A browser demo for **Google's GNM Head** parametric 3D head model, served through
the [fal](https://fal.ai) registry app `google/gnm-head`. It renders the generated
mesh live in a Three.js viewer and exposes every parameter of the three GNM Head
endpoints as interactive controls.

The app is **100% client-side**: there is no backend, no API route, and no
server-held fal key. You paste your fal key into the UI, the
[`@fal-ai/client`](https://www.npmjs.com/package/@fal-ai/client) SDK is configured
in the browser, and every request goes straight from your browser to fal. Because
of that, the app can be exported as a static site.

> ⚠️ **Credentials live in the browser.** A key entered here is visible to anything
> that can read the page's memory or your network traffic. Use a
> [scoped or temporary fal key](https://docs.fal.ai/authentication/key-based),
> never your primary secret. By default the key is held **in memory only** and is
> discarded on reload; the "Remember in this browser tab" checkbox is an explicit
> opt-in that stores it in `sessionStorage` (cleared when the tab closes).

## Features

- **Three modes**, one per GNM Head endpoint:
  - **Semantic** (`/`) — gender, ethnicity, expression (including `neutral`),
    seed with randomize/clear, and yaw/pitch/roll head pose.
  - **Blend** (`/blend`) — gender, two ethnicities with a mix weight, two
    (non-neutral) sampler expressions with a mix weight, seed, and head pose.
  - **Advanced** (`/advanced`) — every notebook slider: 10 head-identity
    coefficients; 3 left-eye, 3 right-eye, 7 lower-face, 4 tongue, and 1 pupils
    expression coefficients; neck XYZ, head XYZ, gaze X/Y/vergence, and root
    translation XYZ — grouped in collapsible sections with per-group and
    global reset.
- **Live Three.js viewer** — GLTFLoader parses the returned GLB, with orbit
  controls, responsive resize, a clay PBR material, computed normals, a wireframe
  toggle, and full disposal of old GPU resources between generations.
- **Interactive by default** — slider changes are debounced and auto-generate;
  there is also an explicit **Generate** button. In-flight requests are aborted
  and stale responses are ignored, so rapid edits never race.
- **Always sync mode + GLB** — every request is sent with `sync_mode: true` and
  `output_format: "glb"`; the returned `model_mesh.url` `data:` URI is decoded and
  loaded directly, with a **Download GLB** button.
- **Request telemetry** — the active endpoint, status, latency, vertex/face
  counts, resolved seed, and streaming request logs are all shown.

## Getting started

```bash
npm install
npm run dev
```

Open <http://localhost:3000>, paste a fal key, and generate.

### Scripts

| Script              | Description                                        |
| ------------------- | -------------------------------------------------- |
| `npm run dev`       | Start the dev server.                              |
| `npm run build`     | Production build → static `out/` (see below).      |
| `npm run start`     | Serve a non-static build (`NEXT_OUTPUT=server`).   |
| `npm run lint`      | ESLint (`next lint`).                              |
| `npm run typecheck` | `tsc --noEmit`.                                    |

### Static export

`npm run build` produces a static site in `out/` (`output: 'export'`) that you can
host on any static file server or CDN:

```bash
npm run build
npx serve out
```

To build for a Node server target instead (`next start`), set `NEXT_OUTPUT=server`.

## Configuration

Copy `.env.example` to `.env.local` if you need to change the target endpoint.
Only `NEXT_PUBLIC_*` variables are read (they are inlined into the client bundle);
**never** put a fal key in the environment.

| Variable                       | Default          | Description                                                             |
| ------------------------------ | ---------------- | ----------------------------------------------------------------------- |
| `NEXT_PUBLIC_FAL_MODEL_ENDPOINT` | `google/gnm-head` | Base fal app id. The app appends `/blend` and `/advanced` for those modes. |

The endpoint is joined without malformed slashes: a trailing slash on the base is
stripped before `/blend` / `/advanced` is appended, and the semantic mode uses the
base id verbatim.

## How it talks to fal

```ts
import { fal } from '@fal-ai/client';

fal.config({ credentials: userKey }); // browser-only

const { data } = await fal.subscribe('google/gnm-head', {
  input: { /* exact registry field names */ sync_mode: true, output_format: 'glb' },
  logs: true,
  abortSignal,
  onQueueUpdate: (u) => { /* stream logs */ },
});

// data.model_mesh.url is a data:model/gltf-binary;base64,... URI in sync mode
```

The input field names, enum values, and numeric bounds in `lib/gnm.ts` mirror the
registry app (`registry/three_d/gnm_head.py`) exactly. If that schema changes,
update `lib/gnm.ts` to match.

## Project layout

```
app/
  layout.tsx        Root layout + metadata
  page.tsx          State, generation orchestration, abort/stale handling
  globals.css       Styling
components/
  Viewer.tsx        Three.js scene, GLTFLoader, orbit controls, disposal
  KeyBar.tsx        fal key input + browser-credential warning
  Field.tsx         Slider / Select primitives
  CollapsibleGroup  Collapsible section with reset
  SharedControls    Pose + seed controls shared by semantic/blend
  SemanticControls  Semantic mode panel
  BlendControls     Blend mode panel
  AdvancedControls  Advanced mode panel (all sliders)
  StatusBar.tsx     Endpoint / status / latency / counts / download
lib/
  gnm.ts            Endpoint constants, input shapes, defaults, slider metadata
  fal.ts            fal client config + endpoint building + generate()
  mesh.ts           data-URI / base64 decoding + GLB download
  useDebouncedCallback.ts
```

## Attribution

GNM ("Generative aNthropometric Model") and GNM Head are Google's, released under
Apache-2.0: <https://github.com/google/GNM>. This app is an unaffiliated demo of
the fal deployment.
