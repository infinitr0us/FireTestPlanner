/**
 * The flame analysis board's 3-D view: the site plan's objects and calibrated
 * cameras (read-only, built by the editor's own builders), and the event's 3-D
 * flame at the playback time, drawn by the reconstructed-flame mesh.
 *
 * Its own renderer, camera and controls, like the FDS results scene: opening the
 * board never touches the editor's viewport.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

import { displayName, positionOf } from '../core/plan';
import type { CameraObject, PlanDocument, PlanObject } from '../core/types';
import type { FlameSequence } from '../core/flame';
import type { Mesh as SurfaceMesh } from '../core/flame-analysis';
import * as i18n from '../ui/i18n';
import { visualTheme } from '../ui/theme';
import {
  buildBurner, buildCamera, buildCeiling, buildHeatFluxSensor, buildHood, buildNewInstrument, buildObstruction,
  buildThermocouple, buildWall, LAYER_CEILING, LAYER_EDITOR,
} from './builders';
import { FlameMesh } from './flame';

export type SceneView = 'site' | 'flame';
/** Cubes (the hull as reconstructed) or the smoothed surface of format 1.1. */
export type FlameLook = 'cubes' | 'surface';
const SURFACE_CACHE = 40;

/** One object of the site plan, as the editor draws it; nothing that edits. */
function buildSiteObject(obj: PlanObject): THREE.Group | null {
  switch (obj.type) {
    case 'burner': return buildBurner(obj as never, false);
    case 'hood': return buildHood(obj as never);
    case 'wall': return buildWall(obj as never);
    case 'ceiling': return buildCeiling(obj as never);
    case 'camera': return buildCamera(obj as never, true);
    case 'heatFluxSensor': return buildHeatFluxSensor(obj as never);
    case 'thermocouple': return buildThermocouple(obj as never);
    case 'velocityProbe': case 'gasSampling': case 'loadCell': return buildNewInstrument(obj as never);
    case 'obstruction': return buildObstruction(obj as never);
    default: return null; // reconstructed flames and unknown types: the board draws its own flame
  }
}

export class AnalysisScene {
  readonly renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  readonly labelRenderer = new CSS2DRenderer();
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.02, 500);
  readonly controls: OrbitControls;
  private site = new THREE.Group();
  private flame = new FlameMesh();
  private siteBounds = new THREE.Box3();
  private flameBounds = new THREE.Box3();
  private observer: ResizeObserver;
  private request = 0;
  private dirty = true;
  private lookFrom = new THREE.Vector3(0, -1, 0.4);
  private siteSide = new THREE.Vector3(0, -1, 0.55).normalize();
  private exportRenderer?: THREE.WebGLRenderer;
  private surface = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.55, metalness: 0, side: THREE.DoubleSide }));
  private surfaceLoader: ((index: number) => Promise<SurfaceMesh>) | null = null;
  private surfaceGeneration = 0;
  private surfaceError: (error: Error) => void = () => {};
  private disposed = false;
  private surfaces = new Map<number, Promise<THREE.BufferGeometry>>();
  private surfaceIndex = -1;
  /** The surface on screen has left the cache, so replacing it must free it. */
  private surfaceEvicted = false;
  private frameIndex = -1;
  private look: FlameLook = 'cubes';
  private zRange: [number, number] = [0, 1];

  constructor(private host: HTMLElement) {
    const theme = visualTheme();
    this.scene.background = new THREE.Color(theme.background);
    this.camera.up.set(0, 0, 1);
    this.camera.layers.enable(LAYER_EDITOR);
    this.camera.layers.enable(LAYER_CEILING);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute('aria-label', i18n.t("3-D view of the site and the flame; drag to turn, wheel to zoom"));
    this.labelRenderer.domElement.classList.add('viewport-labels', 'flame-analysis__labels');
    host.append(this.renderer.domElement, this.labelRenderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(6, -8, 12);
    const fill = new THREE.DirectionalLight(0x93c5fd, 0.5);
    fill.position.set(-8, 6, 4);
    this.surface.visible = false;
    this.surface.raycast = () => {};
    this.scene.add(key, fill, this.site, this.flame.group, this.surface);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.animate();
  }

  /** Move the view into another element (the board rebuilds its layout per event). */
  attach(host: HTMLElement): void {
    if (host === this.host) return;
    this.observer.unobserve(this.host);
    host.append(this.renderer.domElement, this.labelRenderer.domElement);
    this.host = host;
    this.observer.observe(host);
    this.resize();
  }

  /** The site plan, with each analysis camera labelled by its short name. */
  setSite(doc: PlanDocument, cameraLabels: Map<string, string>): void {
    this.clear(this.site);
    const size = doc.environment?.floorSize_m ?? [20, 20];
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(size[0], size[1]),
      new THREE.MeshStandardMaterial({ color: 0x172033, roughness: 1, metalness: 0 }),
    );
    floor.position.z = -0.005;
    const grid = new THREE.GridHelper(Math.max(size[0], size[1]), Math.max(2, 2 * Math.round(Math.max(size[0], size[1]) / 2)), 0x334155, 0x1e293b);
    grid.rotation.x = Math.PI / 2;
    this.site.add(floor, grid);
    this.siteBounds.makeEmpty();
    for (const obj of doc.objects) {
      const group = buildSiteObject(obj);
      if (!group) continue;
      // Cameras (by their short names) and the fire keep their labels; the rest of
      // the site is context, and a label on every plate and pole hides the flame.
      group.traverse((o) => {
        if (!(o instanceof CSS2DObject)) return;
        if (obj.type === 'camera') o.element.textContent = cameraLabels.get(obj.id) ?? displayName(obj);
        else if (obj.type !== 'burner') o.visible = false;
      });
      this.site.add(group);
      this.siteBounds.expandByPoint(new THREE.Vector3(...positionOf(obj)));
    }
    this.siteBounds.expandByPoint(new THREE.Vector3(0, 0, 0));
    this.siteBounds.expandByPoint(new THREE.Vector3(0, 0, 2));
    // Look from the mean horizontal direction of the cameras: that side is open.
    const side = new THREE.Vector3();
    for (const obj of doc.objects) {
      if (obj.type !== 'camera') continue;
      const [x, y] = positionOf(obj);
      const length = Math.hypot(x, y);
      if (length > 0) side.add(new THREE.Vector3(x / length, y / length, 0));
    }
    if (side.lengthSq() < 1e-6) side.set(0, -1, 0);
    side.normalize();
    this.siteSide.copy(side).setZ(0.55).normalize();
    this.dirty = true;
  }

  /** The event's 3-D flame, and the camera the close-up looks from. */
  setFlame(sequence: FlameSequence | null, from?: CameraObject): void {
    this.flame.setSequence(sequence);
    this.flame.setAppearance(1, 'height');
    this.flameBounds.makeEmpty();
    if (sequence) {
      // The flame's usual extent, not the envelope of every instant: one wide
      // fireball would otherwise make the close-up show a small flame far away.
      const boxes = sequence.frames.filter((f) => f.count > 0).map((f) => {
        const o = sequence.frameOrigin(f);
        return [0, 1, 2].map((a) => [o[a], o[a] + (f.dims[a] - 1) * sequence.grid.pitch_m]);
      });
      const pick = (axis: number, end: 0 | 1, q: number): number => {
        const values = boxes.map((b) => b[axis][end]).sort((a, b) => a - b);
        return values[Math.min(values.length - 1, Math.max(0, Math.round(q * (values.length - 1))))];
      };
      // Sideways the usual extent; upwards nearly the tallest, since the tallest
      // instants are the ones worth showing.
      const lo = [pick(0, 0, 0.1), pick(1, 0, 0.1), pick(2, 0, 0.02)];
      const hi = [pick(0, 1, 0.9), pick(1, 1, 0.9), pick(2, 1, 0.98)];
      this.flameBounds.set(new THREE.Vector3(...lo), new THREE.Vector3(...hi));
    }
    if (from) {
      const p = new THREE.Vector3(...positionOf(from));
      const centre = this.flameBounds.isEmpty() ? new THREE.Vector3() : this.flameBounds.getCenter(new THREE.Vector3());
      this.lookFrom.copy(p.sub(centre));
      this.lookFrom.z = Math.max(this.lookFrom.z, 0.3 * Math.hypot(this.lookFrom.x, this.lookFrom.y));
      this.lookFrom.normalize();
    }
    this.dirty = true;
  }

  /** Show instant `index` of the flame (-1 for none). */
  setFrame(index: number): void {
    this.frameIndex = index;
    if (this.flame.setFrame(index)) this.dirty = true;
    if (this.look === 'surface') this.interactiveSurface(index);
  }

  /** Where the event's smoothed surfaces come from (format 1.1), or null. */
  setSurfaces(loader: ((index: number) => Promise<SurfaceMesh>) | null, zRange?: [number, number], onError: (error: Error) => void = () => {}): void {
    ++this.surfaceGeneration;
    this.surfaceError = onError;
    this.surfaceLoader = loader;
    if (this.surfaceIndex < 0 || this.surfaceEvicted) this.surface.geometry.dispose();
    for (const pending of this.surfaces.values()) void pending.then((g) => g.dispose(), () => undefined);
    this.surfaces.clear();
    this.surface.geometry = new THREE.BufferGeometry();
    this.surface.visible = false;
    this.surfaceEvicted = false;
    this.surfaceIndex = -1;
    this.dirty = true;
    if (zRange) this.zRange = zRange;
    if (!loader) this.setLook('cubes');
  }
  get hasSurfaces(): boolean { return this.surfaceLoader !== null; }

  setLook(look: FlameLook): void {
    if (look === 'surface' && !this.surfaceLoader) look = 'cubes';
    this.look = look;
    this.flame.group.visible = look === 'cubes';
    this.surface.visible = look === 'surface' && this.surfaceIndex >= 0;
    if (look === 'surface') this.interactiveSurface(this.frameIndex);
    this.dirty = true;
  }
  get flameLook(): FlameLook { return this.look; }

  /** Resolves once instant `index` is ready to draw (a surface may still be loading). */
  async prepareFrame(index: number): Promise<void> {
    this.frameIndex = index;
    if (this.flame.setFrame(index)) this.dirty = true;
    if (this.look === 'surface') await this.showSurface(index);
  }

  private interactiveSurface(index: number): void {
    const generation = this.surfaceGeneration;
    void this.showSurface(index).catch((error: Error) => {
      if (generation === this.surfaceGeneration && this.frameIndex === index && !this.disposed) this.surfaceError(error);
    });
  }

  private geometry(index: number): Promise<THREE.BufferGeometry> {
    let pending = this.surfaces.get(index);
    if (pending) {
      this.surfaces.delete(index);
      this.surfaces.set(index, pending);
      return pending;
    }
    const zRange = this.zRange;
    const loader = this.surfaceLoader!;
    pending = Promise.resolve().then(() => loader(index)).then((mesh) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      geometry.computeVertexNormals();
      // The cubes' ramp: blue at the base, yellow in the middle, red at the tip, on
      // the sequence's fixed height scale (sRGB, as the voxel shader decodes it).
      const colours = new Float32Array(mesh.positions.length);
      const colour = new THREE.Color();
      const [lo, hi] = zRange;
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const t = Math.min(Math.max((mesh.positions[i + 2] - lo) / Math.max(hi - lo, 1e-6), 0), 1);
        colour.setRGB(Math.min(t * 2, 1), Math.max(0, 1 - Math.abs(t - 0.5) * 2), Math.max(0, 1 - t), THREE.SRGBColorSpace);
        colours[i] = colour.r; colours[i + 1] = colour.g; colours[i + 2] = colour.b;
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
      return geometry;
    });
    this.surfaces.set(index, pending);
    void pending.catch(() => { if (this.surfaces.get(index) === pending) this.surfaces.delete(index); });
    while (this.surfaces.size > SURFACE_CACHE) {
      const [oldest, geometry] = this.surfaces.entries().next().value as [number, Promise<THREE.BufferGeometry>];
      this.surfaces.delete(oldest);
      // The surface on screen stays until it is replaced, and is freed then.
      if (oldest === this.surfaceIndex) this.surfaceEvicted = true;
      else void geometry.then((g) => g.dispose(), () => undefined);
    }
    return pending;
  }

  private async showSurface(index: number): Promise<void> {
    const generation = this.surfaceGeneration;
    if (!this.surfaceLoader || index < 0) {
      this.surface.visible = false;
      this.dirty = true;
      return;
    }
    const pending = this.geometry(index);
    try {
      const geometry = await pending;
      // Replaced caches own disposal of obsolete completions. Never reattach them.
      if (generation !== this.surfaceGeneration || this.disposed || this.surfaces.get(index) !== pending) return;
      if (this.frameIndex !== index || this.look !== 'surface') return;
      this.replaceSurface(geometry, index);
    } catch (error) {
      if (generation !== this.surfaceGeneration || this.disposed) return;
      if (this.frameIndex === index) { this.surface.visible = false; this.dirty = true; }
      throw error;
    }
  }

  private replaceSurface(geometry: THREE.BufferGeometry, index: number): void {
    if (this.surfaceEvicted || this.surfaceIndex < 0) {
      this.surface.geometry.dispose();
      this.surfaceEvicted = false;
    }
    this.surface.geometry = geometry;
    this.surfaceIndex = index;
    this.surface.visible = this.look === 'surface';
    this.dirty = true;
  }
  get cubeCount(): number { return this.flame.cubeCount; }
  get currentFrame(): number { return this.frameIndex; }

  /** Frame the whole site, or the flame from the side of the first camera. */
  setView(view: SceneView): void {
    const box = view === 'flame' && !this.flameBounds.isEmpty() ? this.flameBounds.clone() : this.siteBounds.clone();
    if (view === 'flame') box.expandByScalar(0.15);
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, view === 'flame' ? 0.3 : 0.5);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * (view === 'flame' ? 0.95 : 0.6);
    // The whole site from the side the cameras stand on, low enough to see under a hood.
    const direction = view === 'flame' ? this.lookFrom.clone() : this.siteSide.clone();
    this.camera.position.copy(centre).addScaledVector(direction, distance);
    this.controls.target.copy(centre);
    this.camera.near = Math.max(distance / 500, 0.01);
    this.camera.far = distance * 50;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.dirty = true;
  }

  private resize(): void {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private animate = (): void => {
    this.request = requestAnimationFrame(this.animate);
    this.controls.update();
    if (!this.dirty) return;
    this.dirty = false;
    this.render();
  };

  render(): void {
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  /** The view at the board's camera pose, `width` x `height` pixels, for a video or
   *  PNG frame. A second renderer, so the board's own canvas keeps its size. */
  renderTo(width: number, height: number): HTMLCanvasElement {
    if (!this.exportRenderer) {
      this.exportRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      this.exportRenderer.setPixelRatio(1);
    }
    this.exportRenderer.setSize(width, height, false);
    this.exportRenderer.render(this.scene, this.exportCamera(width, height));
    return this.exportRenderer.domElement;
  }

  /** The visible labels (cameras, the fire) where `renderTo` puts them. */
  labelsAt(width: number, height: number): { text: string; x: number; y: number }[] {
    const camera = this.exportCamera(width, height);
    const out: { text: string; x: number; y: number }[] = [];
    this.scene.updateMatrixWorld();
    this.scene.traverseVisible((o) => {
      if (!(o instanceof CSS2DObject) || !o.element.textContent) return;
      const p = o.getWorldPosition(new THREE.Vector3()).project(camera);
      if (p.z > 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) return;
      out.push({ text: o.element.textContent, x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height });
    });
    return out;
  }

  private exportCamera(width: number, height: number): THREE.PerspectiveCamera {
    const camera = this.camera.clone();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    return camera;
  }

  private clear(group: THREE.Group): void {
    group.traverse((o) => {
      if (o instanceof CSS2DObject) o.element.remove();
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose?.();
    });
    group.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.request);
    this.observer.disconnect();
    this.controls.dispose();
    this.clear(this.site);
    this.flame.dispose();
    this.setSurfaces(null);
    this.surface.geometry.dispose();
    (this.surface.material as THREE.Material).dispose();
    this.exportRenderer?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelRenderer.domElement.remove();
  }
}
