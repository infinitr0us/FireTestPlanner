import * as THREE from 'three';
import { FdsDeviceLayer } from './fds-devices';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type {
  Bounds,
  ResultCase,
  ResultField,
  ResultFrame,
  ResultMesh,
  ResultPatch,
  XYZ,
} from '../core/fds-results';

export interface SurfaceData {
  positions: Float32Array;
  indices: Uint32Array;
}
const solid = (p: XYZ, mesh: ResultMesh): boolean =>
  mesh.obstructions.some((b) => p.every((v, a) => v > b[2 * a] + 1e-7 && v < b[2 * a + 1] - 1e-7));

/** Each rendered vertex points back into the original Fortran-ordered frame.
 * Cell-centered planes drop the low ghost row/column; nodal planes keep nodes. */
export function resultSurface(mesh: ResultMesh, field: ResultField, patches: ResultPatch[]): SurfaceData {
  const positions: number[] = [],
    indices: number[] = [];
  let offset = 0;
  for (const p of patches) {
    const b = p.bounds;
    const normal = [0, 1, 2].find((a) => b[2 * a] === b[2 * a + 1]);
    if (normal === undefined) throw new Error('Expected a planar scalar field.');
    const axes = [0, 1, 2].filter((a) => a !== normal);
    const [a, c] = axes;
    const dims = [0, 1, 2].map((d) => b[2 * d + 1] - b[2 * d] + 1);
    const index = (v: number[]) => offset + v[0] + dims[0] * (v[1] + dims[1] * v[2]);
    let plane = mesh.coordinates[normal][b[2 * normal]];
    if (field.kind === 'slice' && field.cellCentered) {
      const n = b[2 * normal];
      if (n === 0) throw new Error('A cell-centered plane has no preceding cell.');
      plane = (plane + mesh.coordinates[normal][n - 1]) / 2;
    }
    if (field.kind === 'boundary') plane += Math.sign(p.orientation) * 0.0002;
    // Patch zero is an external mesh face, not an obstruction surface.
    if (field.kind !== 'boundary' || p.obstruction > 0) {
      if (indices.length + (dims[a] - 1) * (dims[c] - 1) * 6 > 6000000)
        throw new Error('Surface exceeds the six-million-vertex display limit.');
      for (let j = 0; j < dims[c] - 1; j++)
        for (let i = 0; i < dims[a] - 1; i++) {
          const corners: XYZ[] = [];
          const raw: number[] = [];
          for (const [u, v] of [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ]) {
            const point: XYZ = [0, 0, 0];
            point[normal] = plane;
            point[a] = mesh.coordinates[a][b[2 * a] + i + u];
            point[c] = mesh.coordinates[c][b[2 * c] + j + v];
            corners.push(point);
            const valueIndex = [0, 0, 0];
            valueIndex[a] = i + (field.cellCentered ? (field.kind === 'slice' ? 1 : 0) : u);
            valueIndex[c] = j + (field.cellCentered ? (field.kind === 'slice' ? 1 : 0) : v);
            raw.push(index(valueIndex));
          }
          const centre = corners[0].map((v, d) => (v + corners[2][d]) / 2) as XYZ;
          if (field.kind === 'slice' && solid(centre, mesh)) continue;
          for (const corner of [0, 1, 2, 0, 2, 3]) {
            positions.push(...corners[corner]);
            indices.push(raw[corner]);
          }
        }
    }
    offset += p.count;
  }
  if (positions.length > 18_000_000) throw new Error('Surface exceeds the six-million-vertex display limit.');
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

const scalarVertex = `attribute float scalar; attribute float valid;
varying float value; varying float present; varying float worldZ;
void main(){value=scalar; present=valid; worldZ=position.z; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const scalarFragment = `uniform float low; uniform float high; uniform float opacity; uniform float clipZ;
varying float value; varying float present; varying float worldZ;
vec3 ramp(float t){return clamp(vec3(1.5-abs(4.*t-3.),1.5-abs(4.*t-2.),1.5-abs(4.*t-1.)),0.,1.);}
void main(){if(present<.999 || worldZ>clipZ)discard; float t=clamp((value-low)/max(high-low,1.e-20),0.,1.); gl_FragColor=vec4(ramp(t),opacity);}`;
interface ScalarView {
  object: THREE.Mesh;
  map: Uint32Array;
  scalar: THREE.BufferAttribute;
  valid: THREE.BufferAttribute;
}

const volumeVertex = `out vec3 localPosition;
void main(){ localPosition=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`;
const volumeFragment = `precision highp float; precision highp sampler3D;
uniform sampler3D volume; uniform vec3 eye; uniform vec3 extent; uniform float cellWidth;
uniform bool soot; uniform bool fire; uniform float fireCutoff; uniform float density; uniform float clipZ; uniform vec3 worldCenter; uniform vec3 texScale; uniform vec3 texBias; in vec3 localPosition; out vec4 outColor;
void main(){
 vec3 dir=normalize(localPosition-eye); vec3 inv=1./dir;
 vec3 a=(-.5-eye)*inv, b=(.5-eye)*inv;
 vec3 lower=min(a,b), upper=max(a,b);
 float enter=max(0.,max(lower.x,max(lower.y,lower.z)));
 float leave=min(upper.x,min(upper.y,upper.z)); if(enter>=leave)discard;
 float stepSize=(leave-enter)/96.; vec4 acc=vec4(0.);
 for(int i=0;i<96;i++){
  vec3 p=eye+dir*(enter+(float(i)+.5)*stepSize);
  if((p*extent+worldCenter).z>clipZ)continue;
  float q=texture(volume,(p+.5)*texScale+texBias).r*255./254.;
  if(fire && q<=fireCutoff)continue;
  float alpha; vec3 color;
  if(soot){alpha=1.-pow(max(1.-q,0.),length(dir*extent)*stepSize/max(cellWidth,.0001)*density); color=vec3(.35,.39,.45);}
  else {alpha=(1.-exp(-q*length(dir*extent)*stepSize*8.*density)); color=fire ? mix(vec3(.9,.12,.01),vec3(1.,.95,.35),q) : clamp(vec3(1.5-abs(4.*q-3.),1.5-abs(4.*q-2.),1.5-abs(4.*q-1.)),0.,1.);}
  acc.rgb+=(1.-acc.a)*alpha*color; acc.a+=(1.-acc.a)*alpha; if(acc.a>.98)break;
 }
 if(acc.a<.002)discard; outColor=vec4(acc.rgb/max(acc.a,.00001),acc.a);
}`;
interface VolumeView {
  object: THREE.Mesh;
  texture: THREE.Data3DTexture;
  mask: Uint8Array;
}

export class FdsResultScene {
  readonly renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
  readonly controls: OrbitControls;
  readonly geometry = new THREE.Group();
  readonly fields = new THREE.Group();
  readonly devices: FdsDeviceLayer;
  private scalarViews = new Map<string, ScalarView>();
  private volumes = new Map<string, VolumeView>();
  private observer: ResizeObserver;
  private request = 0;
  private bounds = new THREE.Box3();
  private clipZ = 1e20;
  constructor(readonly host: HTMLElement) {
    this.scene.background = new THREE.Color('#101b2c');
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute('aria-label', 'Simulation view; Space to play or pause');
    this.renderer.domElement.addEventListener('pointerdown', this.focusCanvas);
    host.append(this.renderer.domElement);
    this.scene.add(this.geometry, this.fields);
    this.devices = new FdsDeviceLayer(this.camera, this.renderer.domElement);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.animate();
  }
  private focusCanvas = (): void => {
    this.renderer.domElement.focus({ preventScroll: true });
  };
  private resize(): void {
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.devices.resize(w, h, this.renderer.getPixelRatio());
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  private animate = (): void => {
    this.request = requestAnimationFrame(this.animate);
    this.controls.update();
    for (const v of this.volumes.values()) {
      const eye = (v.object.material as THREE.ShaderMaterial).uniforms.eye.value as THREE.Vector3;
      v.object.updateWorldMatrix(true, false);
      eye.copy(this.camera.position);
      v.object.worldToLocal(eye);
    }
    this.render();
  };
  render(): void {
    this.renderer.render(this.scene, this.camera);
    this.devices.draw();
  }
  setCase(data: ResultCase): void {
    this.devices.setDevices(data.devices);
    this.clearGroup(this.geometry);
    this.clearFields();
    this.bounds.makeEmpty();
    for (const mesh of data.meshes) {
      this.bounds.union(this.box(mesh.bounds));
      for (const b of mesh.obstructions) {
        const box = this.box(b),
          size = box.getSize(new THREE.Vector3()),
          centre = box.getCenter(new THREE.Vector3());
        const g = new THREE.BoxGeometry(size.x, size.y, size.z);
        const fill = new THREE.Mesh(
          g,
          new THREE.MeshBasicMaterial({
            color: '#8a9bac',
            transparent: true,
            opacity: 0.1,
            depthWrite: false,
          })
        );
        fill.position.copy(centre);
        this.geometry.add(fill);
        const edge = new THREE.LineSegments(
          new THREE.EdgesGeometry(g),
          new THREE.LineBasicMaterial({ color: '#8091a2', transparent: true, opacity: 0.55 })
        );
        edge.position.copy(centre);
        this.geometry.add(edge);
      }
    }
    this.geometry.add(new THREE.Box3Helper(this.bounds, new THREE.Color('#31475e')));
    const axes = new THREE.AxesHelper(0.6);
    this.geometry.add(axes);
    this.resize();
    this.fit();
  }
  private box(b: Bounds): THREE.Box3 {
    return new THREE.Box3(new THREE.Vector3(b[0], b[2], b[4]), new THREE.Vector3(b[1], b[3], b[5]));
  }
  fit(): void {
    const visibleBounds = this.bounds.clone();
    if (this.clipZ > visibleBounds.min.z) visibleBounds.max.z = Math.min(visibleBounds.max.z, this.clipZ);
    const centre = visibleBounds.getCenter(new THREE.Vector3());
    const radius = visibleBounds.getSize(new THREE.Vector3()).length() / 2 || 1;
    const distance =
      radius /
      Math.sin(
        Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * Math.min(1, this.camera.aspect))
      );
    this.controls.target.copy(centre);
    this.camera.position
      .copy(centre)
      .add(new THREE.Vector3(1.2, 1.8, 0.9).normalize().multiplyScalar(distance * 1.08));
    this.camera.near = Math.max(0.001, radius / 1000);
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
  setCutaway(height?: number): void {
    this.clipZ = height ?? 1e20;
    this.devices.setCutaway(this.clipZ);
    this.renderer.clippingPlanes =
      height === undefined ? [] : [new THREE.Plane(new THREE.Vector3(0, 0, -1), height)];
    for (const group of [this.scalarViews, this.volumes])
      for (const view of group.values()) {
        (view.object.material as THREE.ShaderMaterial).uniforms.clipZ.value = this.clipZ;
      }
  }
  clearFields(): void {
    this.clearGroup(this.fields);
    this.scalarViews.clear();
    this.volumes.clear();
  }
  hideFields(): void {
    this.fields.visible = false;
  }
  showFrames(
    entries: { field: ResultField; mesh: ResultMesh; frame: ResultFrame }[],
    low: number,
    high: number,
    opacity: number
  ): void {
    this.fields.visible = true;
    for (const view of this.scalarViews.values()) view.object.visible = false;
    for (const view of this.volumes.values()) view.object.visible = false;
    for (const { field, mesh, frame } of entries) {
      if (field.kind === 'smoke') {
        this.showVolume(field, mesh, frame, opacity);
        continue;
      }
      let view = this.scalarViews.get(field.file);
      if (!view) {
        const surface = resultSurface(mesh, field, frame.patches);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
        const scalar = new THREE.BufferAttribute(new Float32Array(surface.indices.length), 1);
        const valid = new THREE.BufferAttribute(new Float32Array(surface.indices.length), 1);
        g.setAttribute('scalar', scalar);
        g.setAttribute('valid', valid);
        const material = new THREE.ShaderMaterial({
          vertexShader: scalarVertex,
          fragmentShader: scalarFragment,
          uniforms: {
            low: { value: low },
            high: { value: high },
            opacity: { value: opacity },
            clipZ: { value: this.clipZ },
          },
          side: THREE.DoubleSide,
          transparent: true,
          depthWrite: true,
        });
        const object = new THREE.Mesh(g, material);
        this.fields.add(object);
        view = { object, map: surface.indices, scalar, valid };
        this.scalarViews.set(field.file, view);
      }
      view.object.visible = true;
      for (let i = 0; i < view.map.length; i++) {
        const value = frame.values[view.map[i]];
        view.scalar.setX(i, Number.isFinite(value) ? value : 0);
        view.valid.setX(i, Number.isFinite(value) ? 1 : 0);
      }
      view.scalar.needsUpdate = true;
      view.valid.needsUpdate = true;
      const u = (view.object.material as THREE.ShaderMaterial).uniforms;
      u.low.value = low;
      u.high.value = high;
      u.opacity.value = opacity;
    }
  }
  private showVolume(field: ResultField, mesh: ResultMesh, frame: ResultFrame, density: number): void {
    let view = this.volumes.get(field.file);
    if (!view) {
      const b = frame.patches[0].bounds;
      const dims = [0, 1, 2].map((a) => b[2 * a + 1] - b[2 * a] + 1);
      for (let a = 0; a < 3; a++) {
        const c = mesh.coordinates[a],
          step = c[1] - c[0];
        if (c.some((v, i) => i > 0 && Math.abs(v - c[i - 1] - step) > 1e-5))
          throw new Error('Smoke volume preview requires uniform spacing within each mesh.');
      }
      if (
        Math.max(...dims) >
        this.renderer
          .getContext()
          .getParameter((this.renderer.getContext() as WebGL2RenderingContext).MAX_3D_TEXTURE_SIZE)
      )
        throw new Error('Smoke texture exceeds the GPU limit.');
      const mask = new Uint8Array(frame.values.length);
      let p = 0;
      for (let k = b[4]; k <= b[5]; k++)
        for (let j = b[2]; j <= b[3]; j++)
          for (let i = b[0]; i <= b[1]; i++) {
            mask[p++] = solid([mesh.coordinates[0][i], mesh.coordinates[1][j], mesh.coordinates[2][k]], mesh)
              ? 0
              : 1;
          }
      const texture = new THREE.Data3DTexture(new Uint8Array(frame.values.length), dims[0], dims[1], dims[2]);
      texture.format = THREE.RedFormat;
      texture.type = THREE.UnsignedByteType;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.unpackAlignment = 1;
      const bounds = this.box(mesh.bounds),
        extent = bounds.getSize(new THREE.Vector3());
      const material = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: volumeVertex,
        fragmentShader: volumeFragment,
        uniforms: {
          volume: { value: texture },
          eye: { value: new THREE.Vector3() },
          extent: { value: extent },
          clipZ: { value: this.clipZ },
          worldCenter: { value: bounds.getCenter(new THREE.Vector3()) },
          texScale: { value: new THREE.Vector3(...dims.map((n) => (n - 1) / n)) },
          texBias: { value: new THREE.Vector3(...dims.map((n) => 0.5 / n)) },
          cellWidth: { value: mesh.coordinates[0][1] - mesh.coordinates[0][0] },
          soot: { value: (field.extinction ?? 0) > 0 },
          fire: { value: field.quantity.trim().toUpperCase() === 'HRRPUV' },
          // FDS 6.9.1 cons.f90 / smvv.f90: HRRPUV bytes encode 0–1200 kW/m³.
          fireCutoff: { value: (field.fireCutoff ?? 0) / 1200 },
          density: { value: density },
        },
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
      });
      const object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
      object.scale.copy(extent);
      object.position.copy(bounds.getCenter(new THREE.Vector3()));
      this.fields.add(object);
      view = { object, texture, mask };
      this.volumes.set(field.file, view);
    }
    view.object.visible = true;
    const data = view.texture.image.data as Uint8Array;
    for (let i = 0; i < data.length; i++) data[i] = view.mask[i] ? frame.values[i] : 0;
    view.texture.needsUpdate = true;
    (view.object.material as THREE.ShaderMaterial).uniforms.density.value = density;
  }
  private clearGroup(group: THREE.Group): void {
    group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m instanceof THREE.ShaderMaterial)
            (m.uniforms.volume?.value as THREE.Texture | undefined)?.dispose();
          m.dispose();
        }
      }
    });
    group.clear();
  }
  dispose(): void {
    cancelAnimationFrame(this.request);
    this.observer.disconnect();
    this.controls.dispose();
    this.clearFields();
    this.clearGroup(this.geometry);
    this.devices.dispose();
    this.renderer.domElement.removeEventListener('pointerdown', this.focusCanvas);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
