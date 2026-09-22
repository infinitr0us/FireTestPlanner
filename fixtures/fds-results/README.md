# Portable FDS 6.9.1 results samples

Extracted from the engineer-supplied RC_BS_2 run (external, about 9.3 GiB).
This is regression data, not a complete simulation for analysis.

- Original mesh geometry (20 meshes), device metadata (67 probes), labels and coordinates.
- Meshes 1 and 2: temperature slice, wall-temperature boundary, soot/HRRPUV/temperature Smoke3D.
- Three byte-identical recorded frames: original indices 0, 1500, 3000. Timestamps remain approximately 0, 600, 1200 s.
- Smoke indices rewritten to list only those frames. Scalar .bnd ranges still describe the full source run.
- Device and HRR CSVs retain the first, closest-to-600 s and last original rows.
- Around 475 KB total; no external dependency needed for the default tests.

Rebuild from repository root with `python tools/build_fds_results_fixture.py [source-folder]`.
The default source is the ignored `fixtures/fds_2`. Rebuilding requires that completed run;
using the fixture and running tests do not. The full inventory test runs only when
`FDS_FULL_RESULTS_DIR` is explicitly set and fails if that directory is missing.

The temperature slice's middle frame preserves the independent FDSreader 1.11.7
reference: time 600.00341796875 s, min 19.99260902404785 C, max 1221.230712890625 C,
X = 0.225 m. Tests pin these values plus four corners after dropping low ghost cells.
