# fireplan

Reader for `.ftp.json` fire test plans. The plan file is authored in the 3D editor by
a fire safety engineer; this package is how a data scientist consumes it.

```bash
pip install -e python/          # or just run pytest from the repo root
```

```python
from fireplan import Plan

p = Plan.load("fixtures/pool-fire-camera-row.ftp.json")

cam = p.cameras["cam-lwir-t650"]
cam.K                      # (3,3) intrinsics in pixels
cam.extrinsics()           # (4,4) camera-to-world, OpenCV frame
cam.hfov_deg               # derived from sensor + focal length, never stored
cam.zoom_factor            # 1.0 unless the camera was zoomed
cam.standoff_m             # slant range to the fire (the origin IS the burner)
cam.intrinsics_source      # 'nominal' | 'datasheet' | 'calibrated'

p.to_nerfstudio("transforms.json")
p.framing(cam)             # does this camera actually frame the flame?
p.check()                  # hood capture, instrument placement, plan hygiene
```

## Instruments (format 1.1)

```python
gauge = p.heat_flux_sensors[0]
gauge.normal               # outward normal of the sensing face
est = p.heat_flux_estimate(gauge)
est["incident_kw_m2"]      # point source at mid-flame: X_r Q cos(theta) / (4 pi r^2)
est["fraction_of_range"]   # None when no range is recorded
est["near_field"]          # True inside 2 effective diameters, where the model fails

rake = p.thermocouples[0]
rake.bead_positions        # (n, 3) world coordinates, through the object frame
for bead in p.thermocouple_beads(rake):
    bead["region"]             # 'flame' | 'plume' | 'outside'
    bead["gas_temperature_c"]  # plume centreline, or None where no correlation applies
```

Both are first-order estimates for sizing and placement, not measurements. The heat
flux model assumes an unobstructed view and knows nothing about walls in the plan; the
plume temperature is a centreline value quoted only above the mean flame tip. Details
in [`../CONVENTIONS.md`](../CONVENTIONS.md) section 5b.

## Format versions

A plan declares the lowest version that describes its contents, so one using nothing
past 1.0 still says `"1.0.0"` and still opens in a 1.0 tool.

```python
p.format_version                  # what the file says
p.effective_version               # what it will say once written
p.validate_schema()               # judged against effective_version
p.validate_schema("1.0.0")        # "would this still open in a 1.0 tool?" -- raises,
                                  # with a reason, when the answer is no
```

## Before you reconstruct from a plan

Check `cam.intrinsics_source`. `nominal` means the numbers are a plausible
placeholder good enough to check framing and **not** good enough to reconstruct from —
`cam.is_reconstruction_ready` is False for anything that has not been calibrated.
`p.check()` reports these as `nominal-intrinsics` findings.

Wide-angle action cameras additionally need `distortion` populated; a pinhole model of
a 122° GoPro lens will bias any reconstruction that trusts it.

## Frames

The file stores OpenGL-style poses (the editor is Three.js); this reader returns
**OpenCV/COLMAP by default** (X right, Y down, Z forward, camera-to-world).

```python
cam.extrinsics()                       # OpenCV c2w      <- default
cam.extrinsics(world_to_camera=True)   # OpenCV w2c
cam.extrinsics("opengl")               # as stored, no flip
```

`to_nerfstudio()` uses the stored OpenGL poses directly, with no flip. Full definitions
are in [`../CONVENTIONS.md`](../CONVENTIONS.md) section 3.

## Tests

```bash
python -m pytest python/tests -q        # from the repo root
python tools/build_fixtures.py          # regenerate reference fixtures
```
