# Changelog

All notable changes to FireTestPlanner. Versions follow [Semantic Versioning](https://semver.org/);
while the version is 0.x, a minor release may change behaviour. The plan file format
has its own version (`fire-test-plan` 1.0.0 to 1.6.0, one JSON Schema each in `schema/`),
and a plan written by any release opens in every later one.

## [Unreleased]

Plan formats 1.5.0 and 1.6.0.

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
- Measured test data, first parts: readers for logger workbooks (`.xlsx`), CSV and FDS
  output with no new dependency, and plan format 1.6.0, in which a plan records which
  column of which file is which gauge, thermocouple bead or burner. In Python,
  `Plan.series(obj)` returns an instrument's series in seconds from ignition. The
  editor's plots follow.
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

### Changed
- The editor's left rail keeps **Checks** on screen on a laptop (1280 × 720): the
  palette, the object list and the checks share the height and each scrolls its own
  contents. **From FDS** and the help for adding a camera preset fold away until
  needed.
- The FLIR A700 24° preset stores the 18 mm focal length FLIR prints for that lens
  instead of 18.07 mm back-solved from the angle, so it now frames 24.1° × 18.2°.
  Cameras already in a plan keep their own stored focal length.

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

[0.7.0]: https://github.com/infinitr0us/FireTestPlanner/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/infinitr0us/FireTestPlanner/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/infinitr0us/FireTestPlanner/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/infinitr0us/FireTestPlanner/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/infinitr0us/FireTestPlanner/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/infinitr0us/FireTestPlanner/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/infinitr0us/FireTestPlanner/releases/tag/v0.1.0
