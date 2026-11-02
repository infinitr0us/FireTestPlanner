/** Placement geometry for instruments without a prediction model. */
import { positionOf, quatOf, toWorld, fuelSurfaceZM } from './plan';
import { quatToColumns } from './math';
import { isBurner, isWall, type LoadCellObject, type PlanDocument, type Vec2, type Vec3 } from './types';

const EPS = 1e-10;

/** Nearest finite opening patch, split at polyline corners. Structural walls use yaw. */
export function nearestOpening(doc: PlanDocument, at: Vec3, reach: number): { normal: Vec3; distance: number } | null {
  let best: { normal: Vec3; distance: number } | null = null;
  for (const wall of doc.objects.filter(isWall)) {
    const origin = positionOf(wall), right = quatToColumns(quatOf(wall))[0];
    const yaw = Math.atan2(right[1], right[0]), c = Math.cos(yaw), s = Math.sin(yaw);
    const dx = at[0] - origin[0], dy = at[1] - origin[1];
    const x = c * dx + s * dy, y = -s * dx + c * dy;
    const z = at[2] - origin[2] - (wall.baseHeight_m ?? 0);
    let along = 0;
    for (let i = 1; i < wall.polyline_m.length; i++) {
      const a = wall.polyline_m[i - 1], b = wall.polyline_m[i];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length <= EPS) continue;
      const ux = (b[0] - a[0]) / length, uy = (b[1] - a[1]) / length;
      const u = (x - a[0]) * ux + (y - a[1]) * uy;
      const v = (x - a[0]) * uy - (y - a[1]) * ux;
      for (const opening of wall.openings ?? []) {
        const lo = Math.max(0, opening.offset_m - along), hi = Math.min(length, opening.offset_m + opening.width_m - along);
        if (hi <= lo) continue;
        const bottom = opening.sillHeight_m ?? 0, top = Math.min(wall.height_m, bottom + opening.height_m);
        if (top <= bottom) continue;
        const distance = Math.hypot(v, Math.max(lo - u, 0, u - hi), Math.max(bottom - z, 0, z - top));
        if (distance <= reach + EPS && (!best || distance < best.distance - EPS)) {
          best = { distance, normal: [c * uy + s * ux, s * uy - c * ux, 0] };
        }
      }
      along += length;
    }
  }
  return best;
}

export const platformCorners = (cell: LoadCellObject): Vec3[] => {
  if (!cell.platform_m) return [positionOf(cell)];
  const [w, d] = cell.platform_m;
  return ([[-w / 2, -d / 2, 0], [w / 2, -d / 2, 0], [w / 2, d / 2, 0], [-w / 2, d / 2, 0]] as Vec3[]).map(p => toWorld(cell, p));
};

/** Convex polygon overlap, also accepting a point or a projected line. */
function overlap(a: Vec2[], b: Vec2[], radius = 0): boolean {
  const axes: Vec2[] = [[1, 0], [0, 1]];
  for (const polygon of [a, b]) for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i], q = polygon[(i + 1) % polygon.length];
    axes.push([p[1] - q[1], q[0] - p[0]]);
  }
  // Circle versus polygon needs the closest vertex axis as well as edge normals.
  if (radius) for (const p of a) axes.push([p[0] - b[0][0], p[1] - b[0][1]]);
  return axes.every(([x, y]) => {
    const length = Math.hypot(x, y); if (length < EPS) return true;
    const pa = a.map(p => (p[0] * x + p[1] * y) / length), pb = b.map(p => (p[0] * x + p[1] * y) / length);
    return Math.min(...pa) <= Math.max(...pb) + radius + EPS && Math.max(...pa) >= Math.min(...pb) - radius - EPS;
  });
}

export function loadCellUnderFuel(doc: PlanDocument, cell: LoadCellObject): boolean {
  const corners = platformCorners(cell);
  return doc.objects.filter(isBurner).some(b => {
    // Clip a tilted platform to the part at or below the fuel surface before
    // projecting it. A higher corner outside the footprint is not a conflict.
    const height = fuelSurfaceZM(b), below: Vec3[] = [];
    for (let i = 0; i < corners.length; i++) {
      const p = corners[i], q = corners[(i + 1) % corners.length];
      const pInside = p[2] <= height + EPS, qInside = q[2] <= height + EPS;
      if (pInside) below.push(p);
      if (pInside !== qInside) {
        const t = Math.max(0, Math.min(1, (height - p[2]) / (q[2] - p[2])));
        below.push(p.map((v, j) => v + t * (q[j] - v)) as Vec3);
      }
    }
    if (!below.length) return false;
    const xy = below.map(p => [p[0], p[1]] as Vec2);
    if (b.footprint.shape === 'circle') return overlap(xy, [positionOf(b).slice(0, 2) as Vec2], (b.footprint.diameter_m ?? 0) / 2);
    const [w, d] = b.footprint.size_m ?? [0, 0];
    const polygon = ([[-w / 2, -d / 2, 0], [w / 2, -d / 2, 0], [w / 2, d / 2, 0], [-w / 2, d / 2, 0]] as Vec3[])
      .map(p => toWorld(b, p).slice(0, 2) as Vec2);
    return overlap(xy, polygon);
  });
}
