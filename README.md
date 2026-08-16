# Fire test plan 3D visualisation

Author a fire test layout in 3D, check that the instrumentation will actually
capture what it needs to, and hand the result to whoever comes next as one
diffable file.

The file is the product. A fire safety engineer authors `.ftp.json` in the editor;
a data scientist reads the same file as a camera rig description. Everything else
here serves that handoff.

```
schema/      fire-test-plan-1.0.0.schema.json — normative
CONVENTIONS.md                                — frames, units, correlations
presets/     camera preset library (shared by the editor and the fixture builder)
fixtures/    reference plans
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
preview show what that lens will actually get.

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
p.check()                   # hood capture, aim consistency, plan hygiene
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
python -m pytest python/tests -q     # 113 tests, no GUI needed
cd web && npm test                   # 52 tests
```

The web suite asserts that the TypeScript writer reproduces the Python-written
fixture byte for byte. A plan saved from the editor and the same plan saved from
`fireplan` must be the same file, or every handoff shows up as a spurious diff.
