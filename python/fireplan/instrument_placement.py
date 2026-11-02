"""Placement geometry mirrored in core/instrument-placement.ts."""
import math
import numpy as np

EPS = 1e-10


def nearest_opening(plan, at, reach):
    best = None
    for wall in plan.walls:
        right = wall.rotation_matrix[:, 0]
        yaw = math.atan2(right[1], right[0])
        c, s = math.cos(yaw), math.sin(yaw)
        dx, dy, dz = np.asarray(at) - wall.position
        x, y = c * dx + s * dy, -s * dx + c * dy
        z = dz - (wall.raw.get('baseHeight_m') or 0)
        along = 0
        poly = wall.raw['polyline_m']
        for a, b in zip(poly, poly[1:]):
            length = math.hypot(b[0] - a[0], b[1] - a[1])
            if length <= EPS:
                continue
            ux, uy = (b[0] - a[0]) / length, (b[1] - a[1]) / length
            u, v = (x - a[0]) * ux + (y - a[1]) * uy, (x - a[0]) * uy - (y - a[1]) * ux
            for opening in wall.openings:
                lo = max(0, opening['offset_m'] - along)
                hi = min(length, opening['offset_m'] + opening['width_m'] - along)
                bottom = opening.get('sillHeight_m') or 0
                top = min(wall.raw['height_m'], bottom + opening['height_m'])
                if hi <= lo or top <= bottom:
                    continue
                distance = math.sqrt(v * v + max(lo - u, 0, u - hi) ** 2 + max(bottom - z, 0, z - top) ** 2)
                if distance <= reach + EPS and (best is None or distance < best['distance'] - EPS):
                    best = {'distance': distance, 'normal': [c * uy + s * ux, s * uy - c * ux, 0]}
            along += length
    return best


def _overlap(a, b, radius=0):
    axes = [[1, 0], [0, 1]]
    for polygon in [a, b]:
        for p, q in zip(polygon, polygon[1:] + polygon[:1]):
            axes.append([p[1] - q[1], q[0] - p[0]])
    if radius:
        axes.extend([[p[0] - b[0][0], p[1] - b[0][1]] for p in a])
    for x, y in axes:
        length = math.hypot(x, y)
        if length < EPS:
            continue
        pa = [(p[0] * x + p[1] * y) / length for p in a]
        pb = [(p[0] * x + p[1] * y) / length for p in b]
        if min(pa) > max(pb) + radius + EPS or max(pa) < min(pb) - radius - EPS:
            return False
    return True


def load_cell_under_fuel(plan, cell):
    corners = cell.platform_corners
    for burner in plan.burners:
        # Clip to the part at or below the fuel surface before projecting.
        height, below = burner.fuel_surface_z_m, []
        for i, p in enumerate(corners):
            q = corners[(i + 1) % len(corners)]
            p_inside, q_inside = p[2] <= height + EPS, q[2] <= height + EPS
            if p_inside:
                below.append(p)
            if p_inside != q_inside:
                t = max(0, min(1, (height - p[2]) / (q[2] - p[2])))
                below.append(p + t * (q - p))
        if not below:
            continue
        xy = [p[:2].tolist() for p in below]
        fp = burner.footprint
        if fp['shape'] == 'circle':
            if _overlap(xy, [burner.position[:2].tolist()], (fp.get('diameter_m') or 0) / 2):
                return True
        else:
            w, d = fp.get('size_m') or [0, 0]
            polygon = [burner.to_world([x, y, 0])[:2].tolist() for x, y in
                       [(-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)]]
            if _overlap(xy, polygon):
                return True
    return False
