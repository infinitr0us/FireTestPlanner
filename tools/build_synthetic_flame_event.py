"""Generate the synthetic flame analysis test, using only NumPy and the standard library.

Run from the repository root: python tools/build_synthetic_flame_event.py
Writes fixtures/flame-analysis/: a flame analysis folder (format 1.0, see
docs/flame-analysis-board-design.md and CONVENTIONS.md section 13) with a small
site, three calibrated cameras and two events. Nothing in it is measured: the flame
is a seeded geometric shape, the pictures are rendered from it, the hood and the
estimates are illustrative numbers with made-up coefficients. It exists so the
board and its tests run on data that can be published.

- Site: a 0.4 m square pan (rim 0.1 m) at the origin, a back wall, a hood.
  Cameras (ideal pinholes, 1 um pixels, off-centre principal points so the
  calibrated projection path is exercised): camA in front (240 x 180), camB at the
  side (240 x 180), camC high at the front left, portrait (135 x 240).
- Flame: on a 3 cm grid, a tapering, leaning column of horizontal discs whose
  radii puff from slice to slice (PCG64 integer draws, seed [20261108, k] for
  the k-th event, so each event can be rebuilt alone). Its size
  follows a piecewise-linear envelope: event E1 grows over 0.8 s, holds to 2.0 s
  and dies out by 3.0 s; event E2 is smaller and shorter.
- Pictures: every pixel's ray is marched through the occupancy grid in 1.5 cm
  steps; the flame's colour depends on how much flame the ray crosses. The scene
  behind is flat-shaded boxes. PNG, written with zlib. The mask is "the ray met
  flame", and the outlines are traced from it (fireplan.flame_analysis).
- 3-D flame: the visual hull of the event's cameras, every grid cell whose centre
  projects (nearest pixel) inside every camera's mask. E1 uses all three cameras,
  E2 only camA and camB, so its hull is visibly fatter than its flame.
- Meshes (event E1, format 1.1): the hull's smoothed surface by naive surface nets,
  on 6 cm cells so the committed files stay small.
  E2 stays format 1.0 (no meshes, no hood response time), so both versions are tested.
- Series (seconds on the test clock "t_clock"): hull volume, exposed-face surface
  area and the flame top above the pan rim per instant; a hood record at 1 Hz, the
  true flame volume times 1800 kW/m3 passed through a first-order lag (35 % of the
  gap closed per second, one second of transport) plus a 3 kW baseline and a
  little seeded noise; estimates from the hull volume (700 kW/m3) and area
  (35 kW/m2) averaged over five instants. These coefficients are invented for the
  test and are not anyone's method.

Only + - * / and square roots are used on floats (no sin, exp or pow), so the
content is the same on every platform (the PNG and NPZ compressed bytes vary with the
zlib build, the pixels and arrays do not); camera poses are rounded in the plan and
the pictures are rendered from the rounded plan.
"""

import csv
import importlib.util
import io
import json
import struct
import sys
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from fireplan import Plan  # noqa: E402
from fireplan._math import look_at_quat  # noqa: E402
from fireplan.flame_analysis import (  # noqa: E402
    dump_compact, outlines_document, trace_outlines, write_mesh)

_spec = importlib.util.spec_from_file_location("synthetic_flame", ROOT / "tools/build_synthetic_flame.py")
_synthetic_flame = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_synthetic_flame)
write_npz = _synthetic_flame.write_npz  # deterministic NPZ writer of the flame fixture

OUT = "fixtures/flame-analysis"
SEED = 20261108
VOXEL = 0.03
GRID_LO = np.array([-0.51, -0.51, 0.10])
GRID_N = (34, 34, 60)                       # x, y: -0.51..0.51; z: 0.10..1.90
RIM = 0.10
STEP = 0.015                                # ray-march step, half a voxel

CAMERAS = [
    # id, name, position, aim, resolution, f (px), principal point offset (px)
    ("camA", "Front", (0.0, -3.0, 1.0), (0.0, 0.0, 0.85), (240, 180), 190.0, (2.5, -1.5)),
    ("camB", "Side", (3.1, 0.35, 1.15), (0.0, 0.0, 0.85), (240, 180), 190.0, (-3.0, 2.0)),
    ("camC", "Front left, high", (-1.9, -2.2, 2.3), (0.0, 0.0, 0.75), (135, 240), 160.0, (1.0, 3.5)),
]

EVENTS = [
    # id, label, onset, cameras, envelope (rise end, hold end, out), peak scale, lean, meshes
    ("E1", "Synthetic event 1", 100.0, ["camA", "camB", "camC"], (0.8, 2.0, 3.0), 1.0, 0.18, True),
    ("E2", "Synthetic event 2", 160.0, ["camA", "camB"], (0.5, 1.2, 2.2), 0.7, -0.12, False),
]
#: The synthetic hood closes 35 % of its gap each second: a first-order response time
#: of -1 / ln(0.65) = 2.32 s, which event E1 (format 1.1) records.
HOOD_RESPONSE_S = 2.3
BEFORE, AFTER, DT = 0.5, 3.0, 0.1           # instants from onset - 0.5 s to onset + 3.0 s


# -- small writers -----------------------------------------------------------

def write_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def png_bytes(rgb):
    """An 8-bit RGB PNG, no filtering, zlib level 9: stable bytes for stable input."""
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def num(x, places=6):
    """Shortest spelling after rounding, as the interchange CSVs."""
    v = round(float(x), places)
    if v == 0:
        v = 0.0
    text = repr(v)
    return text[:-2] if text.endswith(".0") else text


# -- site --------------------------------------------------------------------

def site_plan():
    objects = [
        {"id": "pan", "type": "burner", "name": "Steel pan, 0.4 m square",
         "transform": {"position_m": [0.0, 0.0, 0.0]},
         "footprint": {"shape": "rectangle", "size_m": [0.4, 0.4]}, "rimHeight_m": RIM,
         "fire": {"fuel": "synthetic", "hrr_kw": 150.0},
         "notes": "Synthetic site for the flame analysis tests."},
        {"id": "hood", "type": "hood", "name": "Hood",
         "transform": {"position_m": [0.0, 0.0, 0.0]},
         "opening_m": [2.0, 2.0], "height_m": 2.4, "skirtDepth_m": 0.3,
         "duct": {"diameter_m": 0.5, "length_m": 1.0}},
        {"id": "back-wall", "type": "obstruction", "name": "Back wall",
         "transform": {"position_m": [0.0, 1.7, 0.0]}, "size_m": [4.0, 0.2, 2.6]},
    ]
    for cid, name, pos, aim, res, f, off in CAMERAS:
        quat = look_at_quat(pos, aim)
        w, h = res
        objects.append({
            "id": cid, "type": "camera", "name": name,
            "transform": {"position_m": [float(v) for v in pos],
                          "rotation_quat": [round(float(v), 6) for v in quat],
                          "aimTarget_m": [float(v) for v in aim]},
            "camera": {"modality": "RGB", "presetId": None, "resolution_px": [w, h],
                       "sensor_mm": [w / 1000.0, h / 1000.0], "focalLength_mm": f / 1000.0,
                       "principalPoint_px": [(w - 1) / 2.0 + off[0], (h - 1) / 2.0 + off[1]],
                       "distortion": None, "intrinsicsSource": "calibrated",
                       "spectralBand_um": None, "framerate_hz": 10},
            "mount": {"type": "tripod", "height_m": pos[2]},
            "recording": None,
        })
    data = {
        "format": "fire-test-plan", "version": "1.7.0",
        "meta": {"title": "Synthetic flame analysis site", "testId": "synthetic-flame-analysis",
                 "created": "2026-11-08T00:00:00Z", "modified": "2026-11-08T00:00:00Z",
                 "revision": "A",
                 "notes": "Generated by tools/build_synthetic_flame_event.py. Not a real test."},
        "units": {"length": "m", "angle": "rad", "power": "kW", "temperature": "C",
                  "display": {"length": "m", "angle": "deg"}},
        "coordinateSystem": {"convention": "Z-up-right-handed", "origin": "burner-center-floor"},
        "environment": {"floorSize_m": [8.0, 8.0], "ceilingHeight_m": None,
                        "ambientTemperature_C": 20.0},
        "objects": objects,
    }
    plan = Plan.loads(json.dumps(data))
    data["version"] = plan.effective_version
    plan = Plan.loads(json.dumps(data))
    plan.validate_schema()
    return plan


# -- flame -------------------------------------------------------------------

def envelope(tau, shape, peak):
    rise, hold, out = shape
    if tau <= 0 or tau >= out:
        return 0.0
    if tau < rise:
        return peak * tau / rise
    if tau <= hold:
        return peak
    return peak * (out - tau) / (out - hold)


def flame_grid(tau, shape, peak, lean, draws):
    """Occupancy (nx, ny, nz) at time tau from onset."""
    s = envelope(tau, shape, peak)
    occ = np.zeros(GRID_N, dtype=bool)
    if s <= 0:
        return occ
    nx, ny, nz = GRID_N
    xs = GRID_LO[0] + (np.arange(nx) + 0.5) * VOXEL
    ys = GRID_LO[1] + (np.arange(ny) + 0.5) * VOXEL
    X, Y = np.meshgrid(xs, ys, indexing="ij")
    height = 0.25 + 1.35 * s                 # flame length above the rim
    base_r = 0.10 + 0.10 * s
    for k in range(nz):
        z = GRID_LO[2] + (k + 0.5) * VOXEL
        zn = (z - RIM) / height
        if zn < 0 or zn >= 1:
            continue
        wobble = 1.0 + draws[k] / 1000.0     # puffing, per slice and instant
        r = base_r * (1.0 - zn) * (1.0 + 1.2 * zn) * wobble
        cx = lean * zn * zn * s
        cy = 0.35 * lean * zn * s
        occ[:, :, k] = (X - cx) * (X - cx) + (Y - cy) * (Y - cy) <= r * r
    return occ


def centres(occ):
    idx = np.argwhere(occ)
    return GRID_LO + (idx + 0.5) * VOXEL


# -- pictures ----------------------------------------------------------------

def rays(cam):
    """Per-pixel ray directions in the world (OpenCV camera frame, depth 1)."""
    w, h = cam.resolution
    cx, cy = cam.principal_point
    u, v = np.meshgrid(np.arange(w, dtype=float), np.arange(h, dtype=float))
    d_cam = np.stack([(u - cx) / cam.fx, (v - cy) / cam.fy, np.ones_like(u)], axis=-1)
    return d_cam.reshape(-1, 3) @ cam.rotation("opencv").T, cam.position


BOXES = [
    # lo, hi, colour of the top face, colour of the sides
    ((-2.0, 1.6, 0.0), (2.0, 1.8, 2.6), (150, 120, 96), (122, 92, 74)),     # back wall
    ((-0.2, -0.2, 0.0), (0.2, 0.2, RIM), (96, 96, 104), (64, 64, 72)),       # pan
    ((-1.0, -1.0, 2.1), (1.0, 1.0, 2.4), (170, 176, 184), (138, 144, 152)),  # hood skirt
]
FLOOR = (88, 92, 86)
SKY = (36, 44, 58)


def background(cam):
    d, o = rays(cam)
    n = len(d)
    best = np.full(n, np.inf)
    colour = np.tile(np.array(SKY, dtype=np.uint8), (n, 1))
    with np.errstate(divide="ignore", invalid="ignore"):
        t_floor = -o[2] / d[:, 2]
    hit = (t_floor > 0) & np.isfinite(t_floor)
    best[hit] = t_floor[hit]
    colour[hit] = FLOOR
    for lo, hi, top, side in BOXES:
        lo, hi = np.array(lo), np.array(hi)
        with np.errstate(divide="ignore", invalid="ignore"):
            t1 = (lo - o) / d
            t2 = (hi - o) / d
        tmin = np.nanmax(np.minimum(t1, t2), axis=1)
        tmax = np.nanmin(np.maximum(t1, t2), axis=1)
        entered = np.argmax(np.minimum(t1, t2), axis=1)  # the axis of the face entered
        hit = (tmax >= tmin) & (tmin > 0) & (tmin < best)
        best[hit] = tmin[hit]
        colour[hit & (entered == 2)] = top
        colour[hit & (entered != 2)] = side
    w, h = cam.resolution
    return colour.reshape(h, w, 3)


FLAME_COLOURS = [  # by samples crossed: thin edge to thick core
    (1, (214, 84, 34)), (3, (240, 128, 40)), (6, (252, 178, 64)), (10, (255, 226, 150)),
]


def render(cam, occ, back):
    """The picture and the mask ("the ray met flame") at one instant."""
    d, o = rays(cam)
    w, h = cam.resolution
    hits = np.zeros(len(d), dtype=np.int32)
    if occ.any():
        # March only the rays that cross the box around this instant's flame.
        idx = np.argwhere(occ)
        lo = GRID_LO + idx.min(axis=0) * VOXEL
        hi = GRID_LO + (idx.max(axis=0) + 1) * VOXEL
        with np.errstate(divide="ignore", invalid="ignore"):
            t1, t2 = (lo - o) / d, (hi - o) / d
        tmin = np.nanmax(np.minimum(t1, t2), axis=1)
        tmax = np.nanmin(np.maximum(t1, t2), axis=1)
        sel = np.nonzero((tmax >= tmin) & (tmax > 0))[0]
        ds = d[sel]
        speed = float(np.sqrt((ds * ds).sum(axis=1)).max())   # metres per unit of depth
        t, end = float(tmin[sel].min()), float(tmax[sel].max())
        grid_n = np.array(GRID_N)
        while t <= end:
            ijk = np.floor((o + ds * t - GRID_LO) / VOXEL).astype(np.int64)
            ok = np.nonzero(np.all((ijk >= 0) & (ijk < grid_n), axis=1))[0]
            hits[sel[ok]] += occ[ijk[ok, 0], ijk[ok, 1], ijk[ok, 2]]
            t += STEP / speed
    rgb = back.reshape(-1, 3).copy()
    for threshold, colour in FLAME_COLOURS:
        rgb[hits >= threshold] = colour
    return rgb.reshape(h, w, 3), (hits > 0).reshape(h, w)


def carve(cams, masks):
    """Visual hull: grid cells whose centres project inside every camera's mask."""
    nx, ny, nz = GRID_N
    idx = np.argwhere(np.ones(GRID_N, dtype=bool))
    pts = GRID_LO + (idx + 0.5) * VOXEL
    keep = np.ones(len(pts), dtype=bool)
    for cam, mask in zip(cams, masks):
        uv, visible = cam.project(pts)
        ui = np.floor(uv[:, 0] + 0.5).astype(np.int64)
        vi = np.floor(uv[:, 1] + 0.5).astype(np.int64)
        w, h = cam.resolution
        inside = visible & (ui >= 0) & (ui < w) & (vi >= 0) & (vi < h)
        ok = np.zeros(len(pts), dtype=bool)
        ok[inside] = mask[vi[inside], ui[inside]]
        keep &= ok
    occ = np.zeros(GRID_N, dtype=bool)
    occ[tuple(idx[keep].T)] = True
    return occ


def surface_mesh(occ, smoothing=3, coarsen=2):
    """A smoothed surface of the hull by naive surface nets: one vertex per cube of
    eight neighbouring cells that is partly occupied, a quad across every face between
    an occupied and an empty cell, then Laplacian smoothing. Only + - * / on floats."""
    # On cells `coarsen` times larger (6 cm), which keeps the committed meshes small.
    n = np.array(occ.shape) // coarsen
    occ = occ[:n[0] * coarsen, :n[1] * coarsen, :n[2] * coarsen].reshape(
        n[0], coarsen, n[1], coarsen, n[2], coarsen).any(axis=(1, 3, 5))
    size = VOXEL * coarsen
    nx, ny, nz = occ.shape
    p = np.pad(occ, 1)
    cubes = sum(p[i:i + nx + 1, j:j + ny + 1, k:k + nz + 1].astype(np.int8)
                for i in (0, 1) for j in (0, 1) for k in (0, 1))
    active = (cubes > 0) & (cubes < 8)
    index = -np.ones(active.shape, np.int64)
    cells = np.argwhere(active)
    index[tuple(cells.T)] = np.arange(len(cells))
    vertices = GRID_LO + cells * size       # a cube's centre, in metres
    quads = []
    for axis in range(3):
        perm = (axis, (axis + 1) % 3, (axis + 2) % 3)
        q = p.transpose(perm)
        a, b = q[:-1, 1:-1, 1:-1], q[1:, 1:-1, 1:-1]
        for i, j, k in np.argwhere(a != b):
            corners = [(i, j, k), (i, j + 1, k), (i, j + 1, k + 1), (i, j, k + 1)]
            ids = []
            for c in corners:
                original = [0, 0, 0]
                for d in range(3):
                    original[perm[d]] = c[d]
                ids.append(index[tuple(original)])
            quads.append(ids if a[i, j, k] else ids[::-1])
    if not quads:
        return np.zeros((0, 3)), np.zeros((0, 3), np.int64)
    quads = np.array(quads, dtype=np.int64)
    faces = np.concatenate([quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]])
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    for _ in range(smoothing):
        total = np.zeros_like(vertices)
        count = np.zeros(len(vertices))
        np.add.at(total, edges[:, 0], vertices[edges[:, 1]])
        np.add.at(count, edges[:, 0], 1.0)
        vertices = 0.5 * vertices + 0.5 * total / np.maximum(count, 1.0)[:, None]
    return vertices, faces


def exposed_faces(occ):
    padded = np.pad(occ, 1)
    core = padded[1:-1, 1:-1, 1:-1]
    faces = 0
    for axis in range(3):
        for shift in (-1, 1):
            neighbour = np.roll(padded, shift, axis=axis)[1:-1, 1:-1, 1:-1]
            faces += int((core & ~neighbour).sum())
    return faces


# -- events ------------------------------------------------------------------

def build_event(root, plan, cameras, spec, rng):
    eid, label, onset, cam_ids, shape, peak, lean, meshes = spec
    folder = root / eid
    cams = [plan.cameras[c] for c in cam_ids]
    backs = [background(c) for c in cams]
    n = int(round((BEFORE + AFTER) / DT)) + 1
    times = [round(onset - BEFORE + i * DT, 2) for i in range(n)]
    stems = ["t_{:07.2f}".format(t) for t in times]
    outlines = {c: [] for c in cam_ids}
    true_volume, hull_rows = [], []
    for i, (t, stem) in enumerate(zip(times, stems)):
        draws = rng.integers(-180, 181, size=GRID_N[2])
        occ = flame_grid(round(t - onset, 2), shape, peak, lean, draws)
        true_volume.append(int(occ.sum()) * VOXEL ** 3)
        masks = []
        for cid, cam, back in zip(cam_ids, cams, backs):
            rgb, mask = render(cam, occ, back)
            path = folder / "frames" / cid / (stem + ".png")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(png_bytes(rgb))
            outlines[cid].append(trace_outlines(mask))
            masks.append(mask)
        hull = carve(cams, masks) if any(m.any() for m in masks) else np.zeros(GRID_N, bool)
        (folder / "hull").mkdir(parents=True, exist_ok=True)
        write_npz(folder / "hull" / (stem + ".npz"), centres(hull), voxel_size=VOXEL)
        if meshes:
            (folder / "mesh").mkdir(parents=True, exist_ok=True)
            write_mesh(str(folder / "mesh" / (stem + ".ply")), *surface_mesh(hull))
        count = int(hull.sum())
        top = ""
        if count:
            k = np.nonzero(hull.any(axis=(0, 1)))[0].max()
            top = num(GRID_LO[2] + (k + 1) * VOXEL - RIM, 3)
        hull_rows.append([num(t, 2), num(count * VOXEL ** 3), num(exposed_faces(hull) * VOXEL ** 2), top])

    for cid in cam_ids:
        cam = plan.cameras[cid]
        write_text(folder / "outlines" / (cid + ".json"),
                   dump_compact(outlines_document(cid, cam.resolution, outlines[cid])))

    write_text(folder / "series" / "metrics.csv", "t_s,volume_m3,surface_area_m2,top_above_rim_m\n"
               + "".join(",".join(r) + "\n" for r in hull_rows))

    # Hood: per-second mean of the true flame, x 1800 kW/m3, one second late, lagged.
    hood_t = [round(onset - 5 + k, 1) for k in range(int(AFTER) + 11)]
    hood, y = [], 0.0
    for k, ht in enumerate(hood_t):
        src = ht - 1.0
        vals = [v for tt, v in zip(times, true_volume) if src - 0.5 < tt <= src + 0.5]
        x = 1800.0 * (sum(vals) / len(vals)) if vals else 0.0
        y = y + 0.35 * (x - y)
        noise = int(rng.integers(-15, 16)) / 10.0
        hood.append([num(ht, 1), num(3.0 + y + noise, 2)])
    write_text(folder / "series" / "hood.csv", "t_s,hrr_convective_kW\n"
               + "".join(",".join(r) + "\n" for r in hood))
    # The hood's peak within the event's instants, a key moment as a delivery would mark it.
    hood_peak_t = max((float(v), float(ht)) for ht, v in hood if times[0] <= float(ht) <= times[-1])[1]

    vol = np.array([float(r[1]) for r in hull_rows])
    area = np.array([float(r[2]) for r in hull_rows])
    est = []
    for i, t in enumerate(times):
        lo, hi = max(0, i - 2), min(len(times), i + 3)
        v, a = vol[lo:hi].mean(), area[lo:hi].mean()
        est.append([num(t, 2), num(700.0 * v, 2), num(35.0 * a, 2)])
    write_text(folder / "series" / "hrr_estimate.csv", "t_s,from_volume_kW,from_area_kW\n"
               + "".join(",".join(r) + "\n" for r in est))

    no_hull = [i for i, r in enumerate(hull_rows)
               if times[i] >= onset and r[1] == "0" and any(o[i] for o in outlines.values())]
    edge = {}
    for cid in cam_ids:
        w, h = plan.cameras[cid].resolution
        hits = [i for i, rings in enumerate(outlines[cid])
                if any(min(r[1::2]) <= 0 or min(r[0::2]) <= 0 or max(r[0::2]) >= w - 1
                       or max(r[1::2]) >= h - 1 for r in rings)]
        if hits:
            edge[cid] = hits
    quality = {"noHull": no_hull}
    if edge:
        quality["outsideFrame"] = edge
    peak_i = int(np.argmax(vol))
    event = {
        "format": "fireplan-flame-event", "version": "1.1.0" if meshes else "1.0.0",
        "id": eid, "label": label, "onset_s": onset, "cameras": cam_ids,
        "instants": {"t_s": times, "stem": stems},
        "files": {"display": "frames/{cam}/{stem}.png", "outlines": "outlines/{cam}.json",
                  "hull": "hull/{stem}.npz", **({"mesh": "mesh/{stem}.ply"} if meshes else {})},
        "images": {c: {"size_px": list(plan.cameras[c].resolution),
                       "display_px": list(plan.cameras[c].resolution)} for c in cam_ids},
        "hull": {"voxelSize_m": VOXEL, "frame": "plan"},
        "series": [
            {"id": "hood", "label": {"en": "Hood (measured)", "fr": "Hotte (mesurée)"},
             "role": "measured", "quantity": "hrr", "unit": "kW", "basis": "convective",
             "file": "series/hood.csv", "time": "t_s", "value": "hrr_convective_kW",
             "note": "Synthetic: the true flame volume times 1800 kW/m3, lagged.",
             **({"responseTime_s": HOOD_RESPONSE_S} if meshes else {})},
            {"id": "hrr-from-volume", "label": {"en": "Estimate from flame volume", "fr": "Estimation par le volume de flamme"},
             "role": "estimated", "quantity": "hrr", "unit": "kW", "basis": "convective",
             "file": "series/hrr_estimate.csv", "time": "t_s", "value": "from_volume_kW"},
            {"id": "hrr-from-area", "label": {"en": "Estimate from flame surface area", "fr": "Estimation par la surface de flamme"},
             "role": "estimated", "quantity": "hrr", "unit": "kW", "basis": "convective",
             "file": "series/hrr_estimate.csv", "time": "t_s", "value": "from_area_kW"},
            {"id": "volume", "label": {"en": "Flame volume", "fr": "Volume de flamme"},
             "role": "reconstructed", "quantity": "volume", "unit": "m3",
             "file": "series/metrics.csv", "time": "t_s", "value": "volume_m3"},
            {"id": "area", "label": {"en": "Flame surface area", "fr": "Surface de flamme"},
             "role": "reconstructed", "quantity": "area", "unit": "m2",
             "file": "series/metrics.csv", "time": "t_s", "value": "surface_area_m2"},
            {"id": "height", "label": {"en": "Flame top above the pan", "fr": "Sommet de flamme au-dessus du bac"},
             "role": "reconstructed", "quantity": "height", "unit": "m",
             "file": "series/metrics.csv", "time": "t_s", "value": "top_above_rim_m"},
        ],
        "quality": quality,
        "keyMoments": [
            {"t_s": onset, "label": {"en": "Ignition", "fr": "Allumage"}},
            {"t_s": times[peak_i], "label": {"en": "Largest flame", "fr": "Flamme la plus grande"}},
            {"t_s": round(onset + shape[1], 2), "label": {"en": "Decay starts", "fr": "Début du déclin"}},
            {"t_s": hood_peak_t, "label": {"en": "Hood peak", "fr": "Maximum de la hotte"}},
        ],
        "notes": {
            "reconstruction": {
                "en": "Synthetic: built from {} camera(s); with fewer cameras the 3-D flame is "
                      "larger than the flame that made the pictures.".format(len(cam_ids)),
                "fr": "Synthétique : construite à partir de {} caméra(s) ; avec moins de caméras, la "
                      "flamme 3D est plus grande que la flamme des images.".format(len(cam_ids)),
            },
        },
    }
    write_text(folder / "event.json", json.dumps(event, ensure_ascii=False, indent=1) + "\n")


def analysis_manifest():
    def step(en_title, en, fr_title, fr):
        return {"title": {"en": en_title, "fr": fr_title}, "text": {"en": en, "fr": fr}}

    return {
        "format": "fireplan-flame-analysis", "version": "1.0.0",
        "title": {"en": "Synthetic flame analysis test", "fr": "Essai synthétique d'analyse de flamme"},
        "date": "2026-11-08",
        "sitePlan": "site.ftp.json",
        "timeBase": {"label": "t_clock", "description": {
            "en": "Seconds on the synthetic test's clock.",
            "fr": "Secondes sur l'horloge de l'essai synthétique."}},
        "cameras": [{"id": cid, "planCameraId": cid} for cid, *_ in CAMERAS],
        "steps": {
            "cameras": step("Cameras", "Three synthetic cameras look at a pan from the front, the side and above.",
                            "Caméras", "Trois caméras synthétiques regardent un bac de face, de côté et d'en haut."),
            "frames": step("Synchronised frames", "One picture per camera every 0.1 s, rendered from the synthetic flame.",
                           "Images synchronisées", "Une image par caméra toutes les 0,1 s, rendue à partir de la flamme synthétique."),
            "segmentation": step("Flame in each view", "Every pixel whose line of sight crosses the flame is flame.",
                                 "Flamme dans chaque vue", "Tout pixel dont la ligne de visée traverse la flamme est de la flamme."),
            "reconstruction": step("3-D flame", "The space inside the flame outline of every camera at once.",
                                   "Flamme 3D", "L'espace à l'intérieur du contour de flamme de toutes les caméras à la fois."),
            "size": step("Flame volume and surface area", "Counted on the 3 cm cubes of the 3-D flame.",
                         "Volume et surface de flamme", "Comptés sur les cubes de 3 cm de la flamme 3D."),
            "hrr": step("Heat release rate", "Illustrative numbers with made-up coefficients, for testing the board.",
                        "Débit calorifique", "Valeurs indicatives aux coefficients inventés, pour tester le tableau."),
            "limitations": step("What this can and cannot tell you", "Nothing about a real fire: every number here is synthetic.",
                                "Ce que cela peut et ne peut pas dire", "Rien sur un vrai feu : toutes les valeurs sont synthétiques."),
        },
        "events": [{"id": e[0], "label": {"en": e[1], "fr": e[1].replace("Synthetic event", "Événement synthétique")},
                    "path": e[0] + "/event.json"} for e in EVENTS],
    }


def build(root, events=None):
    """Write the test under `root`; `events` limits it to some event ids (each
    event has its own seed, so one can be rebuilt alone)."""
    root = Path(root)
    plan = site_plan()
    write_text(root / "site.ftp.json", plan.dumps())
    plan = Plan.load(str(root / "site.ftp.json"))   # render from the rounded file
    for k, spec in enumerate(EVENTS):
        if events is None or spec[0] in events:
            rng = np.random.Generator(np.random.PCG64([SEED, k]))
            build_event(root, plan, CAMERAS, spec, rng)
    write_text(root / "analysis.json", json.dumps(analysis_manifest(), ensure_ascii=False, indent=1) + "\n")


def main():
    build(ROOT / OUT)


if __name__ == "__main__":
    main()
