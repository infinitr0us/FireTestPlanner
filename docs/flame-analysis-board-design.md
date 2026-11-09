# Flame analysis board: design

Status: **phases 0 and 1 done** (2026-11-08): format 1.0 with its schemas and
`fireplan.flame_analysis` (CONVENTIONS section 13), the synthetic test, the first
delivery converted, and the board itself (`ui/flame-analysis*.ts`,
`scene/flame-analysis.ts`, the shell's `/api/flame-analysis/*` routes). Video export
(phase 2) is next.

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
      series/          series the delivery did not hold in the format's CSV shape
```

A delivery keeps its own layout: `event.json` names the files the board reads, wherever
they are. Large leftovers the board does not need (overlay pictures, clips, renders)
can be deleted once the board shows the same thing.

## 5. Format 1.0

Two JSON manifests and two kinds of data file. Paths are relative to the manifest that
names them, use `/`, and may not leave the analysis folder. Text shown to people is a
*localised text*: a string, or `{"en": "...", "fr": "..."}` with English required.

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
| `instants` | `{t_s: [...], stem: [...]}`: the instants with pictures and a hull, strictly increasing, and a file stem for each |
| `files` | Path templates with `{cam}` and `{stem}`: `display` (required), `frame` (full resolution, optional), `closeup` (optional), `outlines` (per camera), `hull` (per instant) |
| `images` | Per camera `{size_px, display_px, closeup?}`: the full-resolution size, which must equal the plan camera's resolution for the hull to be drawn over the picture; the display size; and an optional close-up, a fixed rectangle of the full-resolution picture around the flame over the whole event, with the size of its copies. In a wide view the flame can be a few dozen pixels of a display copy, so the close-up is cut from the full-resolution frames |
| `hull` | `{voxelSize_m, frame: "plan"}` |
| `series` | `{id, label, role, quantity, unit, file, time, value, basis?, note?}`. `role`: `measured`, `reconstructed` or `estimated`. `quantity` and `unit`: `hrr` kW, `volume` m3, `area` m2, `height` m. `basis` (heat release rate only): `convective` or `total` |
| `quality` | Optional instant indices: `noHull` (a flame is seen but the hull is empty) and `outsideFrame` per camera (the flame reaches the picture's edge) |
| `keyMoments` | Optional `{t_s, label}` |
| `notes` | Optional localised text per step id, for this event only |

**Series CSV**: UTF-8, comma separated, one header row, then numbers; an empty cell is
a missing value and breaks the line. `time` and `value` name columns, so a file can
serve several series. Times are on the test's time base.

**Outlines** (`fireplan-flame-outlines` 1.0.0): `{camera, size_px, outlines}`, where
`outlines` holds, for every instant, a list of closed rings, each a flat
`[x0, y0, x1, y1, ...]` in full-resolution pixel coordinates (x right, y down, the
pixel centre at integer coordinates, as in `Camera.project`). Filled even-odd, so a
ring inside another is a hole.

**Hull**: the format of [flame playback](flame-playback.md), one NPZ per instant
(`voxels` M x 3 in metres, plan frame; `voxel_size`). Time comes from `instants`, not
from the file name, so instants before the onset are allowed.

Validation (`fireplan.flame_analysis`, and the board when it reads): the schemas;
unique ids; every event camera listed in `analysis.json` and in the site plan; times
strictly increasing; templates resolving inside the folder; one outline list per
instant; series columns present and numeric. A folder that fails says what failed, and
nothing is half shown.

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
  playback time. **Whole site** and **Flame close-up** are two views of one scene; the
  predicted (Heskestad) flame is off by default.
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

## 10. Conventions this will touch

- Shared sources it reuses: `ui/transport.ts` and `state/playhead.ts` (speeds),
  `ui/plot-svg.ts` and the `--plot-*` tokens, `core/plan.ts` modality colours,
  `scene/camera-model.ts` (calibrated projection, off-centre principal point),
  `scene/flame.ts`, `io/flame-sources.ts` (NPZ), `ui/i18n.ts`.
- New shared meanings, added at their source: an *estimated* series role beside
  measured and simulated (its dash family), the quality-strip shading, slower speeds.
- CONVENTIONS gains a section for format 1.0 when phase 0 lands.
- A kept exception may be needed for the video composition's fixed layout.

## 11. Open questions

1. Are the estimates convective heat release rates too (the earlier tests compared
   against the same kind of hood value)? The plot puts them on one axis titled by the
   basis, so a mixed basis has to be said.
