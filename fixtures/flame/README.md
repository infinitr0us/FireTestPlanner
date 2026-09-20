# Reconstructed flame example

A visual-hull reconstruction of a fire on the reference layout's site, as the
engineers' pipeline writes it, and the plan that plays it back.

| File | What it is |
|---|---|
| `voxels/t_<seconds>s.npz` | One frame per 5 s, 0–395 s: the world coordinates of the occupied voxel centres (`voxels`, M×3 float64, metres) and the pipeline's `voxel_size`. 80 frames on a 192³ grid over a 3 m cube. The timestamp is only in the file name. |
| `voxels/t_<seconds>s.ply` | The same points as coloured PLY, ten times the size. On disk for MeshLab; not committed and not read by the tool. |
| `volumes.csv` | The same run's per-frame volume, surface area and geometric features, from the same pipeline. Linked to the burner for the plot. |
| `reconstruct_revised.py` | The pipeline that produced both, kept as the reference for the format. Not run here. |
| `flame-test.ftp.json` | The reference plan with a `reconstructedFlame` linking `voxels/` and the burner linking `volumes.csv`. Format 1.4.0. |
| `expected.json` | The manifest, packed-bytes digest and surface-cell digest the Python reader computes on `voxels/`; the TypeScript reader is held to them. |
| `check-cases.json` | Placement and CSV-provenance check cases run by both test suites. |

Open **flame-test.ftp.json** in the editor and press play. Select the burner for the
volume plot, which follows the same clock. Rebuild the plan with
`python tools/build_flame_fixture.py` from the repository root; rebuild
`expected.json` only when the codec changes, and then run both suites.

See [the design](../../docs/flame-playback-design.md) for the format and the
reasoning, and CONVENTIONS.md section 11 for the rules.
