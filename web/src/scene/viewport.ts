/**
 * The 3D viewport.
 *
 * One scene, two cameras. 'Plan mode' is an orthographic top-down view used for
 * drag-placement and dimensioning; '3D mode' is a free perspective orbit. Keeping
 * both on the same scene graph -- rather than pairing a 2D canvas with a separate
 * 3D preview -- means there is nothing to keep in sync and switching views is free.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

import {
  aspectOf,
  burnerDiameterM,
  cameras as planCameras,
  displayName,
  findObject,
  flameTipZM,
  hfovRadOf,
  isCamera,
  positionOf,
  quatOf,
  standoffHorizontalM,
  vfovRadOf,
} from '../core/plan';
import { formatLengthWithUnit, gridStep } from '../core/units';
import { makeLabel } from './labels';
import type {
  BurnerObject,
  CameraObject,
  CeilingObject,
  HoodObject,
  PlanObject,
  WallObject,
} from '../core/types';
import { isOrthoMode, type Store } from '../state/store';
import {
  LAYER_DEFAULT,
  LAYER_EDITOR,
  buildBurner,
  buildCamera,
  buildCeiling,
  buildHood,
  buildStandoffDimension,
  buildWall,
} from './builders';

export type GizmoMode = 'translate' | 'rotate';

export interface ViewportOptions {
  showFrustums: boolean;
  showDimensions: boolean;
  showFlame: boolean;
  showPreview: boolean;
  snap: boolean;
}

/** Half-height of the plan-mode frustum, in world metres before zoom is applied. */
const ORTHO_HALF_HEIGHT = 10;
/** How far above the floor the plan-mode camera sits. Only has to clear the scene. */
const ORTHO_ELEVATION = 60;

const DEFAULT_OPTIONS: ViewportOptions = {
  showFrustums: true,
  showDimensions: true,
  showFlame: true,
  showPreview: true,
  snap: true,
};

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly labelRenderer = new CSS2DRenderer();

  private container: HTMLElement;
  private store: Store;
  private options: ViewportOptions = { ...DEFAULT_OPTIONS };

  private perspective: THREE.PerspectiveCamera;
  private ortho: THREE.OrthographicCamera;
  private orbitPerspective: OrbitControls;
  private orbitOrtho: OrbitControls;
  private gizmo: TransformControls;
  private gizmoHelper: THREE.Object3D;

  /** Groups built from plan objects, keyed by object id. */
  private objectGroups = new Map<string, THREE.Group>();
  private contentRoot = new THREE.Group();
  private furnitureRoot = new THREE.Group();
  private dimensionRoot = new THREE.Group();
  private selectionBox: THREE.BoxHelper | null = null;

  private previewCamera = new THREE.PerspectiveCamera();
  private previewFrame: HTMLElement;

  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private dragging = false;
  private frameHandle = 0;
  private disposed = false;

  /** Proxy the gizmo drives when more than one object is selected. */
  private pivot = new THREE.Object3D();
  private pivotStart = new THREE.Matrix4();
  private dragStart = new Map<string, { position: THREE.Vector3; quaternion: THREE.Quaternion }>();

  private measureRoot = new THREE.Group();
  private measurePoints: THREE.Vector3[] = [];
  /** Completed measurements, kept out of the document: this is a ruler, not a
   *  drawing annotation, and it should not survive a save. */
  private measurements: Array<[THREE.Vector3, THREE.Vector3]> = [];
  measureMode = false;
  onMeasureChange: (count: number) => void = () => {};

  onSelect: (id: string | null, additive: boolean) => void = () => {};
  /** When set, the next viewport click places an object instead of selecting one. */
  placementMode = false;
  onPlace: (point: THREE.Vector3) => void = () => {};

  constructor(container: HTMLElement, store: Store) {
    this.container = container;
    this.store = store;

    // Z-up must be set before any camera is constructed, or the cameras bake in
    // Three's default Y-up and OrbitControls orbits about the wrong axis.
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.classList.add('viewport-canvas');
    container.appendChild(this.renderer.domElement);

    this.labelRenderer.domElement.classList.add('viewport-labels');
    container.appendChild(this.labelRenderer.domElement);

    this.previewFrame = document.createElement('div');
    this.previewFrame.className = 'viewport-preview-frame';
    this.previewFrame.hidden = true;
    container.appendChild(this.previewFrame);

    this.scene.background = new THREE.Color(0x0f172a);
    this.scene.add(this.contentRoot, this.furnitureRoot, this.dimensionRoot, this.measureRoot);
    this.scene.add(this.pivot);

    this.perspective = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
    this.perspective.position.set(-7, -7, 5);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
    this.ortho.position.set(0, 0, ORTHO_ELEVATION);
    this.ortho.up.set(0, 1, 0);

    this.orbitPerspective = new OrbitControls(this.perspective, this.renderer.domElement);
    this.orbitPerspective.enableDamping = true;
    this.orbitPerspective.dampingFactor = 0.12;
    this.orbitPerspective.maxPolarAngle = Math.PI * 0.495; // stop the camera going under the floor
    this.orbitPerspective.target.set(0, 0, 1);

    this.orbitOrtho = new OrbitControls(this.ortho, this.renderer.domElement);
    this.orbitOrtho.enableRotate = false; // plan mode stays plan mode
    this.orbitOrtho.enableDamping = true;
    this.orbitOrtho.dampingFactor = 0.12;
    this.orbitOrtho.screenSpacePanning = true;
    this.orbitOrtho.target.set(0, 0, 0);
    this.orbitOrtho.enabled = false;

    this.gizmo = new TransformControls(this.perspective, this.renderer.domElement);
    this.gizmo.setSpace('world');
    this.gizmoHelper = this.gizmo.getHelper();
    this.gizmoHelper.traverse((o) => o.layers.set(LAYER_EDITOR));
    this.scene.add(this.gizmoHelper);

    this.setupLights();
    this.setupFurniture();
    this.bindEvents();

    this.resize();
    this.rebuild();
    this.tick();
  }

  // -- setup -------------------------------------------------------------

  private setupLights(): void {
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(6, -8, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const s = 15;
    key.shadow.camera.left = -s;
    key.shadow.camera.right = s;
    key.shadow.camera.top = s;
    key.shadow.camera.bottom = -s;
    key.shadow.camera.far = 60;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x93c5fd, 0.5);
    fill.position.set(-8, 6, 4);
    this.scene.add(fill);
  }

  private setupFurniture(): void {
    this.furnitureRoot.clear();

    const size = this.store.document.environment?.floorSize_m ?? [20, 20];
    const extent = Math.max(size[0], size[1]);
    const step = gridStep(this.store.displayUnit);
    const divisions = Math.max(2, Math.round(extent / step));

    const grid = new THREE.GridHelper(divisions * step, divisions, 0x334155, 0x1e293b);
    grid.rotation.x = Math.PI / 2; // GridHelper is XZ by default; the world is Z-up
    this.furnitureRoot.add(grid);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(size[0], size[1]),
      new THREE.MeshStandardMaterial({ color: 0x172033, roughness: 1, metalness: 0 }),
    );
    floor.position.z = -0.005; // just under the grid, so the grid stays visible
    floor.receiveShadow = true;
    this.furnitureRoot.add(floor);

    // Origin marker: the burner centre, and the datum every dimension refers to.
    const axes = new THREE.AxesHelper(0.6);
    this.furnitureRoot.add(axes);

    this.furnitureRoot.traverse((o) => o.layers.set(LAYER_EDITOR));
    // ...except the floor, which is a real surface. Without it the camera preview
    // has no ground reference and reads as objects floating in a void.
    floor.layers.set(LAYER_DEFAULT);
  }

  private bindEvents(): void {
    window.addEventListener('resize', this.resize);

    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.dragging = Boolean(e.value);
      this.activeOrbit.enabled = !this.dragging;
      if (this.dragging) {
        if (this.gizmo.object === this.pivot) this.beginGroupDrag();
      } else {
        // Rebuild only once the drag ends: derived geometry (plume, frustum reach,
        // dimensions) depends on the transform, but rebuilding mid-drag would
        // detach the gizmo from under the pointer every frame.
        this.store.commit();
        this.dragStart.clear();
        this.rebuild();
      }
    });

    this.gizmo.addEventListener('objectChange', () => {
      if (this.gizmo.object === this.pivot) this.applyGroupDrag();
      else this.writeBackGizmo();
    });

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
  }

  // -- interaction -------------------------------------------------------

  private onPointerDown = (event: PointerEvent): void => {
    if (this.dragging || event.button !== 0) return;

    if (this.placementMode) {
      const point = this.screenToGround(event.clientX, event.clientY);
      if (point) this.onPlace(point);
      return;
    }

    if (this.measureMode) {
      const point = this.pickPoint(event.clientX, event.clientY);
      if (point) this.addMeasurePoint(point);
      return;
    }

    const hit = this.pick(event.clientX, event.clientY);
    this.onSelect(hit, event.shiftKey || event.ctrlKey || event.metaKey);
  };

  // -- measuring ---------------------------------------------------------

  setMeasureMode(on: boolean): void {
    this.measureMode = on;
    if (!on) this.measurePoints.length = 0;
    this.redrawMeasurements();
  }

  clearMeasurements(): void {
    this.measurements.length = 0;
    this.measurePoints.length = 0;
    this.redrawMeasurements();
    this.onMeasureChange(0);
  }

  private addMeasurePoint(point: THREE.Vector3): void {
    this.measurePoints.push(point);
    if (this.measurePoints.length === 2) {
      this.measurements.push([this.measurePoints[0], this.measurePoints[1]]);
      this.measurePoints.length = 0;
      this.onMeasureChange(this.measurements.length);
    }
    this.redrawMeasurements();
  }

  private redrawMeasurements(): void {
    this.disposeTree(this.measureRoot);
    const unit = this.store.displayUnit;

    const marker = (p: THREE.Vector3, color: number): THREE.Object3D => {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.045, 12, 8),
        new THREE.MeshBasicMaterial({ color, depthTest: false }),
      );
      dot.position.copy(p);
      dot.renderOrder = 10;
      return dot;
    };

    for (const [a, b] of this.measurements) {
      this.measureRoot.add(marker(a, 0x34d399), marker(b, 0x34d399));

      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicMaterial({ color: 0x34d399, depthTest: false }),
      );
      line.renderOrder = 10;
      this.measureRoot.add(line);

      const distance = a.distanceTo(b);
      const dz = Math.abs(b.z - a.z);
      const label = makeLabel(
        dz > 1e-3
          ? `${formatLengthWithUnit(distance, unit)}  (Δz ${formatLengthWithUnit(dz, unit)})`
          : formatLengthWithUnit(distance, unit),
        'dimension',
      );
      label.position.copy(a).add(b).multiplyScalar(0.5);
      this.measureRoot.add(label);
    }

    // The pending first click of an unfinished measurement.
    for (const p of this.measurePoints) this.measureRoot.add(marker(p, 0xfbbf24));

    this.measureRoot.traverse((o) => o.layers.set(LAYER_EDITOR));
  }

  /** Exact surface point under the cursor, falling back to the floor plane. */
  private pickPoint(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.activeCamera);
    this.raycaster.layers.set(LAYER_DEFAULT);

    const hits = this.raycaster.intersectObjects(this.contentRoot.children, true);
    if (hits.length > 0) return hits[0].point.clone();
    return this.screenToGround(clientX, clientY);
  }

  /** Object id under the cursor, or null. */
  pick(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.activeCamera);
    this.raycaster.layers.set(LAYER_DEFAULT);

    const hits = this.raycaster.intersectObjects(this.contentRoot.children, true);
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        const id = node.userData.planId;
        if (typeof id === 'string') return id;
        node = node.parent;
      }
    }
    return null;
  }

  /** Where a screen point meets the floor plane, in world metres. */
  screenToGround(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.activeCamera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, out) ? out : null;
  }

  /** Push the gizmo's live transform back into the document. */
  private writeBackGizmo(): void {
    const target = this.gizmo.object;
    if (!target) return;
    const id = target.userData.planId as string | undefined;
    if (!id) return;

    this.store.edit(`Move ${id}`, (doc) => {
      const obj = findObject(doc, id);
      if (!obj) return;
      const t = obj.transform ?? (obj.transform = { position_m: [0, 0, 0] });
      t.position_m = [target.position.x, target.position.y, target.position.z];
      if (this.gizmo.getMode() === 'rotate') {
        const q = target.quaternion;
        t.rotation_quat = [q.x, q.y, q.z, q.w];
        // The quaternion is authoritative, so a manual rotation invalidates the
        // recorded intent rather than silently disagreeing with it.
        t.aimTarget_m = null;
      }
    });
    this.refreshSelectionBox();
  }

  setGizmoMode(mode: GizmoMode): void {
    this.gizmo.setMode(mode);
  }

  setOptions(patch: Partial<ViewportOptions>): void {
    this.options = { ...this.options, ...patch };
    this.gizmo.setTranslationSnap(this.options.snap ? gridStep(this.store.displayUnit) / 4 : null);
    this.gizmo.setRotationSnap(this.options.snap ? THREE.MathUtils.degToRad(5) : null);
    this.rebuild();
  }

  getOptions(): ViewportOptions {
    return { ...this.options };
  }

  // -- cameras -----------------------------------------------------------

  /** True only for the top-down view, which is the one that hides ceilings. */
  private get isPlanMode(): boolean {
    return this.store.viewMode === 'plan';
  }

  private get isOrtho(): boolean {
    return isOrthoMode(this.store.viewMode);
  }

  private get activeCamera(): THREE.Camera {
    return this.isOrtho ? this.ortho : this.perspective;
  }

  private get activeOrbit(): OrbitControls {
    return this.isOrtho ? this.orbitOrtho : this.orbitPerspective;
  }

  syncViewMode(): void {
    const ortho = this.isOrtho;
    this.orbitOrtho.enabled = ortho;
    this.orbitPerspective.enabled = !ortho;
    this.gizmo.camera = this.activeCamera;

    if (ortho) this.orientOrthoCamera();
    this.resize();
    // Ceilings are hidden in plan mode, so scene content depends on the mode.
    this.rebuild();
  }

  /**
   * Point the shared orthographic camera along the axis its mode implies.
   *
   * OrbitControls derives orientation from position and target on update, so
   * setting those plus `up` is enough -- no explicit lookAt needed.
   */
  private orientOrthoCamera(): void {
    const target = this.orbitOrtho.target;
    switch (this.store.viewMode) {
      case 'plan':
        this.ortho.up.set(0, 1, 0);
        this.ortho.position.set(target.x, target.y, ORTHO_ELEVATION);
        break;
      case 'front':
        // Looking north (+Y), so the XZ plane faces the viewer.
        this.ortho.up.set(0, 0, 1);
        this.ortho.position.set(target.x, target.y - ORTHO_ELEVATION, target.z);
        break;
      case 'side':
        // Looking east (+X) from the west, so the YZ plane faces the viewer with
        // +Y to the right. Matches the side elevation in the exported drawing.
        this.ortho.up.set(0, 0, 1);
        this.ortho.position.set(target.x - ORTHO_ELEVATION, target.y, target.z);
        break;
      default:
        break;
    }
    this.ortho.updateProjectionMatrix();
  }

  /**
   * Bounds of the physical layout, ignoring frustums.
   *
   * Measuring the rendered geometry would include camera frustums, which reach
   * many metres past everything else -- a single wide-angle camera would zoom the
   * whole view out until the actual equipment was a speck.
   */
  private contentBounds(): THREE.Box3 {
    const box = new THREE.Box3();
    const doc = this.store.document;

    for (const obj of doc.objects) {
      const p = positionOf(obj);
      box.expandByPoint(new THREE.Vector3(p[0], p[1], p[2]));

      if (obj.type === 'burner') {
        const b = obj as BurnerObject;
        const r = burnerDiameterM(b) / 2;
        box.expandByPoint(new THREE.Vector3(p[0] - r, p[1] - r, p[2]));
        box.expandByPoint(new THREE.Vector3(p[0] + r, p[1] + r, flameTipZM(b) ?? p[2] + 1));
      } else if (obj.type === 'hood') {
        const hood = obj as HoodObject;
        const [w, d] = hood.opening_m;
        box.expandByPoint(new THREE.Vector3(p[0] - w / 2, p[1] - d / 2, 0));
        box.expandByPoint(new THREE.Vector3(p[0] + w / 2, p[1] + d / 2, hood.height_m + 1));
      } else if (obj.type === 'wall') {
        const wall = obj as WallObject;
        for (const [x, y] of wall.polyline_m) {
          box.expandByPoint(new THREE.Vector3(p[0] + x, p[1] + y, p[2]));
          box.expandByPoint(new THREE.Vector3(p[0] + x, p[1] + y, p[2] + wall.height_m));
        }
      } else if (obj.type === 'ceiling') {
        const slab = obj as CeilingObject;
        for (const [x, y] of slab.polygon_m) {
          box.expandByPoint(new THREE.Vector3(p[0] + x, p[1] + y, slab.height_m));
        }
      }
    }

    if (box.isEmpty()) {
      box.setFromCenterAndSize(new THREE.Vector3(0, 0, 1), new THREE.Vector3(6, 6, 2));
    }
    return box;
  }

  frameAll(): void {
    const box = this.contentBounds();
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1.5);

    this.orbitPerspective.target.copy(center);
    const dir = new THREE.Vector3(-1, -1, 0.65).normalize();
    this.perspective.position.copy(center).addScaledVector(dir, radius * 2.4);

    // Elevations look at the mid-height of the content; plan looks at the floor.
    this.orbitOrtho.target.set(center.x, center.y, this.isPlanMode ? 0 : center.z);
    this.orientOrthoCamera();

    // Zoom is a ratio of world units, NOT pixels: the frustum is already
    // ORTHO_HALF_HEIGHT world units tall, scaled sideways by the aspect ratio.
    const aspect = Math.max(this.container.clientWidth / Math.max(this.container.clientHeight, 1), 0.01);
    const halfWidth = ORTHO_HALF_HEIGHT * aspect;
    this.ortho.zoom = Math.min(ORTHO_HALF_HEIGHT, halfWidth) / (radius * 1.15);
    this.ortho.updateProjectionMatrix();
  }

  // -- scene construction ------------------------------------------------

  /** Rebuild every group from the document. Cheap at plan scale (tens of objects),
   *  and far less error-prone than diffing the scene graph against the document. */
  rebuild(): void {
    if (this.dragging) return;

    this.gizmo.detach();
    this.disposeTree(this.contentRoot);
    this.disposeTree(this.dimensionRoot);
    this.objectGroups.clear();

    const doc = this.store.document;

    for (const obj of doc.objects) {
      const group = this.buildObject(obj);
      if (!group) continue;
      this.objectGroups.set(obj.id, group);
      this.contentRoot.add(group);
    }

    if (this.options.showDimensions) {
      const unit = this.store.displayUnit;
      for (const cam of planCameras(doc)) {
        this.dimensionRoot.add(
          buildStandoffDimension(cam, formatLengthWithUnit(standoffHorizontalM(cam), unit)),
        );
      }
    }

    this.setupFurniture();
    this.redrawMeasurements(); // labels are rebuilt with the current display unit
    this.syncSelection();
  }

  private buildObject(obj: PlanObject): THREE.Group | null {
    switch (obj.type) {
      case 'burner':
        return buildBurner(obj as never, this.options.showFlame);
      case 'hood':
        return buildHood(obj as never);
      case 'wall':
        return buildWall(obj as never);
      case 'ceiling':
        // Hidden in plan mode, the way a floor plan cuts below the ceiling --
        // otherwise the slab covers everything the top-down view is for.
        return this.isPlanMode ? null : buildCeiling(obj as never);
      case 'camera':
        return buildCamera(obj as never, this.options.showFrustums);
      default:
        // Unknown types still get a placeholder so they can be selected, inspected
        // and deleted rather than being invisible in a plan that clearly has them.
        return this.buildPlaceholder(obj);
    }
  }

  private buildPlaceholder(obj: PlanObject): THREE.Group {
    const group = new THREE.Group();
    const p = positionOf(obj);
    group.position.set(p[0], p[1], p[2]);
    group.userData.planId = obj.id;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 0.25, 0.25),
      new THREE.MeshStandardMaterial({ color: 0x64748b, wireframe: true }),
    );
    group.add(mesh);
    return group;
  }

  // -- selection ---------------------------------------------------------

  syncSelection(): void {
    const selected = this.store.selected.filter((o) => o.display?.locked !== true);

    if (selected.length === 1) {
      const group = this.objectGroups.get(selected[0].id);
      if (group) this.gizmo.attach(group);
      else this.gizmo.detach();
    } else if (selected.length > 1) {
      // Multi-select drives a pivot rather than any one object: the gizmo moves the
      // pivot, and the drag is replayed onto every member as a rigid transform, so
      // the group keeps its internal arrangement.
      const centre = new THREE.Vector3();
      for (const obj of selected) {
        const p = positionOf(obj);
        centre.add(new THREE.Vector3(p[0], p[1], p[2]));
      }
      centre.divideScalar(selected.length);
      this.pivot.position.copy(centre);
      this.pivot.quaternion.identity();
      this.pivot.updateMatrixWorld(true);
      this.gizmo.attach(this.pivot);
    } else {
      this.gizmo.detach();
    }

    this.refreshSelectionBox();
    this.updatePreviewCamera();
  }

  /** Snapshot the transforms a multi-object drag will be applied to. */
  private beginGroupDrag(): void {
    this.pivotStart.copy(this.pivot.matrix);
    this.dragStart.clear();
    for (const obj of this.store.selected) {
      if (obj.display?.locked === true) continue;
      const p = positionOf(obj);
      const q = quatOf(obj);
      this.dragStart.set(obj.id, {
        position: new THREE.Vector3(p[0], p[1], p[2]),
        quaternion: new THREE.Quaternion(q[0], q[1], q[2], q[3]),
      });
    }
  }

  /**
   * Replay the pivot's movement onto every selected object.
   *
   * delta = pivotNow * pivotStart^-1, applied to each object's starting matrix, so
   * rotation carries the members around the pivot instead of spinning them in place.
   */
  private applyGroupDrag(): void {
    if (this.dragStart.size === 0) return;

    const inverse = this.pivotStart.clone().invert();
    const delta = this.pivot.matrix.clone().multiply(inverse);

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const rotating = this.gizmo.getMode() === 'rotate';

    this.store.edit('Move selection', (doc) => {
      for (const [id, start] of this.dragStart) {
        const obj = findObject(doc, id);
        if (!obj) continue;

        const startMatrix = new THREE.Matrix4().compose(
          start.position, start.quaternion, new THREE.Vector3(1, 1, 1),
        );
        delta.clone().multiply(startMatrix).decompose(position, quaternion, scale);

        const t = obj.transform ?? (obj.transform = { position_m: [0, 0, 0] });
        t.position_m = [position.x, position.y, position.z];
        if (rotating) {
          t.rotation_quat = [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
          t.aimTarget_m = null; // a hand rotation invalidates the recorded intent
        }
      }
    });
  }

  private refreshSelectionBox(): void {
    if (this.selectionBox) {
      this.scene.remove(this.selectionBox);
      this.selectionBox.geometry.dispose();
      this.selectionBox = null;
    }
    const ids = this.store.selectedIds;
    if (ids.length === 0) return;
    const group = this.objectGroups.get(ids[0]);
    if (!group) return;
    this.selectionBox = new THREE.BoxHelper(group, 0x38bdf8);
    this.selectionBox.layers.set(LAYER_EDITOR);
    this.scene.add(this.selectionBox);
  }

  // -- camera preview ----------------------------------------------------

  private get previewSource(): CameraObject | null {
    const sole = this.store.soleSelected;
    return sole && isCamera(sole) ? sole : null;
  }

  private updatePreviewCamera(): void {
    const source = this.previewSource;
    const active = Boolean(source) && this.options.showPreview;
    this.previewFrame.hidden = !active;
    if (!source) return;

    // The stored frame IS Three's camera frame -- looks down -Z with +Y up -- so
    // position and orientation copy across with no conversion. That is the whole
    // reason poses are stored in the OpenGL convention (CONVENTIONS.md section 3).
    const p = positionOf(source);
    this.previewCamera.position.set(p[0], p[1], p[2]);
    const q = source.transform?.rotation_quat ?? [0, 0, 0, 1];
    this.previewCamera.quaternion.set(q[0], q[1], q[2], q[3]);
    this.previewCamera.fov = THREE.MathUtils.radToDeg(vfovRadOf(source));
    this.previewCamera.aspect = aspectOf(source);
    this.previewCamera.near = 0.05;
    this.previewCamera.far = 300;
    this.previewCamera.updateProjectionMatrix();

    this.previewFrame.dataset.label =
      `${displayName(source)} — ${THREE.MathUtils.radToDeg(hfovRadOf(source)).toFixed(0)}° × ` +
      `${THREE.MathUtils.radToDeg(vfovRadOf(source)).toFixed(0)}°`;
  }

  private renderPreview(): void {
    const source = this.previewSource;
    if (!source || !this.options.showPreview) return;

    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const pipWidth = Math.min(Math.round(width * 0.28), 420);
    const pipHeight = Math.round(pipWidth / aspectOf(source));
    const margin = 16;
    const x = width - pipWidth - margin;
    const y = margin; // WebGL viewport origin is bottom-left

    Object.assign(this.previewFrame.style, {
      width: `${pipWidth}px`,
      height: `${pipHeight}px`,
      right: `${margin}px`,
      bottom: `${margin}px`,
    });

    // Hide the camera's own body: it sits exactly at the eye point and would fill
    // the frame. Other cameras stay visible, which is useful -- it answers 'is the
    // GoPro standing in the thermal camera's shot?'
    const ownGroup = this.objectGroups.get(source.id);
    const wasVisible = ownGroup?.visible ?? false;
    if (ownGroup) ownGroup.visible = false;

    this.previewCamera.layers.set(LAYER_DEFAULT);
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(x, y, pipWidth, pipHeight);
    this.renderer.setScissor(x, y, pipWidth, pipHeight);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    this.renderer.render(this.scene, this.previewCamera);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, width, height);

    if (ownGroup) ownGroup.visible = wasVisible;
  }

  // -- loop --------------------------------------------------------------

  private resize = (): void => {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;

    this.renderer.setSize(width, height, false);
    this.labelRenderer.setSize(width, height);

    this.perspective.aspect = width / height;
    this.perspective.updateProjectionMatrix();

    const halfWidth = ORTHO_HALF_HEIGHT * (width / height);
    this.ortho.left = -halfWidth;
    this.ortho.right = halfWidth;
    this.ortho.top = ORTHO_HALF_HEIGHT;
    this.ortho.bottom = -ORTHO_HALF_HEIGHT;
    this.ortho.updateProjectionMatrix();
  };

  private tick = (): void => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.tick);

    this.activeOrbit.update();
    if (this.selectionBox) this.selectionBox.update();

    const camera = this.activeCamera;
    // Editor furniture is on its own layer so the camera preview can drop it.
    camera.layers.enableAll();

    this.renderer.setClearColor(0x0f172a, 1);
    this.renderer.setViewport(0, 0, this.container.clientWidth, this.container.clientHeight);
    this.renderer.clear();
    this.renderer.render(this.scene, camera);
    this.labelRenderer.render(this.scene, camera);

    this.renderPreview();
  };

  // -- teardown ----------------------------------------------------------

  private disposeTree(root: THREE.Object3D): void {
    for (const child of [...root.children]) {
      child.traverse((node) => {
        const mesh = node as Partial<THREE.Mesh>;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
        // CSS2DObject keeps a DOM node alive after removal from the scene.
        const element = (node as unknown as { element?: HTMLElement }).element;
        element?.remove();
      });
      root.remove(child);
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    window.removeEventListener('resize', this.resize);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.disposeTree(this.contentRoot);
    this.disposeTree(this.dimensionRoot);
    this.disposeTree(this.furnitureRoot);
    this.disposeTree(this.measureRoot);
    this.gizmo.detach();
    this.gizmo.dispose();
    this.orbitPerspective.dispose();
    this.orbitOrtho.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelRenderer.domElement.remove();
    this.previewFrame.remove();
  }
}
