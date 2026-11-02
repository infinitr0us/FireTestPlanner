"""Opaque plan geometry. Mirror of web/src/core/occlusion.ts (CONVENTIONS 5b)."""
from __future__ import annotations

import math

import numpy as np

from .objects import Ceiling, Hood, Obstruction, Wall

OCCLUSION_ENDPOINT_TOLERANCE_M = 0.05
FLAME_SAMPLE_COUNT = 9
HOOD_SKIRT_PANEL_THICKNESS_M = 0.01
_EPS = 1e-10


def flame_centreline_samples(burner, t=None):
    base, tip = burner.fuel_surface_z_m, burner.flame_tip_z_m(t)
    x, y = burner.position[:2]
    return [[x, y, base + (tip - base) * i / (FLAME_SAMPLE_COUNT - 1)]
            for i in range(FLAME_SAMPLE_COUNT)]


def _box_interval(a, b, lo, hi, clip):
    enter, leave = clip
    for i in range(3):
        if hi[i] - lo[i] <= _EPS:
            return None
        delta = b[i] - a[i]
        if abs(delta) <= _EPS:
            if a[i] < lo[i] - _EPS or a[i] > hi[i] + _EPS:
                return None
        else:
            t0, t1 = (lo[i] - a[i]) / delta, (hi[i] - a[i]) / delta
            enter, leave = max(enter, min(t0, t1)), min(leave, max(t0, t1))
        if leave - enter <= _EPS:
            return None
    return enter, leave


def _in_polygon(x, y, polygon):
    inside = False
    for i, (ax, ay) in enumerate(polygon):
        bx, by = polygon[(i + 1) % len(polygon)]
        cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax)
        if (abs(cross) <= _EPS and min(ax, bx) - _EPS <= x <= max(ax, bx) + _EPS
                and min(ay, by) - _EPS <= y <= max(ay, by) + _EPS):
            return True
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            inside = not inside
    return inside


def first_occluder(objects, start, end):
    """Nearest opaque object along start -> end, or None; never changes the plan.

    Endpoint clipping is along the ray, including rays starting inside solids.
    Walls/hoods/slabs use yaw; obstructions use the full object transform.
    """
    start, end = np.asarray(start, dtype=float), np.asarray(end, dtype=float)
    distance = float(np.linalg.norm(end - start))
    if distance <= 2 * OCCLUSION_ENDPOINT_TOLERANCE_M:
        return None
    trim = OCCLUSION_ENDPOINT_TOLERANCE_M / distance
    hit = _first_solid_hit(objects, start, end, (trim, 1 - trim))
    return hit[0] if hit else None


def _box_normal(a, b, lo, hi, t, hole=False):
    """Outward entry normal, or inward normal at a hole exit; None inside a box."""
    for i in range(3):
        delta = b[i] - a[i]
        sign = -1 if delta > 0 else 1
        face = lo[i] if (sign < 0) != hole else hi[i]
        if abs(delta) > _EPS and abs(a[i] + t * delta - face) < 1e-9:
            normal = [0, 0, 0]
            normal[i] = sign
            return normal
    return None


def mounting_ior(objects, position, normal):
    """World-axis mounting face behind a gauge within 50 mm; excludes hood skirts."""
    axis = max(range(3), key=lambda i: abs(normal[i]))
    if abs(normal[axis]) < math.cos(math.radians(5)) - _EPS:
        return None
    sign = -1 if normal[axis] < 0 else 1
    # The plan floor is the source floor slab's top after re-origination.
    if axis == 2 and sign > 0 and 0 <= position[2] <= 0.05 + _EPS:
        return 3
    start = np.asarray(position) + np.asarray(normal) * 1e-7
    end = np.asarray(position) - np.asarray(normal) * (0.05 + 1e-7)
    hit = _first_solid_hit(objects, start, end, (0, 1), mounting=True)
    return sign * (axis + 1) if _face_ior(hit) == sign * (axis + 1) else None


def _face_ior(hit):
    """IOR can describe only a world-axis face."""
    if hit is None or hit[2] is None:
        return None
    normal = hit[2]
    axis = max(range(3), key=lambda i: abs(normal[i]))
    return (1 if normal[axis] > 0 else -1) * (axis + 1) if abs(normal[axis]) >= 1 - _EPS else None


def nearest_mounting_ior(objects, position):
    """Nearest mounting face in any axis direction, including just inside solids."""
    nearest = abs(position[2]) if abs(position[2]) <= 0.05 + _EPS else float('inf')
    ior = 3 if math.isfinite(nearest) else None

    def accept(hit, distance):
        nonlocal nearest, ior
        candidate = _face_ior(hit)
        if candidate is not None and distance <= 0.05 + _EPS and distance < nearest - _EPS:
            nearest, ior = distance, candidate

    reach = 0.05 + 1e-7
    for axis in range(3):
        for sign in (1, -1):
            start, end = np.array(position, dtype=float), np.array(position, dtype=float)
            start[axis] -= sign * 1e-7
            end[axis] += sign * reach
            forward = _first_solid_hit(objects, start, end, (0, 1), mounting=True)
            if forward is not None:
                accept(forward, abs(forward[1] * (reach + 1e-7) - 1e-7))
            reverse = _first_solid_hit(objects, end, start, (0, 1), mounting=True)
            if reverse is not None:
                accept(reverse, abs(reach - reverse[1] * (reach + 1e-7)))
    return ior


def _first_solid_hit(objects, start, end, clip, mounting=False):
    nearest, result = float('inf'), None
    for obj in objects:
        if not isinstance(obj, (Wall, Ceiling, Obstruction, Hood)):
            continue
        if mounting and isinstance(obj, Hood):
            continue
        rotation = obj.rotation_matrix
        yaw = math.atan2(rotation[1, 0], rotation[0, 0])
        c, s = math.cos(yaw), math.sin(yaw)

        def local(point):
            v = point - obj.position
            return rotation.T @ v if isinstance(obj, Obstruction) else [
                c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]]

        a, b = local(start), local(end)

        def accept(t, n=None):
            nonlocal nearest, result
            if t < nearest:
                nearest = t
                normal = None if n is None else (rotation @ n if isinstance(obj, Obstruction) else [
                    c * n[0] - s * n[1], s * n[0] + c * n[1], n[2]])
                result = (obj, t, normal)

        def box(lo, hi):
            hit = _box_interval(a, b, lo, hi, clip)
            if hit is not None:
                accept(hit[0], _box_normal(a, b, lo, hi, hit[0]) if mounting else None)

        if isinstance(obj, Obstruction):
            x, y, z = obj.size_m
            box([-x / 2, -y / 2, 0], [x / 2, y / 2, z])
        elif isinstance(obj, Hood):
            if obj.skirt_depth_m <= 0:
                continue
            x, y = [v / 2 for v in obj.opening_m]
            t = HOOD_SKIRT_PANEL_THICKNESS_M / 2
            z = obj.height_m - obj.skirt_depth_m
            for side in (-1, 1):
                box([side * x - t, -y - t, z], [side * x + t, y + t, obj.height_m])
                box([-x - t, side * y - t, z], [x + t, side * y + t, obj.height_m])
        elif isinstance(obj, Wall):
            travelled = 0.0
            half, base = obj.thickness_m / 2, obj.base_height_m
            points = obj.polyline_m
            for i in range(1, len(points)):
                x, y = points[i - 1]
                dx, dy = points[i] - points[i - 1]
                span = math.hypot(dx, dy)
                if span < 1e-9:
                    continue

                def segment_local(p):
                    return [((p[0] - x) * dx + (p[1] - y) * dy) / span,
                            (-(p[0] - x) * dy + (p[1] - y) * dx) / span, p[2]]

                sa, sb = segment_local(a), segment_local(b)
                solid = _box_interval(sa, sb, [0, -half, base], [span, half, base + obj.height_m], clip)
                if solid is not None:
                    holes = []
                    for opening in obj.openings:
                        lo = max(0, opening['offset_m'] - travelled)
                        hi = min(span, opening['offset_m'] + opening['width_m'] - travelled)
                        sill = base + (opening.get('sillHeight_m') or 0)
                        hit = _box_interval(sa, sb, [lo, -half, sill], [hi, half, sill + opening['height_m']], solid)
                        if hit is not None:
                            holes.append((hit, _box_normal(sa, sb, [lo, -half, sill],
                                [hi, half, sill + opening['height_m']], hit[1], True) if mounting else None))
                    holes.sort(key=lambda h: h[0][0])
                    cursor = solid[0]
                    n = _box_normal(sa, sb, [0, -half, base], [span, half, base + obj.height_m], cursor) if mounting else None
                    for (enter, leave), normal in holes:
                        if enter > cursor + _EPS:
                            break
                        if leave > cursor:
                            n = normal
                        cursor = max(cursor, leave)
                    if cursor < solid[1] - _EPS:
                        accept(cursor, [(n[0] * dx - n[1] * dy) / span,
                                        (n[0] * dy + n[1] * dx) / span, n[2]] if n is not None else None)
                travelled += span
        elif isinstance(obj, Ceiling) and len(obj.polygon_m) >= 3:
            polygon = obj.polygon_m
            xs, ys = polygon[:, 0], polygon[:, 1]
            hit = _box_interval(a, b, [min(xs), min(ys), obj.height_m],
                                [max(xs), max(ys), obj.height_m + obj.thickness_m], clip)
            if hit is None:
                continue
            cuts = list(hit)
            dx, dy = b[0] - a[0], b[1] - a[1]
            for i, p in enumerate(polygon):
                q = polygon[(i + 1) % len(polygon)]
                ex, ey = q - p
                cross = dx * ey - dy * ex
                if abs(cross) <= _EPS:
                    continue
                t = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / cross
                u = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / cross
                if hit[0] < t < hit[1] and 0 <= u <= 1:
                    cuts.append(t)
            cuts.sort()
            for lo, hi in zip(cuts, cuts[1:]):
                mid = (lo + hi) / 2
                if hi - lo > _EPS and _in_polygon(a[0] + dx * mid, a[1] + dy * mid, polygon):
                    n = None
                    if mounting:
                        z = a[2] + (b[2] - a[2]) * lo
                        if abs(z - obj.height_m) < 1e-9 and b[2] > a[2]:
                            n = [0, 0, -1]
                        elif abs(z - obj.height_m - obj.thickness_m) < 1e-9 and b[2] < a[2]:
                            n = [0, 0, 1]
                        else:
                            x, y = a[0] + dx * lo, a[1] + dy * lo
                            for j, p in enumerate(polygon):
                                q = polygon[(j + 1) % len(polygon)]
                                ex, ey = q - p
                                span = math.hypot(ex, ey)
                                if (span <= _EPS or abs((x - p[0]) * ey - (y - p[1]) * ex) > 1e-9 * span
                                        or not min(p[0], q[0]) - _EPS <= x <= max(p[0], q[0]) + _EPS
                                        or not min(p[1], q[1]) - _EPS <= y <= max(p[1], q[1]) + _EPS):
                                    continue
                                sign = -1 if dx * ey - dy * ex > 0 else 1
                                n = [sign * ey / span, -sign * ex / span, 0]
                                break
                    accept(lo, n)
                    break
    return result
