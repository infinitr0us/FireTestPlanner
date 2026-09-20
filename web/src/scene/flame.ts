/**
 * Reconstructed flames in the scene: surface voxels as instanced cubes.
 *
 * Cubes are the honest representation of a visual hull -- the blockiness IS the
 * resolution -- and only the surface cells are drawn, which is a fifth of them.
 * One instance attribute of `(i, j, k)` shorts, sized once for the fullest frame,
 * is refilled on a frame switch: 6 bytes a cube, a few hundred kilobytes for the
 * biggest frame anyone has produced, and one GPU buffer that dies with its
 * geometry. Each frame's cells are extracted on first use and kept, so a second
 * pass through the sequence allocates nothing.
 *
 * The layer owns its meshes across `Viewport.rebuild()`: that runs on every edit
 * and disposes the content root, and re-uploading a sequence per keystroke would
 * stall. What the content root gets is a light proxy per flame (`buildFlameProxy`
 * in builders.ts) that carries the label, answers picks and gives the selection
 * box its bounds; the heavy mesh lives here and follows the proxy's transform.
 */

import * as THREE from 'three';

import { surfaceCells, type FlameSequence, type PackedFrame } from '../core/flame';
import { flameSequenceLink, reconstructedFlames } from '../core/plan';
import type { FlameColorMode, PlanDocument, ReconstructedFlameObject } from '../core/types';
import type { FlameStore } from '../state/flame-store';
import { COLORS, LAYER_DEFAULT } from './builders';

const VERTEX = /* glsl */ `
  attribute vec3 ijk;
  uniform vec3 uOrigin;
  uniform float uPitch;
  uniform vec2 uZRange;
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying float vHeight;
  void main() {
    vec3 centre = uOrigin + ijk * uPitch;
    vec3 p = centre + position * uPitch;
    vPosition = p;
    vHeight = clamp((centre.z - uZRange.x) / max(uZRange.y - uZRange.x, 1e-6), 0.0, 1.0);
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

/**
 * The pipeline's own ramp (`color_voxels_by_height`): blue at the base, yellow in
 * the middle, red at the tip -- on a fixed scale over the sequence, so a small
 * frame is not painted full-scale red. The ramp is an sRGB colour the way the PLYs
 * carry it, so it is decoded before lighting and re-encoded on output.
 */
const FRAGMENT = /* glsl */ `
  // The renderer prepends the colour-space transfer functions to every fragment
  // shader; including colorspace_pars_fragment here would define them twice.
  #include <common>
  #include <alphahash_pars_fragment>
  uniform float uOpacity;
  uniform int uColorMode;
  uniform vec3 uColor;
  varying vec3 vNormal;
  // The alpha-hash chunk declares vPosition itself when it is compiled in.
  #ifndef USE_ALPHAHASH
  varying vec3 vPosition;
  #endif
  varying float vHeight;
  vec3 ramp(float t) {
    return vec3(clamp(t * 2.0, 0.0, 1.0), clamp(1.0 - abs(t - 0.5) * 2.0, 0.0, 1.0), clamp(1.0 - t, 0.0, 1.0));
  }
  void main() {
    vec3 base = uColorMode == 0 ? sRGBTransferEOTF(vec4(ramp(vHeight), 1.0)).rgb : uColor;
    vec3 light = normalize(vec3(0.35, 0.5, 1.0));
    float lambert = max(dot(normalize(vNormal), light), 0.0);
    vec4 diffuseColor = vec4(base * (0.55 + 0.45 * lambert), uOpacity);
    #include <alphahash_fragment>
    gl_FragColor = vec4(diffuseColor.rgb, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Above this many cubes the camera preview is skipped while playing: it renders
 *  the scene a second time per tick, and a laptop does not have the second pass. */
export const PREVIEW_CUBE_LIMIT = 400_000;

/** One flame object's mesh: the sequence it shows, the frame it is on, its look. */
export class FlameMesh {
  readonly group = new THREE.Group();
  private box = new THREE.BoxGeometry(1, 1, 1);
  private geometry: THREE.InstancedBufferGeometry;
  private material: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private ijk: THREE.InstancedBufferAttribute | null = null;
  private cells: (Uint8Array | Uint16Array | null)[] = [];
  private sequence: FlameSequence | null = null;
  private frameIndex = -1;
  /** Cubes on screen now. */
  cubeCount = 0;

  constructor() {
    this.geometry = this.emptyGeometry();
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uOrigin: { value: new THREE.Vector3() },
        uPitch: { value: 0.01 },
        uZRange: { value: new THREE.Vector2(0, 1) },
        uOpacity: { value: 1 },
        uColorMode: { value: 0 },
        uColor: { value: new THREE.Color(COLORS.flame) },
      },
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // Picking goes through the proxy in the content root; a million-instance
    // raycast here would answer every click late.
    this.mesh.raycast = () => {};
    // A flame does not cast a shadow, and the shadow pass over every cube would
    // cost for a wrong picture.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.layers.set(LAYER_DEFAULT);
    this.mesh.frustumCulled = true;
    this.group.add(this.mesh);
    this.setSequence(null);
  }

  /** A unit cube with no instances yet; the instance attribute comes with a sequence. */
  private emptyGeometry(): THREE.InstancedBufferGeometry {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(this.box.getIndex());
    geometry.setAttribute('position', this.box.getAttribute('position'));
    geometry.setAttribute('normal', this.box.getAttribute('normal'));
    geometry.instanceCount = 0;
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    return geometry;
  }

  /** Swap the data behind the mesh. Cells are extracted per frame on first use. */
  setSequence(sequence: FlameSequence | null): void {
    if (sequence === this.sequence) return;
    // A new geometry rather than a new attribute on the old one: disposing the
    // geometry is what frees its GPU buffers, and a swapped-out attribute's is
    // never freed.
    this.geometry.dispose();
    this.geometry = this.emptyGeometry();
    this.mesh.geometry = this.geometry;
    this.ijk = null;
    this.cells = [];
    this.sequence = sequence;
    this.frameIndex = -1;
    this.cubeCount = 0;
    if (!sequence) {
      this.mesh.visible = false;
      return;
    }
    // Sized for the fullest frame: a surface is at most every voxel, so this never
    // grows, and never leaves a replaced buffer behind.
    const capacity = Math.max(1, ...sequence.frames.map((f) => f.count));
    this.ijk = new THREE.InstancedBufferAttribute(new Uint16Array(capacity * 3), 3, false);
    this.ijk.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('ijk', this.ijk);
    this.cells = sequence.frames.map(() => null);
    const [lo, hi] = sequence.bounds;
    const pad = sequence.grid.pitch_m;
    const box = new THREE.Box3(
      new THREE.Vector3(lo[0] - pad, lo[1] - pad, lo[2] - pad),
      new THREE.Vector3(hi[0] + pad, hi[1] + pad, hi[2] + pad),
    );
    // Fixed once from the manifest: the alternative, recomputing from a million
    // instances, is what `BoxHelper.update` would trigger every tick while selected.
    this.geometry.boundingBox = box;
    this.geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    this.material.uniforms.uPitch.value = sequence.grid.pitch_m;
    this.material.uniforms.uZRange.value.set(lo[2], hi[2]);
    this.mesh.visible = true;
  }

  private cellsFor(index: number): Uint8Array | Uint16Array | null {
    if (!this.sequence || index < 0 || index >= this.cells.length) return null;
    let cells = this.cells[index];
    if (cells === null) {
      cells = surfaceCells(this.sequence.frames[index]);
      this.cells[index] = cells;
    }
    return cells;
  }

  /** Show frame `index`, or nothing for -1. Returns whether the frame changed. */
  setFrame(index: number): boolean {
    if (index === this.frameIndex) return false;
    this.frameIndex = index;
    const frame: PackedFrame | undefined = this.sequence?.frames[index];
    const cells = frame ? this.cellsFor(index) : null;
    if (!frame || !cells || !this.sequence || !this.ijk) {
      this.geometry.instanceCount = 0;
      this.cubeCount = 0;
      return true;
    }
    const count = cells.length / 3;
    (this.ijk.array as Uint16Array).set(cells);
    this.ijk.clearUpdateRanges();
    this.ijk.addUpdateRange(0, cells.length);
    this.ijk.needsUpdate = true;
    this.geometry.instanceCount = count;
    this.cubeCount = count;
    const origin = this.sequence.frameOrigin(frame);
    this.material.uniforms.uOrigin.value.set(origin[0], origin[1], origin[2]);
    return true;
  }

  setAppearance(opacity: number, colorMode: FlameColorMode): void {
    const clamped = Math.min(Math.max(opacity, 0), 1);
    this.material.uniforms.uOpacity.value = clamped;
    this.material.uniforms.uColorMode.value = colorMode === 'solid' ? 1 : 0;
    // Hashed transparency: stochastic per fragment, no sorting, and honest about
    // a thousand self-overlapping cubes where sorted blending would not be.
    const hashed = clamped < 1;
    if (this.material.alphaHash !== hashed) {
      this.material.alphaHash = hashed;
      this.material.needsUpdate = true;
    }
  }

  dispose(): void {
    this.setSequence(null);
    this.geometry.dispose();
    this.box.dispose();
    this.material.dispose();
    this.group.removeFromParent();
  }
}

/**
 * Every flame in the document, kept in step with it and with the clock.
 *
 * `sync` is cheap and runs on every rebuild; `setTime` runs on every clock tick
 * and does nothing unless a frame boundary was crossed.
 */
export class FlameLayer {
  readonly root = new THREE.Group();
  private meshes = new Map<string, FlameMesh>();
  private sequenceKeys = new Map<string, string>();
  private time_s = 0;

  constructor(private store: FlameStore) {
    this.root.name = 'flames';
  }

  /** Bring the meshes into line with the document and the loaded sequences. */
  sync(doc: PlanDocument): void {
    const seen = new Set<string>();
    for (const flame of reconstructedFlames(doc)) {
      seen.add(flame.id);
      let mesh = this.meshes.get(flame.id);
      if (!mesh) {
        mesh = new FlameMesh();
        this.meshes.set(flame.id, mesh);
        this.root.add(mesh.group);
      }
      const link = flameSequenceLink(flame);
      const sequence = link ? this.store.sequenceOf(link) ?? null : null;
      mesh.setSequence(sequence);
      this.sequenceKeys.set(flame.id, link ? link.path : '');
      this.applyObject(mesh, flame);
      mesh.setFrame(sequence ? sequence.frameIndexAt(this.time_s) : -1);
    }
    for (const [id, mesh] of this.meshes) {
      if (seen.has(id)) continue;
      mesh.dispose();
      this.meshes.delete(id);
      this.sequenceKeys.delete(id);
    }
  }

  private applyObject(mesh: FlameMesh, flame: ReconstructedFlameObject): void {
    const p = flame.transform?.position_m ?? [0, 0, 0];
    const q = flame.transform?.rotation_quat ?? [0, 0, 0, 1];
    mesh.group.position.set(p[0], p[1], p[2]);
    mesh.group.quaternion.set(q[0], q[1], q[2], q[3]);
    mesh.group.visible = flame.display?.visible !== false;
    mesh.setAppearance(flame.display?.opacity ?? 1, flame.display?.colorMode ?? 'height');
  }

  /**
   * Follow the proxies mid-drag. The gizmo moves the proxy in the content root and
   * the document only learns the new transform when the drag ends, so until then
   * the heavy mesh copies the proxy each tick rather than lagging a drag behind.
   */
  follow(proxies: ReadonlyMap<string, THREE.Object3D>): void {
    for (const [id, mesh] of this.meshes) {
      const proxy = proxies.get(id);
      if (!proxy) continue;
      mesh.group.position.copy(proxy.position);
      mesh.group.quaternion.copy(proxy.quaternion);
    }
  }

  /** Move every flame to the frame showing at `time_s`. Returns whether any changed. */
  setTime(time_s: number, doc: PlanDocument): boolean {
    this.time_s = time_s;
    let changed = false;
    for (const flame of reconstructedFlames(doc)) {
      const mesh = this.meshes.get(flame.id);
      const link = flameSequenceLink(flame);
      const sequence = link ? this.store.sequenceOf(link) : undefined;
      if (!mesh) continue;
      if (mesh.setFrame(sequence ? sequence.frameIndexAt(time_s) : -1)) changed = true;
    }
    return changed;
  }

  /** Cubes on screen across every visible flame. */
  get cubeCount(): number {
    let n = 0;
    for (const mesh of this.meshes.values()) if (mesh.group.visible) n += mesh.cubeCount;
    return n;
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) mesh.dispose();
    this.meshes.clear();
    this.root.removeFromParent();
  }
}
