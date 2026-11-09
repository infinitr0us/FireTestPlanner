# Flame analysis board: design

Status: **phases 0 to 3 done** (2026-11-08). Phases 0 and 1: format 1.0 with its
schemas and `fireplan.flame_analysis` (CONVENTIONS section 13), the synthetic test, the
first delivery converted, and the board itself (`ui/flame-analysis*.ts`,
`scene/flame-analysis.ts`, the shell's `/api/flame-analysis/*` routes). Phase 2: video
and PNG export (`ui/flame-analysis-video.ts`, `core/mp4.ts`, `/api/save-media`).
Phase 3: event format 1.1 (meshes and the hood's response time), the hull check, the
hood's view of the estimates, heat released, the Heskestad height and the smoothed
surface.

A read-only workspace that walks a fire safety engineer through one processed fire
event recorded by two to four ordinary video cameras: the synchronised camera frames,
the flame found in each view, the 3-D flame rebuilt from those views inside the test
site, the flame volume and surface area over time, and heat release rate estimates
beside the hood measurement. The engineer needs no background in image processing or
in the pipeline that produced the data.

## 1. Decisions (review of 2026-11-08)

| Question | Answer |
|---|---|
| Live or after the test? | After the test: a review of a processed event, from files delivered by the analysis pipeline |
| How is it opened? | Mainly the desktop exe, reading the data from disk. A browser tab with a folder picker works too (it is how the browser regressions run) |
| Slides? | **Export video** writes an MP4 that PowerPoint plays; default full board, 1920 x 1080, 30 frames per second, real time, with ×0.5 and ×0.25 |
| HRR estimates | Delivered as series; the board plots them and never computes them. How they are made is the team's own work: the board says only what the analysis folder says about them |
| Hood | The reference is the hood's **convective** heat release rate |
| Cameras and events | Two to four cameras (designed for one to eight). A selector switches between the events of a test |
| Data preparation | In this repository: a converter turns a delivery into what the board reads |
| Publication | Code and synthetic data on `main` (public). Deliveries, the converter for the pipeline's output and the explanatory text stay in the ignored `local/` |
| Test data | The first delivery (one event, four cameras) and a synthetic test with two events |

## 2. Where it lives

A **workspace in the same app**, like the FDS results viewer: opened from the toolbar
(**Flame analysis…**), it fills the window, owns its scene, clock and file session,
and returns to the plan on **Back to plan**. It never changes, dirties or saves the
plan that is open in the editor.

Why not a separate tool: the board's 3-D view is the planner's site scene (objects,
calibrated cameras and their frustums, the camera projection, the voxel flame
renderer), and its playback, plots, units, French and accessibility rules already
exist here. A second codebase would copy them and drift. Why not inside the editor:
the palette, inspector and checks are for planning, and this audience needs a fixed
layout with nothing to edit.

## 3. What is public and what is not

The repository is public, and the analysis pipeline's methods stay within the team
until the team decides otherwise. So the board is a viewer of a documented format and
knows nothing about how the data were made:

| Public (this repository) | Internal (`local/`, never committed) |
|---|---|
| The board, the format (section 5), its schemas and readers | Deliveries: frames, masks, hulls, series, workbooks |
| A synthetic test (section 8) with its own illustrative text | The converter for the pipeline's own output (`local/flame-analysis/tools/`) |
| One-line generic step titles, used when a folder has no text | The explanatory text and method descriptions, held in each test's `analysis.json` |

Anything an engineer reads about the method on the board comes from the analysis
folder, so it travels with the data to the people the data are shared with and nowhere
else. The board needs no coefficient, threshold or recipe of the pipeline.

## 4. The analysis folder

```
<test>/
  analysis.json        test manifest: title, site plan, cameras, time base, step texts, events
  site.ftp.json        the site as a FireTestPlanner plan: geometry and calibrated cameras
  test-data/           whole-test records (the hood and other sensors), for reference
  <event>/             one folder per event, as delivered, plus:
    event.json         event manifest
    board/             written by the converter; safe to delete and rebuild
      frames/<cam>/    display copies of the frames, 960 px on the long side
      closeup/<cam>/   the region around the flame, cut from the full-resolution frames
      outlines/<cam>.json   the flame masks as outlines, every instant
      hull/            the 3-D flame per instant in the tool's voxel format, plan frame
      mesh/            its smoothed surface per instant (event format 1.1), plan frame
      series/          series the delivery did not hold in the format's CSV shape
```

A delivery keeps its own layout: `event.json` names the files the board reads, wherever
they are. Large leftovers the board does not need (overlay pictures, clips, renders)
can be deleted once the board shows the same thing.

## 5. Format 1.0

Two JSON manifests and the data files they name. JSON is UTF-8 with an optional BOM;
invalid UTF-8 and non-finite numbers, including `NaN` and infinities, are refused.
Paths are validated before normalization: `/`-separated, nonempty segments, none `.`
or `..`, no control characters (U+0000 to U+001F, U+007F), backslash, colon, drive or
absolute path, and no resolution outside the analysis folder. Braces are forbidden
outside templates; templates permit only the specified `{cam}` and `{stem}` fields.
Text shown to people is a *localised text*: a string, or `{"en": "...", "fr": "..."}`
with English required.

**`analysis.json`** (`"format": "fireplan-flame-analysis"`, `"version": "1.0.0"`)

| Field | Content |
|---|---|
| `title`, `date` | The test; the date is optional (`YYYY-MM-DD`) |
| `sitePlan` | The site plan file |
| `timeBase` | `label` (for example `t_clock`) and an optional `description`: the clock every file of the test uses |
| `cameras` | 1 to 8 of `{id, planCameraId, label?}`: an id used in file names, the camera object in the site plan, a display name (the plan's name when absent) |
| `steps` | Optional. Per step id (`cameras`, `frames`, `segmentation`, `reconstruction`, `size`, `hrr`, `limitations`): `{title?, text, watchFor?}`, all localised |
| `events` | 1 or more of `{id, label, path}`: the event's manifest |

**`event.json`** (`"format": "fireplan-flame-event"`, `"version": "1.0.0"`)

| Field | Content |
|---|---|
| `id`, `label` | As listed in `analysis.json` |
| `onset_s` | The onset on the time base. The board shows time from the onset first, negative before it |
| `cameras` | The event's camera ids, in display order (2 to 4 in practice) |
| `instants` | `{t_s: [...], stem: [...]}`: the instants with pictures and a hull, finite and strictly increasing, and a unique file stem for each |
| `files` | Path templates with `{cam}` and `{stem}`: `display` (required), `frame` (full resolution, optional), `closeup` (optional), `outlines` (per camera), `hull` (per instant) |
| `images` | Per camera `{size_px, display_px, closeup?}`: the full-resolution size, which must equal the plan camera's resolution for the hull to be drawn over the picture; the display size; and an optional close-up, a fixed rectangle of the full-resolution picture around the flame over the whole event, with the size of its copies. In a wide view the flame can be a few dozen pixels of a display copy, so the close-up is cut from the full-resolution frames |
| `hull` | `{voxelSize_m, frame: "plan"}` |
| `series` | `{id, label, role, quantity, unit, file, time, value, basis?, note?}`. `role`: `measured`, `reconstructed` or `estimated`. `quantity` and `unit`: `hrr` kW, `volume` m3, `area` m2, `height` m. `basis` (heat release rate only): `convective` or `total` |
| `quality` | Optional instant indices: `noHull` (a flame is seen but the hull is empty) and `outsideFrame` per camera (the flame reaches the picture's edge) |
| `keyMoments` | Optional `{t_s, label}` |
| `notes` | Optional localised text per step id, for this event only |

Event version **1.1.0** (phase 3) adds two optional fields: `files.mesh`, a template
with `{stem}` naming a smoothed surface of the 3-D flame per instant, and
`responseTime_s` on the measured heat release rate. CONVENTIONS section 13 has the
mesh file's exact layout.

**Series CSV**: UTF-8 with optional BOM, comma separated, one header row and at least
one data row (otherwise "no samples"). CRLF, LF and CR endings are accepted; only
completely empty lines are skipped, and errors name physical line numbers. The
finite decimal grammar, quoting with whitespace outside quotes and strict quote
errors are defined in CONVENTIONS section 13; underscores, non-ASCII digits, hex,
`inf` and `nan` are refused. An empty value breaks the line; an empty time is an
error. `time` and `value` name columns, so a file can serve several series. Times
are on the test's time base. Series ids are unique within each event.

**Outlines** (`fireplan-flame-outlines` 1.0.0): `{camera, size_px, outlines}`, where
`outlines` holds, for every instant, a list of closed rings, each a flat
`[x0, y0, x1, y1, ...]` in full-resolution pixel coordinates (x right, y down, the
pixel centre at integer coordinates, as in `Camera.project`). Filled even-odd, so a
ring inside another is a hole. Its `size_px` must equal `images.<cam>.size_px`;
otherwise loading fails.

**Hull**: the format of [flame playback](flame-playback.md), one NPZ per instant
(`voxels` M x 3 in metres, plan frame; `voxel_size`). Time comes from `instants`, not
from the file name, so instants before the onset are allowed. Each stored
`voxel_size` must equal `hull.voxelSize_m` with relative tolerance 1e-9 and zero
absolute tolerance, including empty hulls. A mismatch is an error.

Validation (`fireplan.flame_analysis`, and the board when it reads): the schemas;
unique ids (including series ids within an event); event id matching its analysis
entry; every event camera listed in `analysis.json` and in the site plan; `images`
keys equal to event cameras; finite, strictly increasing instants; templates
resolving inside the folder; one outline list per instant with matching picture
size; series columns present and numeric, with nonnegative volume and area.
`files.closeup` and every camera's close-up rectangle must be present together,
and each rectangle must stay inside its full-resolution picture. Quality indices
must be within the instants and quality cameras must belong to the event. A folder
that fails says what failed, and nothing is half shown.

## 6. The board

Target 1920 x 1080; everything stays usable at 1280 x 720.

```
┌ ‹ Back to plan   Test title   Event: [Event ▾]            t = +1.5 s from onset (t_clock 101.5 s)   ┐
│ ① Cameras ─► ② Synchronised frames ─► ③ Flame in each view ─► ④ 3-D flame ─► ⑤ Size ─► ⑥ HRR  ⓘ │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Hood peak · kW at t   │ Heat released · MJ   │ Estimate vs hood: peak, energy │ Flame: max L, m  │
├──────────────────────────────────────────────┬───────────────────────────────────────────────────┤
│ [cam1] [cam2] [cam3] [cam4]                  │ Convective HRR (kW): hood, estimates              │
│ Show: Photo | Flame outline | Hull check     │ ──────────────────|───────────                    │
├──────────────────────────────────────────────┤ Flame volume (L) and surface area (m²)            │
│ 3-D: [Whole site | Flame close-up]           │ ──────────────────|───────────                    │
│ site objects, camera cones, hull at t,       │ Flame height (m)                                  │
│ height scale                                 │ ──────────────────|───────────                    │
│                                              │ quality ▮▮ no hull ▮ flame at a picture's edge    │
├──────────────────────────────────────────────┴───────────────────────────────────────────────────┤
│ ⏮ ◀ ▶ ▶| ⏭ ───────────●──────────────── ×1 Loop  Key moments: …                                 │
│                                                                    [Export video…] [PNG]           │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Step bar.** The six steps in order. Clicking one opens its text from
  `analysis.json` (with the event's `notes`) in a side drawer and outlines the panel it
  concerns. Without text the drawer shows the generic title only. ⓘ opens the
  limitations.
- **Key numbers.** Computed by the board from the series, each defined in its tooltip:
  hood peak and its time; heat released (hood and each estimate, over the instants);
  the estimates' peak and heat released relative to the hood; the largest
  one-second-mean volume and the tallest flame.
- **Cameras.** One tile per camera, aspect preserved (portrait and landscape mixed),
  showing the close-up by default and the whole picture on request.
  **Photo**; **Flame outline** (outline and light tint); **Hull check** (the hull at
  that instant drawn through the camera's calibrated projection over the picture).
  Clicking a tile shows it full size at full resolution.
- **3-D.** The site plan's objects and cameras with their frustums, and the hull at the
  playback time. **Whole site** and **Flame close-up** are two views of one scene. (As
  built, the Heskestad height is a line on the height plot instead: see phase 3.)
- **Plots.** One time axis and one cursor. Heat release rate: measured solid
  (`--plot-primary`), estimated in a new dash family, labelled, with the basis in the
  axis title. Volume and area: 10 Hz thin, one-second mean thick. Flame height. A
  quality strip under the axis, and the key moments on every plot.
- **Playback.** The shared transport, keys and Loop, with speeds below real time
  (×0.25, ×0.5) added to the shared `SPEEDS` or kept as a recorded exception.
- **Units.** Volume in litres (ft³ in imperial), area m² (ft²), heights in the plan's
  length unit, heat release rate kW, heat MJ.

## 7. Export video

- **Composition.** A fixed 16:9 layout drawn for video, not a capture of the window:
  title and event, the time from the onset, the camera row, the 3-D view and the plots
  with a moving cursor, in the interface language. Choices: **Full board**,
  **Cameras and 3-D**, **3-D and plots**; 1920 x 1080 or 1280 x 720; the whole event or
  between two key moments; real time, ×0.5 or ×0.25 (each instant is held, never
  interpolated); the 3-D camera as it is on screen.
- **How.** Frame by frame, off the clock: set the time, wait for the pictures, render
  the 3-D view at the output size, draw cameras, outlines, plots and captions onto one
  canvas, encode with the browser engine's `VideoEncoder` (H.264), write the MP4
  container. Progress and Cancel; desktop saves through a native dialog, a browser
  downloads. No ffmpeg is bundled.
- **First, a spike** in the built exe: H.264 encoding in WebView2 on an engineer's
  laptop. Fallback: a numbered PNG sequence, turned into MP4 by ffmpeg when it is on
  the PATH.
- **PNG** saves the same composition at the current time.

## 8. Test data

- **Synthetic test** (`tools/build_synthetic_flame_event.py`, NumPy and the standard
  library only, deterministic): a small site with three calibrated cameras (one
  portrait), two events (three cameras and two cameras), pictures rendered from a
  seeded flame, masks from the same projection, a visual hull carved from those masks,
  volume, area and height, a lagged synthetic hood and illustrative estimates with
  made-up coefficients. Small enough to commit; its text says it is synthetic.
- **First delivery** (internal): one event of a battery vent jet test, four cameras,
  581 instants at 10 per second, converted by the internal converter (display copies
  141 MB, close-ups 106 MB, outlines 3 MB, hull 15 MB, beside the 2.9 GB delivery).
  Checks: every hull voxel projects inside every camera's mask through the
  site plan's cameras (three instants, all four cameras), so the site plan's cameras
  are the reconstruction's; the converted hull equals the pipeline's own plan-frame
  voxels; outlines and hull drawn over the display copies and close-ups line up in
  every view; the quality flags agree with the delivery's own notes. Its estimate file
  had two columns shifted by one when copied; corrected from the reconstruction's own
  metrics.

## 9. Phases

| Phase | Contents |
|---|---|
| 0 | Format 1.0, schemas and `fireplan.flame_analysis`; the converter and the first delivery prepared; the synthetic test |
| 1 | The board: event selector, camera tiles (Photo, Flame outline), 3-D site and hull, plots and quality strip, key numbers, step bar and drawer, playback with the slow speeds, EN and FR |
| 2 | Export video and PNG, after the encoder spike |
| 3 | Hull check, "as the hood sees it" (estimates through the hood's response time), the Heskestad height beside the hull's, cumulative heat released, smooth meshes in the close-up |

Each phase follows the visual-language checklist and ends with the browser checks on
the synthetic test and a desktop check on the first delivery.

**Phase 1 as built.** The layout is section 6's, with four plots rather than three
(heat release rate, volume, surface area, flame height: one quantity per axis reads
better than two axes on one plot). The board opens on the instant of the largest
one-second-mean flame, so the first view shows a flame; Home goes to the first
instant. Pictures open as close-ups when the folder has them. Only the cameras and the
fire are labelled in 3-D, and the flame close-up frames the flame's usual extent (the
10th to 90th percentile of each instant's box), so a brief fireball does not shrink
it. The browser regressions run on the synthetic test (`browser-tests/flame-analysis.*`
and two phases of `run.mjs`, one in French at 1280 x 720, plus two axe scans); the
first delivery was checked by eye in a browser tab, with every instant's 3-D flame
read in under two seconds from a local disk.

**Phase 2 as built.** The spike ran the same probe in WebView2 155 (the desktop app's
runtime), Chrome and Edge: each encodes 1920 x 1080 H.264 High profile, 30 frames in
about 250 ms, with byte-identical output, so the encoder is the engine's own software
one and needs nothing on the laptop. The export draws a fixed 16:9 composition on a
canvas (header with the time from the onset and the key moment just passed; the
cameras as the board shows them; the 3-D view rendered by a second renderer at the
output size from the board's camera; the plots redrawn on canvas), hands each frame to
`VideoEncoder`, and `core/mp4.ts` writes the MP4 with its index first. On the first
delivery a 9.5 s 1080p clip took about 20 s to make; the desktop app saves through a
native dialog (`/api/save-media`, the raw bytes rather than base64), a browser downloads.
The planned PNG-sequence fallback was not needed and is not built: an engine without
H.264 encoding says so.

**Phase 3 as built.** Two of the five items needed data the format did not carry, so
event format 1.1 adds two optional fields (CONVENTIONS section 13): `files.mesh`, a
smoothed surface of the 3-D flame per instant as a small binary PLY in the plan frame,
and `responseTime_s` on the measured heat release rate. A 1.0 event still opens, and
the board leaves out what it cannot show for it.

- **Hull check** (camera bar) draws the 3-D flame at the instant through each camera's
  calibrated projection over its picture, one square per cube, and says under each
  tile how much of the flame outline the projection covers. The percentage is
  measured separately from those enlarged display squares, in a mask over the
  outline's bounding box plus a two-pixel margin in full-resolution coordinates.
  Only boxes exceeding about one million pixels are scaled down. Each cube fills
  the axis-aligned rectangle enclosing its eight projected corners, using both
  focal lengths and each corner's own depth; a cube with a corner behind the camera
  is skipped. The outline uses even-odd fill on the same mask. Covered outline
  pixels divided by outline pixels gives the share; antialiased edge pixels carry
  fractional area. There is no enlargement or minimum cube size in this mask.
  Rectangles approximate true, generally hexagonal cube silhouettes and can
  overestimate coverage. The synthetic E1 still reads 100 % in each camera at its
  largest flame; a test camera in which a small cube spans a few pixels tells the two
  methods apart (about 35 % against the former 100 %). The browser regression checks
  both with the real canvas rasterizer. The overlay
  look is unchanged, and both board and export use the same coverage caption.
- **As the hood sees it** (plot bar, 1.1 with a response time) passes the estimates
  through the hood's first-order lag, stepped exactly between samples, and relabels
  them, so the timing of an estimate compares with the hood's rather than with the
  flame's. With Heat released selected, response is applied before integration and
  the response label remains. The hood's own line and all key numbers remain raw.
- **Heat released** switches the heat release rate plot between the rate (kW) and its
  running integral (MJ, zero at the first instant, missing before it). The same
  clipped trapezoids and interpolated boundaries as the key numbers make the final
  raw heat equal its key number. Missing intervals break the curve; accumulation
  resumes after them without adding unknown heat.
- **Heskestad height** adds L = 0.235 Q^0.4 - 1.02 D to the flame height plot, from
  the hood's record and the site plan's fire: D its effective diameter, and a
  convective hood rate divided by 1 minus the fire's radiative fraction to give the
  total Q the correlation is for. It is drawn as a predicted value (the planned-value
  colour and long dash), and a note under the plots says what it assumed and that it
  is a pool-fire correlation of the mean height, beside the 3-D flame's highest point.
  The 3-D view keeps no predicted flame: one comparison, on the plot, reads better.
- **Cubes | Surface** (3-D bar, 1.1 with meshes) draws the flame as its smoothed
  surface, coloured by height like the cubes. An instant's mesh is read when it is
  first shown and the last 40 are kept; playback shows the latest one read, and the
  export waits for each through one load path. Replacing the surface loader clears
  the shown surface and advances its generation; obsolete completions are disposed
  and cannot replace the current event's geometry. Failed entries leave the cache,
  hide the old surface and name the instant and file in the board's load status;
  export propagates that failure once. The synthetic
  generator makes its meshes from the hull itself (surface nets on a coarsened grid);
  the internal converter takes the pipeline's own meshes, which line up with its hull.

**After the review of 2026-11-09.** A heat total carries the share of the window
its samples cover: none is a dash, and less than 99.5 % is marked partial with the
covered share. Both peak and heat percentages require at least 99.5 % coverage on both series and the same
explicit basis. A different or unstated basis instead gets a short explanation on
the estimate's card. Mixed bases are named per legend label; delivered series notes
are tooltips on the labels and cards. Held camera pictures retain their drawn time
and edge flag, with a visible loading marker until the requested picture is drawn.
Changing picture mode invalidates pending pictures from the old mode. Full-size
pictures return focus to their opening tile. View and look buttons have independent
pressed states, and full workspace disposal also disconnects the plots.

The export panel makes the board inert and contains focus. During encoding
only Cancel is enabled, including Escape. A single operation owns the composition;
changing events, closing the board or changing language aborts it and awaits its
completion. Cancellation is checked after drawing, after flush and before returning
bytes, and an obsolete operation cannot start a save. PNG and video restore the
live scene to the board's current instant in their completion path. A missing
picture is explicitly labelled in its tile, and decoded export pictures remain
owned by the composer until the whole draw finishes. Quality bands retain the
board's text keys and tokens, and hull check retains each camera's coverage caption
with space reserved at 720p and 1080p. The header selects the greatest key-moment
time at or before the frame, inside the event and the existing 1.5 s label window,
irrespective of file order.

Output frame k has timestamp k/30 s. The count is
`round((to - from) / speed * 30) + 1`; its source time is
`from + k / 30 * speed`, with the last frame exactly at `to`. Instant lookup allows
1e-6 s floating-point error. Encoded chunks must arrive in presentation order;
reordered output fails with an explanation instead of being sorted into an invalid
MP4. The inclusive endpoint frame remains part of the video duration.

## 10. Conventions this will touch

- Shared sources it reuses: `ui/transport.ts` and `state/playhead.ts` (speeds),
  `ui/plot-svg.ts` and the `--plot-*` tokens, `core/plan.ts` modality colours,
  `scene/camera-model.ts` (calibrated projection, off-centre principal point),
  `scene/flame.ts`, `io/flame-sources.ts` (NPZ), `ui/i18n.ts`.
- New shared meanings, added at their source: an *estimated* series role beside
  measured and simulated (its dash family), the quality-strip shading, slower speeds.
- CONVENTIONS gains a section for format 1.0 when phase 0 lands (section 13), and
  event format 1.1 joins it in phase 3.
- A kept exception may be needed for the video composition's fixed layout.

## 11. Open questions

1. A delivery must state the basis of each heat release rate if it is to be compared
   with the hood in percent. The board does not infer or convert an unstated basis;
   it names mixed bases and explains why no percentage is shown.
