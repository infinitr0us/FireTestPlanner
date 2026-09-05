# Fire Test Plan 3D Visualization — Implementation Plan

Status: **Phase 1 complete; format 1.2 and the FDS bridge landed** (2026-08-29)
Supersedes nothing; complements `ideas.md`.

---

## 1. Decisions locked

| Decision | Choice |
|---|---|
| Architecture | Shared TypeScript/Three.js core; two shells (single-file HTML, pywebview+PyInstaller exe) |
| Units | SI internal (metres, kW, °C, radians in file / degrees in UI), imperial display toggle |
| v1 objects | Cameras, burner + hood + duct, walls, ceilings |
| v1.1 objects | Heat flux gauges, thermocouples (single bead or rake) |
| v1.2 objects | Obstructions — the box that is neither wall nor slab |
| FDS bridge | Import only for now, shaped so an exporter is a straightforward addition. Reader is ours: fdsreader parses simulation OUTPUT and cannot open a `.fds` input |
| FDS coordinates | Plan is always re-origined onto the burner; the shift is kept in `meta.source.originOffset_m` so the source file's own numbers stay recoverable |
| Camera zoom | Stored beside the lens, not folded into it; multiplies the effective focal length |
| Format versioning | One schema per version; a file declares the lowest version its contents need |
| Preset library | Seeded from `presets/cameras.json`; user additions live in the desktop shell's settings file (browser storage in a plain tab), never a sidecar file |
| Building geometry | Simple composable components — walls and ceilings pieced together. Not detailed room layouts; the tool targets open bays and simple enclosures |
| Planned vs as-built | Planned only. A layout that differs from the plan becomes a new file recording the true positions |
| Deferred to v2 | ~~Thermocouple trees, heat flux gauges~~ (done, 1.1); load cell, gas sampling |
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
FLIR T650 LWIR (25° lens), FLIR A8303sc MWIR (25 mm), FLIR A700 (24° lens), GoPro
(wide ~122°), iPhone. The three FLIR entries are `datasheet`-grade, derived from the
PDFs in `docs/datasheets/`; the two consumer cameras stay `nominal`. Since M9 the
library is also extensible from the GUI, so a preset no longer has to ship with the
tool to exist.

## 7. Milestones

| # | Milestone | Contents | Status |
|---|---|---|---|
| M0 | **Contract** | JSON Schema, `fireplan` reader, convention docs, fixture | **done** — 80 tests |
| M1 | **Scene core** | Vite + TS + Three.js, Z-up world, scaled grid, ortho/persp toggle, orbit | **done** |
| M2 | **Editing** | Palette placement, transform gizmo, grid snapping, unit-aware inspector, undo/redo, multi-select, duplicate | **done** |
| M3 | **Cameras** | Preset library, frustum, PIP preview, aim-at-target, coverage readout | **done** |
| M4 | **Geometry** | Burner shapes + HRR + plume cone, hood + skirt + duct, walls with openings | **done** |
| M5 | **Share** | Save/load, single-file HTML export with plan embedded, standoff dimensions | **done** — measure tool still to do |
| M6 | **Drawing** | Dimensioned plan + elevations, equipment list, coverage table, print to PDF | **done** |
| M7 | **Desktop** | pywebview shell, native dialogs, recent files, PyInstaller exe | **done** — 9.9 MB exe |
| M8 | **Flame** *(Phase 2)* | Import reconstructed 3D flame; time sequence playback | blocked on format decision |
| M9 | **Instruments** | Format 1.1: camera zoom, heat flux gauges, thermocouple rakes, predicted exposure, user-added camera presets | **done** |
| M10 | **FDS bridge** | Namelist reader, FDS → plan import with a preview, format 1.2 obstructions, FDS-style coordinate entry | **done** |

Phase 1 is complete. 338 Python tests, 271 web tests.

### M9, from fire safety engineer feedback

| Ask | How it landed |
|---|---|
| A zoom factor per camera | `camera.zoomFactor`, multiplying the effective focal length. Everything derived goes through it — frustum, preview, coverage, drawing. The lens stays the lens |
| FLIR A8303sc and A700 presets | Seeded from the datasheets now in `docs/datasheets/`, both `intrinsicsSource: "datasheet"`. The A700's focal length is back-solved from the 24° lens designation, because the A-series sheet names lenses by angle and prints no focal length — `docs/datasheets/README.md` maps every stored field to a printed value or to its derivation |
| Heat flux and thermocouple components | New object types, with predicted exposure rather than bare placement: incident flux by point source, bead-by-bead plume temperature, and checks for an over-range gauge, a starved one, one facing the wrong way, and a bead its wire cannot survive |
| Walls and sensors in the example plan | The reference plan gained an L of walls, two gauges and two rakes. It now makes a second argument alongside the camera-framing one: the 50 kW/m² gauge everyone owns reads 3% of scale at 1.5 m from a 130 kW fire |
| Add camera presets from the GUI, without a save file | **Yes, and no sidecar file was needed.** The desktop shell keeps the library in its own per-profile `settings.json`; a browser tab uses `localStorage`. (`localStorage` alone did not work for the desktop build: the shell binds a fresh loopback port on every launch, and browser storage is scoped to the origin, so each launch saw an empty library.) Plans were already self-contained — every intrinsic is copied inline and `presetId` is a hint — so a preset can also be lifted straight back out of a plan someone sends you |

### M10, from the same fire safety engineers

Two asks, one file. They live in FDS, and both were about meeting them there.

| Ask | How it landed |
|---|---|
| Read a test plan out of an FDS input | The whole overlap: geometry, the fire, and the devices that correspond to instruments someone has to mount. Their sample case converts to 4 walls with a door, a ceiling, a 300 kW burner and 25 instruments, with no manual fixing |
| Use their open-source reader, `fdsreader` | **Not usable, and it is worth knowing why.** It reads simulation *output* through the `.smv` file FDS writes after a run; it cannot open a `.fds` input at all. So the reader is ours — about 250 lines, and no numpy in the exe |
| Create an object the way FDS does | A **Fields / FDS** switch in the inspector: `XB` for a box, `XYZ` + `IOR` for a device, in the source file's own coordinates. Plus a paste box that turns one `&OBST` or `&DEVC` into an object, through the importer's own converter |
| — | Format 1.2's `obstruction`: an FDS model is full of boxes that are neither wall nor slab, and this format had nowhere to put them |

**Three syntax rules decide whether the reader works, and their sample exercises all
three.** A record ends at the first `/` *outside a string* — their `&HEAD` title
contains `34.2x1000/300=114s`, so a naive reader truncates the first record in the
file. Parameters separate on commas *or* whitespace — their `&SURF`, `&MATL` and
`&PROP` records use newlines and no commas, so a comma-splitter silently loses
`HRRPUA` and the thermocouple `DIAMETER`. And a line without a leading `&` is a
comment — their `REAC` carrying `RADIATIVE_FRACTION=0.29` is one, and reading it
would have changed every predicted heat flux in the plan.

**The origin is the interesting part.** This format's origin is the burner centre at
floor level; an FDS file's is wherever the author put it. The import re-origins and
records the shift in `meta.source.originOffset_m`, which costs no version bump
(`meta` is open in every 1.x schema) and is what lets the inspector show an engineer
the same six numbers their `.fds` contains. The floor is the top of the lowest
horizontal slab, not the bottom of the mesh — in their case those differ by 200 mm,
and taking the mesh would have left the burner floating.

**What the import immediately tells you about their case**, from the plan's own
checks rather than from anything FDS-specific:

| Finding | Why it matters |
|---|---|
| Mean flame tip at 2.17 m under a 2.4 m ceiling | 0.23 m of clearance; the intermittent tip is in the ceiling jet |
| Nine of 23 gauges inside two effective diameters | The point-source model is an order of magnitude there, not a number to size a gauge on |
| Two of 22 beads on each rake inside the flame envelope | Flame temperatures and radiation error, not a plume reading |
| 23 gauges with no full-scale range | FDS reports a flux at a point and has no gauge; the range has to be chosen |

The last one is the shape of the whole import: nothing is guessed that the file does
not say. No radiative fraction, no gauge range — and everything not imported is named
in the report rather than dropped quietly.

### What the reference layout demonstrates

Loading `fixtures/pool-fire-camera-row.ftp.json` and selecting each camera shows the
trade-off the tool exists to surface. At the sketch's 9 ft standoff:

| Camera | Field of view | Plume in frame | Clips base / tip by | Resolution at the fire |
|---|---|---|---|---|
| FLIR T650 LWIR | 24.9° × 18.8° | 72% | 131 mm / 209 mm | 2.17 mm/px |
| FLIR A8303sc MWIR | 39.4° × 22.8° | 89% | 3 mm / 76 mm | 1.80 mm/px |
| GoPro (wide) | 122° × 90.8° | 100% | — | 5.65 mm/px |
| iPhone | 69.4° × 54.9° | 100% | — | 1.06 mm/px |

The flame is 1.30 m tall and **neither IR camera frames it** at 9 ft. The A8303sc's
wider field does markedly better — 89% of the plume against 72% — and is still short.
Backing the IR row out to about 4.5 m frames the whole plume for both, at 2.7 and
3.3 mm/px. That is a decision worth making before hauling gear to a site, and it is
the whole argument for the frustum and preview being in v1.

The asymmetry between the two ends is worth noticing, because it is the reason this
has to be answered by projecting rather than by arithmetic on a field-of-view angle.
Both cameras stand at 1.5 m and look **down** at mid-flame, so the flame tip is nearly
level with the lens and falls much further off-axis than its height above the pan
suggests. A flat-plane estimate — vertical field angle × standoff, compared against
flame height — makes the A8303sc look like it fits with millimetres to spare. It does
not; it loses 76 mm of tip.

The instruments added in M9 make the same kind of point about selection rather than
placement:

| Instrument | Predicted | Verdict |
|---|---|---|
| East wall gauge, 0–50 kW/m² at 1.46 m | 1.70 kW/m² | 3% of scale — lost in the gauge's own noise |
| North wall gauge, 0–10 kW/m² at 1.96 m | 0.95 kW/m² | 9% of scale — usable |
| Plume rake, 3 beads from 1.6 to 2.2 m | 344 / 247 / 190 °C | all in the plume, all well inside type K |
| East wall rake, 4 beads to 2.1 m | — | outside the plume: a wall temperature, by design |

Both gauges are pointed correctly and neither is over-range. The difference is
entirely which one was brought, which is the commonest way to waste a test day and
is invisible until someone works the arithmetic — or opens the plan.

### Known limitations

- **The browser's load-time validation is a subset of the schema.** It catches the
  structural damage that would reach the renderer as NaN geometry and names the
  offending object; `fireplan.validate_schema()` remains the authoritative check.
  The two are kept aligned by mirrored test cases, not by shared code.
- **Camera distortion is stored but never applied.** A wide-angle action camera's
  frustum and framing verdict assume an ideal pinhole, which overstates coverage at
  the edges. Fine for planning; calibrate before reconstructing.
- **The plume cone is a 15° rule of thumb**, not a Gaussian plume half-width, and
  flame height is the *mean* — the intermittent tip goes higher than anything drawn.
- **The desktop shell uses a loopback HTTP bridge, not pywebview's `js_api`.** With
  `js_api` bound to this page the WebView2 message channel never came up; see
  `python/shell/README.md`. The HTTP bridge is also the right shape for Phase 2.
- **Measurements are not saved.** The measure tool is a ruler, not an annotation.
- **The heat flux model assumes an unobstructed view.** It is a point source at
  mid-flame height and knows nothing about the walls in the plan, so a gauge behind
  one still reads a full flux. Shape factors and shadowing are out of scope. It is
  also far-field only: inside two effective diameters it is an order of magnitude,
  and says so.
- **Plume temperatures are centreline values**, quoted only above the mean flame tip.
  A bead inside the envelope but off the axis reads lower than the figure shown, and
  nothing here corrects a bare bead for radiation error or thermal lag.
- **Digital zoom flatters the resolution readout.** The field of view is right at any
  zoom, but a digital zoom crops and interpolates, so mm/px describes the output
  pixels rather than detail the detector resolved. The inspector says so above 1×.
- **Custom camera presets are not a portable file.** The desktop app keeps them in its
  own settings file and a browser tab keeps them in site data, so they follow the
  machine rather than the plan, and clearing site data clears a browser's copy. Plans
  are unaffected either way: every intrinsic is written into the camera itself, and the
  inspector says so when the library has nowhere durable to be stored.
- **Wall openings do not appear in the exported elevations.** The 3D view cuts doors
  and windows out of a wall; the drawing renders the wall as a solid rectangle. Worth
  knowing before a drawing is handed to someone who will build from it.
- **The FDS import classifies by shape, not by intent.** A box is a wall, a slab or an
  obstruction by aspect ratio (CONVENTIONS §9). A 0.4 m kerb reads as a low wall and a
  deep beam reads as a slab; both are defensible and neither is what the author meant.
  The import preview lists what it made, and the Fields view fixes anything it got
  wrong.
- **A burning lining is a note, not a property.** FDS models routinely put `HRRPUA` on
  a wall surface. That surface is imported as a wall with the fact in its `notes`,
  because this format has one fire and it is the burner. Nothing checks it.
- **Only vertical device runs group into rakes.** A rake's beads lie along its local
  +Z, so a horizontal row would have to be a rotated object — and a rotated rake reads
  correctly in the 3D view but not in the elevations. A horizontal row arrives as one
  object per `&DEVC`.
- **A gauge imported from FDS has no range**, so the over-range and low-signal checks
  stay quiet on it until one is set. That is deliberate — see CONVENTIONS §9 — and the
  import says so, but a plan taken straight from an import has not had those verdicts.
- **The import is one-way.** A plan cannot yet emit `&OBST` / `&DEVC` back. The mapping
  is written so an exporter is an addition rather than a rewrite, but it is not there.
- **Pitch and roll are honoured in the 3D view only** — checks, plan view and
  elevations all read a tilted wall, hood or ceiling as if it were upright. Yaw is
  handled consistently everywhere. See CONVENTIONS §5a.
- **Camera framing is judged against the primary burner only.** Hood, ceiling and
  instrument verdicts take every fire in the plan into account (CONVENTIONS §5b),
  but "does this lens frame the fire" and "aim at fire" mean the burner at the
  origin. A plan with a second lit burner carries a `secondary-burner` warning on
  it so the coverage table is not read as covering a fire it never looked at.
- **A preset is at most datasheet-grade.** A calibration belongs to one physical
  unit and a preset carries none, so **Save as preset** on a calibrated camera saves
  a `datasheet` preset. The camera itself keeps its calibration.
- **Zero-thickness FDS obstructions are drawn 10 mm thick.** This format has no
  planar object, so a thin plate gets a nominal thickness on import and the
  preview says how many. A `&VENT` is not geometry and cannot be pasted as one.

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
4. ~~**What is MW2R?**~~ **Settled in practice.** The sketch's mid-wave camera is
   taken to be the FLIR A8303sc, which is the MWIR body this lab expects to use. The
   generic `mwir-640-25mm` placeholder has been removed rather than left in the
   library as a second, `nominal`-grade way to say the same thing.

Raised by M9 and worth settling before the next format bump:

5. **Should a heat flux gauge record what it is aimed at, or what it is mounted to?**
   It currently records an aim target like a camera. A gauge flush in a wall is really
   "normal to this surface", and re-aiming it when the burner moves is wrong for that
   case in a way it is not wrong for a tripod.
6. **Do plume temperatures need an off-axis correction?** The Gaussian half-width is
   already implied by the 15° envelope; using it to scale the centreline value would
   make a wall-adjacent rake's prediction meaningful rather than absent.

Raised by M10:

7. **Should a plan be able to write FDS?** The engineers design the layout here and
   run the simulation there, so a `&OBST` / `&DEVC` skeleton would close the loop.
   Deferred deliberately: an exporter has to decide mesh, resolution and surfaces,
   none of which this format holds, and guessing them produces an input that runs and
   is wrong.
8. **Does a burning surface deserve a field?** `HRRPUA` on a wall lining is a real
   planning fact — it decides where a gauge survives — and it currently lives in
   `notes`, where nothing can check it. A `combustible` block on `wall`, `ceiling` and
   `obstruction` would be the 1.3 shape.
9. **Should the import read `&MESH` resolution into the plan?** Cell size decides what
   a simulation can resolve, and a plan built to compare against one might want to say
   so. Against: it is a property of the simulation, not of the test.


## M11 — Linked test files and reconstruction results (2026-09-05)

Implemented the requests archived in `docs/feature-requests/2026-09-linked-files.txt`.
One inspector section links burner/sensor spreadsheets and multiple camera videos.
Desktop actions open the default application, reveal the original in Explorer,
relink or remove a reference. All link edits participate in undo/redo and saving.

A burner CSV/TSV imports an explicit reconstruction snapshot and shows two aligned
plots (m³ and m² against seconds), a shared sample slider, dataset selector and
collapse control. The snapshot is embedded in the plan and shared HTML. Malformed
rows are reported without silently dropping measurements; refresh failure preserves
the existing snapshot. Workbook formats link and open but must be exported as CSV
for plotting. Browser originals require reselection after reopening.

Format 1.3.0 is additive, with mirrored schemas, validation and canonical writers.
Measurement precision is preserved independently of geometry precision. The desktop
chooses a Save destination before rebasing a copy of link paths; its in-memory
absolute references keep undo and concurrent edits safe across Save As. Python
`Plan.save` rebases references and `Plan.linked_file_path` resolves without reading.
Neither load nor plotting launches external files automatically.

The supplied CSV and MP4 now live under `fixtures/linked-files/`, together with a
rebuildable demonstration plan. The video is a simulation illustration, not a claim
that the reference camera captured that scene. See `docs/linked-files.md` for the
workflow, CSV contract, portability and deliberate limits (external originals,
no playback synchronization, no workbook parsing or automatic file watching).


Validation of the initial M11 build: 303 web tests and 362 Python tests passed;
`npm run build` and the rebuilt `FireTestPlanner.exe --selftest` passed. Browser
checks linked the supplied CSV and MP4, inspected the 100-point two-axis readout,
verified collapse/expand and sensor controls, and reopened the plot in an exported
HTML viewer without selecting the source CSV. Native Open/Show in folder dispatch
is covered through the desktop bridge with OS-launch calls mocked; external Excel
and video-player windows were not driven interactively. The executable startup
self-test needed unsandboxed WebView2 initialization and then completed successfully.
