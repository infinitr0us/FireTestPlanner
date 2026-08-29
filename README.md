# Fire test plan 3D visualisation

Author a fire test layout in 3D, check that the instrumentation will actually
capture what it needs to, and hand the result to whoever comes next as one
diffable file.

The file is the product. A fire safety engineer authors `.ftp.json` in the editor;
a data scientist reads the same file as a camera rig description. Everything else
here serves that handoff.

```
schema/      fire-test-plan-1.0.0 / -1.1.0 / -1.2.0 .schema.json — normative, one per version
CONVENTIONS.md                                — frames, units, correlations
presets/     camera preset library (shared by the editor and the fixture builder)
docs/datasheets/  manufacturer PDFs behind the datasheet-grade presets
fixtures/    reference plans, and fixtures/fds/ — a real FDS case and its conversion
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

Click **Example** to load the reference plan reconstructed from `example.jpg`, then
click a camera in the object list. The coverage panel and the picture-in-picture
preview show what that lens will actually get. Select **East wall gauge** for the
same argument about instruments: at 1.5 m from a 130 kW fire it sees 1.7 kW/m², which
is 3% of a 50 kW/m² gauge and lost in its noise, while the 10 kW/m² gauge further away
on the north wall reads usefully.

### What you can put in a plan

Cameras, a burner, a calorimeter hood, walls, ceilings, **obstructions** (the box that
is neither), **heat flux gauges** and **thermocouples** (one bead, or a rake of them on
one support). Cameras carry a zoom factor as well as a lens, and every instrument is
checked against the fire it is pointed at rather than merely placed.

### Starting from an FDS model

**Import FDS…** builds a plan from a `.fds` input: walls, ceilings, boxes, the burner
and its heat release, doorways from `&HOLE`, and the `&DEVC`s that correspond to
instruments someone has to mount. It previews what it will make and what it will skip
before anything is adopted.

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
python -m pytest python/tests -q     # 288 tests, no GUI needed
cd web && npm test                   # 211 tests
```

The web suite asserts that the TypeScript writer reproduces the Python-written
fixture byte for byte, and that the TypeScript FDS importer reproduces the
Python-written conversion of `fixtures/fds/IR401_0.fds` the same way — two importers
that agree about the syntax but not about which box is a wall would hand an engineer
and a data scientist two different rooms from one file. A plan saved from the editor and the same plan saved from
`fireplan` must be the same file, or every handoff shows up as a spurious diff. The
instrument models are pinned against hand-derived values in both languages, so the
number the tool prints stays the number the correlation gives.
