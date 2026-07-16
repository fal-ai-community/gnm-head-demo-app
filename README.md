# GNM Head Studio

A browser demo for **Google's GNM Head** parametric 3D head model, served through
the [fal](https://fal.ai) registry app `google/gnm-head`. It renders the generated
mesh live in a Three.js viewer and exposes every parameter of the three GNM Head
endpoints as interactive controls, over two transports:

- **fal.run (default)** — one direct HTTP request per generation, returning a GLB.
- **Realtime (opt-in toggle)** — a WebSocket session against the registry's
  `/realtime` endpoint that streams raw vertex buffers, rendered directly in
  Three.js without ever being converted back to GLB.

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
- **Live Three.js viewer** — GLB results are parsed by GLTFLoader; realtime
  frames update a single reused `BufferGeometry` in place (positions refilled,
  static topology cached, normals recomputed). Orbit controls, responsive
  resize, a clay PBR material, a wireframe toggle, and full disposal of GPU
  resources when switching transports or unmounting.
- **Interactive by default** — on fal.run, control changes auto-generate on
  commit (slider release / discrete change) behind a 450 ms trailing debounce,
  so a drag costs one HTTP request per pause. On realtime, every slider
  movement feeds a 100 ms leading+trailing throttle, so the mesh follows the
  drag itself at a steady cadence and the trailing edge sends the released
  value (no duplicate send on release). There is also an explicit **Generate**
  button. On fal.run, in-flight requests are aborted (`abortSignal`) and stale
  responses are ignored; on realtime, every frame carries a monotonically
  unique `request_id` and stale/out-of-mode frames are dropped, so rapid edits
  never race.
- **Request telemetry** — the active endpoint, transport, session state with
  dead-man countdown, latency, server handler time (realtime), vertex/face
  counts, and resolved seed. A small transport-event log records realtime
  connects/closes.
- **Download GLB** — available for fal.run results. Realtime frames are raw
  geometry, so the button is disabled while a realtime mesh is displayed.

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
| `npm run lint`      | ESLint.                                            |
| `npm run typecheck` | `tsc --noEmit`.                                    |
| `npm test`          | Node test runner over the pure helpers (protocol, throttle). |

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
| `NEXT_PUBLIC_FAL_MODEL_ENDPOINT` | `google/gnm-head` | Base fal app id. The app appends `/blend`, `/advanced`, and `/realtime`. |

The endpoint is joined without malformed slashes: a trailing slash on the base is
stripped before a sub-path is appended, and the semantic mode uses the base id
verbatim.

## Transport 1: fal.run (HTTP)

```ts
import { fal } from '@fal-ai/client';

fal.config({ credentials: userKey }); // browser-only

const { data } = await fal.run('google/gnm-head', {
  input: { /* exact registry field names */ sync_mode: true, output_format: 'glb' },
  abortSignal, // fal.run cancels the underlying fetch on abort
});

// data.model_mesh.url is a data:model/gltf-binary;base64,... URI in sync mode
```

Requests go directly to the synchronous endpoint — there is no queue
subscription and no log streaming. Rapid edits abort the in-flight request, and
a request-id guard drops any stale response that still lands.

## Transport 2: Realtime (WebSocket)

Enabled with the **Realtime** toggle (default off). The client connects with:

```ts
fal.realtime.connect('google/gnm-head', {
  path: '/realtime',
  throttleInterval: 125, // ms, client-side send throttle
  maxBuffering: 2,       // server keeps at most 2 buffered frames
  onResult, onError,
});
```

Messages are msgpack-encoded, so binary fields travel natively (no base64).

### Wire protocol

Request (one per generation — throttled slider movements included):

```jsonc
{
  "payload": {
    "mode": "semantic" | "blend" | "advanced",
    // ...exactly the active mode's input fields,
    // WITHOUT output_format / sync_mode (HTTP-only fields)
  },
  "include_topology": true,   // only until topology has been received
  "request_id": "r42"         // monotonically unique per session
}
```

Response:

```jsonc
{
  "request_id": "r42",
  "mode": "semantic",
  "vertices": <bytes>,        // contiguous little-endian float32 [num_vertices, 3]
  "faces": <bytes> | null,    // contiguous little-endian uint32 [num_faces, 3]
  "num_vertices": 0,
  "num_faces": 0,
  "seed": 0 | null,
  "timings": { "handler_total_ms": 0, "payload_bytes": 0 /* ... */ }
}
```

Topology (`faces`) is static per mesh — the same across all three modes — so the
client requests it only until it has actually been received, caches it for the
lifetime of the connection, and clears/re-requests it whenever the connection
closes or is recreated. Byte lengths are validated against
`num_vertices`/`num_faces` and every face index against the vertex count; the
bytes are decoded as **explicit little-endian** (with a copy/DataView path that
is correct even for unaligned msgpack slices and on big-endian hosts) straight
into a Three.js `BufferGeometry` — no GLB round-trip.

### Sessions, billing, and the two dead-man switches

A realtime connection is **session-priced while the socket is open**. Turning
the toggle on does **not** open a connection by itself — the socket opens on
your next Generate/control action. Two independent safeguards bound the
session:

1. **Client dead-man (8 s)** — the app closes the socket after 8 seconds with
   no sends, results, or control activity. While the session is open the UI
   shows a live countdown (`Realtime · closes in 7s`). The socket is also
   closed immediately when the toggle is switched off, the API key is changed
   or cleared, the tab is hidden, the page unloads, or the component unmounts.
2. **Server dead-man (10 s)** — the registry app closes any connection that
   has received no inbound frames for 10 seconds, independent of the client.

The client timeout is deliberately below the server's so the client normally
closes first. There are **no heartbeats** — an idle session is never kept
alive. After any close (either dead-man, an error, or a page-hide), the next
send reconnects transparently and re-requests topology; there is no reconnect
loop.

## Field-name source of truth

The input field names, enum values, and numeric bounds in `lib/gnm.ts` mirror the
registry app (`registry/three_d/gnm_head.py`) exactly. If that schema changes,
update `lib/gnm.ts` (and the realtime protocol helpers in `lib/protocol.ts`) to
match.

## Project layout

```
app/
  layout.tsx           Root layout + metadata
  page.tsx             State, transport switching, generation orchestration,
                       abort/stale handling, realtime lifecycle closes
  globals.css          Styling
components/
  Viewer.tsx           Three.js scene; GLB loading and direct realtime
                       BufferGeometry updates; orbit controls; disposal
  KeyBar.tsx           fal key input + browser-credential warning
  Field.tsx            Slider / Select primitives
  CollapsibleGroup     Collapsible section with reset
  SharedControls       Pose + seed controls shared by semantic/blend
  SemanticControls     Semantic mode panel
  BlendControls        Blend mode panel
  AdvancedControls     Advanced mode panel (all sliders)
  StatusBar.tsx        Endpoint / transport / session / latency / counts / download
lib/
  gnm.ts               Endpoint constants, input shapes, defaults, slider metadata
  fal.ts               fal client config + fal.run generate()
  protocol.ts          Pure helpers: endpoint joining, realtime request building,
                       little-endian wire decoding, request-id ordering,
                       dead-man timer (unit-tested, no DOM/three/fal imports)
  realtimeSession.ts   Realtime session manager: lazy connect, topology cache,
                       inactivity dead-man, transparent reconnect-on-send
  mesh.ts              data-URI / base64 decoding, ViewerMesh union, GLB download
  throttle.ts          Pure leading+trailing throttle for realtime live updates
                       (unit-tested, injectable clock/scheduler)
  useDebouncedCallback.ts
  useThrottledCallback.ts
test/
  protocol.test.ts     Node test runner tests for lib/protocol.ts
  throttle.test.ts     Node test runner tests for lib/throttle.ts
```

## Limitations

- The realtime transport uses the browser-key flow of `@fal-ai/client` (the
  SDK's default token provider), which the SDK logs a deprecation warning for;
  a production app should mint short-lived tokens behind its own backend.
- Realtime frames cannot be downloaded as GLB; switch back to fal.run for that.
- If the server closes the socket without an error event, the client may not
  notice until the next send — which then reconnects transparently. Topology is
  static, so a cached copy surviving such a close is still correct.

## Attribution

GNM ("Generative aNthropometric Model") and GNM Head are Google's, released under
Apache-2.0: <https://github.com/google/GNM>. This app is an unaffiliated demo of
the fal deployment.
