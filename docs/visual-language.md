# Visual language

Adopted scope, 2026-09-21: consistent device identity, interaction cues, playback
affordances and screen surfaces. Functional differences between planning and
simulation inspection remain deliberate. This replaces the earlier discussion
draft; its proposed camera restrictions, classifier reuse and plot rewrite were
not adopted.

## Device identity

Default colors identify a class of instrument or measurement. They do not prove
that a simulated probe is the same physical device as a plan object, or that the
plan and simulation coordinates have been aligned.

| Meaning | Default color | Results symbol |
|---|---|---|
| Thermocouple | green `#10b981` | filled circle |
| Surface temperature | the same temperature green | hollow diamond |
| Heat-flux measurement | red `#ef4444` | filled square |
| Other numerical probe | neutral `#94a3b8` | hollow circle |

`core/visual.ts` owns these defaults. The editor's `TYPE_COLORS`, 3D builders,
outliner, drawing and results overlay consume them. Camera modality colors remain
in `core/plan.ts`. User-defined plan object colors still override defaults through
`objectColor`; no matching override is inferred for an external simulation.

Result kinds remain in `core/fds-devices.ts`. In particular, numerical gas
`TEMPERATURE` does not establish a thermocouple. The input importer may create a
planning proxy for such a record; that is a different task and is not a reason to
reuse its classifier for recorded results.

Results retain screen-sized markers, exact source coordinates, visibility through
fields, coincident-count badges and the overlap chooser. Surface-temperature
sectors in a shared badge are dashed so the two green classes do not rely on color
alone. Individual shape, name and quantity remain available through the filters
and device details. Markers never acquire invented hardware dimensions.

## Screen palette and interaction

`styles.css :root` owns the screen palette. `ui/theme.ts` reads its computed values
for canvas and WebGL consumers when a view is constructed. There is currently one
static theme; changing themes at runtime would require refreshing these snapshots.

| Token | Purpose |
|---|---|
| `--bg` | scene and page background |
| `--bg-panel`, `--bg-overlay` | panels and translucent floating panels |
| `--bg-raised`, `--bg-input`, `--bg-hover` | controls and hover surfaces |
| `--border` | panel and control boundaries |
| `--text`, `--text-dim`, `--text-faint` | primary, secondary and tertiary text |
| `--accent` | selection, focus, active controls, sliders and checkboxes |
| `--good`, `--warn`, `--bad` | success, caveat and error |
| `--bg-label`, `--font` | scene-label surface and typography |

The accent is the editor's sky blue, `#38bdf8`. Results selection uses that color
for the ring, selected label border and direction arrow, with a dark ring halo to
remain visible over fields. Unselected labels use the device color. Canvas labels
follow the editor's 11 px pill style and remain composited into results PNGs.

Playback, reconstruction plots, linked-file panels and results reuse these tokens.
Warnings keep explanatory text; color is supplementary. Results failures have an
error status, loading messages use neutral text, invalid scale inputs receive an
error border and `aria-invalid`, and disabled controls share a subdued appearance.
Native controls and scrollbars use the dark color scheme.

A red device is a measurement class; red error text is a status. These meanings are
kept apart by placement, shape and explicit text. Data ramps and plot series are
also distinct from interaction colors.

## Playback

`ui/transport.ts` supplies the shared five button glyphs, accessible names and
keyboard dispatch. Each workspace owns its clock, data loading and playback state.

- Order: first, previous, play/pause, next, last, scrubber, time, speed, Loop.
- Readout: `t = … s · frame …/…`. Results retain up to three decimals so nearby
  output timestamps remain distinguishable; the flame clock retains one decimal.
- Speeds use the existing `SPEEDS` values and the same `×10` notation.
- Space toggles, comma/period step, Home/End jump to the first/last frame.
- Form controls retain their keys. Only the frame scrubber borrows Space and
  comma/period; its arrows and Home/End remain native slider actions.
- Holding Space does not repeatedly toggle. Modified shortcuts are left alone.
- Results keys stay inside the results dialog. Opening it suspends the plan
  renderer, and closing it restores the plan's keyboard context.
- Results Loop defaults off, preserving stop-at-end behavior. Flame Loop retains
  its existing default. When looping, the last frame is held for the preceding
  sample interval before returning to the first.
- A single-frame result remains inspectable but cannot play.

The flame bar retains its cube count and height legend; results retain Fit, field
coverage and their own scientific scale. Sharing a small set of controls does not
require merging the two playback systems.

## Plots, geometry and scientific color

Plot series use `--plot-primary` and `--plot-secondary`; the grid and dashed time
cursor have separate tokens. The reconstruction plots remain SVG and result
histories remain canvas. A renderer rewrite is not needed for shared styling.

The result scene keeps its unlit fields, translucent context geometry, free orbit
and existing camera fit. FDS coordinates can be negative and are not constrained
by the editor's planning floor. The editor keeps its hardware models, lighting,
gizmo and floor-aware orbit.

Scientific ramps are unchanged. Scalar fields show the range and unit of the
selected field; the user can rescale them explicitly. Encoded smoke/fire previews
and reconstructed height ramps retain their descriptive legends rather than
claiming a physical min/max scale they do not represent.

Results PNGs retain captions, probe labels and the current renderer pixel ratio
(capped at 2). Editor PNGs retain their existing 3× export path. Unifying export
resolution or adding editor DOM labels to PNGs would be separate work.

## Print and future changes

Print retains dark ink on paper, with its own text, rule and verdict colors.
Instrument defaults still come from the shared identity map.

For future changes, reuse existing identity and interface tokens, preserve the
meaning of data colors, and document a difference when it helps the task. Verify
real focus, selection, playback and export behavior when touching those paths.
Do not enforce arbitrary equality of all shapes, clocks, precision or renderers.
Token reuse alone is not an accessibility or scientific-validation claim.
