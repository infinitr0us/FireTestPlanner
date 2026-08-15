# Fire Test Plan 3D Visualization — Implementation Plan

Status: **draft for discussion** (2026-08-15)
Supersedes nothing; complements `ideas.md`.

---

## 1. Decisions locked

| Decision | Choice |
|---|---|
| Architecture | Shared TypeScript/Three.js core; two shells (single-file HTML, pywebview+PyInstaller exe) |
| Units | SI internal (metres, kW, °C, radians in file / degrees in UI), imperial display toggle |
| v1 objects | Cameras, burner + hood + duct, walls/floor/enclosure |
| Deferred to v2 | Thermocouple trees, heat flux gauges, load cell, gas sampling |
| Primary deliverable | The plan file itself, as an FSE ↔ data-scientist interchange format |
| Secondary deliverable | Dimensioned plan + elevation drawing, and equipment table |
| Origin | Burner centre at floor level = `(0,0,0)`, +Z up, right-handed |
| Reader default convention | OpenCV / COLMAP (X right, Y down, Z forward); others opt-in |
| Recorded-data references | Key reserved in schema, design deferred |
| Deferred to Phase 2 | Reconstructed 3D flame import (format TBD) |

## 2. Why one core, two shells

`ideas.md` describes two variants. Building them as two codebases means writing the
object library, editing gizmos, inspector, dimensioning, save/load and the renderer
twice, and the two renderers will drift apart visually. Instead:

```
src/core/          schema, scene graph, editing, renderer, UI   (TypeScript)
src/shell-web/  -> dist/plan.html          single self-contained file, offline
src/shell-py/   -> app.py (pywebview)  ->  FireTestPlanner.exe   (PyInstaller)
python/fireplan/   reader library for data scientists            (pip-installable)
```

The Python backend supplies only what a browser genuinely cannot:

- native file dialogs, recent-files list, filesystem watch
- streaming multi-GB flame sequences off disk
- format conversion (NeRF / 3DGS → renderable representation)
- offline video export via ffmpeg

pywebview uses the WebView2 runtime already present on Windows 11, so the exe stays
around 40–60 MB rather than the ~150 MB an Electron or QtWebEngine bundle would cost.

## 3. Target machine

i9-12900KS (16C/24T) · 96 GB RAM · RTX 5090 32 GB + RTX 3090 Ti 24 GB · Node 22 · Anaconda

The editor is not remotely compute-bound — a few hundred objects renders at display
refresh rate. Phase 2 is the only part with real headroom questions, and it fits
comfortably: a 256³ uint8 volume is ~17 MB/frame, so a 300-frame sequence is ~5 GB,
resident in 5090 VRAM. A 512³ sequence streams from system RAM without difficulty.

## 4. File format (`.ftp.json`)

Human-readable, diffable, version-controlled. Stable key ordering so git diffs are
meaningful. Validated against a published JSON Schema.

```jsonc
{
  "format": "fire-test-plan",
  "version": "1.0.0",
  "meta": {
    "title": "Pool fire test #3",
    "author": "", "site": "",
    "created": "2026-08-15T00:00:00Z",
    "modified": "2026-08-15T00:00:00Z",
    "notes": ""
  },
  "units": {
    "length": "m", "angle": "rad", "power": "kW", "temperature": "C",
    "display": { "length": "ft", "angle": "deg" }
  },
  "coordinateSystem": {
    "convention": "Z-up, right-handed",
    "origin": "burner center, at floor level",
    "northAzimuth_deg": 0
  },
  "objects": [
    {
      "id": "cam-t650",
      "type": "camera",
      "name": "FLIR T650 LWIR",
      "transform": {
        "position_m": [-2.74, 0.0, 1.50],
        "rotation_quat": [0, 0, 0, 1],       // xyzw, camera-to-world
        "aimTarget_m": [0, 0, 0.30]          // authoring intent; quat is authoritative
      },
      "camera": {
        "modality": "LWIR",
        "presetId": "flir-t650-25deg",
        "resolution_px": [640, 480],
        "sensor_mm": [10.88, 8.16],          // 640 x 17 um pitch
        "focalLength_mm": 24.6,
        "fov_deg": { "h": 25.0, "v": 18.8 },
        "spectralBand_um": [7.5, 14.0],
        "framerate_hz": 30
      },
      "mount": { "type": "tripod", "height_m": 1.50 },
      "recording": null                      // RESERVED — see note below
    },
    {
      "id": "burner-1",
      "type": "burner",
      "shape": "circle",
      "diameter_m": 0.30,
      "transform": { "position_m": [0, 0, 0] },
      "fire": { "fuel": "heptane", "hrr_kw": 120, "hrr_curve": null }
    },
    { "id": "hood-1", "type": "hood",  "...": "canopy + skirt + duct" },
    { "id": "wall-n",  "type": "wall",  "...": "polyline + height + openings" }
  ]
}
```

Design notes:

- **Rotation is a quaternion**, unambiguous in the stated world frame. `aimTarget_m`
  records authoring intent ("point at the flame base") and stays consistent with the
  quaternion, but the quaternion is what a consumer reads.
- **Extrinsic direction is written down**: `camera-to-world`. The reader converts.
- **`presetId` is a hint, not a dependency.** All intrinsics are stored inline, so a
  file opened on a machine without the preset library still describes the rig fully.
- Unknown object types round-trip untouched, so a v1.1 file opened in a v1.0 tool
  does not lose data.
- **`recording` is reserved, not designed.** v1 always writes `null`. Reserving the key
  now means v1 files stay forward-compatible when the post-test record design lands —
  a future writer can populate it without a schema version bump, and the reader can
  expose `cam.recording is None` from day one. Deliberately *not* specified further
  until the DS side shows how it wants footage referenced (paths? content hashes?
  a manifest pointer? clock sync offsets?), because guessing that shape wrong is worse
  than leaving it open.

Because the origin is the burner centre at floor level, standoff distance is just
`norm(position)` and the sketch's `9F` / `3F` / `2.5F` callouts map straight onto
coordinates — which is also why the dimension tool can auto-generate the fire-to-camera
dimension lines that dominate `example.jpg`.

## 5. Python reader (`python/fireplan/`)

The FSE ↔ DS handoff surface. Small, dependency-light (numpy + jsonschema).

```python
from fireplan import Plan

p = Plan.load("test3.ftp.json")

cam = p.cameras["cam-t650"]
cam.K                              # (3,3) intrinsics in pixels
cam.extrinsics()                   # (4,4) camera-to-world, OpenCV/COLMAP by default
cam.extrinsics("opengl")           # explicit opt-out; also "nerfstudio", "colmap"
cam.project(np.array([0,0,1.0]))   # world point -> pixel, for coverage checks
cam.standoff_m                     # == norm(position), since origin is the burner

p.to_nerfstudio("transforms.json") # rig as reconstruction prior
p.burner.hrr_kw, p.burner.diameter_m
p.flame_height_m()                 # Heskestad
```

Round-trip test (`load → dump → load` is byte-identical) is part of M0's exit criteria.

## 6. Editor design

**One Three.js scene, two camera modes.** No separate 2D canvas: an orthographic
top-down camera is "plan mode" (drag-place, grid snap, dimension lines), a perspective
camera is "3D mode" (free orbit/zoom). Same scene graph, so no sync bugs and view
switching is instant. Height (Z) is edited in the inspector; optional front/side
orthographic views for elevation work.

**Camera frustum + picture-in-picture preview.** Each camera draws its real frustum in
3D and renders a live PIP of what it actually sees. This answers the question you
actually have when planning: *does the plume still fit in the T650's frame at 3 m
standoff?* — before hauling gear to the site.

**Placeholder flame.** Until real reconstructions exist, draw a plume cone from the
Heskestad mean flame height correlation:

```
L_f = 0.235 · Q^(2/5) − 1.02 · D        [L_f, D in m; Q in kW]
```

Nearly free to compute, makes camera framing checks meaningful from day one, and
occupies the exact slot the reconstructed flame object will later drop into.

**Camera preset library.** Editable JSON, seeded with the instruments in the sketch —
FLIR T650 LWIR (25° lens), GoPro (wide ~122°), iPhone, MW2R. Seeded values are marked
provisional until verified against datasheets.

## 7. Milestones

| # | Milestone | Contents | Exit criteria |
|---|---|---|---|
| M0 | **Contract** | JSON Schema, `fireplan` reader, convention docs, fixture files | Round-trip test green; a hand-written fixture loads in Python and yields correct `K` and extrinsics |
| M1 | **Scene core** | Vite + TS + Three.js, Z-up world, scaled grid, ortho/persp toggle, orbit | A fixture `.ftp.json` renders read-only and is navigable |
| M2 | **Editing** | Palette drag-in, transform gizmo, grid + object snapping, unit-aware inspector, undo/redo, multi-select, duplicate | Reproduce the `example.jpg` layout from scratch in the UI |
| M3 | **Cameras** | Preset library, frustum, PIP preview, aim-at-target, coverage warnings | Each of the four sketch cameras placed with correct FOV; PIP matches expectation |
| M4 | **Geometry** | Burner shapes + HRR + plume cone, hood + skirt + duct, walls/floor/openings | Full sketch reproduced including hood |
| M5 | **Share** | Save/load, single-file HTML export with plan embedded, dimensions + measure tool | Exported `.html` opens on a clean machine and orbits |
| M6 | **Drawing** | Plan + elevation to PDF/PNG with dimension lines; equipment table | Output is staple-to-a-protocol quality |
| M7 | **Desktop** | pywebview shell, native dialogs, recent files, PyInstaller exe | Single `.exe` runs on a clean Windows 11 box |
| M8 | **Flame** *(Phase 2)* | Import reconstructed 3D flame; time sequence playback | Deferred — blocked on format decision |

M0 through M5 is the substance of the work. M6 and M7 are mechanical once the core exists.

## 8. Open questions

Schema-affecting, so worth settling before M0 closes:

1. **Planned vs as-built** — should each object carry both an intended and a measured
   position, with the delta visible in the 3D view? Cheap to add now (`transform` plus
   optional `transformAsBuilt`), awkward to retrofit. Relevant because reconstruction
   quality depends on *actual* camera poses, not planned ones — so this partly overlaps
   with the deferred `recording` design.
2. **One file per test, or a campaign file** holding several configurations that share a
   site and a camera rig?

Not schema-affecting; can be answered during M4 / M3 respectively:

3. **Enclosure realism** — do tests ever need a ceiling/roof and openings, or is it
   typically a hood in a large open lab bay? Determines how much wall/enclosure
   machinery M4 actually needs.
4. **What is MW2R?** A mid-wave IR camera? Needed to seed its preset with real
   intrinsics rather than a placeholder.
