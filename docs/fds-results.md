# FDS simulation results

This workspace is for inspecting recorded simulation output. The existing **Import
FDS…** command still converts input geometry into an editable test plan.

## External results and coordinate system

The external engineer-supplied `RC_BS_2.smv` (locally kept in the ignored
`fixtures/fds_2/` directory; not included in a clone) describes an FDS 6.9.1 room-corner simulation with
20 meshes and a requested duration of 1200 seconds. The folder contains about
9.3 GiB: 72 slice files, 80 boundary files, 60 smoke files, and device/HRR CSVs.
The metadata, rather than filename numbering or the requested end time, determines
the quantities, mesh associations and actual recorded frames.

The results viewer uses the original FDS Z-up coordinates and the obstruction
geometry in the `.smv` file. It is separate from the editable plan: opening results
does not replace, dirty, re-origin or save over a plan. Results remain external and
are reopened from their folder; they are not embedded in plan JSON or Share HTML.

The reader must seek to individual frames, keep memory bounded, preserve mesh-local
coordinates (including nonuniform spacing and cell centering), use actual recorded
times, validate Fortran record markers, and expose missing/unsupported files.

FDSreader was evaluated against its upstream documentation and source. It reads
output through `.smv`, supports the relevant data families, and is useful for
independent scientific checks. However, accessing a lazy-loaded slice/smoke object's
data materializes its entire time series. One sample smoke quantity would occupy
roughly 10 GiB as float32 across all 20 meshes and 3001 frames. The application
instead uses a shared TypeScript range reader for browser File/Blob objects and
the desktop's authenticated local file bridge. This also preserves the offline,
single-file browser distribution without a Python runtime requirement.

Sources: [FDSreader](https://github.com/FireDynamics/fdsreader),
[slice reader](https://github.com/FireDynamics/fdsreader/blob/master/fdsreader/slcf/slice.py),
[smoke reader](https://github.com/FireDynamics/fdsreader/blob/master/fdsreader/smoke3d/smoke3d.py),
[FDS 6.9.1 output writer](https://github.com/firemodels/fds/blob/FDS-6.9.1/Source/dump.f90),
[Smokeview documentation](https://pages.nist.gov/fds/manuals.html).

## Scope

The implementation supports structured mesh geometry, scalar slices,
surface boundary fields, device/HRR histories and quantized smoke/fire preview,
with play/pause, scrubbing, frame stepping, playback speed and explicit units.
Velocity components present in slice files can be inspected as scalar fields.

Arbitrary quantities or planes not recorded by FDS cannot be reconstructed from
these files. Particle tracks, isosurfaces, Plot3D, unstructured GEOM/cut-cell output,
compressed Smokezip variants, live growing/restarted runs, and movie export require
additional format and rendering support. Smokeview remains the reference for those
workflows and for comparison of scientific visualization. The viewer is not an FDS
solver or an assessment of the simulation's physical validity.


## Use it

1. Click **FDS results…** in the main toolbar.
2. Desktop: choose the simulation’s `.smv` file. Browser: choose its output
   folder, then select a metadata file if there is more than one.
   No files are uploaded to a remote service.
3. Choose a **Recorded field** and **Mesh coverage**. Request 1/2 labels identify the original `&SLCF` request; one request can
   produce multiple mesh-local planes at different coordinates.
4. Drag the time slider, step frames, or press Play. Click or Tab to the simulation
   canvas and press Space to toggle playback. Playback follows recorded
   times, waits for complete frames, and may run below the requested rate when
   storage/GPU throughput is limiting. The time shown is the displayed frame's time.
5. Choose a sensor or HRR history to see its actual units, sample timestamp and
   position marker. Histories use the nearest recorded sample, without temporal
   interpolation; no value is shown outside the series' coverage.
6. For wall fields, enable **Cut away above Z (m)** to reveal the interior. **Fit**
   fits the clipped domain. Use orbit/zoom to inspect the region of interest.
7. **PNG** exports the current view with its quantity, time, dataset and mesh
   selection, and the colour bar with its end values. **Back to plan** releases the
   file session and GPU resources and returns to the existing plan.

Color scales are fixed across playback, initialized from FDS `.bnd` bounds when
available. Enter a different range or choose **Scale to this frame**; the resulting
range remains fixed until changed. Nonfinite scalar values are not colored as zero.
Values are shown to four significant figures, in exponent form below 0.01 and from
10⁶, so a soot or species legend does not read "0 — 0".

| Recorded output in the supplied run | Display |
| --- | --- |
| Temperature on two requested X planes | Cell-centered scalar maps at actual mesh positions |
| U, V, W velocity on those planes | Separate scalar maps in m/s; vector arrows are not implemented |
| Wall temperature | Obstruction-face maps in C |
| Radiative, convective, total heat flux | Obstruction-face maps in kW/m2 |
| Burning rate | Obstruction-face maps in kg/m2/s |
| Soot, HRRPUV, temperature Smoke3D | GPU volume previews, one quantity at a time |
| 67 device channels, 12 HRR/energy/mass channels | History plot and synchronized sample readout |

The smoke byte stream is **encoded display data**, not a float32 physical field.
For soot, opacity is encoded using the extinction coefficient and X cell width;
fire and temperature use clipped/quantized display ranges. This viewer does not
label those bytes as kg/m3, kW/m3 or C. Its volume shading is an appearance preview,
with approximate transparency ordering between meshes, not pixel equivalence to
Smokeview. Use the scalar fields/CSV for quantitative inspection. Smoke preview
currently requires uniform spacing inside each mesh (different meshes may have
separate resolutions). It masks interior solid samples; geometry is shown as
translucent context rather than an opaque ray-occlusion model.

Boundary views display obstruction patches, omitting external mesh-boundary patches
whose obstruction index is zero. The coverage panel reports the omitted-patch
count for the selected boundary dataset and meshes; these may include floor or wall
measurements. Showing these faces requires distinguishing physical surfaces from
OPEN/MIRROR boundaries and mesh interfaces. Box geometry follows the grid-snapped SMV records;
VENT surface styling and custom SURFACE colors are not reproduced. Nonzero mesh
OFFSET is rejected. Cases with time-varying obstruction/vent events open with an
expanded warning: static SMV obstructions and masks remain at every time, and vent
state and changing visibility are not reproduced. This is not guaranteed to be the
initial geometry. Use Smokeview to inspect animated geometry. Unsupported families
and missing files are listed under **Coverage and limitations**. A broken field
reports an error; select an unaffected mesh or another quantity. A CSV-only case
can show its history plot, but playback currently requires a supported spatial field.

The reader supports 32-bit Fortran record markers with either byte order and
uncompressed `.sf`/`.bf` plus RLE `.s3d` with matching `.s3d.sz` indices. It rejects
corrupt record markers, mismatched labels/dimensions, invalid RLE, and changed desktop
files. A run stopped mid-write is read up to its last complete frame: the field note
says how many files end part-way through a frame, a smoke index that runs ahead of its
data is cut to the frames present, and a CSV's partial last row is dropped with a
warning. Nonmonotonic/restarted timelines are unsupported.

Outputs the `.smv` names in a subfolder — FDS `RESULTS_DIR` — are read from there,
on the desktop as in a browser folder pick. A path that would leave the case folder
(`..`, a drive or an absolute path) skips that one output with a warning; the rest of
the case still opens.
The time-range scrubber follows the first selected mesh; other selected meshes use
their nearest available frame, report differing sample times and hide outside their
coverage. Longer recordings on another mesh can be inspected by selecting that mesh.

Reads and individual decoded scalar frames are capped at 64 MiB; a selected dataset
is capped at 128 MiB of samples and six million potential surface vertices. Select
an individual mesh for larger datasets. At most four desktop result sessions are
retained; opening another releases the oldest abandoned session. Files are served
only by opaque handles from an explicitly selected result folder, with path and
modification checks and the existing shell authentication token.

## Simulation devices

The viewer shows symbolic probes from the SMV metadata, independently of any open
plan. Thermocouples, surface-temperature probes, heat-flux probes and other numerical
probes have separate colors, shapes and visibility controls. These are measurement
locations, not inferred physical hardware. Gas-temperature probes are not labeled as
thermocouples. No companion input file or aligned planning document is required.

- **Show devices** controls the overlay. Type filters work independently of field and
  mesh selection. **Labels** adds collision-limited labels; the selected label takes priority.
- Select a device from **Find / select a device**, or click its marker. Coincident
  positions have a count badge. A click that intersects several probes offers all of
  them in a keyboard-accessible chooser, including probes overlapping in projection.
  Their recorded coordinates are never displaced to separate the symbols.
- Selection opens the matching device CSV history, with units and the nearest sample
  timestamp. Selecting a device history also selects and reveals its marker. Missing
  or ambiguous device histories are reported without borrowing HRR or other channels.
- The selected probe shows its original FDS coordinates. Surface-temperature and
  heat-flux probes show their recorded direction; thermocouples and other point
  probes do not acquire a facing from FDS’s default normal. Marker size and arrow length are symbolic. Probes are visible through the
  scene; the cutaway hides probes above its height. The dropdown still reaches them.
- Device markers, labels and selected arrows are included in PNG snapshots. Closing
  or changing simulations releases the overlay and resets its controls.

The supplied run has 67 probes at 23 distinct recorded positions: 22 sites shared by
wall temperature, heat flux and thermocouple devices, plus the floor heat-flux probe.
The latter is recorded at X=1.1995 m in SMV, slightly different from X=1.2 m in the
input; the viewer deliberately retains the output metadata's position.

Planned cameras, hoods and added test equipment are not overlaid. Device rendering is
an independent layer, leaving room for a future explicitly aligned equipment layer
without coupling simulation playback to the planning document.

## Preview thresholds and local sessions

HRRPUV fire previews use the SMV `HRRPUVCUT` threshold with the FDS 6.9.1
0–1200 kW/m³ byte encoding; missing thresholds are reported. Temperature volumes
use the scalar ramp and do not use a fire cutoff. The preview remains quantized
appearance data, not a quantitative value readout. Encoding source:
[FDS 6.9.1 constants](https://github.com/firemodels/fds/blob/FDS-6.9.1/Source/cons.f90)
and [Smoke3D writer](https://github.com/firemodels/fds/blob/FDS-6.9.1/Source/smvv.f90).

Desktop sessions inventory only result files beside the selected metadata file,
without walking subfolders. Failed opens retain an Open button. The plan's render
loop and reconstruction clock are held while the results dialog is open, then resume
without catching up the elapsed wall time. A short successful byte response is logged
with file, offset, expected length and actual length, and retried once.

## Regression data

`fixtures/fds-results/` contains a portable subset of the external run: all source
mesh/device metadata, ten fields from two meshes, and three unchanged samples per
field (original frames 0, 1500 and 3000), plus three actual CSV rows. The ordinary
web suite always reads it, including the independent FDSreader reference sample;
missing fixture files fail the suite. See its README for provenance and rebuilding.

To opt into the separate 212-file, 3001-frame external inventory in PowerShell:

```powershell
$env:FDS_FULL_RESULTS_DIR = 'E:\path\to\completed-run'
npm --prefix web test
Remove-Item Env:FDS_FULL_RESULTS_DIR
```

An explicitly requested external inventory fails if its data is absent. The full
multi-gigabyte run is neither committed nor required in a fresh clone.
