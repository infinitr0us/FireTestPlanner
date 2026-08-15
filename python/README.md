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
cam.standoff_m             # slant range to the fire (the origin IS the burner)
cam.intrinsics_source      # 'nominal' | 'datasheet' | 'calibrated'

p.to_nerfstudio("transforms.json")
p.framing(cam)             # does this camera actually frame the flame?
p.check()                  # hood capture, aim consistency, plan hygiene
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
