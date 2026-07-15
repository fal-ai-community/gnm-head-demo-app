'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { base64ToBytes, decodeDataUri, type ViewerMesh } from '@/lib/mesh';

interface ViewerProps {
  /**
   * A GLB data URI (fal.run transport) or raw realtime geometry (WebSocket
   * transport); null when there is nothing to show yet.
   */
  mesh: ViewerMesh | null;
  wireframe: boolean;
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

export default function Viewer({ mesh, wireframe }: ViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Long-lived three.js objects, kept across renders.
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const glbRootRef = useRef<THREE.Object3D | null>(null);
  const realtimeRef = useRef<RealtimeModel | null>(null);
  const wireframeRef = useRef(wireframe);

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

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth;
      const h = Math.max(container.clientHeight, 1);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(container);
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
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
  }, [wireframe]);

  return <div ref={containerRef} className="viewer-canvas" aria-label="3D head viewer" role="img" />;
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
