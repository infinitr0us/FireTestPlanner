/**
 * Plan document model and derived geometry. Mirror of python/fireplan/plan.py and
 * objects.py -- the two implementations must agree, since a plan can be authored in
 * either and consumed in either.
 */

import {
  effectiveDiameterM,
  flameHeightM,
  plumeRadiusM,
  virtualOriginM,
} from './correlations';
import {
  angleBetweenDeg,
  forwardOf,
  IDENTITY_QUAT,
  length,
  quatToColumns,
  rotateVec,
  sub,
  unrotateVec,
} from './math';
import {
  FORMAT,
  FORMAT_VERSION,
  isBurner,
  isCamera,
  isCeiling,
  isHood,
  isWall,
  type BurnerObject,
  type CameraObject,
  type CeilingObject,
  type HoodObject,
  type Issue,
  type Modality,
  type PlanDocument,
  type PlanObject,
  type Quat,
  type Vec3,
  type WallObject,
} from './types';

// Re-exported so callers get the whole plan vocabulary from one module rather than
// having to know that narrowing helpers live next door in types.ts.
export { isBurner, isCamera, isCeiling, isHood, isWall } from './types';

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
export const quatOf = (o: PlanObject): Quat => o.transform?.rotation_quat ?? IDENTITY_QUAT;
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

/** fx = f * res_x / sensor_w, in pixels. */
export const fxOf = (c: CameraObject): number =>
  (c.camera.focalLength_mm * c.camera.resolution_px[0]) / c.camera.sensor_mm[0];

export const fyOf = (c: CameraObject): number =>
  (c.camera.focalLength_mm * c.camera.resolution_px[1]) / c.camera.sensor_mm[1];

/** Null principal point means the OpenCV image centre, ((w-1)/2, (h-1)/2). */
export function principalPointOf(c: CameraObject): [number, number] {
  const pp = c.camera.principalPoint_px;
  if (pp) return [pp[0], pp[1]];
  const [w, h] = c.camera.resolution_px;
  return [(w - 1) / 2, (h - 1) / 2];
}

export const hfovRadOf = (c: CameraObject): number =>
  2 * Math.atan(c.camera.sensor_mm[0] / (2 * c.camera.focalLength_mm));

export const vfovRadOf = (c: CameraObject): number =>
  2 * Math.atan(c.camera.sensor_mm[1] / (2 * c.camera.focalLength_mm));

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
export const cameraColor = (c: CameraObject): string => {
  const raw = c.display?.color;
  if (typeof raw === 'string' && HEX_COLOR.test(raw)) return raw;
  return MODALITY_COLORS[c.camera.modality] || MODALITY_COLORS.other;
};

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

/** Semantic checks beyond what the schema can express. */
export function checkPlan(d: PlanDocument): Issue[] {
  const out: Issue[] = [];

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
    const target = o.transform?.aimTarget_m;
    if (target && isCamera(o) && q) {
      const delta = sub(target, positionOf(o));
      if (length(delta) < 1e-9) {
        out.push(issue('warning', 'degenerate-aim', 'aimTarget_m coincides with the camera position.', o.id));
      } else {
        const off = angleBetweenDeg(delta, forwardOf(q));
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

  return out.concat(hoodChecks(d), ceilingChecks(d));
}
