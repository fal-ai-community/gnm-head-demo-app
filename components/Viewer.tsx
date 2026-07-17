'use client';

import { useCallback, useEffect, useRef, type SyntheticEvent } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { base64ToBytes, decodeDataUri, type ViewerMesh } from '@/lib/mesh';
import { createThrottle, type Throttle } from '@/lib/throttle';

/**
 * Diffusion capture format, per the FLUX.2 [klein] realtime guidance:
 * 704x704 JPEG at 50% quality is the endpoint's optimal input.
 */
const CAPTURE_SIZE = 704;
const CAPTURE_JPEG_QUALITY = 0.5;
/** Pace captures during a sustained orbit/slider drag (leading+trailing). */
const CAPTURE_THROTTLE_MS = 125;

/** Square side and frame rate of the WebRTC input feed (Lucy video mode). */
const STREAM_SIZE = 512;
const STREAM_FPS = 24;

/**
 * How the diffusion model consumes the rendered view: 'frames' captures
 * throttled JPEG data URIs (FLUX klein over WebSocket); 'stream' exposes the
 * render as a continuous MediaStream (Lucy over WebRTC).
 */
export type DiffusionInputMode = 'frames' | 'stream';

interface ViewerProps {
  /**
   * A GLB data URI (fal.run transport) or raw realtime geometry (WebSocket
   * transport); null when there is nothing to show yet.
   */
  mesh: ViewerMesh | null;
  wireframe: boolean;
  /** When true, rendered frames are captured and streamed for diffusion. */
  diffusionEnabled?: boolean;
  /** See {@link DiffusionInputMode}. */
  diffusionInput?: DiffusionInputMode;
  /** Latest diffused frame (blob URL) shown over the raw render ('frames' mode). */
  diffusionImageUrl?: string | null;
  /** Transformed remote video shown over the raw render ('stream' mode). */
  diffusionVideoStream?: MediaStream | null;
  /** Receives a 704x704 JPEG data URI of the rendered frame, throttled. */
  onDiffusionCapture?: (dataUri: string) => void;
  /**
   * Receives the live capture MediaStream of the rendered view while
   * 'stream' mode is enabled, and null when it is torn down.
   */
  onDiffusionStream?: (stream: MediaStream | null) => void;
  /** Reports the remote video's intrinsic resolution (diagnostics). */
  onDiffusionVideoSize?: (width: number, height: number) => void;
  /** Bump to force a re-capture without a scene change (e.g. prompt edit). */
  captureNonce?: number;
}

/** Clay-style PBR material shared by the GLB and realtime paths. */
function clayMaterial(wireframe: boolean): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xcbb8a6,
    roughness: 0.62,
    metalness: 0.04,
    flatShading: false,
    wireframe,
  });
}

/**
 * Turns a decoded GLB into an ArrayBuffer for GLTFLoader.parse. Falls back to
 * decoding the base64 payload by hand if the data URI regex path is ever fed a
 * value it does not recognise as base64.
 */
function toArrayBuffer(dataUri: string): ArrayBuffer {
  try {
    const { bytes } = decodeDataUri(dataUri);
    return bytes.slice().buffer;
  } catch {
    const comma = dataUri.indexOf(',');
    const payload = comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
    return base64ToBytes(payload).slice().buffer;
  }
}

/** The single mesh + geometry reused across realtime vertex-only updates. */
interface RealtimeModel {
  object: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  /** Identity of the index array currently uploaded, to skip redundant re-uploads. */
  indices: Uint32Array;
}

export default function Viewer({
  mesh,
  wireframe,
  diffusionEnabled = false,
  diffusionInput = 'frames',
  diffusionImageUrl = null,
  diffusionVideoStream = null,
  onDiffusionCapture,
  onDiffusionStream,
  onDiffusionVideoSize,
  captureNonce = 0,
}: ViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Long-lived three.js objects, kept across renders.
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const glbRootRef = useRef<THREE.Object3D | null>(null);
  const realtimeRef = useRef<RealtimeModel | null>(null);
  const wireframeRef = useRef(wireframe);

  // --- Diffusion capture state (all refs: read inside the RAF loop) ---
  const diffusionEnabledRef = useRef(diffusionEnabled);
  const diffusionInputRef = useRef<DiffusionInputMode>(diffusionInput);
  const onCaptureRef = useRef(onDiffusionCapture);
  onCaptureRef.current = onDiffusionCapture;
  const onStreamRef = useRef(onDiffusionStream);
  onStreamRef.current = onDiffusionStream;
  const onVideoSizeRef = useRef(onDiffusionVideoSize);
  onVideoSizeRef.current = onDiffusionVideoSize;
  /** Set by the capture throttle; consumed right after the next render. */
  const captureDueRef = useRef(false);
  /** Reusable offscreen canvas for the 704x704 center-cropped JPEG. */
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Offscreen canvas blitted every frame and exposed via captureStream(). */
  const streamCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Small picture-in-picture canvas showing the raw render under the overlay. */
  const pipCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /** The <video> element the transformed remote stream plays in. */
  const overlayVideoRef = useRef<HTMLVideoElement | null>(null);
  const captureThrottleRef = useRef<Throttle | null>(null);
  if (captureThrottleRef.current === null) {
    captureThrottleRef.current = createThrottle({
      intervalMs: CAPTURE_THROTTLE_MS,
      fn: () => {
        captureDueRef.current = true;
      },
    });
  }

  /**
   * Request a diffusion capture of the next rendered frame. Safe to call from
   * anywhere (controls events, mesh updates); throttled so a sustained drag
   * streams at a steady cadence with a trailing capture of the settled frame.
   */
  const markCaptureDirty = useCallback(() => {
    if (!diffusionEnabledRef.current || !onCaptureRef.current) return;
    // In 'stream' mode the render is fed continuously over the MediaStream;
    // there is no per-frame JPEG capture to schedule.
    if (diffusionInputRef.current !== 'frames') return;
    captureThrottleRef.current?.call();
  }, []);

  // --- One-time scene setup + render loop ---
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0e14);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      35,
      container.clientWidth / Math.max(container.clientHeight, 1),
      0.01,
      100,
    );
    camera.position.set(0, 0, 0.6);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.1;
    controls.maxDistance = 5;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    // Lighting: hemisphere fill + a key/rim pair for readable facial geometry.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x30343d, 0.9);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1, 1.5, 2);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 1.1);
    rim.position.set(-2, 1, -1.5);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(0, -1, 1);
    scene.add(fill);

    // Camera movement (orbit/zoom/pan, including damping) re-captures for
    // diffusion. The throttle collapses the per-frame change events.
    controls.addEventListener('change', markCaptureDirty);

    /**
     * Center-crop the freshly rendered WebGL canvas into a square. Must run in
     * the same task as renderer.render() — the WebGL back buffer is only
     * guaranteed readable before the browser composites (no
     * preserveDrawingBuffer needed this way).
     */
    const blitSquare = (target: HTMLCanvasElement) => {
      const source = renderer.domElement;
      const s = Math.min(source.width, source.height);
      if (s === 0) return false;
      const ctx = target.getContext('2d');
      if (!ctx) return false;
      ctx.drawImage(
        source,
        (source.width - s) / 2,
        (source.height - s) / 2,
        s,
        s,
        0,
        0,
        target.width,
        target.height,
      );
      return true;
    };

    const afterRender = () => {
      if (!diffusionEnabledRef.current) return;
      // Nothing worth diffusing (or paying for) until a head exists.
      const hasModel = glbRootRef.current !== null || realtimeRef.current !== null;
      if (!hasModel) return;

      const pip = pipCanvasRef.current;
      if (pip) blitSquare(pip);

      // 'stream' mode: refresh the captureStream() source canvas every frame;
      // WebRTC picks the frames up from there. No JPEG capture path.
      if (diffusionInputRef.current === 'stream') {
        const streamCanvas = streamCanvasRef.current;
        if (streamCanvas) blitSquare(streamCanvas);
        return;
      }

      if (!captureDueRef.current) return;
      const onCapture = onCaptureRef.current;
      if (!onCapture) return;
      let canvas = captureCanvasRef.current;
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.width = CAPTURE_SIZE;
        canvas.height = CAPTURE_SIZE;
        captureCanvasRef.current = canvas;
      }
      if (!blitSquare(canvas)) return; // zero-sized canvas; retry next frame
      captureDueRef.current = false;
      onCapture(canvas.toDataURL('image/jpeg', CAPTURE_JPEG_QUALITY));
    };

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      afterRender();
    };
    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth;
      const h = Math.max(container.clientHeight, 1);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      markCaptureDirty();
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(container);
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(raf);
      captureThrottleRef.current?.cancel();
      captureDueRef.current = false;
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
      controls.removeEventListener('change', markCaptureDirty);
      disposeGlb();
      disposeRealtime();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disposeGlb = () => {
    const model = glbRootRef.current;
    const scene = sceneRef.current;
    if (!model) return;
    if (scene) scene.remove(model);
    model.traverse((obj) => {
      const child = obj as THREE.Mesh;
      if (child.isMesh) {
        child.geometry?.dispose();
        const material = child.material;
        const materials = Array.isArray(material) ? material : [material];
        for (const mat of materials) {
          if (!mat) continue;
          for (const value of Object.values(mat)) {
            if (value instanceof THREE.Texture) value.dispose();
          }
          mat.dispose();
        }
      }
    });
    glbRootRef.current = null;
  };

  const disposeRealtime = () => {
    const model = realtimeRef.current;
    if (!model) return;
    sceneRef.current?.remove(model.object);
    model.geometry.dispose();
    model.material.dispose();
    realtimeRef.current = null;
  };

  /**
   * Create or update the single realtime mesh. Vertex-only frames refill the
   * existing position buffer in place; a fresh geometry is only built on the
   * first frame or if the vertex count ever changes.
   */
  const updateRealtimeModel = (
    frame: Extract<ViewerMesh, { kind: 'geometry' }>,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
  ) => {
    const { positions, indices } = frame;
    const existing = realtimeRef.current;
    if (existing) {
      const attribute = existing.geometry.getAttribute('position') as THREE.BufferAttribute;
      if (attribute.array.length === positions.length) {
        (attribute.array as Float32Array).set(positions);
        attribute.needsUpdate = true;
        if (existing.indices !== indices) {
          existing.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
          existing.indices = indices;
        }
        existing.geometry.computeVertexNormals();
        existing.geometry.computeBoundingSphere();
        return;
      }
    }

    disposeRealtime();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    const material = clayMaterial(wireframeRef.current);
    const object = new THREE.Mesh(geometry, material);
    frameModel(object, camera, controls);
    scene.add(object);
    realtimeRef.current = { object, geometry, material, indices };
  };

  // --- Load / update the displayed mesh whenever the source changes ---
  useEffect(() => {
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!scene || !camera || !controls) return;

    if (!mesh) {
      disposeGlb();
      disposeRealtime();
      return;
    }

    if (mesh.kind === 'geometry') {
      disposeGlb();
      updateRealtimeModel(mesh, scene, camera, controls);
      markCaptureDirty();
      return;
    }

    // GLB path (fal.run transport).
    disposeRealtime();
    let cancelled = false;
    const loader = new GLTFLoader();
    let arrayBuffer: ArrayBuffer;
    try {
      arrayBuffer = toArrayBuffer(mesh.dataUri);
    } catch (err) {
      // Malformed payload; leave the previous model in place.
      console.error('Failed to decode mesh data URI', err);
      return;
    }

    loader.parse(
      arrayBuffer,
      '',
      (gltf) => {
        if (cancelled) return;
        disposeGlb();

        const model = gltf.scene;
        applyMaterial(model, wireframeRef.current);
        frameModel(model, camera, controls);
        scene.add(model);
        glbRootRef.current = model;
        markCaptureDirty();
      },
      (err) => {
        console.error('GLTFLoader failed to parse the GLB', err);
      },
    );

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesh]);

  // --- Toggle wireframe on the current model without a reload ---
  useEffect(() => {
    wireframeRef.current = wireframe;
    const glb = glbRootRef.current;
    if (glb) {
      glb.traverse((obj) => {
        const child = obj as THREE.Mesh;
        if (child.isMesh) {
          const material = child.material as
            | THREE.MeshStandardMaterial
            | THREE.MeshStandardMaterial[];
          const materials = Array.isArray(material) ? material : [material];
          for (const mat of materials) {
            if (mat && 'wireframe' in mat) mat.wireframe = wireframe;
          }
        }
      });
    }
    const realtimeModel = realtimeRef.current;
    if (realtimeModel) realtimeModel.material.wireframe = wireframe;
    markCaptureDirty();
  }, [wireframe, markCaptureDirty]);

  // --- Diffusion enable/disable + forced re-captures ---
  useEffect(() => {
    diffusionEnabledRef.current = diffusionEnabled;
    diffusionInputRef.current = diffusionInput;
    if (diffusionEnabled && diffusionInput === 'frames') {
      // Capture the current frame right away so toggling the box (or editing
      // the prompt, via captureNonce) diffuses without needing camera motion.
      markCaptureDirty();
    } else {
      captureThrottleRef.current?.cancel();
      captureDueRef.current = false;
    }
  }, [diffusionEnabled, diffusionInput, captureNonce, markCaptureDirty]);

  // --- 'stream' mode: expose the render as a live MediaStream ---
  useEffect(() => {
    if (!diffusionEnabled || diffusionInput !== 'stream') return;
    const canvas = document.createElement('canvas');
    canvas.width = STREAM_SIZE;
    canvas.height = STREAM_SIZE;
    streamCanvasRef.current = canvas;
    const stream = canvas.captureStream(STREAM_FPS);
    onStreamRef.current?.(stream);
    return () => {
      streamCanvasRef.current = null;
      for (const track of stream.getTracks()) track.stop();
      onStreamRef.current?.(null);
    };
  }, [diffusionEnabled, diffusionInput]);

  const showImageOverlay =
    diffusionEnabled && diffusionInput === 'frames' && Boolean(diffusionImageUrl);
  const showVideoOverlay =
    diffusionEnabled && diffusionInput === 'stream' && Boolean(diffusionVideoStream);
  const showOverlay = showImageOverlay || showVideoOverlay;

  // Attach the remote stream to the overlay <video> once both exist.
  useEffect(() => {
    const video = overlayVideoRef.current;
    if (!video) return;
    video.srcObject = showVideoOverlay ? diffusionVideoStream : null;
  }, [showVideoOverlay, diffusionVideoStream]);

  /** Fires on loadedmetadata and any mid-stream resolution change. */
  const reportVideoSize = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const { videoWidth, videoHeight } = event.currentTarget;
    if (videoWidth > 0 && videoHeight > 0) {
      onVideoSizeRef.current?.(videoWidth, videoHeight);
    }
  }, []);

  return (
    <div className="viewer-canvas" aria-label="3D head viewer" role="img">
      {/* three.js appends its canvas here; React never touches this subtree. */}
      <div ref={containerRef} className="viewer-gl" />
      {showImageOverlay && (
        // eslint-disable-next-line @next/next/no-img-element -- blob URL frames streamed over WebSocket; next/image adds nothing here.
        <img
          className="diffusion-overlay"
          src={diffusionImageUrl as string}
          alt="Diffused render"
        />
      )}
      {showVideoOverlay && (
        <video
          ref={overlayVideoRef}
          className="diffusion-overlay-video"
          autoPlay
          playsInline
          muted
          aria-label="Diffused render (live video)"
          onLoadedMetadata={reportVideoSize}
          onResize={reportVideoSize}
        />
      )}
      {showOverlay && (
        <div className="diffusion-pip" aria-hidden="true">
          <canvas ref={pipCanvasRef} width={160} height={160} />
          <span className="diffusion-pip-label">raw render</span>
        </div>
      )}
    </div>
  );
}

/**
 * Replace whatever material the GLB shipped with (trimesh exports an untextured
 * default) with the shared clay material and ensure normals exist so lighting
 * reads correctly.
 */
function applyMaterial(model: THREE.Object3D, wireframe: boolean) {
  model.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    if (geometry && !geometry.getAttribute('normal')) {
      geometry.computeVertexNormals();
    }
    const oldMaterial = mesh.material;
    mesh.material = clayMaterial(wireframe);
    const oldMaterials = Array.isArray(oldMaterial) ? oldMaterial : [oldMaterial];
    for (const mat of oldMaterials) mat?.dispose();
  });
}

/** Center the model at the origin and pull the camera back to frame it. */
function frameModel(
  model: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  model.position.sub(center); // recenter to origin

  const maxDim = Math.max(size.x, size.y, size.z) || 0.2;
  const fov = (camera.fov * Math.PI) / 180;
  const distance = (maxDim / 2 / Math.tan(fov / 2)) * 1.6;

  camera.position.set(0, size.y * 0.08, distance);
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();

  controls.target.set(0, 0, 0);
  controls.update();
}
