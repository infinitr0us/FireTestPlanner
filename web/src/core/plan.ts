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
import { angleBetweenDeg, forwardOf, IDENTITY_QUAT, length, sub } from './math';
import {
  FORMAT,
  FORMAT_VERSION,
  isBurner,
  isCamera,
  isHood,
  isWall,
  type BurnerObject,
  type CameraObject,
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
export { isBurner, isCamera, isHood, isWall } from './types';

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

export const cameraColor = (c: CameraObject): string =>
  c.display?.color || MODALITY_COLORS[c.camera.modality] || MODALITY_COLORS.other;

export const intrinsicsSourceOf = (c: CameraObject) => c.camera.intrinsicsSource ?? 'nominal';

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

// -- checks ---------------------------------------------------------------

const issue = (severity: Issue['severity'], code: string, message: string, objectId?: string): Issue =>
  objectId === undefined ? { severity, code, message } : { severity, code, message, objectId };

/**
 * Flame impingement and plume capture.
 *
 * Both are measurement-validity questions, not cosmetics: flame in the canopy is no
 * longer a free plume, and a hood that spills plume under-reads HRR by oxygen
 * consumption.
 */
export function hoodChecks(d: PlanDocument): Issue[] {
  const out: Issue[] = [];
  const allHoods = hoods(d);
  if (allHoods.length === 0) return out;

  const burner = primaryBurner(d);
  if (!burner) return out;
  const tip = flameTipZM(burner);
  if (tip === null) return out;

  for (const hood of allHoods) {
    const intake = hoodIntakeHeightM(hood);

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
      const opening = Math.min(hood.opening_m[0], hood.opening_m[1]);
      if (plumeD > opening) {
        out.push(issue('error', 'plume-spillage',
          `Plume is ${plumeD.toFixed(2)} m across at the hood intake but the opening is only ` +
          `${opening.toFixed(2)} m — the hood will spill and HRR by oxygen consumption will read low.`,
          hood.id));
      } else if (plumeD > 0.8 * opening) {
        out.push(issue('warning', 'plume-margin',
          `Plume is ${plumeD.toFixed(2)} m across at a ${opening.toFixed(2)} m opening, leaving ` +
          `little margin for draught or an off-centre fire.`, hood.id));
      }
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

  return out.concat(hoodChecks(d));
}
