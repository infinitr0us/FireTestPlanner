# Fire test plan 3D visualisation

Author a fire test layout in 3D, check that the instrumentation will actually
capture what it needs to, and hand the result to whoever comes next as one
diffable file.

The file is the product. A fire safety engineer authors `.ftp.json` in the editor;
a data scientist reads the same file as a camera rig description. Everything else
here serves that handoff.

```
schema/      fire-test-plan-1.0.0 through -1.4.0 .schema.json — normative, one per version
CONVENTIONS.md                                — frames, units, correlations
presets/     camera preset library (shared by the editor and the fixture builder)
docs/datasheets/  manufacturer PDFs behind the datasheet-grade presets
fixtures/    reference plans; fixtures/fds/ — a real FDS case and its conversion;
             fixtures/flame/ — a reconstructed flame, its pipeline and the plan that plays it
python/      fireplan — reader, validator, exporters
python/shell/  desktop shell (pywebview + PyInstaller)
web/         the 3D editor
tools/       build_fixtures.py
PLAN.md      milestones, decisions and known limitations
```

## Try it

```bash
cd web && npm install
npm run dev                 # editor at localhost:5173
```

Click **Example** to load the reference plan reconstructed from `example.jpg` — with
the flame reconstructed from a test on that site, and that test's recorded 80 kW on
the burner, so press play — then click a camera in the object list. The coverage
panel and the picture-in-picture preview show what that lens will actually get.
Select **East wall gauge** for the same argument about instruments: at 1.5 m from an
80 kW fire it sees 1.0 kW/m², which is 2% of a 50 kW/m² gauge and lost in its noise,
while the 10 kW/m² gauge further away on the north wall still reads above its noise
floor (0.6 kW/m², 6% of scale). The reference layout itself, `fixtures/
pool-fire-camera-row.ftp.json`, keeps the 130 kW steady-state figure for a 1 ft pan.

### What you can put in a plan

Cameras, a burner, a calorimeter hood, walls, ceilings, **obstructions** (the box that
is neither), **heat flux gauges** and **thermocouples** (one bead, or a rake of them on
one support). Cameras carry a zoom factor as well as a lens, and every instrument is
checked against the fire it is pointed at rather than merely placed.

### Starting from an FDS model

**Import FDS…** builds a plan from a `.fds` input: walls, ceilings, boxes, the burner
and its heat release, doorways from `&HOLE`, and the `&DEVC`s that correspond to
instruments someone has to mount. It previews what it will make and what it will skip
before anything is adopted, and it will not adopt a conversion the editor could not
open again.

A split input — geometry in one file, devices in another, pulled together by `&CATF`
— imports whole: the desktop build reads the sibling files from the folder the input
came from. A browser tab only has the one file it was handed, and says which files it
could not read rather than presenting part of a model as all of it.

```bash
python -c "from fireplan import Plan; Plan.from_fds('fixtures/fds/IR401_0.fds')"
```

The sample case in `fixtures/fds/` converts to 4 walls with a door, a ceiling, a
300 kW burner and 25 instruments — and the plan's own checks immediately report that
the flame tip comes within 0.23 m of the ceiling and that nine gauges sit inside the
near field, which is the point of importing it here rather than reading it there.

The origin moves: this format measures everything from the burner centre at floor
level, so an import re-origins and keeps the shift in `meta.source.originOffset_m`.
The inspector's **Fields / FDS** switch uses it to show a wall as the `XB` the source
file actually contains, and accepts one typed back. **From FDS** in the palette turns
a single pasted `&OBST` or `&DEVC` into an object.

`fdsreader`, the obvious library, does not help here: it reads simulation *output*
through the `.smv` file and cannot open a `.fds` input. The reader is ours, and small.

### Playing back FDS simulation output

**FDS results…** opens a separate results workspace. In the desktop app, select the
simulation's `.smv` file; in the browser, choose its output folder. The viewer reads
individual frames locally, including multi-gigabyte simulations, without importing
those results into the editable plan.

Replay temperature and velocity-component slices, wall temperature and heat-flux
maps, quantized 3D smoke/fire previews, and device/HRR histories. Controls include
play/pause, frame stepping, scrubbing, playback speed, mesh selection, stable color
scales, an adjustable cutaway for interior surfaces, and a labeled PNG snapshot.
Simulation probes have type filters, optional labels, recorded direction arrows,
and a chooser for overlapping positions. Selecting a probe opens its recorded
history; the PNG snapshot includes the visible probe markers.

The engineers' case in `fixtures/fds_2/` has 20 meshes and 3,001 recorded frames.
See [supported outputs, usage and limitations](docs/fds-results.md). Results stay
external: plan Save and Share HTML do not embed the simulation output.

### Connecting the plan to recorded test data

Select a burner, camera or sensor and use **Linked files** in its inspector.
Cameras link multiple videos; burners, heat flux gauges and thermocouple rakes link
spreadsheets. The desktop app provides **Open**, **Show in folder** and **Relink**.
Save As preserves the targets, and moving a plan together with its data folder
preserves relative links.

A burner CSV with `timestamp_s`, `volume_m3` and `surface_area_m2` columns produces
two aligned plots in the upper-right of the viewport, with a shared sample slider.
The snapshot travels inside the plan and shared HTML; originals stay external.
See the [usage guide](docs/linked-files.md), or open
[`linked-test.ftp.json`](fixtures/linked-files/linked-test.ftp.json) for a working
example using the engineers' supplied CSV and MP4.

### Playing back the reconstructed flame

The reconstruction pipeline turns the cameras' footage into a visual hull, one
`t_<seconds>s.npz` of occupied voxel centres per timestep. Link that folder — the
**3D flame…** tile, or **Link 3D flame sequence…** on the burner whose `volumes.csv`
came from the same run — and a playback bar docks along the viewport: the hull
plays back inside the layout, under the hood and inside the frustums of the cameras
that produced it, with the predicted Heskestad cone over it for comparison. The
burner's volume plot follows the same clock, and a selected camera's
picture-in-picture shows the hull from its own view at that moment.

The plan stores a reference and a manifest, never the voxels; the desktop app reads
the frames as the plan opens, and **Share…** embeds them in the exported page (the
example is 49 KB packed). Placement checks say when a hull sits below the floor or
away from its burner — the reconstruction frame was not the plan frame — and the
object's transform is the correction. See [docs/flame-playback.md](docs/flame-playback.md).

```python
from fireplan import Plan
plan = Plan.load("fixtures/flame/flame-test.ftp.json")
seq = plan.flame_sequence(plan.reconstructed_flames[0])
seq.voxels(55.0)                     # (35960, 3) centres at t = 55 s
```

### Cameras this build has never heard of

The preset list is seeded from `presets/cameras.json` — including the FLIR A700 and
A8303sc, derived from the datasheets in `docs/datasheets/`. For anything else: place
the nearest camera, correct its optics in the inspector, then **Save as preset**. It
joins the list and persists — in the desktop app's settings file, or in site data in a
browser tab — with **no file to keep beside your plans**. That works because `presetId` is only a
hint: every intrinsic is copied inline into the camera, so a plan is fully specified
on a machine whose preset library is empty — and opening someone else's plan offers to
adopt the preset it names.

```bash
npm run build               # -> dist/index.html, one self-contained file
```

That single file is the lightweight variant: no server, no install, works offline.
**Share…** inside the app writes a copy with the current plan baked in, so a
collaborator can double-click it and orbit the scene with nothing installed.
**Drawing…** produces the dimensioned plan and elevations with an equipment list
and coverage table, ready to print to PDF.

## Desktop app

Rebuilding the exe means rebuilding the web bundle first — the exe carries
`web/dist/index.html` as bundled data, and packaging around a stale bundle looks
exactly like the code change simply not working. `build.bat` does the whole chain:

```bat
build.bat                   :: web bundle -> exe -> selftest
build.bat clean test        :: both suites first, then a clean package
build.bat console           :: console variant, so --selftest prints to a terminal
build.bat noverify          :: skip the post-build selftest
```

It creates `python/shell/.venv` and runs `npm install` on first use, stops on the
first failure rather than shipping a broken build, and finishes by running the
packaged exe's own `--selftest`. Output lands in
`python/shell/dist/FireTestPlanner.exe` (~10 MB).

The underlying steps, if you want them by hand:

```bash
cd web && npm run build                         # the bundle the exe will carry
cd ../python/shell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe app.py                 # run from source
.venv\Scripts\python.exe build_exe.py           # -> dist/FireTestPlanner.exe
```

Same bundle, in a native window with native file dialogs and a recent-files list.
See [`python/shell/README.md`](python/shell/README.md) for how the bridge works and
why it is HTTP rather than pywebview's `js_api`.

## Read a plan in Python

```bash
pip install -e python/      # or just run pytest from the repo root
```

The wheel carries its own copy of the schemas (`fireplan/schemas/`, a byte-identical
mirror of `schema/` that a test holds it to), so `validate_schema()` and FDS
conversion work from an installed package with no repository checkout beside it.

```python
from fireplan import Plan

p = Plan.load("fixtures/pool-fire-camera-row.ftp.json")
cam = p.cameras["cam-lwir-t650"]

cam.K                       # (3,3) intrinsics in pixels
cam.extrinsics()            # (4,4) camera-to-world, OpenCV frame
cam.intrinsics_source       # 'nominal' | 'datasheet' | 'calibrated'

p.to_nerfstudio("transforms.json")
p.framing(cam)              # does this camera actually frame the flame?
p.check()                   # hood capture, instrument placement, plan hygiene

gauge = p.heat_flux_sensors[0]
p.heat_flux_estimate(gauge)          # predicted incident kW/m2, and whether it is usable
p.thermocouple_beads(p.thermocouples[0])   # each bead: flame / plume / outside, and its
                                           # predicted plume-centreline temperature
```

Before reconstructing from a plan, check `intrinsics_source`. `nominal` means the
numbers are a placeholder — good enough to check framing, not good enough to
reconstruct from.

## Two things worth knowing

**The origin is the burner centre at floor level.** Camera standoff is therefore
just `norm(position)`, and the dimension callouts a hand sketch is covered in are
generated rather than drawn.

**Poses are stored in the OpenGL frame and read in the OpenCV frame by default.**
Storage matches the editor (Three.js), reading matches reconstruction tooling.
Both ends are explicit; neither has to remember the other's choice. Full
definitions in [CONVENTIONS.md](CONVENTIONS.md) section 3.

## Tests

```bash
python -m pytest python/tests -q     # 444 tests, no GUI needed
cd web && npm test                   # 397 tests
```

The web suite asserts that the TypeScript writer reproduces the Python-written
fixture byte for byte, that the TypeScript flame reader produces the manifest, the
packed bytes and the surface cells the Python reader pinned on the 80-frame fixture,
and that the TypeScript FDS importer reproduces the
Python-written conversion of `fixtures/fds/IR401_0.fds` the same way — two importers
that agree about the syntax but not about which box is a wall would hand an engineer
and a data scientist two different rooms from one file. A plan saved from the editor and the same plan saved from
`fireplan` must be the same file, or every handoff shows up as a spurious diff. The
instrument models are pinned against hand-derived values in both languages, so the
number the tool prints stays the number the correlation gives.
