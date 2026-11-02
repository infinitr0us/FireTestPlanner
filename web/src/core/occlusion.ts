/** Opaque plan geometry, mirrored in python/fireplan/occlusion.py.
 * Intersections are intervals, not just entry faces: clipping the endpoints must
 * not let a ray starting inside a thick wall escape through the rest of it.
 */
import { IDENTITY_QUAT, length, quatToColumns, sub, unrotateVec } from './math';
import { isCeiling, isHood, isObstruction, isWall, type PlanDocument, type PlanObject, type Vec2, type Vec3 } from './types';

export const OCCLUSION_ENDPOINT_TOLERANCE_M = 0.05;
export const FLAME_SAMPLE_COUNT = 9;
/** The rendered skirt has no thickness; checks give each side a 1 cm skin. */
export const HOOD_SKIRT_PANEL_THICKNESS_M = 0.01;
const EPS = 1e-10;
type Interval = [number, number];

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
  const clip: Interval = [trim, 1 - trim];
  let nearest = Number.POSITIVE_INFINITY;
  let blocker: PlanObject | null = null;
  for (const o of d.objects) {
    if (!isWall(o) && !isCeiling(o) && !isObstruction(o) && !isHood(o)) continue;
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
    const accept = (t: number): void => {
      if (t < nearest) { nearest = t; blocker = o; }
    };
    const box = (lo: Vec3, hi: Vec3): void => {
      const hit = boxInterval(a, b, lo, hi, clip);
      if (hit) accept(hit[0]);
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
          const holes: Interval[] = [];
          for (const opening of o.openings ?? []) {
            const start = Math.max(0, opening.offset_m - travelled);
            const end = Math.min(span, opening.offset_m + opening.width_m - travelled);
            const sill = base + (opening.sillHeight_m ?? 0);
            const hit = boxInterval(sa, sb, [start, -half, sill], [end, half, sill + opening.height_m], solid);
            if (hit) holes.push(hit);
          }
          holes.sort((a, b) => a[0] - b[0]);
          let cursor = solid[0];
          for (const [enter, leave] of holes) {
            if (enter > cursor + EPS) break;
            cursor = Math.max(cursor, leave);
          }
          if (cursor < solid[1] - EPS) accept(cursor);
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
          accept(cuts[i - 1]); break;
        }
      }
    }
  }
  return blocker;
}
