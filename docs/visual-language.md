# Visual language

**Status: discussion draft.** The recommendations and decisions below have not yet
been adopted. The owner is considering a focused consistency pass while retaining
functional differences between the editor and results viewer. See the
[review assessment](../review/2026-09-21-fds/fix-assessment.md) for qualifications.


What the editor looks like, written down once, so that a new scene, panel or overlay
looks like part of the same tool rather than a second one. This note describes what
the code does today, names the few places it disagrees with itself, and gives the
rule for each. Where the rule is a choice the owner has to make, it is marked
**Decision** and comes with a recommendation.

Scope: the 3D viewport, the side panels and toolbar, floating overlays (playback bar,
reconstruction plot, the FDS results workspace), and the printed drawing and report.
Not in scope: the plan file format, which is CONVENTIONS.md.

The default is the family. A deviation is allowed when it serves the reader — a
results viewer needs probes visible through smoke, a print needs dark ink on white —
and it is then recorded in section 9 with its reason, not left as a surprise in the
code. "Same family" means: same colour for the same physical thing, same accent for
the same interaction, same label, same transport, same typography.

## 1. Two contexts, one set of object colours

| Context | Where | Surface | Ink |
|---|---|---|---|
| Screen | viewport, panels, overlays, dialogs | dark, `--bg #0f172a` | light, `--text #e2e8f0` |
| Print | `web/src/export/drawing.ts`, `export/report.ts` | paper `#eef2f7` / white | ink `#1f2937` |

Object colours are the same in both: a heat flux gauge is `#ef4444` in the 3D view,
in the outliner swatch, in the results overlay and on the printed plan. Everything
that is not an object colour — chrome, accent, status, ramps — has a token per
context.

## 2. Where colours live

There are four token sources. A colour is defined in one of them or it does not exist.

| Source | Holds | Consumers |
|---|---|---|
| `web/src/styles.css` `:root` | chrome: backgrounds, borders, text, accent, status | every panel, control and overlay |
| `web/src/scene/builders.ts` `COLORS` | 3D object and furniture colours | scene builders, flame layer, results scene |
| `web/src/core/plan.ts` `MODALITY_COLORS`, `TYPE_COLORS` | colours that *carry information*: a camera's modality, an instrument's kind, a user's `display.color` | 3D view, outliner, drawing, report, results overlay |
| `web/src/export/drawing.ts` print palette | paper, ink, dimension blue, verdict colours for print | drawing, report |

`TYPE_COLORS` and `COLORS` are kept in step by hand (the comment in `plan.ts` says
so). If that ever becomes a burden, `COLORS` should read the instrument entries from
`TYPE_COLORS` rather than the other way round, because `plan.ts` is the one the
drawing and the outliner already use.

**Rules**
- A module never defines its own colour. It imports a token. A new kind of thing
  gets a new entry in the right table, with a name that says what it is for.
- The same physical thing has the same colour everywhere. If the results window
  draws a thermocouple, it is thermocouple green.
- `display.color` on a plan object overrides its type colour, and is the only
  per-object colour. It is read in one place (`objectColor`), which also sanitises it.

### 2.1 Chrome tokens (screen)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0f172a` | page and scene background |
| `--bg-panel` | `#131c31` | panels, toolbar, floating overlays |
| `--bg-raised` | `#1c2740` | buttons, selects, hover rows |
| `--bg-input` | `#0b1220` | inputs, code blocks |
| `--border` | `#263251` | every 1 px border |
| `--text` | `#e2e8f0` | body text |
| `--text-dim` | `#94a3b8` | labels, section headers |
| `--text-faint` | `#64748b` | hints, codes, disabled |
| `--accent` | `#38bdf8` | the one interaction colour (section 3.1) |
| `--good` / `--warn` / `--bad` | `#34d399` / `#fbbf24` / `#f87171` | verdicts (section 3.2) |
| `--radius` | 6 px | corners |
| `--font` / `--mono` | system sans / system mono | text / codes, paths, values |

Floating overlays today use their own greys (`rgba(20,29,43,.97)`, `#526079`,
`#29374c`, `#dce5f2`, `#a9bbd3` in the playback bar and plot; `#20324a`, `#3b526f`,
`#49617e`, `#edf5ff` in the results dialog). They are all within a shade of the
tokens above and should become them: overlay surface = `--bg-panel` at 97 %, border
= `--border`, button = `--bg-raised`, text = `--text`, secondary = `--text-dim`.

### 2.2 Object colours

| Object | `COLORS` | Note |
|---|---|---|
| burner pan | `pan #475569` | |
| flame (proxy, solid mode) | `flame #f59e0b` | the amber is an *object* colour, not an accent |
| plume envelope | `plume #64748b` | line, 50 % |
| hood | `hood #38bdf8`, `duct #0ea5e9` | shell 28 % translucent |
| wall | `wall #94a3b8` | opaque |
| ceiling | `ceiling #cbd5e1` | 32 % translucent, edge lines |
| obstruction | `obstruction #78716c` | opaque, edge lines at 0.55× |
| camera body | `cameraBody #334155` | lens and frustum in the modality colour |
| heat flux gauge | `heatFlux #ef4444` = `TYPE_COLORS.heatFluxSensor` | sensing face, sight line, label border |
| thermocouple | `thermocouple #10b981` = `TYPE_COLORS.thermocouple` | beads, label border; surface-temperature probes are thermocouples too |
| instrument body | `instrumentBody #334155` | barrels, rods |
| camera by modality | `MODALITY_COLORS`: RGB `#3b82f6`, LWIR `#f97316`, MWIR `#a855f7`, SWIR `#14b8a6`, NIR `#eab308`, other `#94a3b8` | |

**Decision D2 — probes in the FDS results window.** Today the overlay has its own
palette (amber, purple, cyan, grey for thermocouple, surface, flux, other).
Recommendation: thermocouple = `TYPE_COLORS.thermocouple` filled circle; surface
temperature = the same green as a hollow diamond (the import treats it as a
thermocouple flagged surface, so the editor already draws it green); heat flux =
`TYPE_COLORS.heatFluxSensor` filled square; any other quantity = `--text-dim` ring.
The kinds and their quantity lists come from `core/fds.ts` (`GAUGE_QUANTITIES`,
`GAS_TC_QUANTITIES`, `SURFACE_TC_QUANTITIES`), not from a second map.

### 2.3 Data colours are not object colours

A ramp colours *values*; it never reuses an object colour to mean something else.

| Data | Ramp | Scale |
|---|---|---|
| reconstructed flame height | blue → yellow → red (`scene/flame.ts` `ramp`) | fixed over the whole sequence |
| FDS scalar fields | rainbow (blue → cyan → green → yellow → red) | fixed over the run from the `.bnd` bounds, or the user's range |
| FDS soot | grey, density by opacity | encoded display data, no unit |
| FDS fire (HRRPUV) | red → yellow | encoded display data, no unit |

**Rules**
- A ramp is fixed over the sequence unless the user rescales it; a small frame is
  not painted full-scale red.
- Every ramp on screen has a legend with its minimum, maximum and unit, using the
  one legend widget (section 7).
- The legend gradient is the shader's ramp, not an approximation of it.

## 3. Meaning

### 3.1 One accent

`--accent` (`#38bdf8`) is the only interaction colour: selection box in the scene,
selected outliner row, focused input border, active toolbar button, hover border on
buttons and tiles, dimension labels, checkbox and slider accent.

**Decision D1.** Three accents exist today: the editor's sky blue, the flame
playback bar's amber slider (`#f59e0b`), and the results dialog's cyan
(`#67e8f9`) for slider, focus ring and selection ring. Recommendation: `--accent`
everywhere. The amber survives as `COLORS.flame`, an object colour; the cyan goes.

### 3.2 Three verdicts

`--good`, `--warn`, `--bad` and `--text-faint` for information. The split is the
one the Checks list, the inspector readouts and the report's verdict column already
share, and the CSS comment says why: amber is a caveat on a number, red is a failed
placement. The playback bar's own `#ffcb87` and `#ff9b9b` are these two tokens.
Print uses darker versions (`#047857`, `#b45309`, `#b91c1c`) for contrast on paper.

### 3.3 Backgrounds carry no meaning

Backgrounds are the tokens. Nothing is tinted to say something about it: a wall is
grey because a wall has no colour that carries information (`hasObjectColor`).

## 4. The scene

- **Background** `--bg`. The results scene's `#101b2c` is the same colour by
  accident; use the token.
- **Furniture** (editor-only, on `LAYER_EDITOR`): grid `0x334155` / `0x1e293b`
  at the display unit's step, floor plane `0x172033`, `AxesHelper(0.6)` at the
  origin. When a scene's origin is not the burner (FDS coordinates), say so in a
  caption; the same axes glyph must not silently mean two different datums.
- **Lighting**: ambient `0xffffff` 1.1, key `0xffffff` 1.6 with shadows from
  `(6, -8, 12)`, fill `0x93c5fd` 0.5 from `(-8, 6, 4)`. Any scene that draws lit
  meshes uses these three; a scene with only unlit surfaces and shaders may have
  none.
- **Solids**: `MeshStandardMaterial`, roughness 0.85–0.9, opaque.
- **Context that must be seen through** (ceiling 0.32, hood shell 0.28, camera
  frustum 0.07, results obstructions 0.10): translucent fill plus `EdgesGeometry`
  lines in the same hue at 0.55×. The results obstructions should take their hue
  from `COLORS.wall` / `COLORS.obstruction` (or the SMV surface colour) rather than
  a private grey.
- **Camera and orbit**: perspective, fov 50, `OrbitControls` with damping 0.12,
  `maxPolarAngle` 0.495 π so the view never goes under the floor, target 1 m up.
  The results scene uses fov 45 and defaults; align it.
- **Labels**: `CSS2DRenderer` pills, `.scene-label`: 11 px, `rgba(9,14,28,.82)`
  background, 1 px border in the object's colour, 4 px radius. Dimension labels are
  mono 10 px in the accent; warnings in `--warn`. Labels never intercept the
  pointer. Known gap: they are DOM, so the editor's PNG snapshot does not contain
  them (section 7).
- **Selection**: `BoxHelper` in the accent plus the gizmo. There is no hover
  state, on purpose.
- **Measure**: `--good` dots and line, `depthTest: false`; a pending point in
  `--warn`.
- **Screen-space glyphs** (the results overlay) are a permitted exception for
  probes in a results viewer: constant 5–7 px symbols anchored to world points,
  visible through fields, with a count badge for coincident points and a click
  chooser. Their colours come from section 2.2, the selection ring is the accent,
  and their labels use the `.scene-label` look (or `CSS2DRenderer` itself).

## 5. Panels and controls

- **Type**: 13 px / 1.45 body; 12 px controls; 11.5 px readouts and field labels;
  11 px hints, notes and label pills; 10 px codes. Section headers are 11 px,
  700, uppercase, 0.07 em tracking, `--text-dim`. Paths, check codes and values
  that are numbers are `--mono`; readouts use `font-variant-numeric: tabular-nums`.
- **Surfaces**: panels `--bg-panel`; buttons and selects `--bg-raised` with a
  `--border` border and `--radius`; inputs `--bg-input`. Hover is an accent
  border, not a fill change. Focus is an accent border on inputs and an accent
  outline elsewhere. A destructive button is `--bad` text.
- **Floating overlays** sit 14 px from the viewport edge, `--bg-panel` at 97 %,
  `--border`, 8 px radius, soft shadow. That is the playback bar today and what
  the reconstruction plot and the results transport should be.
- **Dialogs** (import preview, report, results): full-height modal with the same
  surfaces inside; a header row with the title left and one primary action right.
- **Status lines** in bars and panels: 12 px, `--text-dim`; `--warn` and `--bad`
  colour the text, never the background.

## 6. Time and transport

There is one transport bar, `.playback-bar` (`web/src/ui/playback-bar.ts`),
modelled on Smokeview's time bar:

- glyph buttons ⏮ ◀ ▶ (❚❚ when playing) ▶| ⏭, then the scrubber, the readout,
  speed, Loop, the legend and PNG;
- readout `t = 55.0 s · frame 12/80`, one decimal, seconds first because the
  engineers think in test seconds;
- speed spelled `×10`, from `SPEEDS` `[1, 2, 5, 10, 30, 60]`;
- keys: Space play/pause, `,` and `.` step, Home and End, handled on the window
  and left alone when a form control has focus, except on the scrubber where they
  are the transport's.

**Rule**: every clock-driven view — flame, FDS results, a future video — uses this
bar's markup, CSS and key map, even when it keeps its own clock. The results
transport currently has text buttons, a three-decimal readout, `10×`, no Loop, no
first/last and no working keys; it should become an instance of the bar.

## 7. Legends, plots and snapshots

- **Legend**: one widget — a gradient bar (8–12 px high, 3 px radius) and a line
  `min — max unit` in 12 px tabular figures. `.playback-bar__ramp` and
  `.fds-results__ramp` should be the same class.
- **Plots**: SVG (`ui/reconstruction-plot.ts` is the reference), 10 px system text
  in `#b7c7dc`, gridlines `#405066` at 0.6 px, primary series `#65caff`, secondary
  `#ffbe66`, a dashed `#cbd5e1` cursor and a dot at the current sample. A history
  plot in the results window uses the same helper, not a canvas.
  **Decision D4**: keep the two series colours as they are (they are data colours,
  section 2.3), or fold the primary into `--accent`. Recommendation: keep them, and
  move them into a `PLOT` table next to the print palette.
- **Snapshots**: a PNG for a figure is rendered at 3× the screen density (editor)
  and carries a caption line — case or plan name, what is shown, the time, the
  scale and unit — and the labels. The editor has the resolution and no caption or
  labels; the results window has the caption and labels at 1×. Each should adopt
  the other's half.

## 8. Print

The drawing and the report are dark ink on paper: paper `#eef2f7` / white, ink
`#1f2937`, secondary `#475569`, rules `#cbd5e1`, dimension blue `#0369a1` /
`#0284c7`, print verdicts `#047857` / `#b45309` / `#b91c1c`. Object colours are the
screen ones (section 2.2): cameras by modality, gauges red, thermocouples green,
walls `#94a3b8`, obstructions `#78716c`. Nothing in the print palette is used on
screen and nothing from the screen chrome appears in print.

## 9. Recorded exceptions

Deviations that exist today, with the verdict of the 2026-09-21 review. "Keep"
means the deviation serves the reader and stays; "fix" means it is incidental.

| Where | Deviation | Reason | Verdict |
|---|---|---|---|
| Results overlay | probes as screen-space symbols, not 3D glyphs | visible through fields at any zoom; coincident probes badge | keep (D2 recolours them) |
| Results scene | obstructions at 10 % opacity | fields must show through | keep; take the hue from `COLORS` |
| Results scene | no lights | nothing lit is drawn | keep until 3D glyphs are added |
| Results scene | rainbow ramp for scalars | Smokeview convention for scalar fields | keep |
| Results window | full-screen modal | separate session and clock | keep |
| Results window | own dialog palette, cyan accent | none | fix (D1, section 2.1) |
| Results overlay | own probe palette and quantity map | none | fix (D2) |
| Results overlay | canvas-drawn labels | composited into the PNG | keep the compositing; fix the style to `.scene-label` |
| Results transport | text buttons, `600.003 s`, `10×`, no keys | none | fix (section 6) |
| Results history | canvas plot, 20 px text | none | fix (section 7) |
| Results PNG | caption and labels at 1× | better than the editor's | keep; editor adopts the caption |
| Flame layer | own shader with alpha-hash translucency and height ramp | the data is a voxel hull | keep (documented in `flame-playback-design.md`) |
| Flame playback bar | amber slider | none | fix (D1) |
| Reconstruction plot | own overlay greys | none | fix (section 2.1) |

## 10. Checklist for a new scene, panel or overlay

1. Every colour is a token from section 2; none is defined in the module.
2. The same physical thing is the same colour as in the 3D view and the drawing.
3. Selection, focus, hover and active states use `--accent`; verdicts use
   `--good` / `--warn` / `--bad`.
4. Labels are `.scene-label` pills (or the same look when drawn on a canvas).
5. A lit scene has the three lights of section 4; an unlit one has none.
6. The orbit has the editor's damping and floor limit; the axes glyph is captioned
   when the origin is not the burner.
7. A clock-driven view uses `.playback-bar`'s markup, readout format and keys.
8. A ramp is fixed over the sequence and has the one legend widget.
9. A plot is the SVG helper; a snapshot has a caption and the labels.
10. A deliberate deviation is added to section 9 with its reason before the change
    is merged.

## 11. Keeping it honest

A small test would hold the line better than this prose: a Vitest that scans
`web/src/**/*.ts` (tests excluded) and `web/src/styles.css` for colour literals
(`0x` and `#` hex) and fails when a file outside the four token sources gains one.
Seed it with today's counts so it only ratchets down:

| File | Colour literals today |
|---|---|
| `export/report.ts` | 24 |
| `export/drawing.ts` | 17 (token source) |
| `scene/viewport.ts` | 16 (furniture and measure colours — move to `COLORS`) |
| `scene/builders.ts` | 16 (token source) |
| `core/plan.ts` | 8 (token source) |
| `scene/fds-devices.ts` | 7 |
| `ui/panels.ts` | 6 |
| `ui/fds-results.ts` | 5 |
| `ui/reconstruction-plot.ts` | 4 |
| `scene/fds-results.ts` | 4 |
| `styles.css` outside `:root` | 40, of which 32 in the playback bar, plot, linked-files and results blocks |

## Decisions for the owner

| | Question | Recommendation |
|---|---|---|
| D1 | Which accent: sky `--accent`, the flame bar's amber, or the results' cyan? | `--accent` everywhere; amber stays as the flame object colour |
| D2 | Do results probes take the editor's instrument colours and kinds? | Yes: green thermocouple (hollow for surface), red gauge, dim ring for other; kinds from `core/fds.ts` |
| D3 | Do overlays keep their own greys? | No: `--bg-panel` at 97 %, `--border`, `--bg-raised`, `--text`, `--text-dim` |
| D4 | Plot series colours: keep `#65caff` / `#ffbe66` or use the accent? | Keep them as data colours, in a `PLOT` table beside the print palette |

Once these are answered, the answers replace the "Decision" paragraphs above and
this note becomes normative in the same way CONVENTIONS.md is for the file format.
