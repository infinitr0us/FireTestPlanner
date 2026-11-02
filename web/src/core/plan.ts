/**
 * Plan document model and derived geometry. Mirror of python/fireplan/plan.py and
 * objects.py -- the two implementations must agree, since a plan can be authored in
 * either and consumed in either.
 */

import { DEVICE_COLORS } from './visual';
import { testDataChecks } from './test-data';
import { firstOccluder, flameCentrelineSamples } from './occlusion';
import {
  DEFAULT_RADIATIVE_FRACTION,
  POINT_SOURCE_MIN_DIAMETERS,
  effectiveDiameterM,
  flameHeightM,
  plumeCentrelineRiseK,
  plumeRadiusM,
  pointSourceFluxKwM2,
  virtualOriginM,
} from './correlations';
import {
  angleBetweenDeg,
  dot,
  forwardOf,
  IDENTITY_QUAT,
  length,
  normalize,
  quatToColumns,
  rotateVec,
  sub,
  unrotateVec,
} from './math';
import {
  FORMAT,
  FORMAT_VERSION,
  isAimable,
  isBurner,
  isCamera,
  isCeiling,
  isHeatFluxSensor,
  isHood,
  isObstruction,
  isReconstructedFlame,
  isThermocouple,
  isWall,
  maxVersion,
  requiredFormatVersion,
  type BurnerObject,
  type CameraObject,
  type CeilingObject,
  type HeatFluxSensorObject,
  type HoodObject,
  type Issue,
  type LinkedFile,
  type Modality,
  type ObstructionObject,
  type PlanDocument,
  type PlanObject,
  type Quat,
  type ReconstructedFlameObject,
  type TcType,
  type ThermocoupleObject,
  type Vec3,
  type VoxelSequenceManifest,
  type WallObject,
} from './types';

// Re-exported so callers get the whole plan vocabulary from one module rather than
// having to know that narrowing helpers live next door in types.ts.
export {
  isAimable, isBurner, isCamera, isCeiling, isHeatFluxSensor, isHood, isObstruction,
  isReconstructedFlame, isThermocouple, isWall,
} from './types';

export const MODALITY_COLORS: Record<Modality, string> = {
  RGB: '#3b82f6',
  LWIR: '#f97316',
  MWIR: '#a855f7',
  SWIR: '#14b8a6',
  NIR: '#eab308',
  other: '#94a3b8',
};

const nowIso = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export function newPlan(title = 'Untitled fire test'): PlanDocument {
  const now = nowIso();
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    meta: { title, created: now, modified: now },
    units: {
      length: 'm',
      angle: 'rad',
      power: 'kW',
      temperature: 'C',
      display: { length: 'm', angle: 'deg' },
    },
    coordinateSystem: { convention: 'Z-up-right-handed', origin: 'burner-center-floor' },
    environment: { floorSize_m: [20, 20], ambientTemperature_C: 20 },
    objects: [],
  };
}

export function parsePlan(text: string): PlanDocument {
  let data: unknown;
  try {
    // A byte-order mark from a Windows editor is not JSON. A picked file's
    // `Blob.text()` drops it; text that came through the desktop shell or a paste
    // did not, and the same file then opened in one path and not the other.
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }
  if (typeof data !== 'object' || data === null) throw new Error('Plan data must be a JSON object');
  const doc = data as PlanDocument;
  if (doc.format !== FORMAT) {
    throw new Error(`Not a fire test plan: expected format "${FORMAT}", got "${String(doc.format)}"`);
  }
  // Deliberately NOT normalised here. `objects` that is a map rather than a list is
  // a file this format cannot read, and `validateStructure` says so as
  // `bad-objects`; quietly replacing it with an empty list opened the file as a
  // plan with nothing in it and threw the collection away on the next save.
  return doc;
}

// -- access ---------------------------------------------------------------

export const cameras = (d: PlanDocument): CameraObject[] => d.objects.filter(isCamera);
export const burners = (d: PlanDocument): BurnerObject[] => d.objects.filter(isBurner);
export const hoods = (d: PlanDocument): HoodObject[] => d.objects.filter(isHood);
export const walls = (d: PlanDocument): WallObject[] => d.objects.filter(isWall);
export const ceilings = (d: PlanDocument): CeilingObject[] => d.objects.filter(isCeiling);
export const heatFluxSensors = (d: PlanDocument): HeatFluxSensorObject[] =>
  d.objects.filter(isHeatFluxSensor);
export const thermocouples = (d: PlanDocument): ThermocoupleObject[] =>
  d.objects.filter(isThermocouple);

export const obstructions = (d: PlanDocument): ObstructionObject[] =>
  d.objects.filter(isObstruction);
export const reconstructedFlames = (d: PlanDocument): ReconstructedFlameObject[] =>
  d.objects.filter(isReconstructedFlame);

export const findObject = (d: PlanDocument, id: string): PlanObject | undefined =>
  d.objects.find((o) => o.id === id);

/** The burner at the origin -- by definition the one the frame was built around. */
export function primaryBurner(d: PlanDocument): BurnerObject | undefined {
  const all = burners(d);
  if (all.length <= 1) return all[0];
  return all.find((b) => Math.hypot(...positionOf(b).slice(0, 2)) < 1e-6) ?? all[0];
}

/**
 * Every burner with a fire to assess -- an HRR and a footprint -- primary first.
 *
 * A plan can hold several (CONVENTIONS section 1 calls the one at the origin the
 * primary, and an FDS import keeps every face the burner surface burns on), and the
 * scene draws a flame on each. The checks that ask "does this fire reach that
 * surface", "what does this bead sit in" or "what does this gauge receive" have to
 * ask it of every fire, or a second burner is drawn and then silently left out of
 * the verdicts -- a type-T bead half a metre above a megawatt fire was being called
 * "outside the plume" because the plume it was in belonged to the other burner.
 */
export function fireBurners(d: PlanDocument): BurnerObject[] {
  const primary = primaryBurner(d);
  const lit = burners(d).filter((b) => flameTipZM(b) !== null);
  if (!primary || !lit.includes(primary)) return lit;
  return [primary, ...lit.filter((b) => b !== primary)];
}

/** Burners drawn with a fire that the camera framing does not judge. */
export function secondaryBurners(d: PlanDocument): BurnerObject[] {
  const primary = primaryBurner(d);
  return fireBurners(d).filter((b) => b !== primary);
}

// -- reconstructed flames (1.4) ------------------------------------------

/** The one link a flame carries: the folder of voxel frames, with its manifest. */
export const flameSequenceLink = (f: ReconstructedFlameObject): LinkedFile | undefined =>
  f.linkedFiles?.find((l) => l.kind === 'voxelSequence');

export const flameManifest = (f: ReconstructedFlameObject): VoxelSequenceManifest | undefined =>
  flameSequenceLink(f)?.sequence;

/** The burner a flame was reconstructed from: the one it names, else the primary. */
export function flameBurner(d: PlanDocument, f: ReconstructedFlameObject): BurnerObject | undefined {
  if (f.burnerId) {
    const named = findObject(d, f.burnerId);
    if (named && isBurner(named)) return named;
  }
  return primaryBurner(d);
}

/**
 * The eight corners of the manifest's bounding box, in world space.
 *
 * Corners rather than the two extremes because the object's transform may rotate
 * the rig frame onto the plan's, and a rotated box is bounded by its corners.
 */
export function flameBoundsCorners(f: ReconstructedFlameObject): Vec3[] {
  const bounds = flameManifest(f)?.bounds_m;
  if (!bounds) return [];
  const [lo, hi] = bounds;
  const out: Vec3[] = [];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
    out.push(toWorld(f, [x, y, z]));
  }
  return out;
}

export function nextId(d: PlanDocument, prefix: string): string {
  const taken = new Set(d.objects.map((o) => o.id));
  for (let i = 1; ; i += 1) {
    const candidate = `${prefix}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export const positionOf = (o: PlanObject): Vec3 => o.transform?.position_m ?? [0, 0, 0];
/**
 * The object's orientation, always usable.
 *
 * A zero-length quaternion is schema-legal -- the schema says "unit" in prose, and
 * prose is not a constraint -- but every frame helper throws on one, which would
 * cost the user the entire checks list over a single degenerate object. The raw
 * value is still what `checkPlan` reads to report `non-unit-quaternion`, so the
 * data problem is named; here it falls back to the identity so the rest of the
 * plan can still be computed.
 */
export const quatOf = (o: PlanObject): Quat => {
  const q = o.transform?.rotation_quat;
  return q && Math.hypot(q[0], q[1], q[2], q[3]) > 0 ? q : IDENTITY_QUAT;
};
export const displayName = (o: PlanObject): string => o.name || o.id;

// -- object frames --------------------------------------------------------

/**
 * A point in an object's local frame, in world coordinates.
 *
 * `rotation_quat` is part of every object's transform and the 3D view draws it, so
 * checks and drawings have to apply it too -- otherwise a rotated wall is in one
 * place on screen and another in the printed plan. Vertex lists (`polyline_m`,
 * `polygon_m`, hood openings) are all local, so they all go through here.
 */
export function toWorld(o: PlanObject, local: Vec3): Vec3 {
  const r = rotateVec(quatOf(o), local);
  const p = positionOf(o);
  return [p[0] + r[0], p[1] + r[1], p[2] + r[2]];
}

/** A world point in the object's local frame -- the inverse of `toWorld`. */
export function toLocal(o: PlanObject, world: Vec3): Vec3 {
  const p = positionOf(o);
  return unrotateVec(quatOf(o), [world[0] - p[0], world[1] - p[1], world[2] - p[2]]);
}

/** A local footprint vertex `[x, y]` as a world `[x, y]`, dropping height. */
/**
 * The four base corners of an obstruction, in world XY.
 *
 * The box's extents are local, so they go through the object transform like every
 * other vertex list in this format -- a yawed box is drawn yawed in the plan view,
 * not as its unrotated self. Counter-clockwise, so the polygon closes the way the
 * ceiling outline does.
 */
export function obstructionCornersXY(o: ObstructionObject): Array<[number, number]> {
  const [hx, hy] = [o.size_m[0] / 2, o.size_m[1] / 2];
  return ([[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]] as Array<[number, number]>)
    .map((c) => footprintXY(o, c));
}

export function footprintXY(o: PlanObject, xy: readonly [number, number]): [number, number] {
  const w = toWorld(o, [xy[0], xy[1], 0]);
  return [w[0], w[1]];
}

// -- camera ---------------------------------------------------------------

export const resolutionOf = (c: CameraObject): [number, number] => c.camera.resolution_px;

/**
 * Zoom setting, as a multiplier on the effective focal length.
 *
 * Absent, null or non-positive all mean 1. A plan is someone else's file, and a
 * zero here would take every derived quantity to infinity.
 */
export function zoomOf(c: CameraObject): number {
  const z = c.camera.zoomFactor;
  return typeof z === 'number' && Number.isFinite(z) && z > 0 ? z : 1;
}

/**
 * The focal length the image is actually formed at: lens times zoom.
 *
 * Everything derived -- fx, fy, both fields of view, the frustum, the preview,
 * the coverage verdict -- goes through here, so a zoomed camera is zoomed
 * everywhere or nowhere. `focalLength_mm` stays the lens, because that is what a
 * datasheet gives and what the operator screws onto the front.
 */
export const effectiveFocalLengthMm = (c: CameraObject): number =>
  c.camera.focalLength_mm * zoomOf(c);

/** fx = f_eff * res_x / sensor_w, in pixels. */
export const fxOf = (c: CameraObject): number =>
  (effectiveFocalLengthMm(c) * c.camera.resolution_px[0]) / c.camera.sensor_mm[0];

export const fyOf = (c: CameraObject): number =>
  (effectiveFocalLengthMm(c) * c.camera.resolution_px[1]) / c.camera.sensor_mm[1];

/** Null principal point means the OpenCV image centre, ((w-1)/2, (h-1)/2). */
export function principalPointOf(c: CameraObject): [number, number] {
  const pp = c.camera.principalPoint_px;
  if (pp) return [pp[0], pp[1]];
  const [w, h] = c.camera.resolution_px;
  return [(w - 1) / 2, (h - 1) / 2];
}

export const hfovRadOf = (c: CameraObject): number =>
  2 * Math.atan(c.camera.sensor_mm[0] / (2 * effectiveFocalLengthMm(c)));

export const vfovRadOf = (c: CameraObject): number =>
  2 * Math.atan(c.camera.sensor_mm[1] / (2 * effectiveFocalLengthMm(c)));

export const hfovDegOf = (c: CameraObject): number => (hfovRadOf(c) * 180) / Math.PI;
export const vfovDegOf = (c: CameraObject): number => (vfovRadOf(c) * 180) / Math.PI;

export const aspectOf = (c: CameraObject): number =>
  c.camera.resolution_px[0] / c.camera.resolution_px[1];

/**
 * Where the image's edges fall, as tangents: multiply by a depth along the view
 * axis to get metres right, left, up and down of the axis at that depth.
 *
 * Derived from `fx`, `fy` and the principal point -- the same numbers
 * `projectToPixels` uses -- rather than from the two fields of view and the pixel
 * aspect ratio. The two agree only for square pixels and a centred principal
 * point. A camera whose sensor is square but whose image is 2:1 has fx = 2 fy, and
 * a preview built from vfov and aspect showed it seeing 50 percent wider than the
 * framing verdict said it could; an off-centre calibrated principal point shifts
 * the whole frame sideways and a symmetric frustum cannot show that at all. The
 * drawn frustum and the picture-in-picture preview are built from these, so what
 * they show is what `isPointVisible` judges.
 *
 * Edges are at pixel EDGES: the image spans u from -0.5 to W-0.5 under the OpenCV
 * convention (CONVENTIONS section 4). The verdict tests pixel centres, so the
 * preview shows half a pixel more per side than the verdict accepts -- the same
 * half pixel `verticalCoverageM` accounts for.
 */
export function imagePlaneExtents(c: CameraObject): {
  left: number; right: number; top: number; bottom: number;
} {
  const [w, h] = c.camera.resolution_px;
  const [cx, cy] = principalPointOf(c);
  const fx = fxOf(c);
  const fy = fyOf(c);
  return {
    left: (-0.5 - cx) / fx,
    right: (w - 0.5 - cx) / fx,
    // Image v grows downward; the camera's local +Y is up.
    top: (cy + 0.5) / fy,
    bottom: -(h - 0.5 - cy) / fy,
  };
}

/** Slant range to the burner. Trivial only because the origin IS the burner. */
export const standoffM = (c: CameraObject): number => length(positionOf(c));

/** Plan-view distance -- the number a drawing dimensions. */
export const standoffHorizontalM = (c: CameraObject): number => {
  const p = positionOf(c);
  return Math.hypot(p[0], p[1]);
};

/** Metres per pixel on a surface square to the axis at the standoff distance. */
export const groundSampleDistanceM = (c: CameraObject, distanceM?: number): number =>
  (distanceM ?? standoffM(c)) / fxOf(c);

/**
 * Height of the visible strip at a distance, square to the axis.
 *
 * Derived from the PIXEL grid, not from `vfovRadOf`. The two differ by half a
 * pixel per side, because the field of view spans the whole sensor while a pixel
 * centre only reaches `(h-1)/2` from the principal point -- and `isPointVisible`
 * judges pixel centres. A tenth of a percent, which never mattered while cameras
 * were missing the flame by whole centimetres; it matters the moment one is
 * marginal, because a readout that says the strip is taller than the flame while
 * the verdict says the flame is clipped is a readout nobody can act on.
 */
export const verticalCoverageM = (c: CameraObject, distanceM?: number): number =>
  ((c.camera.resolution_px[1] - 1) / fyOf(c)) * (distanceM ?? standoffM(c));

/** The one colour literal the schema allows: `#rrggbb`. */
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * A camera's display colour, normalised.
 *
 * Plans are untrusted input -- a shared `.ftp.json` is someone else's file -- and
 * this value ends up inside SVG and HTML attributes. Anything that is not the plain
 * six-digit hex the schema mandates is dropped for the modality colour rather than
 * passed through, so a crafted `display.color` cannot escape its attribute. Doing it
 * here covers every consumer, because this is the only place the field is read.
 */
export const cameraColor = (c: CameraObject): string => objectColor(c);

/** Default instrument identity shared with the scene, results and drawing. */
export const TYPE_COLORS: Record<string, string> = {
  heatFluxSensor: DEVICE_COLORS.heatFlux,
  thermocouple: DEVICE_COLORS.temperature,
};

/** Own-property lookup. `type in TYPE_COLORS` is true for an object whose type is
 *  `constructor` or `toString`, because those are on every object's prototype --
 *  and an unknown type is exactly the kind of value a plan from a newer tool can
 *  carry. Mirror of the same care in serialize.ts. */
const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/**
 * True when an object's colour carries information — a camera's modality, an
 * instrument's kind, or a colour the user set by hand. A wall has no such colour,
 * and tinting it would say something about it that is not true.
 */
export const hasObjectColor = (o: PlanObject): boolean =>
  isCamera(o)
  || hasOwn(TYPE_COLORS, o.type)
  || (typeof o.display?.color === 'string' && HEX_COLOR.test(o.display.color));

/** Any object's display colour, normalised. Same guarantees as above: this is the
 *  only place `display.color` is read, so an untrusted value is neutralised once. */
export function objectColor(o: PlanObject): string {
  const raw = o.display?.color;
  if (typeof raw === 'string' && HEX_COLOR.test(raw)) return raw;
  if (isCamera(o)) return MODALITY_COLORS[o.camera.modality] || MODALITY_COLORS.other;
  return hasOwn(TYPE_COLORS, o.type) ? TYPE_COLORS[o.type] : MODALITY_COLORS.other;
}

export const intrinsicsSourceOf = (c: CameraObject) => c.camera.intrinsicsSource ?? 'nominal';

/**
 * Project a world point into this camera's image, in the OpenCV pixel frame.
 *
 * Ideal pinhole: distortion coefficients are carried in the file but not applied,
 * because a plan's job is framing, not undistortion. Points behind the camera are
 * reported as not in front rather than mapped to a plausible-looking pixel, which
 * would claim a camera "sees" a fire it is facing away from.
 */
export function projectToPixels(
  c: CameraObject,
  point: Vec3,
): { u: number; v: number; inFront: boolean } {
  const cols = quatToColumns(quatOf(c));
  const p = positionOf(c);
  const right = cols[0];
  // Stored frame is OpenGL (+Y up, -Z forward); OpenCV wants +Y down, +Z forward.
  const down: Vec3 = [-cols[1][0], -cols[1][1], -cols[1][2]];
  const fwd: Vec3 = [-cols[2][0], -cols[2][1], -cols[2][2]];
  const d: Vec3 = [point[0] - p[0], point[1] - p[1], point[2] - p[2]];

  const z = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
  const [cx, cy] = principalPointOf(c);
  if (z <= 0) return { u: Number.NaN, v: Number.NaN, inFront: false };

  const x = d[0] * right[0] + d[1] * right[1] + d[2] * right[2];
  const y = d[0] * down[0] + d[1] * down[1] + d[2] * down[2];
  return { u: (fxOf(c) * x) / z + cx, v: (fyOf(c) * y) / z + cy, inFront: true };
}

export function isPointVisible(c: CameraObject, point: Vec3): boolean {
  const { u, v, inFront } = projectToPixels(c, point);
  if (!inFront) return false;
  const [w, h] = c.camera.resolution_px;
  return u >= 0 && u <= w - 1 && v >= 0 && v <= h - 1;
}

export interface Framing {
  base: boolean;
  tip: boolean;
  fraction: number;
  /** Clear share of in-frame centreline samples; null when none is in frame. */
  unobstructed: number | null;
}

function cameraLineOfSight(d: PlanDocument, c: CameraObject, b: BurnerObject): {
  unobstructed: number | null; blockers: PlanObject[];
} {
  const samples = flameCentrelineSamples(positionOf(b), fuelSurfaceZM(b), flameTipZM(b)!)
    .filter(p => isPointVisible(c, p));
  const hits = samples.map(p => firstOccluder(d, positionOf(c), p));
  const blockers = [...new Map(hits.filter((o): o is PlanObject => o !== null).map(o => [o.id, o])).values()];
  return { unobstructed: samples.length ? hits.filter(o => o === null).length / samples.length : null, blockers };
}

/**
 * Does this camera frame the fire?
 *
 * Samples a ring around the plume at each height from the fuel surface to the mean
 * flame tip, so a plume that overflows sideways is caught as well as one that
 * overflows the top. Mirrors Plan.framing() in the Python reader.
 */
export function framingOf(d: PlanDocument, c: CameraObject, rings = 24): Framing | null {
  const burner = primaryBurner(d);
  if (!burner) return null;
  const baseZ = fuelSurfaceZM(burner);
  const tipZ = flameTipZM(burner);
  if (tipZ === null) return null;
  const bp = positionOf(burner);
  const cp = positionOf(c);
  // The four samples per ring are taken relative to the camera -- toward it, away
  // from it and the two sides -- not along the world axes. A world-axis ring was
  // narrower to a camera standing at 45 degrees than to one on an axis, so the
  // same camera read 92% or 100% depending only on which way the room was drawn.
  const bearing = Math.hypot(cp[0] - bp[0], cp[1] - bp[1]) > 1e-9
    ? Math.atan2(cp[1] - bp[1], cp[0] - bp[0]) : 0;

  const samples: Vec3[] = [];
  for (let i = 0; i < rings; i += 1) {
    const z = baseZ + ((tipZ - baseZ) * i) / (rings - 1);
    // The drawn envelope: the flame cone near the pan, where it is wider than the
    // 15-degree plume cone (which starts at the virtual origin), and the plume
    // above. The plume alone put the base ring inside the pan, and a wide pool
    // whose edges were cut off read as fully framed.
    const r = Math.max(plumeRadiusAtZ(burner, z) ?? 0, flameRadiusAtZ(burner, z) ?? 0);
    for (let k = 0; k < 4; k += 1) {
      const a = bearing + (k * Math.PI) / 2;
      samples.push([bp[0] + r * Math.cos(a), bp[1] + r * Math.sin(a), z]);
    }
  }

  return {
    base: isPointVisible(c, [bp[0], bp[1], baseZ]),
    tip: isPointVisible(c, [bp[0], bp[1], tipZ]),
    fraction: samples.filter((s) => isPointVisible(c, s)).length / samples.length,
    unobstructed: cameraLineOfSight(d, c, burner).unobstructed,
  };
}

// -- burner ---------------------------------------------------------------

export function burnerAreaM2(b: BurnerObject): number {
  const fp = b.footprint;
  if (fp.shape === 'circle') return Math.PI * ((fp.diameter_m ?? 0) / 2) ** 2;
  const [w, d] = fp.size_m ?? [0, 0];
  return w * d;
}

/** Effective (equal-area) diameter, which is what the correlations want. */
export function burnerDiameterM(b: BurnerObject): number {
  if (b.footprint.shape === 'circle') return b.footprint.diameter_m ?? 0;
  return effectiveDiameterM(burnerAreaM2(b));
}

export const rimHeightM = (b: BurnerObject): number => b.rimHeight_m ?? 0;

/** Absolute height of the fuel surface. Correlations measure from here. */
export const fuelSurfaceZM = (b: BurnerObject): number => positionOf(b)[2] + rimHeightM(b);

export const hrrKwOf = (b: BurnerObject): number | null => b.fire?.hrr_kw ?? null;

export function burnerFlameHeightM(b: BurnerObject): number | null {
  const q = hrrKwOf(b);
  const d = burnerDiameterM(b);
  if (q === null || q <= 0 || d <= 0) return null;
  return flameHeightM(q, d);
}

export function flameTipZM(b: BurnerObject): number | null {
  const h = burnerFlameHeightM(b);
  return h === null ? null : fuelSurfaceZM(b) + h;
}

export function burnerVirtualOriginM(b: BurnerObject): number | null {
  const q = hrrKwOf(b);
  const d = burnerDiameterM(b);
  if (q === null || q <= 0 || d <= 0) return null;
  return virtualOriginM(q, d);
}

/** Plume radius at an absolute height above the floor. */
export function plumeRadiusAtZ(b: BurnerObject, zAboveFloorM: number): number | null {
  const q = hrrKwOf(b);
  const d = burnerDiameterM(b);
  if (q === null || q <= 0 || d <= 0) return null;
  return plumeRadiusM(zAboveFloorM - fuelSurfaceZM(b), q, d);
}

/** Radiated fraction of the heat release. Fuel-dependent; 0.3 when unstated. */
export const radiativeFractionOf = (b: BurnerObject): number => {
  const f = b.fire?.radiativeFraction;
  return typeof f === 'number' && Number.isFinite(f) && f > 0 && f <= 1
    ? f
    : DEFAULT_RADIATIVE_FRACTION;
};

/**
 * Radius of the drawn mean flame cone at an absolute height.
 *
 * The cone tapers from the effective diameter at the fuel surface to a point at
 * the mean tip -- the same shape `buildBurner` draws, so "this bead is in the
 * flame" means the same thing in the readout as it looks like on screen.
 */
export function flameRadiusAtZ(b: BurnerObject, zAboveFloorM: number): number | null {
  const tip = flameTipZM(b);
  if (tip === null) return null;
  const base = fuelSurfaceZM(b);
  if (tip <= base) return null;
  if (zAboveFloorM < base || zAboveFloorM > tip) return 0;
  return (burnerDiameterM(b) / 2) * (1 - (zAboveFloorM - base) / (tip - base));
}

/** Where the point-source model puts one burner's fire: mid-flame, on its axis. */
export function burnerPointSourceM(b: BurnerObject): Vec3 | null {
  const tip = flameTipZM(b);
  if (tip === null) return null;
  const p = positionOf(b);
  return [p[0], p[1], (fuelSurfaceZM(b) + tip) / 2];
}

/**
 * Where the point-source radiation model puts THE fire: mid-flame, on the primary
 * burner's axis. Also the point a camera or a gauge means by "aim at the fire",
 * which is why there is one function rather than two conventions. The heat flux
 * estimate itself sums every burner (`heatFluxEstimate`); this is the primary
 * only, because "aim at the fire" needs one point.
 */
export function firePointSourceM(d: PlanDocument): Vec3 | null {
  const b = primaryBurner(d);
  return b ? burnerPointSourceM(b) : null;
}

// -- heat flux sensor ------------------------------------------------------

export interface HeatFluxEstimate {
  /** Slant distance from the sensing face to the mid-flame point source of
   *  `sourceId`. */
  distanceM: number;
  /** Angle between the gauge's outward normal and the line to that source. */
  offAxisDeg: number;
  /** Predicted incident flux, kW/m2, summed over every fire inside the gauge's
   *  acceptance cone. Zero when it faces away from all of them, or its view tube
   *  admits none. */
  incidentKwM2: number;
  /** Visible centreline share; flux-weighted across admitted fires. */
  visibleFraction: number;
  /** True when at least one fire is in front of the sensing face. */
  facesFire: boolean;
  /** False when no fire falls inside a view-limiting tube's acceptance cone. */
  withinViewAngle: boolean;
  /** True when `sourceId` is close enough that "point source" stops being true. */
  nearField: boolean;
  /** Fraction of full scale, or null when no range is recorded. */
  fractionOfRange: number | null;
  /**
   * The burner the geometric figures refer to: the one contributing most of the
   * flux, or the primary when none contributes. Incident radiation from several
   * independent sources adds, so the flux is a sum; a distance and an angle are
   * to one point, and the one that dominates the reading is the one that matters.
   */
  sourceId: string;
}

/** The gauge's outward normal: it looks down local -Z, exactly as a camera does. */
export const gaugeNormal = (s: HeatFluxSensorObject): Vec3 => forwardOf(quatOf(s));

export const gaugeRangeKwM2 = (s: HeatFluxSensorObject): number | null => {
  const r = s.gauge?.range_kw_m2;
  return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : null;
};

/** Full acceptance angle of the sensing face; 180° is an open hemisphere. */
export const gaugeViewAngleDeg = (s: HeatFluxSensorObject): number => {
  const v = s.gauge?.viewAngle_deg;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 180 ? v : 180;
};

/**
 * What this gauge will read, by the point-source model.
 *
 * Null when there is no fire to radiate -- no burner, or no HRR -- rather than
 * zero, because "nothing to compute" and "computed zero" are different answers
 * and only one of them is a placement problem.
 */
export function heatFluxEstimate(
  d: PlanDocument,
  s: HeatFluxSensorObject,
): HeatFluxEstimate | null {
  const fires = fireBurners(d);
  if (fires.length === 0) return null;

  const at = positionOf(s);
  const normal = gaugeNormal(s);
  const range = gaugeRangeKwM2(s);

  interface Part {
    burner: BurnerObject; distanceM: number; cosTheta: number; offAxisDeg: number; incident: number;
    visibleFraction: number; unshadowed: number;
  }
  const parts: Part[] = [];
  for (const burner of fires) {
    const source = burnerPointSourceM(burner)!;
    const delta = sub(source, at);
    const distanceM = length(delta);
    const samples = flameCentrelineSamples(positionOf(burner), fuelSurfaceZM(burner), flameTipZM(burner)!);
    const visibleFraction = samples.filter(p => firstOccluder(d, at, p) === null).length / samples.length;
    if (distanceM < 1e-9) {
      // Sitting in the fire. There is no direction to the source, so there is no
      // cosine either; say so rather than dividing by zero.
      return {
        distanceM: 0, offAxisDeg: 0, incidentKwM2: Number.POSITIVE_INFINITY,
        facesFire: true, withinViewAngle: true, nearField: true,
        fractionOfRange: range === null ? null : Number.POSITIVE_INFINITY,
        sourceId: burner.id,
        visibleFraction,
      };
    }
    const cosTheta = dot(normal, normalize(delta));
    const unshadowed = pointSourceFluxKwM2(hrrKwOf(burner)!, distanceM, cosTheta, radiativeFractionOf(burner));
    parts.push({
      burner, distanceM, cosTheta,
      offAxisDeg: angleBetweenDeg(normal, delta),
      incident: unshadowed * visibleFraction, unshadowed, visibleFraction,
    });
  }

  // A view-limiting tube admits only what lies inside its acceptance cone. The sum
  // is over those fires alone: a second fire 45 degrees off a +/-10 degree gauge
  // does not reach the sensor, and adding it in filed a false over-range. With an
  // open hemisphere (180 degrees) that is every fire in front of the face, exactly
  // as before.
  const halfAngle = gaugeViewAngleDeg(s) / 2;
  const admitted = parts.filter((p) => p.offAxisDeg <= halfAngle);
  // The primary is first, so a tie -- and the one-burner case -- keeps it. With no
  // fire inside the cone, the figures still describe the strongest one outside it.
  const pool = admitted.length > 0 ? admitted : parts;
  const dominant = pool.reduce((best, p) => (p.incident > best.incident ? p : best), pool[0]);
  const incidentKwM2 = admitted.reduce((sum, p) => sum + p.incident, 0);
  const unshadowed = pool.reduce((sum, p) => sum + p.unshadowed, 0);
  // Keep an exact k/9 for one fire (and exactly 1 when all fires are clear).
  // With different shadows, the aggregate is the fraction of flux retained.
  const visibleFraction = pool.every(p => p.visibleFraction === pool[0].visibleFraction)
    ? pool[0].visibleFraction
    : unshadowed > 0 ? pool.reduce((sum, p) => sum + p.incident, 0) / unshadowed
      : pool.reduce((sum, p) => sum + p.visibleFraction, 0) / pool.length;

  return {
    distanceM: dominant.distanceM,
    offAxisDeg: dominant.offAxisDeg,
    incidentKwM2,
    visibleFraction,
    facesFire: parts.some((p) => p.cosTheta > 0),
    withinViewAngle: admitted.length > 0,
    nearField: dominant.distanceM < POINT_SOURCE_MIN_DIAMETERS * burnerDiameterM(dominant.burner),
    fractionOfRange: range === null ? null : incidentKwM2 / range,
    sourceId: dominant.burner.id,
  };
}

// -- thermocouple ----------------------------------------------------------

/** Standard continuous-use upper limits, ASTM/ANSI, largest wire gauge. */
export const TC_MAX_TEMPERATURE_C: Record<TcType, number> = {
  K: 1260, J: 760, T: 370, E: 870, N: 1260, R: 1480, S: 1480, B: 1700,
};

export const tcTypeOf = (t: ThermocoupleObject): TcType => t.thermocouple?.tcType ?? 'K';

export const tcMaxTemperatureC = (t: ThermocoupleObject): number => {
  const explicit = t.thermocouple?.maxTemperature_C;
  return typeof explicit === 'number' && Number.isFinite(explicit)
    ? explicit
    : TC_MAX_TEMPERATURE_C[tcTypeOf(t)];
};

/** Bead offsets along local +Z. Always at least one, so a rake and a single
 *  thermocouple are the same object with a different list length. */
export const beadOffsetsOf = (t: ThermocoupleObject): number[] => {
  const raw = t.beadOffsets_m;
  const clean = Array.isArray(raw) ? raw.filter((v) => typeof v === 'number' && Number.isFinite(v)) : [];
  return clean.length > 0 ? clean : [0];
};

export interface BeadState {
  index: number;
  /** Offset along the rake, from the object origin. */
  offsetM: number;
  world: Vec3;
  /** Horizontal distance from the axis of the fire it sits in -- or from the
   *  primary burner's axis when it sits in none. NaN with no fire at all. */
  radialM: number;
  /** Where it sits relative to the drawn fires: inside any burner's flame cone
   *  first, else inside any burner's plume envelope, else outside them all. */
  region: 'flame' | 'plume' | 'outside';
  /**
   * Inside a plume envelope at or below that burner's mean flame tip: the flame's
   * own height band. The drawn cone tapers to a point at the mean tip, but the
   * intermittent flame does not -- a bead 1.5 cm off the axis at 0.95 L_f is in
   * flame much of the time. No plume temperature applies there, so the survival
   * question is answered against flame temperature, as for a bead in the cone.
   */
  flameZone: boolean;
  /**
   * Predicted gas temperature, degrees Celsius, or null where no correlation
   * applies. This is the PLUME CENTRELINE value: an upper bound for a bead that
   * is inside the envelope but off the axis.
   */
  gasTemperatureC: number | null;
}

/**
 * Each bead in world coordinates, and what the fire is doing there.
 *
 * The offsets are local, so they go through the object transform like every
 * other vertex list in this format (CONVENTIONS.md section 5a) -- a rake leaned
 * against a wall leans in the readout too.
 */
export function thermocoupleBeads(d: PlanDocument, t: ThermocoupleObject): BeadState[] {
  const fires = fireBurners(d);
  const ambient = d.environment?.ambientTemperature_C ?? 20;
  const primary = primaryBurner(d);

  return beadOffsetsOf(t).map((offsetM, index) => {
    const world = toWorld(t, [0, 0, offsetM]);
    const radialTo = (b: BurnerObject): number => {
      const bp = positionOf(b);
      return Math.hypot(world[0] - bp[0], world[1] - bp[1]);
    };

    let region: BeadState['region'] = 'outside';
    let gasTemperatureC: number | null = null;
    let flameZone = false;
    let radialM = primary ? radialTo(primary) : Number.NaN;

    // Every fire in the plan, flame beating plume: a bead inside one burner's flame
    // is in the flame whatever another burner's plume says, and a bead in two
    // plumes reads the hotter centreline -- an upper bound either way, which is
    // what the figure is documented as.
    for (const burner of fires) {
      const surface = fuelSurfaceZM(burner);
      const tipZ = flameTipZM(burner)!;
      const radial = radialTo(burner);
      const flameR = flameRadiusAtZ(burner, world[2]);
      const plumeR = plumeRadiusAtZ(burner, world[2]);
      // Both bounds are load-bearing. `flameRadiusAtZ` reports 0 outside the cone's
      // own height band rather than null, so without the lower bound a bead exactly
      // on the burner axis -- the default placement of a rake with no transform --
      // satisfies `radial <= 0` at any depth below the pan and is called `flame`.
      if (world[2] >= surface && world[2] <= tipZ && flameR !== null && radial <= flameR) {
        region = 'flame';
        gasTemperatureC = null;
        flameZone = false;
        radialM = radial;
        break;
      }
      if (world[2] > surface && plumeR !== null && radial <= plumeR) {
        // Above the mean tip only: inside the flame's own height the plume
        // correlation is not merely imprecise, it is the wrong correlation.
        if (world[2] <= tipZ) flameZone = true;
        let here: number | null = null;
        if (world[2] > tipZ) {
          const rise = plumeCentrelineRiseK(
            world[2] - surface, hrrKwOf(burner)!, burnerDiameterM(burner),
            radiativeFractionOf(burner),
          );
          if (rise !== null) here = ambient + rise;
        }
        if (region !== 'plume' || (here !== null && (gasTemperatureC === null || here > gasTemperatureC))) {
          region = 'plume';
          gasTemperatureC = here;
          radialM = radial;
        }
      }
    }

    return { index, offsetM, world, radialM, region, gasTemperatureC, flameZone };
  });
}

/** In the flame, or in its height band inside a plume: where a bead has to survive
 *  flame temperature. `beadVerdict` and `instrumentChecks` both judge this. */
export const beadAtFlameTemperature = (b: BeadState): boolean => b.region === 'flame' || b.flameZone;

// -- hood -----------------------------------------------------------------

/**
 * Height of the opening plane above the floor, in world space.
 *
 * `height_m` is measured from the hood's own origin, and the origin can move: the
 * gizmo translates a hood in Z like any other object, and the 3D view draws the
 * canopy where the transform puts it. Every check, readout, drawing and bound goes
 * through here rather than reading `height_m` directly, so a hood dragged three
 * metres down is judged where it is drawn -- a check that read `height_m` alone
 * cleared a flame that was visibly inside the canopy.
 */
export const hoodOpeningZM = (h: HoodObject): number => positionOf(h)[2] + h.height_m;

/**
 * How far the drawn canopy rises above the opening to its duct collar. A picture,
 * not a dimension any check reads -- but the 3D view, Fit and the printed
 * elevations all draw it, and a drawing that sized its page from one rise and drew
 * another cut a wide hood's canopy off the top of the sheet.
 */
export const hoodCanopyRiseM = (h: HoodObject): number =>
  Math.max(Math.min(h.opening_m[0], h.opening_m[1]) * 0.45, 0.4);

/** Lowest plane that must capture the plume: opening, less any skirt. World space. */
export const hoodIntakeHeightM = (h: HoodObject): number =>
  hoodOpeningZM(h) - (h.skirtDepth_m ?? 0);

/** The four corners of the opening in world XY, honouring the hood's own rotation. */
export function hoodOpeningCornersXY(h: HoodObject): Array<[number, number]> {
  const [w, d] = h.opening_m;
  const local: Array<[number, number]> = [
    [-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2],
  ];
  return local.map((c) => footprintXY(h, c));
}

/**
 * Where a point sits relative to the opening, in the hood's own opening axes.
 *
 * `inside` answers 'is the hood over this?'; `overhang` is how far past the rim it
 * is, which is the number worth printing when it is not.
 */
export function hoodOpeningOffset(
  h: HoodObject,
  worldXY: readonly [number, number],
): { u: number; v: number; halfW: number; halfD: number; inside: boolean; overhang: number } {
  const l = toLocal(h, [worldXY[0], worldXY[1], 0]);
  const halfW = h.opening_m[0] / 2;
  const halfD = h.opening_m[1] / 2;
  const overU = Math.max(0, Math.abs(l[0]) - halfW);
  const overV = Math.max(0, Math.abs(l[1]) - halfD);
  return {
    u: l[0], v: l[1], halfW, halfD,
    inside: overU === 0 && overV === 0,
    overhang: Math.hypot(overU, overV),
  };
}

// -- ceiling --------------------------------------------------------------

/** Height of the soffit above the floor, in world space: the slab's own `height_m`
 *  plus wherever its transform puts it. Same reasoning as `hoodOpeningZM`. */
export const ceilingSoffitZM = (c: CeilingObject): number => positionOf(c)[2] + c.height_m;

/** Shoelace area of the slab footprint. */
export function ceilingAreaM2(c: CeilingObject): number {
  const p = c.polygon_m;
  let sum = 0;
  for (let i = 0; i < p.length; i += 1) {
    const q = p[(i + 1) % p.length];
    sum += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return Math.abs(sum) / 2;
}

/** Point-in-polygon by ray casting, so a slab off to one side does not claim a
 *  flame impinges on it. */
export function ceilingCoversXY(c: CeilingObject, x: number, y: number): boolean {
  const p = c.polygon_m;
  let inside = false;
  for (let i = 0; i < p.length; i += 1) {
    const j = (i + 1) % p.length;
    // Through the object frame, not a bare translation: a rotated slab covers a
    // different footprint, and the 3D view already draws it rotated.
    const [x0, y0] = footprintXY(c, p[i]);
    const [x1, y1] = footprintXY(c, p[j]);
    // Half-open edge test avoids double-counting a vertex sitting on the ray.
    if ((y0 > y) !== (y1 > y)) {
      const t = (y - y0) / (y1 - y0);
      if (x < x0 + t * (x1 - x0)) inside = !inside;
    }
  }
  return inside;
}

// -- checks ---------------------------------------------------------------

const issue = (severity: Issue['severity'], code: string, message: string, objectId?: string): Issue =>
  objectId === undefined ? { severity, code, message } : { severity, code, message, objectId };

/**
 * Flame impingement and plume capture.
 *
 * Both are measurement-validity questions, not cosmetics: flame in the canopy is no
 * longer a free plume, and a hood that spills plume under-reads HRR by oxygen
 * consumption.
 *
 * Capture is a spatial question, not just a size one. The plume rises from the
 * burner, so what has to fit inside the opening is a disk centred on the BURNER,
 * offset from the opening centre by however far apart the two are. A hood that is
 * merely large is not a hood that captures.
 */
/** ` of "name"` when a plan has more than one fire, so a finding says which; nothing
 *  when there is only the one, as there almost always is. */
const whichFire = (b: BurnerObject, many: boolean): string =>
  many ? ` of "${displayName(b)}"` : '';

export function hoodChecks(d: PlanDocument): Issue[] {
  const out: Issue[] = [];
  const allHoods = hoods(d);
  if (allHoods.length === 0) return out;

  // Every fire, not only the primary: a second burner beside the hood is a plume
  // the hood does not capture, and a fire the HRR measurement will miss.
  const fires = fireBurners(d);
  const many = fires.length > 1;

  // A fire no hood covers is one finding, filed once, against the hood nearest to
  // covering it. Asking it of every (hood, fire) pair filed an error for each hood
  // that stands over a different fire -- two fires under two hoods, both captured,
  // read as two captures missed.
  for (const burner of fires) {
    const bp = positionOf(burner);
    const offsets = allHoods.map((hood) => ({ hood, off: hoodOpeningOffset(hood, [bp[0], bp[1]]) }));
    if (offsets.some((o) => o.off.inside)) continue;
    const nearest = offsets.reduce((a, b) => (b.off.overhang < a.off.overhang ? b : a));
    const of = whichFire(burner, many);
    out.push(issue('error', 'hood-offset',
      `${allHoods.length > 1 ? 'No hood opening covers' : 'The hood opening does not cover'} ` +
      `the burner${of} — the burner centre is ${nearest.off.overhang.toFixed(2)} m outside ` +
      `${allHoods.length > 1 ? 'the nearest opening' : 'the opening'}, so no hood captures ` +
      `any of its plume.`, nearest.hood.id));
  }

  for (const hood of allHoods) {
    const intake = hoodIntakeHeightM(hood);
    for (const burner of fires) {
      const tip = flameTipZM(burner)!;
      const surface = fuelSurfaceZM(burner);
      const bp = positionOf(burner);
      const of = whichFire(burner, many);
      const off = hoodOpeningOffset(hood, [bp[0], bp[1]]);

      // Nothing else is meaningful about a hood that is not over the fire: the
      // flame cannot reach a canopy beside it, and the plume it fails to capture is
      // not a margin problem but a placement one (filed above, once per fire). Nor
      // about one whose intake is at or below the fuel surface -- the ceiling check
      // skips a slab below the fire for the same reason.
      if (!off.inside || intake <= surface) continue;

      // Clearance is judged on the flame's own height, from the fuel surface: a
      // 12 cm flame on a 2 m stand is not "close to" a canopy 0.5 m above it.
      if (tip >= intake) {
        out.push(issue('error', 'flame-impingement',
          `Mean flame tip${of} reaches ${tip.toFixed(2)} m, at or above the hood intake at ` +
          `${intake.toFixed(2)} m — flame in the canopy, not a free plume.`, hood.id));
      } else if (tip - surface > 0.8 * (intake - surface)) {
        out.push(issue('warning', 'flame-clearance',
          `Mean flame tip${of} at ${tip.toFixed(2)} m leaves only ${(intake - tip).toFixed(2)} m ` +
          `below the hood intake; an intermittent tip will reach higher.`, hood.id));
      }

      const radius = plumeRadiusAtZ(burner, intake);
      if (radius !== null) {
        const plumeD = 2 * radius;
        // Span the plume demands along each opening axis, and the axis with the
        // least slack -- which is the one that spills first.
        const axes: Array<[number, number]> = [
          [2 * (Math.abs(off.u) + radius), hood.opening_m[0]],
          [2 * (Math.abs(off.v) + radius), hood.opening_m[1]],
        ];
        const [need, avail] = axes.reduce((a, b) => (a[1] - a[0] <= b[1] - b[0] ? a : b));
        const eccentric = Math.hypot(off.u, off.v) > 1e-9
          ? `, ${Math.hypot(off.u, off.v).toFixed(2)} m off the opening centre`
          : '';

        if (need > avail) {
          out.push(issue('error', 'plume-spillage',
            `Plume${of} is ${plumeD.toFixed(2)} m across at the hood intake${eccentric}, needing ` +
            `${need.toFixed(2)} m of a ${avail.toFixed(2)} m opening — the hood will spill and ` +
            `HRR by oxygen consumption will read low.`, hood.id));
        } else if (need > 0.8 * avail) {
          out.push(issue('warning', 'plume-margin',
            `Plume${of} is ${plumeD.toFixed(2)} m across at the hood intake${eccentric}, needing ` +
            `${need.toFixed(2)} m of a ${avail.toFixed(2)} m opening — little margin for ` +
            `draught or an off-centre fire.`, hood.id));
        }
      }
    }
  }
  return out;
}

/**
 * Flame reaching a ceiling slab above the fire.
 *
 * Distinct from the hood check and worth its own: a flame on a ceiling stops
 * behaving as a free plume, spreads as a ceiling jet, and invalidates the
 * correlations everything else here is drawn with.
 */
export function ceilingChecks(d: PlanDocument): Issue[] {
  const out: Issue[] = [];
  const slabs = ceilings(d);
  if (slabs.length === 0) return out;

  const fires = fireBurners(d);
  const many = fires.length > 1;

  for (const slab of slabs) {
    const soffit = ceilingSoffitZM(slab);
    for (const burner of fires) {
      const tip = flameTipZM(burner)!;
      const surface = fuelSurfaceZM(burner);
      const bp = positionOf(burner);
      const of = whichFire(burner, many);
      if (soffit <= surface) continue;                     // below the fire
      if (!ceilingCoversXY(slab, bp[0], bp[1])) continue;  // off to one side

      if (tip >= soffit) {
        out.push(issue('error', 'ceiling-impingement',
          `Mean flame tip${of} reaches ${tip.toFixed(2)} m, at or above the ceiling soffit at ` +
          `${soffit.toFixed(2)} m — the fire will spread as a ceiling jet and the ` +
          `free-plume correlations no longer apply.`, slab.id));
      } else if (tip - surface > 0.8 * (soffit - surface)) {
        // From the fuel surface, not the floor: the question is how much of the
        // gap above the fire the flame fills.
        out.push(issue('warning', 'ceiling-clearance',
          `Mean flame tip${of} at ${tip.toFixed(2)} m leaves only ` +
          `${(soffit - tip).toFixed(2)} m below the ceiling; an intermittent tip ` +
          `will reach higher.`, slab.id));
      }
    }
  }
  return out;
}

/**
 * Representative mean temperature inside a flame, for the over-temperature test.
 *
 * A rule of thumb, not a correlation: hydrocarbon pool flames run roughly
 * 800-1200 C. It is used only to answer "will this bead survive", which is a
 * question about the letter type's limit and does not need a better number.
 */
export const FLAME_TEMPERATURE_C = 1000;

/** Below 5% of full scale a gauge is reading in its own noise. */
export const LOW_SIGNAL_FRACTION = 0.05;

// -- instrument verdicts ---------------------------------------------------

/**
 * How an instrument placement reads at a glance.
 *
 * `muted` is not a lesser `ok`: a rake deliberately outside the plume is neither
 * good nor bad, and colouring it green would be a claim nobody made.
 */
export type InstrumentStatus = 'ok' | 'warn' | 'bad' | 'muted';

export interface InstrumentVerdict {
  status: InstrumentStatus;
  /** Short phrase for a table cell or a readout, not a sentence. */
  label: string;
}

const STATUS_RANK: Record<InstrumentStatus, number> = { bad: 0, warn: 1, ok: 2, muted: 3 };

/**
 * The single place an instrument placement is judged.
 *
 * Three surfaces say this -- the Checks list, the inspector readout and the
 * report's exposure table -- and each used to decide for itself. They disagreed:
 * a type-T bead sitting in the flame was an error in Checks and green in the
 * other two, and a near-field gauge was a warning in Checks and green in the
 * report. A printed table is read on its own, a page away from the checks list,
 * so a green cell contradicting a red finding is a safety statement, not a
 * styling bug. One classifier, and `instruments.test.ts` asserts that its status
 * matches the worst severity `instrumentChecks` files for the same object.
 */
export function gaugeVerdict(d: PlanDocument, s: HeatFluxSensorObject): InstrumentVerdict | null {
  const e = heatFluxEstimate(d, s);
  if (!e) return null;
  const frac = e.fractionOfRange;

  // Errors first, then warnings, in the order `instrumentChecks` files them.
  if (!Number.isFinite(e.incidentKwM2)) return { status: 'bad', label: 'in the fire' };
  if (!e.facesFire) return { status: 'bad', label: 'faces away' };
  if (e.visibleFraction === 0) return { status: 'bad', label: 'no line of sight' };
  if (frac !== null && frac > 1) return { status: 'bad', label: 'over range' };
  if (!e.withinViewAngle) return { status: 'warn', label: 'outside view cone' };
  if (e.visibleFraction < 1) return { status: 'warn', label: 'partly shadowed' };
  if (frac !== null && frac < LOW_SIGNAL_FRACTION) return { status: 'warn', label: 'low signal' };
  // The number is still printed, but it is an order of magnitude. Green would say
  // "size the gauge on this", which is the one thing `gauge-near-field` forbids.
  if (e.nearField) return { status: 'warn', label: 'near field' };
  // Without a range there is no over-range or low-signal verdict to have passed --
  // every gauge an FDS import makes is like this, by design. Green "usable" said
  // those checks had been made; neutral says they have not.
  if (frac === null) return { status: 'muted', label: 'no range set' };
  return { status: 'ok', label: 'usable' };
}

/** One bead. The flame branch never falls through to the plume wording: a bead in
 *  the flame has no plume temperature, and calling it "in the plume" was how the
 *  report described an over-temperature bead as if it were a good one. */
export function beadVerdict(b: BeadState, limitC: number): InstrumentVerdict {
  if (beadAtFlameTemperature(b)) {
    const where = b.region === 'flame' ? 'in the flame' : 'below the flame tip';
    return limitC < FLAME_TEMPERATURE_C
      ? { status: 'bad', label: `${where}, past the ${limitC} °C limit` }
      : { status: 'warn', label: where };
  }
  if (b.region === 'plume') {
    return b.gasTemperatureC !== null && b.gasTemperatureC > limitC
      ? { status: 'bad', label: `in the plume, past the ${limitC} °C limit` }
      : { status: 'ok', label: 'in the plume' };
  }
  return { status: 'muted', label: 'outside the plume' };
}

/** The rake as a whole: its worst bead, which is the one that ends the test. */
export function thermocoupleVerdict(d: PlanDocument, t: ThermocoupleObject): InstrumentVerdict {
  const limit = tcMaxTemperatureC(t);
  return thermocoupleBeads(d, t)
    .map((b) => beadVerdict(b, limit))
    .reduce((worst, v) => (STATUS_RANK[v.status] < STATUS_RANK[worst.status] ? v : worst));
}

/**
 * Instrument placement.
 *
 * These are the same kind of finding as the hood checks: not style, but whether
 * the measurement will mean anything. A gauge pointed at a wall, one that pins
 * at full scale, and a type-T bead sitting in the flame are all mistakes that
 * cost a test day, and all three are visible in the plan before anyone travels.
 */
export function instrumentChecks(d: PlanDocument): Issue[] {
  const out: Issue[] = [];

  for (const s of heatFluxSensors(d)) {
    const e = heatFluxEstimate(d, s);
    if (!e) continue;

    // Standing on the point source itself. Everything below would report an
    // unbounded flux, and "Infinity kW/m2" in a printed report is not a finding.
    if (!Number.isFinite(e.incidentKwM2)) {
      out.push(issue('error', 'gauge-in-fire',
        'The gauge sits on the point source the model puts the fire at, so the ' +
        'predicted flux is unbounded. Move it out of the flame.', s.id));
      continue;
    }

    if (e.visibleFraction === 0) {
      out.push(issue('error', 'gauge-no-line-of-sight',
        `${displayName(s)} has no line of sight: nothing in the plan lets it see the flame, ` +
        'so it will read only what reaches it indirectly.', s.id));
      // Facing, view cone, near field and range all judge radiation this gauge cannot
      // receive. A low-signal "fit a more sensitive gauge" would be the wrong advice.
      continue;
    } else if (e.visibleFraction < 1) {
      const share = (e.visibleFraction * 100).toFixed(0);
      out.push(issue('warning', 'gauge-partly-shadowed',
        (fireBurners(d).length > 1
          ? `${displayName(s)} has ${share}% line of sight, weighted by each fire's unshadowed flux; `
          : `${displayName(s)} sees ${share}% of the flame centreline; `) +
        'the predicted flux has been scaled by this visible share.', s.id));
    }
    if (!e.facesFire) {
      out.push(issue('error', 'gauge-facing-away',
        `The gauge normal is ${e.offAxisDeg.toFixed(0)}° off the line to the fire, so the ` +
        `sensing face is turned away from it and will see only background radiation.`, s.id));
      continue;
    }
    if (!e.withinViewAngle) {
      out.push(issue('warning', 'gauge-view-restricted',
        `The fire is ${e.offAxisDeg.toFixed(0)}° off the gauge axis but the view-limiting ` +
        `tube only accepts ±${(gaugeViewAngleDeg(s) / 2).toFixed(0)}° — the flame is outside ` +
        `the acceptance cone.`, s.id));
    }
    if (e.nearField) {
      const source = findObject(d, e.sourceId) as BurnerObject;
      out.push(issue('warning', 'gauge-near-field',
        `The gauge is ${e.distanceM.toFixed(2)} m from a fire of effective diameter ` +
        `${burnerDiameterM(source).toFixed(2)} m. Closer than ` +
        `${POINT_SOURCE_MIN_DIAMETERS} diameters the fire is plainly not a point source, so ` +
        `the predicted flux is an order of magnitude, not a value to size a gauge on.`, s.id));
    }

    const range = gaugeRangeKwM2(s);
    if (range !== null && e.fractionOfRange !== null) {
      if (e.fractionOfRange > 1) {
        out.push(issue('error', 'gauge-over-range',
          `Predicted incident flux is ${e.incidentKwM2.toFixed(1)} kW/m² against a ` +
          `${range} kW/m² gauge — it will pin at full scale and the reading is lost.`, s.id));
      } else if (e.fractionOfRange < LOW_SIGNAL_FRACTION) {
        out.push(issue('warning', 'gauge-low-signal',
          `Predicted incident flux is ${e.incidentKwM2.toFixed(2)} kW/m², only ` +
          `${(e.fractionOfRange * 100).toFixed(1)}% of the ${range} kW/m² range — move it in, ` +
          `or fit a more sensitive gauge.`, s.id));
      }
    }
  }

  for (const t of thermocouples(d)) {
    const beads = thermocoupleBeads(d, t);
    const limit = tcMaxTemperatureC(t);
    const type = tcTypeOf(t);

    const inFlame = beads.filter(beadAtFlameTemperature);
    if (inFlame.length > 0) {
      const which = inFlame.length === beads.length
        ? 'every bead'
        : `${inFlame.length} of ${beads.length} beads`;
      const sits = inFlame.length === beads.length || inFlame.length === 1 ? 'sits' : 'sit';
      if (limit < FLAME_TEMPERATURE_C) {
        out.push(issue('error', 'tc-over-temperature',
          `${which} ${sits} in the flame or below its mean tip, where gas is roughly ` +
          `${FLAME_TEMPERATURE_C} °C — past the ${limit} °C limit of a type ${type} ` +
          `thermocouple.`, t.id));
      } else {
        out.push(issue('warning', 'tc-in-flame',
          `${which} ${sits} in the flame or below its mean tip. Expect intermittent flame ` +
          `temperatures rather than a plume reading, and significant radiation error on a ` +
          `bare bead.`, t.id));
      }
    }

    const hottest = beads.reduce<number | null>(
      (acc, b) => (b.gasTemperatureC !== null && (acc === null || b.gasTemperatureC > acc)
        ? b.gasTemperatureC : acc),
      null,
    );
    if (hottest !== null && hottest > limit) {
      out.push(issue('error', 'tc-over-temperature',
        `Predicted plume centreline reaches ${hottest.toFixed(0)} °C at the hottest bead, past ` +
        `the ${limit} °C limit of a type ${type} thermocouple.`, t.id));
    }

    if (beads.every((b) => b.region === 'outside') && fireBurners(d).length > 0) {
      out.push(issue('info', 'tc-outside-plume',
        'No bead falls inside the flame or the plume envelope of any fire, so this rake ' +
        'will read close to ambient.', t.id));
    }
  }

  return out;
}

export function cameraChecks(d: PlanDocument): Issue[] {
  const b = primaryBurner(d);
  if (!b || flameTipZM(b) === null) return [];
  const out: Issue[] = [];
  for (const c of cameras(d)) {
    const view = cameraLineOfSight(d, c, b);
    if (view.unobstructed !== null && view.unobstructed < 1) {
      out.push(issue('warning', 'camera-view-blocked',
        `${displayName(c)} frames the flame but ${((1 - view.unobstructed) * 100).toFixed(0)}% ` +
        'of the centreline it frames is hidden behind ' +
        view.blockers.slice(0, 2).map(displayName).join(' and ') + '.', c.id));
    }
  }
  return out;
}

/** Semantic checks beyond what the schema can express. */
export function checkPlan(d: PlanDocument): Issue[] {
  const out: Issue[] = [];

  // A file whose label understates its contents. Only a hand edit or a broken
  // writer produces one -- this writer derives the version -- but it matters: the
  // label is what a consumer checks before deciding it can read the file.
  const declared = String(d.version ?? '');
  const effective = maxVersion(declared, requiredFormatVersion(d));
  if (declared !== effective) {
    out.push(issue('warning', 'version-understated',
      `The file declares format ${declared || '(none)'} but uses ${effective} features; ` +
      'saving will correct it.'));
  }

  const seen = new Set<string>();
  for (const o of d.objects) {
    if (seen.has(o.id)) {
      out.push(issue('error', 'duplicate-id', `Object id "${o.id}" is used more than once.`, o.id));
    }
    seen.add(o.id);
  }

  for (const o of d.objects) {
    const q = o.transform?.rotation_quat;
    if (q) {
      const n = Math.hypot(q[0], q[1], q[2], q[3]);
      if (Math.abs(n - 1) > 1e-6) {
        out.push(issue('warning', 'non-unit-quaternion',
          `rotation_quat has length ${n.toFixed(6)}, expected 1.`, o.id));
      }
    }
    // Any object whose orientation records what it is pointed at, which since 1.1
    // is heat flux gauges as well as cameras -- a gauge whose quaternion and target
    // disagree is exactly as wrong, and for exactly the same reason.
    const target = o.transform?.aimTarget_m;
    if (target && isAimable(o) && q) {
      const delta = sub(target, positionOf(o));
      if (length(delta) < 1e-9) {
        out.push(issue('warning', 'degenerate-aim',
          "aimTarget_m coincides with the object's own position.", o.id));
      } else {
        // `quatOf`, not the raw `q`: a zero-length quaternion is reported above and
        // must not also throw out of the check that follows it.
        const off = angleBetweenDeg(delta, forwardOf(quatOf(o)));
        if (off > 0.1) {
          out.push(issue('warning', 'aim-mismatch',
            `rotation_quat points ${off.toFixed(2)}° away from aimTarget_m; the quaternion is authoritative.`,
            o.id));
        }
      }
    }
  }

  for (const c of cameras(d)) {
    if (intrinsicsSourceOf(c) === 'nominal') {
      out.push(issue('info', 'nominal-intrinsics',
        'Intrinsics are a placeholder — fine for framing, not for reconstruction.', c.id));
    }
  }

  const allBurners = burners(d);
  if (allBurners.length === 0) {
    out.push(issue('warning', 'no-burner', 'Plan has no burner; flame geometry is undefined.'));
  } else {
    if (!allBurners.some((b) => Math.hypot(positionOf(b)[0], positionOf(b)[1]) < 1e-6)) {
      out.push(issue('warning', 'burner-off-origin',
        'No burner sits at the origin, but the coordinate system is defined as burner-centred; ' +
        'camera standoff will be misleading.'));
    }
    for (const b of allBurners) {
      if (hrrKwOf(b) === null) {
        out.push(issue('info', 'no-hrr', 'No hrr_kw, so flame and plume geometry cannot be drawn.', b.id));
      }
    }
    // The hood, ceiling and instrument checks below take every fire into account.
    // Camera framing does not: it answers "does this lens see THE fire", and the
    // fire it means is the primary at the origin. Say so on each other burner, so a
    // coverage table that reads 100 percent is not taken to cover a fire it never
    // looked at.
    for (const b of secondaryBurners(d)) {
      out.push(issue('warning', 'secondary-burner',
        `"${displayName(b)}" is a second fire. The hood, ceiling and instrument verdicts ` +
        'include it, but camera framing and "aim at fire" are judged against the primary ' +
        'burner at the origin only.', b.id));
    }
  }

  return out.concat(hoodChecks(d), ceilingChecks(d), instrumentChecks(d), cameraChecks(d), flameChecks(d), testDataChecks(d));
}

/**
 * Placement checks for reconstructed flames, from the manifest alone.
 *
 * The voxels are in the reconstruction rig's frame and this format's frame is the
 * burner's. When the rig was set up from this plan the two coincide; when they do
 * not, the hull lands somewhere a flame cannot be -- under the floor, or metres
 * from the pan -- and the object's transform is the correction. Both checks read the
 * transformed bounds, so a corrected object passes. The third notices a CSV linked
 * to the burner that was not produced by the same reconstruction run.
 */
export function flameChecks(d: PlanDocument): Issue[] {
  const out: Issue[] = [];
  for (const f of reconstructedFlames(d)) {
    const manifest = flameManifest(f);
    if (!manifest) continue;
    const corners = flameBoundsCorners(f);
    if (f.burnerId && !(findObject(d, f.burnerId) && isBurner(findObject(d, f.burnerId)!))) {
      out.push(issue('warning', 'flame-burner-unknown',
        `burnerId "${f.burnerId}" names no burner in this plan; the primary burner is used instead.`, f.id));
    }
    const burner = flameBurner(d, f);
    const floor = burner ? positionOf(burner)[2] : 0;
    const lowest = Math.min(...corners.map((c) => c[2]));
    if (lowest < floor - manifest.grid.pitch_m) {
      out.push(issue('warning', 'flame-below-floor',
        `The reconstructed hull reaches ${(floor - lowest).toFixed(2)} m below the floor. ` +
        'The reconstruction frame is probably offset from the plan frame; correct the object\'s position.', f.id));
    }
    if (burner) {
      const bp = positionOf(burner);
      const cx = corners.reduce((a, c) => a + c[0], 0) / corners.length;
      const cy = corners.reduce((a, c) => a + c[1], 0) / corners.length;
      const offset = Math.hypot(cx - bp[0], cy - bp[1]);
      const allowed = Math.max(burnerDiameterM(burner), 0.25);
      if (offset > allowed) {
        out.push(issue('warning', 'flame-off-burner',
          `The reconstructed hull is centred ${offset.toFixed(2)} m from "${displayName(burner)}". ` +
          'The reconstruction frame is probably not the plan frame; correct the object\'s transform.', f.id));
      }
      for (const link of burner.linkedFiles ?? []) {
        if (!link.plot) continue;
        const mismatch = plotSequenceMismatch(link.plot.samples, manifest);
        if (mismatch) {
          out.push(issue('info', 'flame-csv-mismatch',
            `"${link.label || link.path}" on "${displayName(burner)}" ${mismatch}, so it is not this reconstruction's volumes.csv.`, f.id));
        }
      }
    }
  }
  return out;
}

/**
 * Whether a burner's CSV snapshot is a reconstruction in this plan: its burner's,
 * matching that flame's manifest sample for frame, and -- when the caller can say
 * -- with that flame's frames loaded, so the clock's range is this run's.
 *
 * This is what lets the plot follow the playback clock. A CSV from some other
 * run -- another burner's, or an earlier test on this one -- keeps its own slider,
 * or the clock would drag its cursor to times it has no samples at; so does the
 * right CSV while only some other flame is loaded and the clock runs on its time.
 */
export function plotFollowsFlame(
  d: PlanDocument, burner: BurnerObject, link: LinkedFile,
  loaded: (flame: ReconstructedFlameObject) => boolean = () => true,
): boolean {
  if (!link.plot) return false;
  return reconstructedFlames(d).some((f) => {
    const manifest = flameManifest(f);
    return manifest !== undefined && flameBurner(d, f) === burner && loaded(f)
      && plotSequenceMismatch(link.plot!.samples, manifest) === null;
  });
}

/** Six-decimal cubic-metre rounding in `volumes.csv`: one millilitre. */
export const PLOT_VOLUME_ROUNDING_M3 = 1e-6;
/** Half the tenth of a second a frame file's name carries, and a hair more. */
export const FRAME_NAME_TIME_TOLERANCE_S = 0.05 + 1e-9;

/**
 * Why a burner's CSV snapshot and a flame's manifest are not from one run, or null.
 *
 * Timestamps must be the same set; then each row's volume must be the frame's voxel
 * count times the voxel volume, to within a voxel -- the CSV rounds to a microlitre
 * and a 10 mm voxel is one, so the tolerance is a voxel rather than exactness.
 */
export function plotSequenceMismatch(
  samples: readonly [number, number, number][], manifest: VoxelSequenceManifest,
): string | null {
  const frames = manifest.frames;
  if (samples.length !== frames.length) return `has ${samples.length} samples against ${frames.length} frames`;
  const voxelVolume = manifest.grid.voxelSize_m ** 3;
  // The pipeline writes volumes rounded to a microlitre (1e-6 m3). Below a voxel of
  // about 7.9 mm that rounding alone is more than one voxel, and a tolerance of one
  // voxel called the run's own CSV someone else's.
  const countTolerance = 1 + PLOT_VOLUME_ROUNDING_M3 / 2 / voxelVolume;
  for (let i = 0; i < frames.length; i += 1) {
    // Frame names carry a tenth of a second (`t_{t:09.1f}s.npz`) while the CSV keeps
    // the full timestamp, so 0.30000000000000004 s is the frame at 0.3 s.
    if (Math.abs(samples[i][0] - frames[i][0]) > FRAME_NAME_TIME_TOLERANCE_S) {
      return `is sampled at ${samples[i][0]} s where the sequence has a frame at ${frames[i][0]} s`;
    }
    const count = samples[i][1] / voxelVolume;
    if (Math.abs(count - frames[i][1]) > countTolerance) return `records ${samples[i][1]} m³ at ${frames[i][0]} s where the frame holds ${frames[i][1]} voxels`;
  }
  return null;
}

// -- extents --------------------------------------------------------------

/**
 * Every point the physical layout occupies, in world space.
 *
 * One list for the two consumers that frame the layout -- Fit in the viewport and
 * the page bounds of the exported drawing -- so neither can forget a primitive the
 * other draws. Fit used to see an obstruction as its origin alone and put the camera
 * inside a 20 m box; the drawing used to size its page from a wall's transform Z
 * and clip a raised wall clean off the sheet. Everything here is what the scene
 * builders and the SVG projector actually emit: walls from their base height,
 * hoods and ceilings where their transforms put them, boxes by their corners.
 *
 * Editor furniture -- frustums, dimension lines, the grid -- is deliberately not
 * here. A single wide-angle camera's frustum would zoom the whole view out until
 * the equipment was a speck.
 */
export function boundsPoints(d: PlanDocument, opts: { ducts?: boolean } = {}): Vec3[] {
  const pts: Vec3[] = [];
  for (const obj of d.objects) {
    const p = positionOf(obj);
    pts.push(p);

    if (isBurner(obj)) {
      const r = burnerDiameterM(obj) / 2;
      const surface = fuelSurfaceZM(obj);
      pts.push([p[0] - r, p[1] - r, p[2]], [p[0] + r, p[1] + r, surface]);
      if (obj.footprint.shape !== 'circle') {
        // The equal-area diameter bounds the flame cone, not a rectangular pan.
        // A long narrow pan can extend metres beyond that circle, especially
        // after rotation, so Fit and the drawing need its physical corners too.
        const [w, depth] = obj.footprint.size_m ?? [0, 0];
        for (const x of [-w / 2, w / 2]) for (const y of [-depth / 2, depth / 2]) {
          pts.push(toWorld(obj, [x, y, 0]), toWorld(obj, [x, y, Math.max(rimHeightM(obj), 0.02)]));
        }
      }
      const tip = flameTipZM(obj);
      if (tip !== null) pts.push([p[0], p[1], tip]);
    } else if (isHood(obj)) {
      const apex = hoodOpeningZM(obj) + hoodCanopyRiseM(obj);
      const top = opts.ducts && obj.duct ? apex + (obj.duct.length_m ?? 2) : apex;
      for (const [x, y] of hoodOpeningCornersXY(obj)) {
        pts.push([x, y, hoodIntakeHeightM(obj)], [x, y, top]);
      }
    } else if (isWall(obj)) {
      const base = p[2] + (obj.baseHeight_m ?? 0);
      for (const v of obj.polyline_m) {
        const [x, y] = footprintXY(obj, v);
        pts.push([x, y, base], [x, y, base + obj.height_m]);
      }
    } else if (isCeiling(obj)) {
      const soffit = ceilingSoffitZM(obj);
      for (const v of obj.polygon_m) {
        const [x, y] = footprintXY(obj, v);
        pts.push([x, y, soffit], [x, y, soffit + (obj.thickness_m ?? 0.1)]);
      }
    } else if (isObstruction(obj)) {
      for (const [x, y] of obstructionCornersXY(obj)) {
        pts.push([x, y, p[2]], [x, y, p[2] + obj.size_m[2]]);
      }
    } else if (isThermocouple(obj)) {
      // Every bead, not the origin: a rake reaching to the ceiling would otherwise
      // be framed as a point on the floor.
      for (const offset of beadOffsetsOf(obj)) pts.push(toWorld(obj, [0, 0, offset]));
      pts.push([p[0], p[1], 0]);
    } else if (isCamera(obj) || isHeatFluxSensor(obj)) {
      pts.push([p[0], p[1], 0]); // the tripod foot
    } else if (isReconstructedFlame(obj)) {
      // The manifest's box, so Fit and the drawing frame the hull without a frame loaded.
      pts.push(...flameBoundsCorners(obj));
    }
  }
  return pts;
}
