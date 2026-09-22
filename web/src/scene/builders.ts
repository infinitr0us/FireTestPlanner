/**
 * Plan objects -> Three.js groups.
 *
 * Every builder returns a Group already placed at the object's transform, tagged
 * with `userData.planId` so picking can map a hit back to the document.
 *
 * Note on axes: the world is Z-up (CONVENTIONS.md section 1) but Three's built-in
 * cylinder and cone geometries are generated along +Y, so anything upright needs a
 * +90 degrees rotation about X applied to the GEOMETRY (not the mesh) -- doing it on
 * the mesh would fight the object's own transform.
 */

import * as THREE from 'three';
import { DEVICE_COLORS } from '../core/visual';

import {
  beadOffsetsOf,
  burnerDiameterM,
  burnerFlameHeightM,
  burnerVirtualOriginM,
  cameraColor,
  fuelSurfaceZM,
  gaugeViewAngleDeg,
  imagePlaneExtents,
  plumeRadiusAtZ,
  positionOf,
  quatOf,
  rimHeightM,
  standoffM,
  displayName,
  flameManifest,
  hasObjectColor,
  objectColor,
} from '../core/plan';
import type {
  BurnerObject,
  CameraObject,
  CeilingObject,
  HeatFluxSensorObject,
  HoodObject,
  ObstructionObject,
  PlanObject,
  ReconstructedFlameObject,
  ThermocoupleObject,
  WallObject,
} from '../core/types';
import { makeLabel } from './labels';

export const COLORS = {
  burner: 0x8b5cf6,
  pan: 0x475569,
  flame: 0xf59e0b,
  plume: 0x64748b,
  hood: 0x38bdf8,
  duct: 0x0ea5e9,
  wall: 0x94a3b8,
  ceiling: 0xcbd5e1,
  obstruction: 0x78716c,
  cameraBody: 0x334155,
  heatFlux: Number(DEVICE_COLORS.heatFlux.replace('#', '0x')),
  thermocouple: Number(DEVICE_COLORS.temperature.replace('#', '0x')),
  instrumentBody: 0x334155,
};

/** Layer 1 holds editor-only furniture (grid, gizmo, dimensions) so the camera
 *  preview can exclude it and show only what the real camera would see. */
export const LAYER_DEFAULT = 0;
export const LAYER_EDITOR = 1;
/**
 * Ceilings get a layer of their own. Plan mode hides them -- a floor plan is cut
 * below the ceiling, and the slab would otherwise cover everything the top-down
 * view is for -- but that is a choice about the EDITOR'S camera, not about the
 * room. The camera preview renders the same scene, and a modelled camera looking
 * up at a ceiling has to keep seeing it whichever view the editor is in; leaving
 * ceilings out of the scene in plan mode made the preview show empty sky.
 */
export const LAYER_CEILING = 2;

const upright = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
  g.rotateX(Math.PI / 2);
  return g;
};

function applyTransform(group: THREE.Group, obj: PlanObject): void {
  const p = positionOf(obj);
  group.position.set(p[0], p[1], p[2]);
  const q = quatOf(obj);
  group.quaternion.set(q[0], q[1], q[2], q[3]);
  group.userData.planId = obj.id;
  group.visible = obj.display?.visible !== false;
}

function setEditorLayer(o: THREE.Object3D): void {
  o.traverse((child) => child.layers.set(LAYER_EDITOR));
}

// -- burner ---------------------------------------------------------------

export function buildBurner(b: BurnerObject, showFlame: boolean): THREE.Group {
  const group = new THREE.Group();
  applyTransform(group, b);

  const rim = Math.max(rimHeightM(b), 0.02);
  const panMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.pan,
    metalness: 0.6,
    roughness: 0.5,
  });

  let pan: THREE.Mesh;
  if (b.footprint.shape === 'circle') {
    const r = (b.footprint.diameter_m ?? 0.3) / 2;
    pan = new THREE.Mesh(upright(new THREE.CylinderGeometry(r, r, rim, 48)), panMaterial);
  } else {
    const [w, d] = b.footprint.size_m ?? [0.3, 0.3];
    pan = new THREE.Mesh(new THREE.BoxGeometry(w, d, rim), panMaterial);
  }
  pan.position.z = rim / 2;
  pan.castShadow = true;
  group.add(pan);

  if (showFlame) {
    const flameHeight = burnerFlameHeightM(b);
    if (flameHeight !== null && flameHeight > 0) {
      const dEff = burnerDiameterM(b);
      // Cone from the fuel surface to the mean flame tip. Translucent because it is
      // a correlation, not an observation -- it should not read as solid geometry.
      const flame = new THREE.Mesh(
        upright(new THREE.ConeGeometry(dEff / 2, flameHeight, 32, 1, true)),
        new THREE.MeshBasicMaterial({
          color: COLORS.flame,
          transparent: true,
          opacity: 0.35,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      flame.position.z = rim + flameHeight / 2;
      group.add(flame);

      group.add(buildPlume(b, flameHeight));
    }
  }

  const label = makeLabel(displayName(b), 'object');
  label.position.set(0, 0, rim + 0.15);
  group.add(label);

  return group;
}

/**
 * Plume cone above the flame, opening from the Heskestad virtual origin.
 *
 * Drawn as a wireframe rather than a surface: it is the boundary used for the hood
 * capture check, and a solid cone would imply more certainty than a 15 degree rule
 * of thumb deserves.
 */
function buildPlume(b: BurnerObject, flameHeight: number): THREE.Object3D {
  const group = new THREE.Group();
  const z0 = burnerVirtualOriginM(b);
  if (z0 === null) return group;

  const base = fuelSurfaceZM(b);
  const top = base + Math.max(flameHeight * 2.5, flameHeight + 1.5);
  const rings = 6;
  const material = new THREE.LineBasicMaterial({
    color: COLORS.plume,
    transparent: true,
    opacity: 0.5,
  });

  for (let i = 1; i <= rings; i += 1) {
    const z = base + ((top - base) * i) / rings;
    const r = plumeRadiusAtZ(b, z);
    if (r === null || r <= 0) continue;
    const pts: THREE.Vector3[] = [];
    for (let a = 0; a <= 48; a += 1) {
      const t = (a / 48) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(t) * r, Math.sin(t) * r, z - positionOf(b)[2]));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material));
  }

  // Four generatrices, so the cone reads as a cone from any angle.
  const rTop = plumeRadiusAtZ(b, top) ?? 0;
  const apexZ = base + z0 - positionOf(b)[2];
  for (let a = 0; a < 4; a += 1) {
    const t = (a / 4) * Math.PI * 2;
    const pts = [
      new THREE.Vector3(0, 0, apexZ),
      new THREE.Vector3(Math.cos(t) * rTop, Math.sin(t) * rTop, top - positionOf(b)[2]),
    ];
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material));
  }

  return group;
}

// -- hood -----------------------------------------------------------------

/** Shell between a bottom and a top rectangle, both centred on the local axis. */
function rectFrustum(
  bottom: [number, number],
  bottomZ: number,
  top: [number, number],
  topZ: number,
): THREE.BufferGeometry {
  const [bw, bd] = [bottom[0] / 2, bottom[1] / 2];
  const [tw, td] = [top[0] / 2, top[1] / 2];
  const b = [
    [-bw, -bd, bottomZ], [bw, -bd, bottomZ], [bw, bd, bottomZ], [-bw, bd, bottomZ],
  ];
  const t = [
    [-tw, -td, topZ], [tw, -td, topZ], [tw, td, topZ], [-tw, td, topZ],
  ];
  const verts: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4;
    verts.push(...b[i], ...b[j], ...t[j]);
    verts.push(...b[i], ...t[j], ...t[i]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.computeVertexNormals();
  return g;
}

export function buildHood(h: HoodObject): THREE.Group {
  const group = new THREE.Group();
  applyTransform(group, h);

  const [w, d] = h.opening_m;
  const skirt = h.skirtDepth_m ?? 0;
  // Local to the group, which `applyTransform` has already placed: the world-space
  // intake `hoodIntakeHeightM` reports is this plus the transform's Z.
  const intake = h.height_m - skirt;
  const ductD = h.duct?.diameter_m ?? Math.min(w, d) * 0.25;
  const apexRise = Math.max(Math.min(w, d) * 0.45, 0.4);

  const shellMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.hood,
    metalness: 0.3,
    roughness: 0.7,
    transparent: true,
    opacity: 0.28,
    side: THREE.DoubleSide,
  });

  // Canopy: opening rectangle tapering up to the duct throat.
  group.add(new THREE.Mesh(
    rectFrustum([w, d], h.height_m, [ductD, ductD], h.height_m + apexRise),
    shellMaterial,
  ));

  // Skirt: a straight collar hanging below the opening. It lowers the plane the
  // plume must reach, which is why the capture check uses `intake`, not `height_m`.
  if (skirt > 0) {
    group.add(new THREE.Mesh(rectFrustum([w, d], intake, [w, d], h.height_m), shellMaterial));
  }

  if (h.duct) {
    const len = h.duct.length_m ?? 2;
    const duct = new THREE.Mesh(
      upright(new THREE.CylinderGeometry(ductD / 2, ductD / 2, len, 24, 1, true)),
      new THREE.MeshStandardMaterial({
        color: COLORS.duct,
        metalness: 0.5,
        roughness: 0.6,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
      }),
    );
    duct.position.z = h.height_m + apexRise + len / 2;
    group.add(duct);
  }

  // Hard outline on the intake rectangle: it is the plane the capture check judges,
  // so it should be readable even through the translucent shell.
  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-w / 2, -d / 2, intake),
      new THREE.Vector3(w / 2, -d / 2, intake),
      new THREE.Vector3(w / 2, d / 2, intake),
      new THREE.Vector3(-w / 2, d / 2, intake),
    ]),
    new THREE.LineBasicMaterial({ color: COLORS.hood }),
  );
  group.add(outline);

  const label = makeLabel(displayName(h), 'object');
  label.position.set(0, 0, h.height_m + apexRise + 0.2);
  group.add(label);

  return group;
}

// -- wall -----------------------------------------------------------------

/**
 * Wall run as a chain of boxes, with openings cut by splitting each segment.
 *
 * Openings are positioned by arc length from the polyline start, so an opening can
 * straddle a corner; this builder clips each opening to the segment it overlaps
 * rather than pretending it cannot happen.
 */
export function buildWall(wall: WallObject): THREE.Group {
  const group = new THREE.Group();
  applyTransform(group, wall);

  const thickness = wall.thickness_m ?? 0.1;
  const base = wall.baseHeight_m ?? 0;
  const height = wall.height_m;
  const material = new THREE.MeshStandardMaterial({
    color: COLORS.wall,
    roughness: 0.9,
    metalness: 0,
  });

  const pts = wall.polyline_m;
  const openings = (wall.openings ?? []).slice().sort((a, b) => a.offset_m - b.offset_m);

  let travelled = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1e-9) continue;
    const angle = Math.atan2(dy, dx);

    // Openings overlapping this segment, in segment-local coordinates.
    const local = openings
      .map((o) => ({
        start: Math.max(0, o.offset_m - travelled),
        end: Math.min(segLen, o.offset_m + o.width_m - travelled),
        sill: o.sillHeight_m ?? 0,
        head: (o.sillHeight_m ?? 0) + o.height_m,
      }))
      .filter((o) => o.end > o.start);

    const addBox = (from: number, to: number, zFrom: number, zTo: number): void => {
      const len = to - from;
      const h = zTo - zFrom;
      if (len <= 1e-9 || h <= 1e-9) return;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, thickness, h), material);
      const mid = (from + to) / 2;
      mesh.position.set(
        x0 + Math.cos(angle) * mid,
        y0 + Math.sin(angle) * mid,
        (zFrom + zTo) / 2,
      );
      mesh.rotation.z = angle;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    };

    let cursor = 0;
    for (const o of local) {
      addBox(cursor, o.start, base, base + height);          // solid before
      addBox(o.start, o.end, base, base + Math.min(o.sill, height));            // sill
      addBox(o.start, o.end, base + Math.min(o.head, height), base + height);   // lintel
      cursor = o.end;
    }
    addBox(cursor, segLen, base, base + height);

    travelled += segLen;
  }

  return group;
}

// -- obstruction ----------------------------------------------------------

/**
 * A box standing on its base.
 *
 * The origin is the centre of the base (CONVENTIONS section 5a), so the mesh is
 * offset up by half its height rather than centred on the transform -- which is what
 * makes dragging one along the floor keep it on the floor, and what makes the rotate
 * gizmo yaw it about its own axis rather than swing it around a point in the air.
 *
 * A wire outline on top of the solid: an obstruction is usually in the way of
 * something, and its edges are what you are judging when you decide whether a camera
 * can see past it.
 */
export function buildObstruction(o: ObstructionObject): THREE.Group {
  const group = new THREE.Group();
  applyTransform(group, o);

  const [dx, dy, dz] = o.size_m;
  const geometry = new THREE.BoxGeometry(Math.max(dx, 1e-4), Math.max(dy, 1e-4), Math.max(dz, 1e-4));
  const color = new THREE.Color(hasObjectColor(o) ? objectColor(o) : COLORS.obstruction);

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05 }),
  );
  mesh.position.z = dz / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: color.clone().multiplyScalar(0.55) }),
  );
  edges.position.z = dz / 2;
  group.add(edges);

  const label = makeLabel(displayName(o), 'object');
  label.position.set(0, 0, dz + 0.15);
  group.add(label);

  return group;
}

// -- reconstructed flame ------------------------------------------------------

/**
 * The light half of a reconstructed flame: what the content root holds.
 *
 * The voxels are drawn by `FlameLayer` (scene/flame.ts), which survives rebuilds;
 * this group is what a rebuild is allowed to throw away. It is placed at the
 * object's transform like any other group, so the gizmo, the selection box and
 * `pick` treat the flame as an object, and it carries an invisible box over the
 * manifest's bounds so those three have something to hit and to fit. Without a
 * manifest -- a link not yet made -- a small wireframe marks the spot.
 *
 * The box is the envelope of every frame, not a surface anyone can see, so it is
 * marked `selectionOnly`: a click selects the flame through it, but the measure
 * tool looks past it to the room, or the ruler would snap to the top of an
 * invisible box over an empty frame. The placeholder is marked the same way: it
 * is an editor marker for a link not yet made, not a 0.25 m cube in the room, and
 * a ruler that landed on its top read 0.25 m where the floor is.
 */
export function buildFlameProxy(f: ReconstructedFlameObject): THREE.Group {
  const group = new THREE.Group();
  applyTransform(group, f);

  const bounds = flameManifest(f)?.bounds_m;
  if (bounds) {
    const [lo, hi] = bounds;
    const size = [0, 1, 2].map((a) => Math.max(hi[a] - lo[a], 1e-3));
    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(size[0], size[1], size[2]),
      // Never drawn, only picked: colour and depth both stay untouched.
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
    );
    hit.position.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
    hit.renderOrder = -1;
    hit.userData.selectionOnly = true;
    group.add(hit);
    const label = makeLabel(displayName(f), 'object');
    label.position.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2] + 0.15);
    group.add(label);
  } else {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 0.25, 0.25),
      new THREE.MeshStandardMaterial({ color: COLORS.flame, wireframe: true }),
    );
    mesh.position.z = 0.125;
    mesh.userData.selectionOnly = true;
    group.add(mesh);
    const label = makeLabel(displayName(f), 'object');
    label.position.set(0, 0, 0.4);
    group.add(label);
  }
  return group;
}

// -- ceiling --------------------------------------------------------------

/**
 * Slab extruded upward from its underside.
 *
 * Translucent because an opaque ceiling would hide the entire scene the moment
 * you orbit above it; plan mode hides ceilings outright, the way a floor plan does.
 *
 * The slab is pushed back a fraction in the depth buffer, because a wall whose top
 * is level with a ceiling's is not a corner case -- it is the normal way a room is
 * built, and it is exactly what the sample FDS import produces (walls to z = 2.5,
 * ceiling slab 2.4 to 2.5). Two faces at one depth flicker against each other as
 * the camera moves, which reads as the wall tops "flashing" during an orbit. The
 * bias is in depth only: nothing moves, and the solid wins the tie, which is the
 * right way round for an opaque wall under a glassy roof. Same reasoning as the
 * floor plane's -0.005 nudge in viewport.ts, one buffer down.
 */
export function buildCeiling(c: CeilingObject): THREE.Group {
  const group = new THREE.Group();
  applyTransform(group, c);

  const shape = new THREE.Shape();
  c.polygon_m.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  shape.closePath();

  const thickness = c.thickness_m ?? 0.1;
  const slab = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false }),
    new THREE.MeshStandardMaterial({
      color: COLORS.ceiling,
      roughness: 0.95,
      metalness: 0,
      transparent: true,
      opacity: 0.32,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  );
  slab.position.z = c.height_m;
  group.add(slab);

  // Hard outline on the soffit: that is the plane the impingement check judges.
  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      c.polygon_m.map(([x, y]) => new THREE.Vector3(x, y, c.height_m)),
    ),
    new THREE.LineBasicMaterial({ color: COLORS.ceiling }),
  );
  group.add(outline);

  const centroid = c.polygon_m.reduce(
    (acc, [x, y]) => [acc[0] + x / c.polygon_m.length, acc[1] + y / c.polygon_m.length],
    [0, 0],
  );
  const label = makeLabel(displayName(c), 'object');
  label.position.set(centroid[0], centroid[1], c.height_m + thickness + 0.15);
  group.add(label);

  // The whole slab, label included, on the ceiling layer: the editor's plan camera
  // switches the layer off, every other camera -- and the preview -- keeps it on.
  group.traverse((o) => o.layers.set(LAYER_CEILING));

  return group;
}

// -- instruments ----------------------------------------------------------

/**
 * Heat flux gauge: barrel, sensing face, and the direction it looks.
 *
 * Drawn on the camera convention — the face points down local -Z — because that
 * is how the file stores it and how `heatFluxEstimate` reads it. The aim ray is
 * the gauge's equivalent of a frustum: the whole question about a gauge is what
 * it is pointed at, and cos(theta) is a first-order term in what it will read.
 */
export function buildHeatFluxSensor(s: HeatFluxSensorObject): THREE.Group {
  const group = new THREE.Group();
  applyTransform(group, s);

  const face = new THREE.Color(COLORS.heatFlux);
  const bodyLength = 0.09;
  const radius = 0.022;

  // Barrel behind the face, so the object origin IS the sensing surface: that is
  // the point every distance in the estimate is measured from.
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, bodyLength, 20),
    new THREE.MeshStandardMaterial({ color: COLORS.instrumentBody, metalness: 0.6, roughness: 0.4 }),
  );
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = bodyLength / 2;
  group.add(barrel);

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 0.95, 20),
    new THREE.MeshBasicMaterial({ color: face, side: THREE.DoubleSide }),
  );
  disc.position.z = -0.001; // just proud of the barrel end, so it is never z-fought
  group.add(disc);

  // A water-cooled gauge has hoses; two short stubs read as "plumbed" at a glance
  // and distinguish it from a bare thermopile without needing a label.
  if (s.gauge?.waterCooled) {
    for (const side of [-1, 1]) {
      const hose = new THREE.Mesh(
        new THREE.CylinderGeometry(0.006, 0.006, 0.07, 8),
        new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.8 }),
      );
      hose.rotation.z = Math.PI / 2;
      hose.position.set(side * 0.035, 0, bodyLength * 0.9);
      group.add(hose);
    }
  }

  group.add(buildGaugeAim(s, face));

  const label = makeLabel(displayName(s), 'object', `#${face.getHexString()}`);
  label.position.set(0, 0.1, 0);
  group.add(label);

  return group;
}

/** Acceptance cone for a view-limited gauge, or a plain sight line for an open
 *  hemispherical one — where a cone would claim a restriction that is not there. */
function buildGaugeAim(s: HeatFluxSensorObject, color: THREE.Color): THREE.Object3D {
  const group = new THREE.Group();
  const reach = 0.6;
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 });
  const viewAngle = gaugeViewAngleDeg(s);

  if (viewAngle >= 180) {
    const sight = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -reach),
      ]),
      material,
    );
    group.add(sight);
  } else {
    const r = Math.tan(((viewAngle / 2) * Math.PI) / 180) * reach;
    const rim: THREE.Vector3[] = [];
    for (let i = 0; i <= 32; i += 1) {
      const t = (i / 32) * Math.PI * 2;
      rim.push(new THREE.Vector3(Math.cos(t) * r, Math.sin(t) * r, -reach));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rim), material));

    const spokes: THREE.Vector3[] = [];
    for (let i = 0; i < 4; i += 1) {
      const t = (i / 4) * Math.PI * 2;
      spokes.push(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(Math.cos(t) * r, Math.sin(t) * r, -reach),
      );
    }
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(spokes), material));
  }

  setEditorLayer(group);
  return group;
}

/**
 * Thermocouple rake: a support rod with a bead at each offset.
 *
 * One bead is the same object as twelve, so this draws both. Offsets run along
 * local +Z, which puts them through the group transform and means a leaning rake
 * leans here exactly as it does in the readout.
 */
export function buildThermocouple(t: ThermocoupleObject): THREE.Group {
  const group = new THREE.Group();
  applyTransform(group, t);

  const color = new THREE.Color(COLORS.thermocouple);
  const offsets = beadOffsetsOf(t);
  const lo = Math.min(0, ...offsets);
  const hi = Math.max(0, ...offsets);

  // Support rod only where there is something to support. A single bead sitting
  // at the origin gets no rod, because there is no rake -- just a thermocouple.
  if (hi - lo > 1e-6) {
    const rod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.008, hi - lo, 10),
      new THREE.MeshStandardMaterial({ color: COLORS.instrumentBody, metalness: 0.5, roughness: 0.6 }),
    );
    rod.rotation.x = Math.PI / 2;
    rod.position.z = (hi + lo) / 2;
    group.add(rod);
  }

  const beadMaterial = new THREE.MeshStandardMaterial({
    color,
    emissive: color.clone().multiplyScalar(0.35),
    roughness: 0.4,
  });
  const beadRadius = Math.max((t.thermocouple?.beadDiameter_mm ?? 1.5) / 1000, 0.008) * 2.5;
  for (const offset of offsets) {
    const bead = new THREE.Mesh(new THREE.SphereGeometry(beadRadius, 12, 10), beadMaterial);
    bead.position.z = offset;
    group.add(bead);
  }

  const label = makeLabel(displayName(t), 'object', `#${color.getHexString()}`);
  label.position.set(0, 0.08, hi + 0.08);
  group.add(label);

  return group;
}

// -- camera ---------------------------------------------------------------

/**
 * Camera body, frustum and label.
 *
 * The frustum is the point of the whole object: it is drawn from the real sensor
 * and focal length, so 'will this lens see the flame from here' is answered by
 * looking rather than by arithmetic.
 */
export function buildCamera(c: CameraObject, showFrustum: boolean): THREE.Group {
  const group = new THREE.Group();
  applyTransform(group, c);

  const color = new THREE.Color(cameraColor(c));

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.09, 0.09),
    new THREE.MeshStandardMaterial({ color: COLORS.cameraBody, metalness: 0.5, roughness: 0.5 }),
  );
  group.add(body);

  // Lens barrel points down local -Z, the stored view axis.
  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.028, 0.07, 20),
    new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.8), metalness: 0.4, roughness: 0.4 }),
  );
  lens.rotation.x = Math.PI / 2;
  lens.position.z = -0.075;
  group.add(lens);

  // Tripod stem down to the floor, so the mount height is visible in elevation.
  const stemHeight = positionOf(c)[2];
  if (stemHeight > 0.05) {
    const stem = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -stemHeight),
      ]),
      new THREE.LineDashedMaterial({ color: 0x64748b, dashSize: 0.08, gapSize: 0.06 }),
    );
    // Drawn in world orientation, not the camera's, so tilting the camera does not
    // tilt its tripod.
    stem.quaternion.copy(group.quaternion).invert();
    stem.computeLineDistances();
    group.add(stem);
  }

  if (showFrustum) {
    const frustum = buildFrustum(c, color);
    // Editor annotation, not an object in the room: the camera preview must not
    // show other cameras' frustum lines, because a real camera would not see them.
    setEditorLayer(frustum);
    group.add(frustum);
  }

  const label = makeLabel(displayName(c), 'object', `#${color.getHexString()}`);
  label.position.set(0, 0.12, 0);
  group.add(label);

  return group;
}

function buildFrustum(c: CameraObject, color: THREE.Color): THREE.Object3D {
  // Reach far enough to pass the fire without cluttering the scene.
  const far = Math.min(Math.max(standoffM(c) * 1.35, 1.5), 12);
  // The image's own edges -- fx, fy and the principal point -- not a symmetric
  // pyramid from two fields of view. Non-square pixels and an off-centre principal
  // point both move these, and the framing verdict is computed from them.
  const e = imagePlaneExtents(c);
  const left = e.left * far;
  const right = e.right * far;
  const top = e.top * far;
  const bottom = e.bottom * far;

  // Local -Z is forward; local +Y is up.
  const corners = [
    new THREE.Vector3(left, bottom, -far),
    new THREE.Vector3(right, bottom, -far),
    new THREE.Vector3(right, top, -far),
    new THREE.Vector3(left, top, -far),
  ];
  const apex = new THREE.Vector3(0, 0, 0);

  const pts: THREE.Vector3[] = [];
  for (const corner of corners) pts.push(apex.clone(), corner.clone());
  for (let i = 0; i < 4; i += 1) pts.push(corners[i].clone(), corners[(i + 1) % 4].clone());

  const group = new THREE.Group();
  group.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }),
  ));

  // Faint image plane, so overlapping fields of view are legible at a glance.
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(right - left, top - bottom),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.07,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  plane.position.set((left + right) / 2, (top + bottom) / 2, -far);
  group.add(plane);

  return group;
}

// -- dimensions -----------------------------------------------------------

/**
 * Ground dimension line from the fire to a camera, with its standoff labelled.
 *
 * This is the '9F' callout from the hand sketch, generated rather than drawn --
 * which only works because the origin is the burner (CONVENTIONS.md section 1).
 */
export function buildStandoffDimension(c: CameraObject, unitLabel: string): THREE.Object3D {
  const p = positionOf(c);
  const group = new THREE.Group();

  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0.01),
      new THREE.Vector3(p[0], p[1], 0.01),
    ]),
    new THREE.LineDashedMaterial({ color: 0x0ea5e9, dashSize: 0.15, gapSize: 0.1 }),
  );
  line.computeLineDistances();
  group.add(line);

  const label = makeLabel(unitLabel, 'dimension');
  label.position.set(p[0] / 2, p[1] / 2, 0.05);
  group.add(label);

  setEditorLayer(group);
  return group;
}
