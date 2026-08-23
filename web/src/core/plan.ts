/**
 * Plan document model and derived geometry. Mirror of python/fireplan/plan.py and
 * objects.py -- the two implementations must agree, since a plan can be authored in
 * either and consumed in either.
 */

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
  type Modality,
  type PlanDocument,
  type PlanObject,
  type Quat,
  type TcType,
  type ThermocoupleObject,
  type Vec3,
  type WallObject,
} from './types';

// Re-exported so callers get the whole plan vocabulary from one module rather than
// having to know that narrowing helpers live next door in types.ts.
export {
  isAimable, isBurner, isCamera, isCeiling, isHeatFluxSensor, isHood, isThermocouple, isWall,
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
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }
  if (typeof data !== 'object' || data === null) throw new Error('Plan data must be a JSON object');
  const doc = data as PlanDocument;
  if (doc.format !== FORMAT) {
    throw new Error(`Not a fire test plan: expected format "${FORMAT}", got "${String(doc.format)}"`);
  }
  if (!Array.isArray(doc.objects)) doc.objects = [];
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

export const findObject = (d: PlanDocument, id: string): PlanObject | undefined =>
  d.objects.find((o) => o.id === id);

/** The burner at the origin -- by definition the one the frame was built around. */
export function primaryBurner(d: PlanDocument): BurnerObject | undefined {
  const all = burners(d);
  if (all.length <= 1) return all[0];
  return all.find((b) => Math.hypot(...positionOf(b).slice(0, 2)) < 1e-6) ?? all[0];
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

/** Fallback colours for object types that have no modality to key off. Kept in
 *  step with `COLORS` in web/src/scene/builders.ts so the 3D view, the outliner
 *  and the printed drawing agree on what a gauge looks like. */
export const TYPE_COLORS: Record<string, string> = {
  heatFluxSensor: '#ef4444',
  thermocouple: '#10b981',
};

/**
 * True when an object's colour carries information — a camera's modality, an
 * instrument's kind, or a colour the user set by hand. A wall has no such colour,
 * and tinting it would say something about it that is not true.
 */
export const hasObjectColor = (o: PlanObject): boolean =>
  isCamera(o)
  || o.type in TYPE_COLORS
  || (typeof o.display?.color === 'string' && HEX_COLOR.test(o.display.color));

/** Any object's display colour, normalised. Same guarantees as above: this is the
 *  only place `display.color` is read, so an untrusted value is neutralised once. */
export function objectColor(o: PlanObject): string {
  const raw = o.display?.color;
  if (typeof raw === 'string' && HEX_COLOR.test(raw)) return raw;
  if (isCamera(o)) return MODALITY_COLORS[o.camera.modality] || MODALITY_COLORS.other;
  return TYPE_COLORS[o.type] ?? MODALITY_COLORS.other;
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

  const samples: Vec3[] = [];
  for (let i = 0; i < rings; i += 1) {
    const z = baseZ + ((tipZ - baseZ) * i) / (rings - 1);
    const r = plumeRadiusAtZ(burner, z) ?? 0;
    for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      samples.push([bp[0] + r * Math.cos(a), bp[1] + r * Math.sin(a), z]);
    }
  }

  return {
    base: isPointVisible(c, [bp[0], bp[1], baseZ]),
    tip: isPointVisible(c, [bp[0], bp[1], tipZ]),
    fraction: samples.filter((s) => isPointVisible(c, s)).length / samples.length,
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

/**
 * Where the point-source radiation model puts the fire: mid-flame, on the burner
 * axis. Also the point a camera or a gauge means by "aim at the fire", which is
 * why there is one function rather than two conventions.
 */
export function firePointSourceM(d: PlanDocument): Vec3 | null {
  const b = primaryBurner(d);
  if (!b) return null;
  const tip = flameTipZM(b);
  if (tip === null) return null;
  const p = positionOf(b);
  return [p[0], p[1], (fuelSurfaceZM(b) + tip) / 2];
}

// -- heat flux sensor ------------------------------------------------------

export interface HeatFluxEstimate {
  /** Slant distance from the sensing face to the mid-flame point source. */
  distanceM: number;
  /** Angle between the gauge's outward normal and the line to the fire. */
  offAxisDeg: number;
  /** Predicted incident flux, kW/m2. Zero when the gauge faces away. */
  incidentKwM2: number;
  facesFire: boolean;
  /** False when the fire falls outside a view-limiting tube's acceptance cone. */
  withinViewAngle: boolean;
  /** True when the gauge is close enough that "point source" stops being true. */
  nearField: boolean;
  /** Fraction of full scale, or null when no range is recorded. */
  fractionOfRange: number | null;
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
  const burner = primaryBurner(d);
  const source = firePointSourceM(d);
  if (!burner || !source) return null;
  const q = hrrKwOf(burner);
  if (q === null || q <= 0) return null;

  const at = positionOf(s);
  const delta = sub(source, at);
  const distanceM = length(delta);
  const range = gaugeRangeKwM2(s);

  if (distanceM < 1e-9) {
    // Sitting in the fire. There is no direction to the source, so there is no
    // cosine either; say so rather than dividing by zero.
    return {
      distanceM: 0, offAxisDeg: 0, incidentKwM2: Number.POSITIVE_INFINITY,
      facesFire: true, withinViewAngle: true, nearField: true,
      fractionOfRange: range === null ? null : Number.POSITIVE_INFINITY,
    };
  }

  const cosTheta = dot(gaugeNormal(s), normalize(delta));
  const incidentKwM2 = pointSourceFluxKwM2(q, distanceM, cosTheta, radiativeFractionOf(burner));

  return {
    distanceM,
    offAxisDeg: angleBetweenDeg(gaugeNormal(s), delta),
    incidentKwM2,
    facesFire: cosTheta > 0,
    withinViewAngle: angleBetweenDeg(gaugeNormal(s), delta) <= gaugeViewAngleDeg(s) / 2,
    nearField: distanceM < POINT_SOURCE_MIN_DIAMETERS * burnerDiameterM(burner),
    fractionOfRange: range === null ? null : incidentKwM2 / range,
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
  /** Horizontal distance from the burner axis. */
  radialM: number;
  /** Where it sits relative to the drawn fire. */
  region: 'flame' | 'plume' | 'outside';
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
  const burner = primaryBurner(d);
  const ambient = d.environment?.ambientTemperature_C ?? 20;
  const bp = burner ? positionOf(burner) : null;
  const tipZ = burner ? flameTipZM(burner) : null;
  const q = burner ? hrrKwOf(burner) : null;

  return beadOffsetsOf(t).map((offsetM, index) => {
    const world = toWorld(t, [0, 0, offsetM]);
    const radialM = bp ? Math.hypot(world[0] - bp[0], world[1] - bp[1]) : Number.NaN;

    let region: BeadState['region'] = 'outside';
    let gasTemperatureC: number | null = null;

    if (burner && bp && tipZ !== null) {
      const flameR = flameRadiusAtZ(burner, world[2]);
      const plumeR = plumeRadiusAtZ(burner, world[2]);
      // Both bounds are load-bearing. `flameRadiusAtZ` reports 0 outside the cone's
      // own height band rather than null, so without the lower bound a bead exactly
      // on the burner axis -- the default placement of a rake with no transform --
      // satisfies `radialM <= 0` at any depth below the pan and is called `flame`.
      if (world[2] >= fuelSurfaceZM(burner) && world[2] <= tipZ
          && flameR !== null && radialM <= flameR) {
        region = 'flame';
      } else if (world[2] > fuelSurfaceZM(burner) && plumeR !== null && radialM <= plumeR) {
        region = 'plume';
        // Above the mean tip only: inside the flame's own height the plume
        // correlation is not merely imprecise, it is the wrong correlation.
        if (world[2] > tipZ && q !== null) {
          const rise = plumeCentrelineRiseK(
            world[2] - fuelSurfaceZM(burner), q, burnerDiameterM(burner),
            radiativeFractionOf(burner),
          );
          if (rise !== null) gasTemperatureC = ambient + rise;
        }
      }
    }

    return { index, offsetM, world, radialM, region, gasTemperatureC };
  });
}

// -- hood -----------------------------------------------------------------

/** Lowest plane that must capture the plume: opening, less any skirt. */
export const hoodIntakeHeightM = (h: HoodObject): number => h.height_m - (h.skirtDepth_m ?? 0);

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
export function hoodChecks(d: PlanDocument): Issue[] {
  const out: Issue[] = [];
  const allHoods = hoods(d);
  if (allHoods.length === 0) return out;

  const burner = primaryBurner(d);
  if (!burner) return out;
  const tip = flameTipZM(burner);
  if (tip === null) return out;
  const bp = positionOf(burner);

  for (const hood of allHoods) {
    const intake = hoodIntakeHeightM(hood);
    const off = hoodOpeningOffset(hood, [bp[0], bp[1]]);

    // Nothing else is meaningful about a hood that is not over the fire: the flame
    // cannot reach a canopy beside it, and the plume it fails to capture is not a
    // margin problem but a placement one.
    if (!off.inside) {
      out.push(issue('error', 'hood-offset',
        `The hood opening does not cover the burner — the burner centre is ` +
        `${off.overhang.toFixed(2)} m outside the opening, so this hood captures ` +
        `none of the plume.`, hood.id));
      continue;
    }

    if (tip >= intake) {
      out.push(issue('error', 'flame-impingement',
        `Mean flame tip reaches ${tip.toFixed(2)} m, at or above the hood intake at ` +
        `${intake.toFixed(2)} m — flame in the canopy, not a free plume.`, hood.id));
    } else if (tip > 0.8 * intake) {
      out.push(issue('warning', 'flame-clearance',
        `Mean flame tip at ${tip.toFixed(2)} m leaves only ${(intake - tip).toFixed(2)} m ` +
        `below the hood intake; an intermittent tip will reach higher.`, hood.id));
    }

    const radius = plumeRadiusAtZ(burner, intake);
    if (radius !== null) {
      const plumeD = 2 * radius;
      // Span the plume demands along each opening axis, and the axis with the least
      // slack -- which is the one that spills first.
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
          `Plume is ${plumeD.toFixed(2)} m across at the hood intake${eccentric}, needing ` +
          `${need.toFixed(2)} m of a ${avail.toFixed(2)} m opening — the hood will spill and ` +
          `HRR by oxygen consumption will read low.`, hood.id));
      } else if (need > 0.8 * avail) {
        out.push(issue('warning', 'plume-margin',
          `Plume is ${plumeD.toFixed(2)} m across at the hood intake${eccentric}, needing ` +
          `${need.toFixed(2)} m of a ${avail.toFixed(2)} m opening — little margin for ` +
          `draught or an off-centre fire.`, hood.id));
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

  const burner = primaryBurner(d);
  if (!burner) return out;
  const tip = flameTipZM(burner);
  if (tip === null) return out;

  const bp = positionOf(burner);
  const surface = fuelSurfaceZM(burner);

  for (const slab of slabs) {
    if (slab.height_m <= surface) continue;              // below the fire
    if (!ceilingCoversXY(slab, bp[0], bp[1])) continue;  // off to one side

    if (tip >= slab.height_m) {
      out.push(issue('error', 'ceiling-impingement',
        `Mean flame tip reaches ${tip.toFixed(2)} m, at or above the ceiling soffit at ` +
        `${slab.height_m.toFixed(2)} m — the fire will spread as a ceiling jet and the ` +
        `free-plume correlations no longer apply.`, slab.id));
    } else if (tip > 0.8 * slab.height_m) {
      out.push(issue('warning', 'ceiling-clearance',
        `Mean flame tip at ${tip.toFixed(2)} m leaves only ` +
        `${(slab.height_m - tip).toFixed(2)} m below the ceiling; an intermittent tip ` +
        `will reach higher.`, slab.id));
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
  if (frac !== null && frac > 1) return { status: 'bad', label: 'over range' };
  if (!e.withinViewAngle) return { status: 'warn', label: 'outside view cone' };
  if (frac !== null && frac < LOW_SIGNAL_FRACTION) return { status: 'warn', label: 'low signal' };
  // The number is still printed, but it is an order of magnitude. Green would say
  // "size the gauge on this", which is the one thing `gauge-near-field` forbids.
  if (e.nearField) return { status: 'warn', label: 'near field' };
  return { status: 'ok', label: 'usable' };
}

/** One bead. The flame branch never falls through to the plume wording: a bead in
 *  the flame has no plume temperature, and calling it "in the plume" was how the
 *  report described an over-temperature bead as if it were a good one. */
export function beadVerdict(b: BeadState, limitC: number): InstrumentVerdict {
  if (b.region === 'flame') {
    return limitC < FLAME_TEMPERATURE_C
      ? { status: 'bad', label: `in the flame, past the ${limitC} °C limit` }
      : { status: 'warn', label: 'in the flame' };
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
      out.push(issue('warning', 'gauge-near-field',
        `The gauge is ${e.distanceM.toFixed(2)} m from a fire of effective diameter ` +
        `${burnerDiameterM(primaryBurner(d)!).toFixed(2)} m. Closer than ` +
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

    const inFlame = beads.filter((b) => b.region === 'flame');
    if (inFlame.length > 0) {
      const which = inFlame.length === beads.length
        ? 'every bead'
        : `${inFlame.length} of ${beads.length} beads`;
      if (limit < FLAME_TEMPERATURE_C) {
        out.push(issue('error', 'tc-over-temperature',
          `${which} sits inside the mean flame envelope, where gas is roughly ` +
          `${FLAME_TEMPERATURE_C} °C — past the ${limit} °C limit of a type ${type} ` +
          `thermocouple.`, t.id));
      } else {
        out.push(issue('warning', 'tc-in-flame',
          `${which} sits inside the mean flame envelope. Expect intermittent flame ` +
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

    if (beads.every((b) => b.region === 'outside') && firePointSourceM(d) !== null) {
      out.push(issue('info', 'tc-outside-plume',
        'No bead falls inside the flame or the plume envelope, so this rake will read close ' +
        'to ambient.', t.id));
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
  }

  return out.concat(hoodChecks(d), ceilingChecks(d), instrumentChecks(d));
}
