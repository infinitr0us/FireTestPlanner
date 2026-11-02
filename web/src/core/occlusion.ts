/** Opaque plan geometry, mirrored in python/fireplan/occlusion.py.
 * Intersections are intervals, not just entry faces: clipping the endpoints must
 * not let a ray starting inside a thick wall escape through the rest of it.
 */
import { IDENTITY_QUAT, length, quatToColumns, rotateVec, sub, unrotateVec } from './math';
import { isCeiling, isHood, isObstruction, isWall, type PlanDocument, type PlanObject, type Vec2, type Vec3 } from './types';

export const OCCLUSION_ENDPOINT_TOLERANCE_M = 0.05;
export const FLAME_SAMPLE_COUNT = 9;
/** The rendered skirt has no thickness; checks give each side a 1 cm skin. */
export const HOOD_SKIRT_PANEL_THICKNESS_M = 0.01;
const EPS = 1e-10;
type Interval = [number, number];

interface SolidHit { object: PlanObject; t: number; normal: Vec3 | null }

/** IOR can describe only a world-axis face. */
function faceIor(hit: SolidHit | null): number | null {
  if (!hit?.normal) return null;
  const n = hit.normal;
  const axis = n.reduce((best, v, i) => Math.abs(v) > Math.abs(n[best]) ? i : best, 0);
  return Math.abs(n[axis]) >= 1 - EPS ? Math.sign(n[axis]) * (axis + 1) : null;
}

/** Outward normal at a box entry (or the inward normal at a hole exit).
 * A clipped point inside a solid has no entry face. */
function boxNormal(a: Vec3, b: Vec3, lo: Vec3, hi: Vec3, t: number, hole = false): Vec3 | null {
  for (let i = 0; i < 3; i += 1) {
    const delta = b[i] - a[i];
    const sign = delta > 0 ? -1 : 1;
    const face = (sign < 0) !== hole ? lo[i] : hi[i];
    if (Math.abs(delta) > EPS && Math.abs(a[i] + t * delta - face) < 1e-9) {
      const n: Vec3 = [0, 0, 0]; n[i] = sign; return n;
    }
  }
  return null;
}

export function flameCentrelineSamples(at: Vec3, base: number, tip: number): Vec3[] {
  return Array.from({ length: FLAME_SAMPLE_COUNT }, (_, i) =>
    [at[0], at[1], base + (tip - base) * i / (FLAME_SAMPLE_COUNT - 1)]);
}

/** Segment parameters inside an axis-aligned box, restricted to `clip`. */
function boxInterval(a: Vec3, b: Vec3, lo: Vec3, hi: Vec3, clip: Interval): Interval | null {
  let [enter, leave] = clip;
  for (let i = 0; i < 3; i += 1) {
    if (hi[i] - lo[i] <= EPS) return null;
    const delta = b[i] - a[i];
    if (Math.abs(delta) <= EPS) {
      if (a[i] < lo[i] - EPS || a[i] > hi[i] + EPS) return null;
    } else {
      const t0 = (lo[i] - a[i]) / delta;
      const t1 = (hi[i] - a[i]) / delta;
      enter = Math.max(enter, Math.min(t0, t1));
      leave = Math.min(leave, Math.max(t0, t1));
    }
    if (leave - enter <= EPS) return null;
  }
  return [enter, leave];
}

function inPolygon(x: number, y: number, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0; i < polygon.length; i += 1) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[(i + 1) % polygon.length];
    const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
    if (Math.abs(cross) <= EPS && x >= Math.min(ax, bx) - EPS && x <= Math.max(ax, bx) + EPS
      && y >= Math.min(ay, by) - EPS && y <= Math.max(ay, by) + EPS) return true;
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/** Return the nearest opaque object along A -> B, or null. Hidden objects block.
 * Walls/hoods/slabs use yaw; a box uses its full object transform. No plan data
 * is changed. Openings subtract intervals through the entire wall thickness.
 */
export function firstOccluder(d: PlanDocument, from: Vec3, to: Vec3): PlanObject | null {
  const distance = length(sub(to, from));
  if (distance <= 2 * OCCLUSION_ENDPOINT_TOLERANCE_M) return null;
  const trim = OCCLUSION_ENDPOINT_TOLERANCE_M / distance;
  return firstSolidHit(d, from, to, [trim, 1 - trim])?.object ?? null;
}

/** Surface mounting uses the same solids and opening subtraction as visibility,
 * with no endpoint trimming and no hood skirts. */
export function mountingIor(d: PlanDocument, position: Vec3, normal: Vec3): number | null {
  const axis = normal.reduce((best, v, i) => Math.abs(v) > Math.abs(normal[best]) ? i : best, 0);
  if (Math.abs(normal[axis]) < Math.cos(5 * Math.PI / 180) - EPS) return null;
  const sign = normal[axis] < 0 ? -1 : 1;
  // The plan floor is the source floor slab's top after re-origination. Its
  // mounting face exists even though that slab is not stored as a plan object.
  if (axis === 2 && sign > 0 && position[2] >= 0 && position[2] <= 0.05 + EPS) return 3;
  // Start just outside a flush face; include the 50 mm boundary itself.
  const from = position.map((v, i) => v + normal[i] * 1e-7) as Vec3;
  const to = position.map((v, i) => v - normal[i] * (0.05 + 1e-7)) as Vec3;
  const hit = firstSolidHit(d, from, to, [0, 1], true);
  // IOR describes a world-axis face, not merely the closest axis of a rotated box.
  return faceIor(hit) === sign * (axis + 1) ? sign * (axis + 1) : null;
}

/** A surface bead has no facing. Search both sides of each world axis using
 * the same solid entry faces as gauges, then choose the closest within 50 mm.
 * Reverse rays also find a face when the bead is just inside a solid. */
export function nearestMountingIor(d: PlanDocument, position: Vec3): number | null {
  let nearest = Math.abs(position[2]) <= 0.05 + EPS ? Math.abs(position[2]) : Infinity;
  let ior: number | null = Number.isFinite(nearest) ? 3 : null;
  const accept = (hit: SolidHit | null, distance: number): void => {
    const candidate = faceIor(hit);
    if (candidate !== null && distance <= 0.05 + EPS && distance < nearest - EPS) {
      nearest = distance; ior = candidate;
    }
  };
  const reach = 0.05 + 1e-7;
  for (let axis = 0; axis < 3; axis += 1) for (const sign of [1, -1]) {
    const start = [...position] as Vec3, end = [...position] as Vec3;
    start[axis] -= sign * 1e-7;
    end[axis] += sign * reach;
    const forward = firstSolidHit(d, start, end, [0, 1], true);
    if (forward) accept(forward, Math.abs(forward.t * (reach + 1e-7) - 1e-7));
    const reverse = firstSolidHit(d, end, start, [0, 1], true);
    if (reverse) accept(reverse, Math.abs(reach - reverse.t * (reach + 1e-7)));
  }
  return ior;
}

function firstSolidHit(d: PlanDocument, from: Vec3, to: Vec3, clip: Interval, mounting = false): SolidHit | null {
  let nearest = Number.POSITIVE_INFINITY;
  let result: SolidHit | null = null;
  for (const o of d.objects) {
    if (!isWall(o) && !isCeiling(o) && !isObstruction(o) && !isHood(o)) continue;
    if (mounting && isHood(o)) continue;
    const q = o.transform?.rotation_quat ?? IDENTITY_QUAT;
    const rotation = Math.hypot(...q) > 0 ? q : IDENTITY_QUAT;
    const axis = quatToColumns(rotation)[0];
    const yaw = Math.atan2(axis[1], axis[0]);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const local = (p: Vec3): Vec3 => {
      const v = sub(p, o.transform?.position_m ?? [0, 0, 0]);
      return isObstruction(o) ? unrotateVec(rotation, v)
        : [c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]];
    };
    const a = local(from), b = local(to);
    const accept = (t: number, n: Vec3 | null = null): void => {
      if (t < nearest) {
        nearest = t;
        const normal = n === null ? null : isObstruction(o) ? rotateVec(rotation, n)
          : [c * n[0] - s * n[1], s * n[0] + c * n[1], n[2]] as Vec3;
        result = { object: o, t, normal };
      }
    };
    const box = (lo: Vec3, hi: Vec3): void => {
      const hit = boxInterval(a, b, lo, hi, clip);
      if (hit) accept(hit[0], mounting ? boxNormal(a, b, lo, hi, hit[0]) : null);
    };
    if (isObstruction(o)) {
      const [x, y, z] = o.size_m;
      box([-x / 2, -y / 2, 0], [x / 2, y / 2, z]);
    } else if (isHood(o)) {
      const depth = o.skirtDepth_m ?? 0;
      if (depth <= 0) continue;
      const [x, y] = o.opening_m.map(v => v / 2);
      const t = HOOD_SKIRT_PANEL_THICKNESS_M / 2;
      const z = o.height_m - depth;
      for (const side of [-1, 1]) {
        box([side * x - t, -y - t, z], [side * x + t, y + t, o.height_m]);
        box([-x - t, side * y - t, z], [x + t, side * y + t, o.height_m]);
      }
    } else if (isWall(o)) {
      let travelled = 0;
      const half = (o.thickness_m ?? 0.1) / 2;
      const base = o.baseHeight_m ?? 0;
      for (let i = 1; i < o.polyline_m.length; i += 1) {
        const [x, y] = o.polyline_m[i - 1];
        const dx = o.polyline_m[i][0] - x, dy = o.polyline_m[i][1] - y;
        const span = Math.hypot(dx, dy);
        if (span < 1e-9) continue;
        const segmentLocal = (p: Vec3): Vec3 => [
          ((p[0] - x) * dx + (p[1] - y) * dy) / span,
          (-(p[0] - x) * dy + (p[1] - y) * dx) / span, p[2],
        ];
        const sa = segmentLocal(a), sb = segmentLocal(b);
        const solid = boxInterval(sa, sb, [0, -half, base], [span, half, base + o.height_m], clip);
        if (solid) {
          const holes: Array<{ interval: Interval; normal: Vec3 | null }> = [];
          for (const opening of o.openings ?? []) {
            const start = Math.max(0, opening.offset_m - travelled);
            const end = Math.min(span, opening.offset_m + opening.width_m - travelled);
            const sill = base + (opening.sillHeight_m ?? 0);
            const hit = boxInterval(sa, sb, [start, -half, sill], [end, half, sill + opening.height_m], solid);
            if (hit) holes.push({ interval: hit, normal: mounting
              ? boxNormal(sa, sb, [start, -half, sill], [end, half, sill + opening.height_m], hit[1], true) : null });
          }
          holes.sort((a, b) => a.interval[0] - b.interval[0]);
          let cursor = solid[0];
          let n = mounting ? boxNormal(sa, sb, [0, -half, base], [span, half, base + o.height_m], cursor) : null;
          for (const { interval: [enter, leave], normal } of holes) {
            if (enter > cursor + EPS) break;
            if (leave > cursor) n = normal;
            cursor = Math.max(cursor, leave);
          }
          if (cursor < solid[1] - EPS) accept(cursor, n
            ? [(n[0] * dx - n[1] * dy) / span, (n[0] * dy + n[1] * dx) / span, n[2]] : null);
        }
        travelled += span;
      }
    } else if (isCeiling(o) && o.polygon_m.length >= 3) {
      // Most slabs are rectangles. Preserve polygon edges too, so a concave slab
      // does not cast a shadow across the empty part of its bounding box.
      const xs = o.polygon_m.map(p => p[0]), ys = o.polygon_m.map(p => p[1]);
      const hit = boxInterval(a, b, [Math.min(...xs), Math.min(...ys), o.height_m],
        [Math.max(...xs), Math.max(...ys), o.height_m + (o.thickness_m ?? 0.1)], clip);
      if (!hit) continue;
      const cuts = [...hit];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      for (let i = 0; i < o.polygon_m.length; i += 1) {
        const p = o.polygon_m[i], q = o.polygon_m[(i + 1) % o.polygon_m.length];
        const ex = q[0] - p[0], ey = q[1] - p[1];
        const cross = dx * ey - dy * ex;
        if (Math.abs(cross) <= EPS) continue;
        const t = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / cross;
        const u = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / cross;
        if (t > hit[0] && t < hit[1] && u >= 0 && u <= 1) cuts.push(t);
      }
      cuts.sort((a, b) => a - b);
      for (let i = 1; i < cuts.length; i += 1) {
        const mid = (cuts[i - 1] + cuts[i]) / 2;
        if (cuts[i] - cuts[i - 1] > EPS && inPolygon(a[0] + dx * mid, a[1] + dy * mid, o.polygon_m)) {
          const t = cuts[i - 1];
          let n: Vec3 | null = null;
          if (mounting) {
            const z = a[2] + (b[2] - a[2]) * t;
            if (Math.abs(z - o.height_m) < 1e-9 && b[2] > a[2]) n = [0, 0, -1];
            else if (Math.abs(z - o.height_m - (o.thickness_m ?? 0.1)) < 1e-9 && b[2] < a[2]) n = [0, 0, 1];
            else {
              const x = a[0] + dx * t, y = a[1] + dy * t;
              for (let j = 0; j < o.polygon_m.length; j += 1) {
                const p = o.polygon_m[j], q = o.polygon_m[(j + 1) % o.polygon_m.length];
                const ex = q[0] - p[0], ey = q[1] - p[1], span = Math.hypot(ex, ey);
                if (span <= EPS || Math.abs((x - p[0]) * ey - (y - p[1]) * ex) > 1e-9 * span
                  || x < Math.min(p[0], q[0]) - EPS || x > Math.max(p[0], q[0]) + EPS
                  || y < Math.min(p[1], q[1]) - EPS || y > Math.max(p[1], q[1]) + EPS) continue;
                const sign = dx * ey - dy * ex > 0 ? -1 : 1;
                n = [sign * ey / span, -sign * ex / span, 0]; break;
              }
            }
          }
          accept(t, n); break;
        }
      }
    }
  }
  return result;
}
