import * as i18n from '../ui/i18n';
/**
 * Reading and writing a plan object as FDS would spell it.
 *
 * Fire safety engineers who live in FDS think of a wall as `XB=x1,x2,y1,y2,z1,z2`
 * -- two opposite corners -- and of an instrument as `XYZ` plus an `IOR`. This
 * format stores the same wall as a centreline, a thickness and two heights, because
 * that is what a drawing and a coverage check need. Both descriptions are complete;
 * they are just different parameterisations, and this module converts between them
 * so the inspector can offer either without a second source of truth.
 *
 * Two things make this more than arithmetic.
 *
 * **The frame.** A plan's origin is the burner centre at floor level; an FDS file's
 * is arbitrary. An imported plan records the difference in
 * `meta.source.originOffset_m`, so the numbers shown here can be the ones actually
 * in the `.fds` file rather than merely FDS-shaped. A plan that was never imported
 * has no offset, and the view says so rather than implying the numbers would match
 * a file somewhere.
 *
 * **Not everything is expressible.** `XB` is an axis-aligned box. A wall on a
 * diagonal, a wall with three points, a circular pan, a yawed anything -- none of
 * them is an `XB`, and pretending otherwise would quietly square off geometry
 * someone drew deliberately. Those come back read-only, as the bounding box, with
 * the reason attached.
 */

import { positionOf, quatOf, toWorld } from './plan';
import { forwardOf } from './math';
import type { Xb } from './fds';
import { formatLengthWithUnit } from './units';
import type {
  BurnerObject,
  CeilingObject,
  LengthUnit,
  ObstructionObject,
  PlanDocument,
  PlanObject,
  Vec3,
} from './types';

/** Rotations closer than this to identity are treated as unrotated. A gizmo drag
 *  leaves float noise in a quaternion that was never deliberately turned. */
const QUAT_TOL = 1e-6;
/** Coordinates closer than this are the same coordinate, matching the importer. */
const TOL_M = 1e-4;

export interface FdsFrame {
  /** Add this to a plan coordinate to get the source file's. */
  offset: Vec3;
  /** True when the offset came from an actual import, so the numbers match a file. */
  fromImport: boolean;
  /** The source file's name, when there is one. */
  file: string | null;
}

/**
 * The frame FDS coordinates are shown in.
 *
 * A plan built in the editor has no source file, so the offset is zero and the FDS
 * view is simply plan coordinates in `XB` form -- still useful for typing a wall the
 * way you would type it in FDS, and honest about not matching anyone's input file.
 */
export function fdsFrame(doc: PlanDocument): FdsFrame {
  const source = doc.meta?.source;
  const offset = source?.originOffset_m;
  if (source?.tool === 'FDS' && Array.isArray(offset) && offset.length === 3) {
    return { offset: [offset[0], offset[1], offset[2]], fromImport: true, file: source.file ?? null };
  }
  return { offset: [0, 0, 0], fromImport: false, file: null };
}

const isUnrotated = (o: PlanObject): boolean => {
  const q = quatOf(o);
  return Math.abs(q[0]) < QUAT_TOL && Math.abs(q[1]) < QUAT_TOL && Math.abs(q[2]) < QUAT_TOL
    && Math.abs(Math.abs(q[3]) - 1) < QUAT_TOL;
};

export interface XbView {
  xb: Xb;
  /** False when the box is only a bounding box, so writing it back would change
   *  geometry the user drew deliberately. */
  editable: boolean;
  /** Why it is not editable, phrased for the inspector. */
  why?: string;
}

/**
 * A box in the object's LOCAL frame as an `XB` in the source file's frame.
 *
 * All eight corners go through the shared local-to-world path and the extremes are
 * taken from what comes back, because for a rotated object the two are not the same
 * thing: a 2 x 1 box yawed 90 degrees occupies 1 x 2 of the world, and reporting its
 * unrotated extents as "the bounding box" -- which is what this view promises for
 * anything it cannot write back -- puts the box somewhere it is not. For an
 * unrotated object the rotation is the identity and this is plain translation.
 */
function worldXb(obj: PlanObject, local: Xb, offset: Vec3): Xb {
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (const i of [0, 1]) {
    for (const j of [2, 3]) {
      for (const k of [4, 5]) {
        const w = toWorld(obj, [local[i], local[j], local[k]]);
        xs.push(w[0]);
        ys.push(w[1]);
        zs.push(w[2]);
      }
    }
  }
  return [
    Math.min(...xs) + offset[0], Math.max(...xs) + offset[0],
    Math.min(...ys) + offset[1], Math.max(...ys) + offset[1],
    Math.min(...zs) + offset[2], Math.max(...zs) + offset[2],
  ];
}

/** Which object types have an `XB` at all. Instruments are points, not boxes. */
export const hasXbView = (o: PlanObject): boolean =>
  o.type === 'wall' || o.type === 'ceiling' || o.type === 'obstruction' || o.type === 'burner';

/** Which object types have an FDS `XYZ` + `IOR` view. */
export const hasXyzView = (o: PlanObject): boolean =>
  o.type === 'heatFluxSensor' || o.type === 'thermocouple' || o.type === 'velocityProbe' || o.type === 'gasSampling';

/**
 * This object as an FDS `XB`, or null if it has no meaningful one.
 *
 * Never throws and never returns a box for an object that has no extent: the
 * inspector calls this on whatever is selected.
 */
export function xbOfObject(obj: PlanObject, offset: Vec3 = [0, 0, 0]): XbView | null {
  const rotated = !isUnrotated(obj);
  const rotatedWhy = i18n.t("this object is rotated, so its XB is only a bounding box");

  if (obj.type === 'wall') {
    const wall = obj as unknown as { polyline_m: Array<[number, number]>; height_m: number;
      thickness_m?: number | null; baseHeight_m?: number | null };
    const pts = wall.polyline_m ?? [];
    if (pts.length < 2) return null;
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const thickness = wall.thickness_m ?? 0.1;
    const base = wall.baseHeight_m ?? 0;

    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    // The centreline has no thickness; the box does, so the thin axis grows by the
    // wall's thickness about the line and the long one is left alone.
    const alongX = x1 - x0 >= y1 - y0;
    const xb = worldXb(obj, [
      x0 - (alongX ? 0 : thickness / 2), x1 + (alongX ? 0 : thickness / 2),
      y0 - (alongX ? thickness / 2 : 0), y1 + (alongX ? thickness / 2 : 0),
      base, base + wall.height_m,
    ], offset);

    const straight = pts.length === 2;
    const axisAligned = straight
      && (Math.abs(xs[1] - xs[0]) <= TOL_M || Math.abs(ys[1] - ys[0]) <= TOL_M);
    if (rotated) return { xb, editable: false, why: rotatedWhy };
    if (!straight) {
      return { xb, editable: false, why: i18n.t("this wall has {p1} points, and an XB is one box", { p1: pts.length }) };
    }
    if (!axisAligned) {
      return { xb, editable: false, why: i18n.t("this wall runs on a diagonal, and an XB is axis-aligned") };
    }
    return { xb, editable: true };
  }

  if (obj.type === 'ceiling') {
    const slab = obj as CeilingObject;
    const pts = slab.polygon_m ?? [];
    if (pts.length < 3) return null;
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const z0 = slab.height_m;
    const xb = worldXb(obj, [
      Math.min(...xs), Math.max(...xs),
      Math.min(...ys), Math.max(...ys),
      z0, z0 + (slab.thickness_m ?? 0.1),
    ], offset);
    if (rotated) return { xb, editable: false, why: rotatedWhy };
    // A rectangle has four corners, each sharing an x with one neighbour and a y
    // with the other. Anything else is a shape XB cannot describe.
    const rectangular = pts.length === 4
      && new Set(xs.map((v) => v.toFixed(4))).size === 2
      && new Set(ys.map((v) => v.toFixed(4))).size === 2;
    if (!rectangular) {
      return { xb, editable: false, why: i18n.t("this slab is not a rectangle, and an XB is one box") };
    }
    return { xb, editable: true };
  }

  if (obj.type === 'obstruction') {
    const size = (obj as ObstructionObject).size_m;
    const xb = worldXb(obj, [
      -size[0] / 2, size[0] / 2, -size[1] / 2, size[1] / 2, 0, size[2],
    ], offset);
    return rotated ? { xb, editable: false, why: rotatedWhy } : { xb, editable: true };
  }

  if (obj.type === 'burner') {
    const burner = obj as BurnerObject;
    const rim = burner.rimHeight_m ?? 0;
    const fp = burner.footprint;
    if (fp?.shape === 'circle') {
      const d = fp.diameter_m ?? 0;
      return {
        xb: worldXb(obj, [-d / 2, d / 2, -d / 2, d / 2, 0, rim], offset),
        editable: false,
        why: i18n.t("a circular pan has no XB; this is the box around it"),
      };
    }
    const size = fp?.size_m ?? [0, 0];
    const xb = worldXb(obj, [
      -size[0] / 2, size[0] / 2, -size[1] / 2, size[1] / 2, 0, rim,
    ], offset);
    return rotated ? { xb, editable: false, why: rotatedWhy } : { xb, editable: true };
  }

  return null;
}

/** `raw` in plan coordinates with each pair ascending, exactly as the importer
 *  normalises an XB: typing the far corner first is a normal thing to do and should
 *  not invert the object. */
const normalisedXb = (raw: Xb, offset: Vec3): Xb => [
  Math.min(raw[0], raw[1]) - offset[0], Math.max(raw[0], raw[1]) - offset[0],
  Math.min(raw[2], raw[3]) - offset[1], Math.max(raw[2], raw[3]) - offset[1],
  Math.min(raw[4], raw[5]) - offset[2], Math.max(raw[4], raw[5]) - offset[2],
];

/**
 * Why `raw` cannot be written onto `obj` as its XB, or null when it can.
 *
 * Checked BEFORE anything is mutated, and phrased for the person typing: the XB view
 * is where an engineer types six numbers straight out of an input file, and a slab
 * whose Z1 is the floor is a normal thing to type -- but a ceiling with a soffit
 * height of zero is not an object this format has, and writing it produced a plan
 * that saved and then refused to reopen.
 */
export function xbProblem(
  obj: PlanObject, raw: Xb, offset: Vec3 = [0, 0, 0], unit: LengthUnit = 'm',
): string | null {
  if (raw.some((v) => !Number.isFinite(v))) return i18n.t("every XB coordinate has to be a number");
  const xb = normalisedXb(raw, offset);
  const dx = xb[1] - xb[0];
  const dy = xb[3] - xb[2];
  const dz = xb[5] - xb[4];
  const floorInFile = offset[2];

  if (obj.type === 'wall') {
    if (Math.max(dx, dy) <= TOL_M) return i18n.t("a wall needs some length: X1 X2 or Y1 Y2 have to differ");
    if (dz <= TOL_M) return i18n.t("a wall needs some height: Z2 has to be above Z1");
    return null;
  }
  if (obj.type === 'ceiling') {
    if (dx <= TOL_M || dy <= TOL_M) return i18n.t("a slab needs a footprint: X1 X2 and Y1 Y2 have to differ");
    if (xb[4] <= TOL_M) {
      // In the unit the fields are typed in: a bare metre figure beside feet fields
      // read as the wrong number.
      return i18n.t("a ceiling's Z1 is its soffit, and it has to be above the floor (Z1 > {floor}): a slab at floor level is the floor, not a ceiling", { floor: i18n.numberText(formatLengthWithUnit(floorInFile, unit)) });
    }
    return null;
  }
  if (obj.type === 'obstruction') {
    if (dx <= TOL_M || dy <= TOL_M || dz <= TOL_M) {
      return i18n.t("a box needs three extents: X, Y and Z pairs all have to differ");
    }
    return null;
  }
  if (obj.type === 'burner') {
    if (dx <= TOL_M || dy <= TOL_M) return i18n.t("a burner needs a footprint: X1 X2 and Y1 Y2 have to differ");
    if (dz < 0) return i18n.t("a burner needs Z2 at or above Z1");
    return null;
  }
  return null;
}

/**
 * Rewrite an object's geometry from an FDS `XB`. Mutates in place, and returns
 * the reason it refused to when it did -- in which case nothing was changed.
 *
 * Only ever called for a box `xbOfObject` reported as editable, so it may assume
 * the object is unrotated and its shape is one FDS can describe.
 */
export function applyXbToObject(obj: PlanObject, raw: Xb, offset: Vec3 = [0, 0, 0]): string | null {
  const problem = xbProblem(obj, raw, offset);
  if (problem !== null) return problem;

  const xb = normalisedXb(raw, offset);
  const dx = Math.max(xb[1] - xb[0], TOL_M);
  const dy = Math.max(xb[3] - xb[2], TOL_M);
  const dz = Math.max(xb[5] - xb[4], TOL_M);
  const cx = (xb[0] + xb[1]) / 2;
  const cy = (xb[2] + xb[3]) / 2;

  if (obj.type === 'wall') {
    const wall = obj as unknown as { transform?: { position_m: Vec3 };
      polyline_m: Array<[number, number]>; height_m: number;
      thickness_m?: number | null; baseHeight_m?: number | null };
    // The wall's own geometry is absolute here, so the transform goes back to the
    // origin -- the same shape the importer and `createWall` produce.
    wall.transform = { ...(wall.transform ?? {}), position_m: [0, 0, 0] };
    const alongX = dx >= dy;
    wall.polyline_m = alongX
      ? [[xb[0], cy], [xb[1], cy]]
      : [[cx, xb[2]], [cx, xb[3]]];
    wall.thickness_m = alongX ? dy : dx;
    wall.baseHeight_m = xb[4];
    wall.height_m = dz;
    return null;
  }

  if (obj.type === 'ceiling') {
    const slab = obj as CeilingObject;
    slab.transform = { ...(slab.transform ?? {}), position_m: [0, 0, 0] };
    slab.polygon_m = [[xb[0], xb[2]], [xb[1], xb[2]], [xb[1], xb[3]], [xb[0], xb[3]]];
    slab.height_m = xb[4];
    slab.thickness_m = dz;
    return null;
  }

  if (obj.type === 'obstruction') {
    const solid = obj as ObstructionObject;
    solid.transform = { ...(solid.transform ?? {}), position_m: [cx, cy, xb[4]] };
    solid.size_m = [dx, dy, dz];
    return null;
  }

  if (obj.type === 'burner') {
    const burner = obj as BurnerObject;
    burner.transform = { ...(burner.transform ?? {}), position_m: [cx, cy, xb[4]] };
    burner.footprint = {
      ...(burner.footprint ?? { shape: 'rectangle' }),
      shape: Math.abs(dx - dy) <= TOL_M ? 'square' : 'rectangle',
      size_m: [dx, dy],
      diameter_m: null,
    };
    // The rim may genuinely be zero -- a fire on a flat surface -- so this is not
    // clamped the way the extents are.
    burner.rimHeight_m = Math.max(xb[5] - xb[4], 0);
  }
  return null;
}

export interface XyzView {
  xyz: Vec3;
  /** FDS's index of orientation, when the object faces down an axis. Null for a
   *  thermocouple, which has no facing, and for a gauge aimed off-axis. */
  ior: number | null;
  /** True when the object has a facing at all, so the IOR field is meaningful. */
  aimable: boolean;
}

const IOR_AXES: Array<[number, Vec3]> = [
  [1, [1, 0, 0]], [-1, [-1, 0, 0]],
  [2, [0, 1, 0]], [-2, [0, -1, 0]],
  [3, [0, 0, 1]], [-3, [0, 0, -1]],
];

/** FDS's label for an `IOR`, for the inspector's readout. */
export const iorLabel = (ior: number | null): string =>
  ior === null ? i18n.t("off-axis") : ({
    1: '+X', '-1': '−X', 2: '+Y', '-2': '−Y', 3: '+Z', '-3': '−Z',
  } as Record<string, string>)[String(ior)] ?? String(ior);

export function xyzOfObject(obj: PlanObject, offset: Vec3 = [0, 0, 0]): XyzView | null {
  if (!hasXyzView(obj)) return null;
  const p = positionOf(obj);
  const xyz: Vec3 = [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]];
  if (obj.type !== 'heatFluxSensor') return { xyz, ior: null, aimable: false };

  const normal = forwardOf(quatOf(obj));
  // An IOR is an axis, so only a gauge that really does face down one gets a
  // number. Rounding a 40 degrees-off normal to the nearest axis would be a
  // different gauge reading, not a tidier display.
  const match = IOR_AXES.find(([, axis]) =>
    Math.abs(normal[0] - axis[0]) < 1e-3
    && Math.abs(normal[1] - axis[1]) < 1e-3
    && Math.abs(normal[2] - axis[2]) < 1e-3);
  return { xyz, ior: match ? match[0] : null, aimable: true };
}

/** The world-space outward normal an `IOR` names, for writing one back. */
export const normalForIor = (ior: number): Vec3 | null =>
  IOR_AXES.find(([v]) => v === ior)?.[1] ?? null;
