# Public room-corner FDS 6.9.1 results

These are real outputs of this repository's own [room_corner.fds](../fds/room_corner.fds),
not excerpts of an external engineer's model or run. The input and extracts are
released with the repository under MIT. Import that input to edit the plan, then
open `room_corner.smv` here to inspect the same case in the results workspace.

## Case and provenance

The interior is 3.6 m deep, 2.4 m wide and 2.4 m high. A centred 0.8 m by 2.0 m
opening is in the front narrow wall. These public ISO 9705 dimensions and the
100/300 kW burner stages are described in [NISTIR 5904, the ISO ignition-source
abstract](https://nvlpubs.nist.gov/nistpubs/Legacy/IR/nistir5904.pdf).
This is an original, shortened demonstration, not a standard-duration test or a
validated prediction of a particular lining's fire performance.

- Interior FDS coordinates: X=1.0..3.4, Y=2.0..5.6, Z=0.5..2.9 m.
  The doorway faces +Y, with X=1.8..2.6 and Z=0.5..2.5 m.
- Floor slab: Z=0.3..0.5 m. Walls start at Z=0.4 m, buried 0.1 m, and
  end at Z=3.0 m. The ceiling soffit is Z=2.9 m.
- The 0.18 m square propane burner has its centre at (1.11, 2.11), stands on
  the slab and has a fuel surface 0.30 m above it. HRRPUA is
  9259.25925925926 kW/m2. Its ramp grows from zero to 100 kW over 0..1 s,
  holds to 25 s, rises to 300 kW over 25..26 s, and holds to 60 s.
  FDS snaps the burner to a 0.20 m square and adjusts its mass flux to preserve
  the specified total. The importer retains the authored 0.18 m footprint.
- The back wall, left wall and ceiling underside use `LINING`: 12 mm of a generic
  board (600 kg/m3, 0.16 W/m/K, 1.3 kJ/kg/K), ignition at 280 C, prescribed
  120 kW/m2 after a 5 s growth ramp, and 1500 kJ/kg heat of vaporization.
  Propane is the gas-phase fuel surrogate. This heat-up-and-burn model uses the
  [FDS 6.9.1 input conventions](https://github.com/firemodels/fds/blob/FDS-6.9.1/Manuals/FDS_User_Guide/FDS_User_Guide.tex).
- Two uniform 0.1 m meshes: room 26 x 38 x 28 (27,664 cells), exterior
  26 x 12 x 28 (8,736 cells), 36,400 cells total. Exterior Y=5.7..6.9 m;
  both meshes have X=0.9..3.5 and Z=0.3..3.1 m. External sides/top are OPEN.
- Forty devices: twelve gas thermocouples, twelve wall-temperature probes,
  thirteen directed heat-flux gauges and three doorway V-velocity probes.
  Six triplets run up each burner-side wall at Z=0.85..2.85 m in 0.4 m steps.
  Triplets share exact gas-side points 1 mm off the wall; IOR selects the surface
  for the wall quantities. This avoids sampling a solid cell for the gas beads.
  One floor gauge faces upward. The output has sixteen distinct device sites.
- Thermocouple quantity and 1.5 mm bead diameter come only from `PROP_ID='BEAD'`.
  The slash in HEAD TITLE, comma-free multiline MATL/SURF/PROP records and a
  disabled REAC without `&` are deliberate accepted-input parser regressions.
  The only RADIATIVE_FRACTION is on that disabled line.
- `T_END=60`, `NFRAMES=60`: 61 recorded frames per field. The full run has sixteen
  cell-centred slices (temperature and U/V/W, two X requests, both meshes), ten
  boundary files (wall temperature, total/radiative/convective flux, burning rate),
  and six Smoke3D files (soot density, HRRPUV, temperature). FDS writes all three
  Smoke3D quantities by default for this combustion case.

The importer yields four walls, a door, one ceiling, a 300 kW burner, thirteen
gauges and four six-bead rakes: seventeen instrument objects. Its origin offset
is (1.11, 2.11, 0.5) m. `LINING` is reported as `fds-fire-not-a-burner`; the slab
is not emitted as an object. No behavior had to move to review-cases.json.

Run completion and wall time: FDS-6.9.1-0-g889da6a-release completed all 60 s and 6,986
time steps in 707.347 s wall time (one process, OMP_NUM_THREADS=1). The `.out`
ends with `STOP: FDS completed successfully (CHID: room_corner)`. No numerical
instability was reported. Total heat release also includes the ignited lining.

## Portable selection

The complete metadata geometry and all forty devices are retained. Fourteen field
files retain source frames 0, 30 and 60 (first, middle, last), with their original
recorded times. `manifest.json` records the exact per-file times, offsets, sizes
and SHA-256 hashes, the input hash, and the full-run frame counts.

| Mesh | Slice files | Boundary files | Smoke3D files |
| --- | --- | --- | --- |
| Room (1) | `_1_1.sf`: burner-plane temperature | `_1_1.bf`: wall temperature; `_1_2.bf`: total heat flux | `_1_1.s3d`, `_1_2.s3d`, `_1_3.s3d`: soot, HRRPUV, temperature |
| Exterior (2) | `_2_5.sf`..`_2_8.sf`: doorway-plane temperature, U, V, W | `_2_1.bf`: wall temperature | `_2_1.s3d`, `_2_2.s3d`, `_2_3.s3d`: soot, HRRPUV, temperature |

Every binary header and retained Fortran/RLE frame is a byte-identical extract;
no arrays are synthesized, resampled or re-encoded, including ghost values.
SMV field/CSV inventories and Smoke3D indices are filtered. Scalar `.bnd` files
keep the complete run's bounds. Device and HRR CSVs keep their original headers
and the first, nearest-to-midpoint and last rows. Text values and fixed-width
padding are unchanged; Windows FDS CRLF terminators become LF for this repository.
The unneeded steps CSV inventory entry is removed. A subset is regression data,
not the complete time history needed for scientific analysis.

Size including manifest and this README: 497,968 bytes.

## Rebuild

Use FDS **6.9.1**, with its `bin` and `bin/mpi` on PATH. From the repository root
in PowerShell (run outputs stay in the ignored `local/` directory):

```powershell
New-Item -ItemType Directory -Force local/fds-run/completed | Out-Null
Copy-Item fixtures/fds/room_corner.fds local/fds-run/completed/room_corner.fds
$env:OMP_NUM_THREADS = '1'
Push-Location local/fds-run/completed
fds.exe room_corner.fds
Pop-Location
python tools/build_fixtures.py
python tools/build_fds_results_fixture.py local/fds-run/completed
```

The extraction tool requires successful FDS 6.9.1 completion. CHID defaults to the
only `.smv` in the source directory; `--chid` overrides it. `--files` replaces the
inventory-derived room-corner selection, `--meshes` filters mesh numbers, and
`--frames` overrides the three indices. Otherwise indices are derived separately
from each file's record count. `--dest` supports a disposable verification folder.
The tool does not delete unrelated files; when changing a selection, retire old
outputs explicitly. Rebuilding the subset from the same saved run is byte-stable.
A fresh solver run on another platform can differ numerically; update independent
references only after reviewing the new run, never by copying application output.

The default tests need neither FDS nor FDSreader nor the full run. To additionally
check every field in the complete local run:

```powershell
$env:FDS_FULL_RESULTS_DIR = (Resolve-Path local/fds-run/completed).Path
npm --prefix web test
Remove-Item Env:FDS_FULL_RESULTS_DIR
```

## Independent temperature reference

Run with a Python environment containing **FDSreader 1.11.7**:

```powershell
python tools/reference_fds_results_fixture.py local/fds-run/completed
```

The script selects `room_corner_1_1.sf`, reads its middle frame through FDSreader,
and reports the data after FDSreader drops the low ghost row and column. The
38 x 28 array is indexed (Y,Z); the four corners below are (low Y,low Z),
(high Y,low Z), (low Y,high Z), (high Y,high Z). The browser test retains the raw
39 x 29 record and explicitly drops those same low cells before comparison.

| Value | FDSreader 1.11.7 reference |
| --- | --- |
| Original frame | 30 of 61 (zero based) |
| Time | 30.004154205322266 s |
| Minimum | 19.99980354309082 C |
| Maximum | 1353.847900390625 C |
| Four corners | 20.0, 20.0, 20.000019073486328, 20.003232955932617 C |
| Cell-centre X | 1.1500000953674316 m (1.15 m nominal) |

FDSreader 1.11.7 emits warnings when parsing the `!` annotations on this FDS
version's VENT metadata. Its slice reader still loads the selected array; the
independent check does not use FDSreader's vent module. No metadata was rewritten
to hide that limitation. The application reader inventories the case without warnings.
