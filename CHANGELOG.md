# Changelog

All notable changes to FireTestPlanner. Versions follow [Semantic Versioning](https://semver.org/);
while the version is 0.x, a minor release may change behaviour. The plan file format
has its own version (`fire-test-plan` 1.0.0 to 1.7.0, one JSON Schema each in `schema/`),
and a plan written by any release opens in every later one.

## [0.9.0] - 2026-11-02

No plan format change (still 1.7.0 at most): every addition is derived from what a plan
already stores, and a plan written by 0.9.0 opens in 0.8.0.

### Added
- **Every standoff lens FLIR lists for the three IR bodies.** The T650sc becomes a body
  with its five lenses (7°, 15°, 25°, 45° and 80°); the A8303sc gains the 200 mm lens its
  own datasheet lists; the A700 gains the second 24° lens, 17 mm f/1.3 (T300240), beside
  the 18 mm f/1.0 one. Each is cited in `docs/datasheets/README.md`, which also closes
  the gap the T650sc preset had there. Close-up and microscope lenses stay out.
- **Thermocouple beads in a camera's image.** Coverage reports how many beads a camera
  sees in frame and in line of sight, how far apart in pixels the two closest are, and
  the size of a 3 × 3 px measurement spot at the beads; the lens comparison and the
  printed coverage table add the same for every lens. Separation is good at 6 px or
  more, touching from 3 to 6 px and overlapping below 3 px. In Python,
  `Plan.thermocouple_view(camera)` gives every bead's pixel position.
- **Camera roll.** A camera's **Roll** field mounts it on its side (90°) without
  changing where it looks; re-aiming and moving keep the roll. When a level landscape
  camera clips the flame, Coverage suggests it. The equipment list tells the crew
  ("on its side (roll 90°)"). In Python, `Camera.roll_deg` and `set_roll_deg`.
- **A flame height field on the burner.** Typing a mean flame height back-solves the
  heat release rate through the Heskestad correlation, the way typing a field of view
  back-solves a focal length. In Python, `correlations.hrr_for_flame_height_kw`.

## [0.8.0] - 2026-11-02

Plan formats 1.5.0, 1.6.0 and 1.7.0.

### Added
- **Drawings a crew can build from.** The elevations cut doors and windows out of
  their walls and dimension their width and sill; the plan marks windows; a
  **Set-out** table gives every object's coordinates, aim point, standoff and facing
  in words.
- A **feet and inches** display unit (`ft-in`, to 1/16"), for inspector fields,
  dimensions, the drawing and the set-out table. Plan format 1.5.0 (only a plan shown
  in `ft-in` declares it).
- **Export to FDS…** writes the plan's gauges and thermocouple beads as `&DEVC` lines,
  in the source FDS file's frame and under its device IDs when the plan came from an
  import: wall-mounted gauges and surface thermocouples with their `IOR`. Checked
  against FDS 6.9.1.
- **Measured and simulated test data on the instruments.** **Test data…** links a
  logger workbook (`.xlsx`), a CSV or an FDS `_devc.csv` / `_hrr.csv`, shows how it was
  read, and maps its columns to gauges, thermocouple beads and burners, with a gauge's
  calibration constant taken from a channel name and the ignition time offered from
  the sheets. Selecting an instrument plots its measured and simulated series against
  the plan's prediction and the gauge's range. The plan records the mapping, never the
  samples (format 1.6.0); **Share…** embeds them; **Download schedule (CSV)** in the
  drawing lists every instrument with its channel. In Python, `Plan.series(obj)`
  returns an instrument's series in seconds from ignition.
- **A heat release rate curve on the burner** (format 1.7.0). The burner's **Curve**
  control makes one from t² growth (slow to ultra-fast, peak, hold, decay), a table
  pasted from a spreadsheet, or a measured HRR series; an FDS `RAMP_Q` or `TAU_Q` is
  kept on import. Checks still judge the peak. A **fire clock** plays the predicted
  cone through the curve even without a reconstructed flame, and the planned value in
  the instrument plots becomes a curve. In Python, `burner.hrr_at(t)` and
  `heat_flux_estimate(g, t=...)`.
- **Velocity probes, gas sampling points and load cells** (format 1.7.0), with gauge
  kinds for plate thermometers and thin-skin calorimeters: in the palette, the
  inspector, the drawings, the schedule and as test-data targets; checks for a probe
  that is not in an opening and a load cell with no fuel above it. FDS velocity and
  gas-fraction devices import as these and export back.
- **Line of sight.** Walls (with their doors and windows), ceilings, obstructions and
  hood skirts now block a view. A heat flux gauge's predicted flux is scaled by how
  much of the flame it can see, with a check when it sees none or only part; a
  camera's coverage shows how much of the flame it frames is unobstructed, and a
  check names what is in the way.
- Camera presets: the FLIR A700 gains a lens choice like the A8303sc's (6°, 14°, 24°,
  42° and 80°, at the focal lengths FLIR prints), and there are new presets for the
  FLIR K65, the FLIR ONE Pro, a Canon VIXIA HF R50 at its optical wide end and the
  iPhone X's rear wide camera in 1080p. `docs/datasheets/README.md` maps each to its source,
  including where a printed focal length and a printed field of view disagree.
- **As built and the next test** (format 1.7.0). **Record as built** stores where an
  object was actually set up beside its planned position and reports the offset; the
  **As built** toggle shows surveyed positions as ghosts; the drawing adds a
  planned-against-measured table for sign-off. **Next test…** saves a copy for the
  next test of a series with the same rig and none of the previous test's data. In
  Python, `cam.extrinsics(pose="best")` uses the surveyed pose and `cam.pose_used()`
  says which one it took.
- **A French interface** (draft Canadian French): **EN | FR** in the toolbar switches
  the editor, check messages and the printed drawing, with decimal commas in French.
  The choice is a per-user setting, never part of a plan, and every file the tool
  writes is unchanged. `docs/french-review.md` lists the terms for a francophone
  engineer to confirm; that review waits for feedback from French-speaking users.
- **Accessibility.** The editor and every dialog pass automated WCAG 2.1 AA checks
  (axe-core) in both languages. Dialogs take keyboard focus and give it back, the
  object list and the checks work from the keyboard, status messages are announced
  to screen readers, and Windows contrast themes keep selected and pressed states
  visible without relying on colour.

### Changed
- **Import FDS…**, **Export to FDS…** and **FDS results…** are now in an **FDS** menu
  in the toolbar, which fits in two rows on a laptop screen in English and French.
- The palette shows two columns of tiles with the icon beside the label, so no word
  is split and every instrument is in view without scrolling.
- Export to FDS treats a gauge on a wall, ceiling or obstruction as a surface gauge
  (`GAUGE HEAT FLUX` with the face's `IOR`) when it faces within 45° of the face's
  normal, and notes in the file when it is tilted more than 5°. Two wall gauges aimed
  a few degrees toward the fire used to export as different quantities.
- The editor's left rail keeps **Checks** on screen on a laptop (1280 × 720): the
  palette, the object list and the checks share the height and each scrolls its own
  contents. **From FDS** and the help for adding a camera preset fold away until
  needed.
- Hints, check codes and other faint text are lighter, and now meet the WCAG AA
  contrast ratio on every panel background.
- The FLIR A700 24° preset stores the 18 mm focal length FLIR prints for that lens
  instead of 18.07 mm back-solved from the angle, so it now frames 24.1° × 18.2°.
  Cameras already in a plan keep their own stored focal length.
- The desktop app is built with Python 3.14 instead of 3.9, which no longer gets
  security fixes, with pythonnet 3.2 for its window. `build.bat` makes its venv from
  Python 3.11 or later (`FIREPLAN_PYTHON`, else `py -3.14`, else `python`) and stops
  with a message when it finds an older one. The build now fails when the exe lacks a
  DLL that its own binaries load, and the exe no longer carries the packager's own
  modules (PyInstaller, setuptools). CI tests the Python package on 3.9 and 3.14.

### Fixed
- **Print / Save as PDF** in the drawing preview printed only the first page of the
  drawing. It now prints every page, on white margins.
- Optional numbers left unset (a load cell's capacity, a gauge's or probe's range)
  show an empty field instead of 0.
- The drawing's north arrow no longer overlaps objects placed at the plan's far
  top-right corner.
- `THIRD_PARTY_NOTICES.md` also covers the native libraries inside the exe (OpenSSL,
  libffi, zlib, bzip2, XZ, Zstandard, Expat, libmpdec and the Microsoft C runtime),
  which the 0.7.0 notices left out.

## [0.7.0] - 2026-10-18

The first public release.

### Added
- Lens choice for the FLIR A8303sc: the palette lists the camera once, and its **Lens**
  field switches between the four lenses on the datasheet (17, 25, 50 and 100 mm),
  keeping position, aim and zoom. A **Lens comparison** under Coverage shows each lens
  fitted where the camera stands: field of view, mm/px at the fire, and how much of the
  flame envelope stays in frame.
- The drawing prints the lens in the equipment list and beside the camera in every view.
  Labels that would collide move up their stack until they clear.

### Changed
- The bundled example data is now synthetic or written for this repository: a modelled
  80 kW flame for the Example's playback, a public ISO 9705 style room corner case for
  FDS import and results playback, and a synthetic example video. The test data the
  tool was developed against stays private.
- Manufacturer datasheets are referenced by link and checksum instead of being bundled.
- The schema `$id`s point at this repository.
- MIT license, continuous integration, and this changelog.

## [0.6.0] - 2026-09-22

### Added
- **FDS results**: a separate workspace that plays back the output of a completed FDS
  simulation from its `.smv` file, reading frames on demand so multi-gigabyte runs
  open. Temperature and velocity slices, wall temperature and heat flux maps, Smoke3D
  previews, device and HRR histories, with play, step, scrub, speed, mesh selection,
  fixed colour scales, a cutaway and a labelled PNG snapshot.
- Simulation probes as overlays: type filters, labels, recorded direction arrows, a
  chooser for overlapping positions, and the probe's history on selection.
- One visual language for the editor, results, plots and drawings (shared colours,
  device identities and transport controls), documented in `docs/visual-language.md`
  with a checklist for new features, and a browser regression runner.

### Fixed
- A whole-repository review and a cross-check fixed findings across both engines, the
  desktop shell and the docs, among them: a prompt before closing the window over
  unsaved changes, atomic settings writes, format parity of number rounding, `&MULT`
  and `&CATF` read as FDS reads them, and inspector focus handling.

## [0.5.0] - 2026-09-20

Plan format 1.4.0.

### Added
- **Reconstructed flame playback**: a `reconstructedFlame` object links a folder of
  visual-hull frames (one `t_<seconds>s.npz` per timestep) and plays it inside the
  layout, under the hood and inside the frustums of the cameras, with the predicted
  Heskestad cone for comparison. A playback bar, a shared clock for the flame, the
  burner's volume plot and the camera preview, and placement checks for a hull that
  sits below the floor or away from its burner.
- A packed, engine-identical frame codec; **Share…** embeds the frames in the exported
  page. The Example plays a flame out of the box.
- `Plan.flame_sequence()` in the Python reader.

### Fixed
- The findings of the flame playback review (17), among them stale playback after
  removing a link, Share mixing two plans, and keyboard shortcuts from the playback bar.

## [0.4.0] - 2026-09-05

Plan format 1.3.0.

### Added
- **Linked files**: cameras link videos; burners, heat flux gauges and thermocouple
  rakes link spreadsheets. The desktop app opens them, shows them in their folder and
  relinks them; Save As keeps relative links working.
- A burner CSV with volume and surface area columns gives two aligned plots in the
  viewport, with a sample slider; the snapshot travels inside the plan and shared pages.

### Fixed
- The 23 findings of the September review in both engines: document identity for Save,
  per-burner assessment, world-space heights, FDS floor and vent rules, and more.
- Linked-file review findings across save, import and plotting.

## [0.3.0] - 2026-08-29

Plan format 1.2.0.

### Added
- **Import FDS…**: builds a plan from a `.fds` input (walls, ceilings, boxes, the
  burner and its heat release, doorways from `&HOLE`, and the `&DEVC`s that are real
  instruments), with a preview of what it will make and skip. Split inputs joined by
  `&CATF` import whole in the desktop app.
- The `obstruction` object, an inspector **Fields / FDS** switch that shows and accepts
  geometry in the source file's coordinates, and **From FDS** for pasting one record.
- `Plan.from_fds()` and a Fortran namelist reader in Python.

### Fixed
- Both FDS review passes: Save could overwrite the open plan after an import, comment
  and record-boundary rules of the namelist reader, burner selection, and `&MULT`.

## [0.2.0] - 2026-08-22

Plan format 1.1.0.

### Added
- Camera zoom, stored beside the lens.
- **Heat flux gauges** and **thermocouples** (one bead or a rake), checked against the
  fire they face: predicted incident flux, plume centreline temperature per bead, and
  warnings for a gauge that over-ranges, one lost in its noise, one in the near field.
- FLIR A8303sc and A700 presets from their datasheets; user presets that persist.
- Format versioning: a writer declares the lowest version its contents need.

### Fixed
- The 23 findings of the 1.1 review, among them one placement verdict shared by checks,
  inspector and report.

## [0.1.0] - 2026-08-16

Plan format 1.0.0.

### Added
- The `.ftp.json` plan format: a versioned JSON Schema, frame and unit conventions, and
  a canonical writer that the Python reader and the editor reproduce byte for byte.
- `fireplan`, the Python reader: intrinsics and extrinsics in the OpenCV frame,
  Heskestad correlations, hood and framing checks, nerfstudio export.
- The 3D editor: plan and orbit views, cameras with real frustums and a
  picture-in-picture preview, coverage checks, ceilings, front and side elevations, a
  measure tool, Share as one self-contained HTML file, and a dimensioned drawing with
  an equipment list and coverage table.
- The desktop app: the same bundle in a native window (pywebview, WebView2), native
  file dialogs and recent files, packaged as one exe.

[0.9.0]: https://github.com/infinitr0us/FireTestPlanner/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/infinitr0us/FireTestPlanner/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/infinitr0us/FireTestPlanner/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/infinitr0us/FireTestPlanner/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/infinitr0us/FireTestPlanner/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/infinitr0us/FireTestPlanner/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/infinitr0us/FireTestPlanner/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/infinitr0us/FireTestPlanner/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/infinitr0us/FireTestPlanner/releases/tag/v0.1.0
