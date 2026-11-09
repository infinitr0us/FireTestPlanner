# Synthetic flame analysis test

A flame analysis folder (format 1.0, [CONVENTIONS.md section 13](../../CONVENTIONS.md))
made entirely by `tools/build_synthetic_flame_event.py` for the flame analysis board's
tests and as a public example. Nothing in it was measured or filmed, and its numbers
say nothing about any real fire or about any analysis method.

- `site.ftp.json`: a 0.4 m square pan, a back wall, a hood and three calibrated pinhole
  cameras: `camA` in front and `camB` at the side (240 x 180 px), `camC` high at the
  front left in portrait (135 x 240 px). Their principal points are off centre on
  purpose, so the calibrated projection is exercised.
- `E1` (three cameras) and `E2` (`camA` and `camB` only): 36 instants each, every
  0.1 s from 0.5 s before the onset, on the test clock `t_clock` (onsets at 100 s and
  160 s).
- `frames/`: pictures rendered by marching each pixel's ray through a seeded flame
  shape; `outlines/`: the rings of the pixels whose ray met the flame;
  `hull/`: the visual hull of the event's cameras carved from those masks on a 3 cm
  grid, so E2's two-camera hull is visibly larger than its flame.
- `series/`: hull volume, surface area (exposed faces) and flame top per instant; a
  1 Hz "hood" made from the true flame volume (1800 kW/m3, one second late, lagged,
  plus noise); "estimates" from the hull volume (700 kW/m3) and area (35 kW/m2)
  averaged over five instants. These coefficients are invented for the test.

Regenerate from the repository root with `python tools/build_synthetic_flame_event.py`
(NumPy and the standard library). The content comes out the same on every platform:
the text files byte for byte, the PNGs pixel for pixel and the NPZ files array for
array (compressed bytes vary with the zlib build). `python/tests/test_flame_analysis.py`
rebuilds event E2 and compares.
