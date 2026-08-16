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
web/         the 3D editor
tools/       build_fixtures.py
PLAN.md      milestones and open questions
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
python -m pytest python/tests -q     # 80 tests
cd web && npm test                   # 33 tests
```

The web suite asserts that the TypeScript writer reproduces the Python-written
fixture byte for byte. A plan saved from the editor and the same plan saved from
`fireplan` must be the same file, or every handoff shows up as a spurious diff.
