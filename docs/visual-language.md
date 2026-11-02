# Visual language

Adopted scope, 2026-09-21: consistent device identity, interaction cues, playback
affordances and screen surfaces. Functional differences between planning and
simulation inspection remain deliberate. This replaces the earlier discussion
draft; its proposed camera restrictions and plot rewrite were not adopted. The
follow-up review aligns the gas-temperature display family with the input importer
while retaining the original simulation quantity.

## Developing a new feature

This agreement applies to new and changed UI from the start of implementation,
including new workspaces, scenes, dialogs, plots and exported figures. A feature
that uses the existing rules needs no separate visual-design instruction from the
user and no new design document.

Before implementing, identify the existing components and shared definitions for
the feature:

| Need | Shared source (paths relative to `web/src/`) |
|---|---|
| Screen surfaces, typography, selection, focus and status | `styles.css :root` and existing component styles |
| Canvas/WebGL interface colors and fonts | `ui/theme.ts`, reading the root CSS palette |
| Instrument/measurement colors | `core/visual.ts`, consumed by plan and results |
| Plan object colors and camera modalities | `core/plan.ts`: `TYPE_COLORS`, `MODALITY_COLORS`, `objectColor` |
| Results quantity families and symbols | `core/fds-devices.ts`, preserving the recorded quantity |
| Results scalar colour scale | `scene/fds-results.ts`: the shader's `ramp`, and `resultRampRgb` for anything drawn outside it (the PNG colour bar); `.fds-results__ramp` shows the same five stops |
| Playback controls and shortcuts | `ui/transport.ts`; speeds from `state/playhead.ts` |
| HRR curve readout in inspector, drawing and import preview | `core/hrr.ts`: `curveSummary` |
| Making a curve in the inspector, and its sparkline | `ui/hrr-curve-editor.ts`, with `ui/hrr-curve-model.ts` |
| Fire clock marks, the cone's time and the Q readout | `state/fire-clock.ts` |
| As-built ghost opacity and connection opacity | `core/visual.ts`: `AS_BUILT_STYLE`, with `core/plan.ts` object identity colors |
| Plot series, grid and cursor | `--plot-*` tokens in `styles.css` |
| Viewport plot frame, collapse and view selector | `ui/plot-panel.ts` |
| Plot dashes, bead ramp, ticks and time axis | `ui/plot-svg.ts` |

Reuse those definitions rather than copying their current values into a new
component. When an existing definition cannot express a new meaning,
extend the appropriate shared source and update this reference in the same change.
Check all consumers if an existing token's meaning changes. A scientific scale
must retain its quantity, unit and legend; its colors do not become UI status
colors.

A task-specific difference is allowed when it helps the workflow. Add its scope,
reason and keep/fix decision to **Kept exceptions** in the same change. An exception
for one renderer or export path does not establish a new default for other views.

Before completing the feature, apply **Checklist for a new scene or panel** to
every affected surface. Run `npm test` and `npm run build` from `web/` for web code
changes; run `npm run test:browser` for changes to visual or interaction behavior
(it includes the build). Extend the existing browser fixture or add a focused
fixture when it does not cover the new path. Inspect the relevant normal,
selected/focused, disabled, error and narrow-layout states; check PNG or print
output when those paths change. Report which states were applicable and verified.

Extend identity parity tests when adding an instrument family or quantity mapping.
New presentation consumers that should use only shared colors belong in the
color-literal guard in `core/visual.test.ts`; its file list does not expand
automatically. Keep scientific ramps, print ink and documented scene-material
exceptions out of that guard. Use behavior tests for new keyboard or playback
rules. Documentation-only changes need a link and consistency check, not a fresh
application build.

Visual consistency is part of completing each feature. These checks reduce drift;
the current regression suite does not automatically validate a new feature's
layout or scientific meaning.

## Device identity

Default colors identify a class of instrument or measurement. They do not prove
that a simulated probe is the same physical device as a plan object, or that the
plan and simulation coordinates have been aligned.

| Meaning | Default color | Results symbol |
|---|---|---|
| Gas temperature / thermocouple | green `#10b981` | filled circle |
| Surface temperature | the same temperature green | hollow diamond |
| Heat-flux measurement | red `#ef4444` | filled square |
| Velocity / bi-directional probe | cyan `#06b6d4` | short tube / bar along the axis; magnitude has a point glyph |
| Gas sampling / species fraction | violet `#c084fc` | open ring |
| Load / mass measurement | amber `#f59e0b` | flat square platform; no FDS results counterpart |
| Other numerical probe | light neutral `#e2e8f0` | hollow circle with dark halo |

`core/visual.ts` owns the instrument defaults. The editor's `TYPE_COLORS`, 3D
builders, outliner, drawing and results overlay consume those defaults. Surface and
other-probe symbols are specific to results. Camera modality colors live in
`core/plan.ts` (`MODALITY_COLORS`), including the palette swatches. User-defined plan
object colors still override defaults through
`objectColor`; no matching override is inferred for an external simulation.

Result kinds remain in `core/fds-devices.ts`. `TEMPERATURE` and `THERMOCOUPLE` share
the green, filled-circle display family, matching the importer's default planning
proxy. The filter is named **Gas temperatures / thermocouples** and device details
retain the exact recorded quantity: a numerical gas temperature is not evidence of
a physical thermocouple. Surface quantities remain hollow diamonds in the same
temperature color. Unknown quantities stay visible as other probes, while the
planning importer may skip quantities with no supported instrument. Import overrides
and user colors do not change external results. `core/visual.test.ts` checks color
parity for every default imported quantity.

The new colors distinguish flow, composition and mass from the existing heat-flux
red and temperature green. Labels and the tube, ring and platform shapes provide
identity without depending on color. Explicit object colors still take precedence.
Velocity and fraction result families use the same colors, retaining exact recorded
quantity labels; a fraction without a supported species can remain a result even
when the planning importer cannot make a gas object from it.

Other probes use a lighter neutral than the context walls; the dark halo remains
necessary when a field is bright. Color and shape complement the quantity label.

Results retain screen-sized markers, exact source coordinates, visibility through
fields, coincident-count badges and the overlap chooser. Surface-temperature
sectors in a shared badge are dashed so the two green classes do not rely on color
alone. Individual shape, name and quantity remain available through the filters
and device details. Markers never acquire invented hardware dimensions.

## Screen palette and interaction

`styles.css :root` owns the screen palette. `ui/theme.ts` reads its computed values
from `document.documentElement` for canvas and WebGL consumers, even before a host
is attached. Results scenes, probe layers and dialogs keep a construction-time
snapshot; dialog histories and PNG captions reuse it. The editor also reads the
root palette when creating its selection box. There is currently one static theme;
changing themes at runtime would require refreshing existing snapshots.

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
| `--bg-backdrop` | modal backdrop |
| `--plot-primary`, `--plot-secondary`, `--plot-grid`, `--plot-cursor` | plot series, grid and time cursor |
| `--plot-planned`, `--plot-limit` | a plot's planned-value line and a gauge's full-scale range |
| `--plot-ramp-low`, `--plot-ramp-high` | ends of the ordinal ramp a rake's beads take by height |

Current screen values (the CSS definitions remain authoritative):

| Tokens | Values |
|---|---|
| bg, panel, raised, input, hover | `#0f172a`, `#131c31`, `#1c2740`, `#0b1220`, `#253352` |
| overlay, label, backdrop | `rgba(19,28,49,.97)`, `rgba(9,14,28,.82)`, `rgb(2 6 23 / 72%)` |
| border, text, dim, faint | `#263251`, `#e2e8f0`, `#94a3b8`, `#8190a6` |
| accent, good, warn, bad | `#38bdf8`, `#34d399`, `#fbbf24`, `#f87171` |
| plot primary, secondary, grid, cursor | `#65caff`, `#ffbe66`, `#405066`, `#cbd5e1` |
| plot planned, limit, ramp low, ramp high | `#e2e8f0`, `#7b8aa1`, `#7a68e0`, `#e6e0fd` |

The accent is the editor's sky blue, `#38bdf8`. Results selection uses that color
for the ring, selected label border and direction arrow, with a dark ring halo to
remain visible over fields. Unselected labels use the device color. Canvas labels
follow the editor's 11 px pill style and remain composited into results PNGs.

Playback, viewport plots, linked-file panels, dialogs and results reuse these tokens.
A dialog's primary action (`btn--primary`) carries an accent border.
Warnings keep explanatory text; color is supplementary. Results failures have an
error status, loading messages use neutral text, invalid scale inputs receive an
error border and `aria-invalid`, and disabled controls share a subdued appearance.
Native controls and scrollbars use the dark color scheme.

A red device is a measurement class; red error text is a status. These meanings are
kept apart by placement, shape and explicit text. Data ramps and plot series are
also distinct from interaction colors.

The editor's left rail is laid out so that Checks is on screen at laptop size (a
1280 × 720 window): its sections share the height, each scrolling its own contents,
with floors for the Add tiles, five object rows and two check cards. Help that is
read once, and tools most plans never use, fold behind a native `<details>`
(`.palette__fold`): a section-style summary for a tool (**From FDS**), a hint-style
one for help (**Camera not listed?**). A fold stays open across repaints, and opens
by itself while it holds a draft or an error. A new rail section follows the same
rule rather than adding to the rail's natural height. Heat flux, thermocouple,
velocity, gas and load tiles share the Instruments disclosure. It starts open
(gauges and thermocouples are core tools) and keeps whatever state the user leaves it
in across repaints. Checks remains visible at 1280 x 720 with it open.

The FDS device export preview uses a native modal dialog with the existing
`modal__panel`, `field__input` and shared buttons. Its read-only text uses `--mono`;
the summary names exported quantities and omissions. Copy and Download report
success, cancellation or failure in a status line using the shared text/error
tokens. Focus starts in the text, Escape closes the dialog and restores the
toolbar focus, and the plan's playback and keyboard commands pause while it is
open. Desktop Download uses the native save bridge; browsers download the same
UTF-8 text. Browser regressions cover the preview separately from native dialogs.

The burner curve readout uses the existing note/readout styles and shared buttons.
The peak replaces the editable steady HRR field while a curve is present. Remove
curve keeps the peak as the steady rate (a zero peak becomes an unset steady rate)
and is undoable. The full point count, peak, first peak time and source also appear
in the drawing's equipment row. Source text wraps at narrow inspector widths.

The burner's **Curve** select names the ways to make a curve: Steady, t² growth,
Table and From test data, plus the source of a curve made elsewhere (**From FDS:
FIRE_RAMP**, **Imported: …**), which is kept as it is until replaced or removed.
Picking a way only opens its form, grouped by a left rule; the form's primary
button (`btn--primary`: Make t² curve, Use table, Use series) commits one undoable
edit. A named growth rate shows its α as static text; Custom α makes it a field.
Each form previews its result in the note voice as it is typed (time to peak, the
table's points and peak, the series' samples), keeping a number and its unit on one
line. An invalid t² field or table keeps its text, takes the error border and
`aria-invalid`, says why in `panel__error` text (by row for a table) and turns the
button off. Drafts survive repaints, Escape restores a field's text as elsewhere,
and focus returns to the same control after an apply even when the HRR field above
it becomes a readout. The readout sits beside a 96 × 34 px sparkline: the curve in
solid `--plot-planned` on a `--plot-grid` baseline, the first peak marked with a dot,
and its peak and time as the accessible name.
The **As built** inspector section uses the existing unit-aware fields, buttons
and hint text. Survey vectors use the full inspector width so XYZ and quaternion
values stay legible. Record copies the planned pose as one edit; position, aim,
rotation, date, note and Clear are undoable. World-axis offsets are named unless
the plan records a north bearing, when compass directions are meaningful.

Survey ghosts use `objectColor`, preserving camera modality, device identity and
explicit user colors. `AS_BUILT_STYLE` gives geometry 0.25 opacity and outlines
and the thin planned-to-measured connection 0.55 opacity. Camera ghosts contain
only the frustum outline. Ghosts are editor annotations: they are not pickable,
do not enter camera previews or planning checks, and follow object visibility.
**As built** in the toolbar view group shows or hides them, initially shown.
The next-test action lives beside Save as in the file group, and its completion
message names the previous test's data that was left behind.

## Playback

`ui/transport.ts` supplies the shared five button glyphs, accessible names and
keyboard dispatch. Each workspace owns its clock, data loading and playback state.

- Order: first, previous, play/pause, next, last, scrubber, time, speed, Loop.
- Readout: `t = … s · frame …/…`. Results retain up to three decimals so nearby
  output timestamps remain distinguishable; the flame clock retains one decimal.
- Speeds use the existing `SPEEDS` values and the same `×10` notation.
- Space toggles, comma/period step, Home/End jump to the first/last frame.
- Editable controls retain their keys. Buttons, disclosure summaries, links and
  custom focus controls retain Space activation; comma/period and Home/End still
  step/jump from a focused transport button. Only the frame scrubber borrows Space
  and comma/period; its arrows and Home/End remain native slider actions.
- First/last glyphs request Unicode text presentation, and both bars use `--font`.
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

The **fire clock** is the same editor bar, not a second one. A plan with a burner
curve and no loaded flame sequence gets it (`aria-label` "Fire clock", scrubber
"Fire clock time", no height legend): its marks are a round step of about 1 % over
the curves' span, and the readout is `Q = 168.8 kW at t = 60.0 s · flame 1.23 m`
(the total over burners, and the tallest flame, when there are several). When a
flame is loaded there is still one clock, the flame's, and its readout gains the
same `Q = … · flame …` part. The predicted cone and plume take each burner's Q(t)
once the clock is played or moved; paused at the first mark, where a plan opens and
where Home returns, the clock is at rest and the cone shows the peak the checks and
the drawing use, and the readout says so (`Cone at peak, Q = 1000 kW · …`). The
readout's tooltip explains the rule. Keys, speeds, Loop and focus follow the rules
above.

## Plots, geometry and scientific color

Plot series use `--plot-primary` and `--plot-secondary`; the grid and dashed time
cursor have separate tokens. The reconstruction plots remain SVG and result
histories remain canvas. A renderer rewrite is not needed for shared styling.

The viewport's upper right holds one plot panel for the selected object
(`ui/plot-panel.ts`): a burner's reconstruction CSV and an instrument's test data
share its frame, header, Collapse/Expand and cursor slider, and a burner with both
shows a segmented Reconstruction / Test data selector rather than two panels. Scene
labels sit in their own stacking context below it and below the playback bar.

Instrument plots (test data, `ui/instrument-plot.ts`) encode the source by line
style first: measured solid, simulated dashed, a second source of the same role the
next pattern of its family (`seriesDash`). On a gauge or burner, measured is
`--plot-primary` and simulated `--plot-secondary`. On a rake, colour is the bead's
height rank on an ordinal one-hue ramp between `--plot-ramp-low` and
`--plot-ramp-high` (mixed in OKLab; lowest darkest; low end 3.9:1 on the overlay)
and the dash still names the source, so neither is read from hue alone. Planned
values are long dashes labelled Planned, neutral `--plot-planned` on one instrument
and the bead's colour on a rake (only the highest labelled); a gauge's range is a
dotted `--plot-limit` line labelled Range, or an off-scale label when drawing it
would flatten the data. Line labels, the axis title and the legend use text
tokens; colour sits in the line keys. The legend is a table that doubles as the
readout at the cursor, and no value is shown outside a series' own span. Missing
samples break the line and are counted in a note; nothing is interpolated.

When a burner's heat release rate has a curve, Planned is that same long-dash line
drawn as a path over time (`plannedSeries`), labelled over its highest point and
broken where no correlation applies; on a burner's own plot it is the burner's
curve. Its span joins the time axis, and its legend cell reads the prediction at
the cursor (`plannedValue` at t), '–' outside the curve's span. Without a curve it
stays the horizontal line. The cursor follows whichever clock runs, and the note
names it (flame playback or fire clock).

The Test data dialog is a native modal like the FDS export preview, with
`modal__panel`, `field__input`, the shared buttons and a status line in the shared
text, warning and error tokens. Its sheet preview marks the names, units and first
data rows and the time columns with text tags as well as a raised surface. Invalid
scale, offset, row and time inputs keep the typed text with an error border and
`aria-invalid`. Focus survives its repaints; Escape closes it and returns focus to
the toolbar, and playback and plan keys pause while it is open. Browser
regressions cover it separately from native dialogs.

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

The drawing uses heavy wall strokes in plan. Doors leave gaps; windows replace
the heavy span with two thin (0.8 px) parallel lines inside the recorded wall
thickness. Both use cumulative distance along the wall polyline. Elevations cut
opening outlines out of the wall fill, with 1 px outlines; angled and edge-on
openings retain their projected corners (no invented minimum width). An edge-on
opening is not dimensioned: the elevation its wall faces and the plan give its
width and sill, and an edge-on callout printed over the facing walls' own
dimensions. Widths are true lengths, not foreshortened
distances; a corner-crossing opening dimensions each part and states its total.
Window sill dimensions are above the wall base, including on raised walls.
Structural pitch/roll remain unsupported as described in CONVENTIONS section 5a.

Dimension and set-out decimal labels retain the unit's fixed precision; inspector
fields may trim. `ft-in` uses reduced sixteenths and its own foot/inch marks,
without a redundant suffix. The Set-out table follows Equipment, with one row per
physical object, world coordinates, and repeated column headings on print pages.
Rows stay together; wall vertices and rake beads stay in their object's row.
Camera standoffs are the same origin-based plan/slant distances as Coverage.
Gauge facing is the quaternion's dimensionless world unit normal; an absent
advisory aim target is shown as unstated. These are setup values, not exposure
predictions or reconstructed-flame positions.

The Drawing toolbar's schedule CSV uses the same fixed length formatting and
world coordinates as set-out, with one row per thermocouple bead. Facing words
come from `core/facing.ts` for both exports. The toolbar wraps on narrow screens
and the schedule action reuses its existing native button and focus styling.

**Set-out check** follows Set-out when surveys exist. It uses the same print ink,
fixed display-unit precision, repeated table headings and unbroken object rows.
The table compares object origins, gives signed height and facing-angle changes,
and includes survey dates and a sign-off line. Measured schedule columns transform
each rake bead through its surveyed pose.

For future changes, reuse existing identity and interface tokens, preserve the
meaning of data colors, and document a difference when it helps the task. Verify
real focus, selection, playback and export behavior when touching those paths.
Do not enforce arbitrary equality of all shapes, clocks, precision or renderers.
Token reuse alone is not an accessibility or scientific-validation claim.

## Kept exceptions

| Where | Difference | Reason | Decision |
|---|---|---|---|
| Interface language | French display numbers use a decimal comma and narrow no-break space; machine-readable exports and recorded strings retain their original form | Crew-facing text follows the selected language without changing engineering data or interchange formats | Keep; display helpers live in `ui/i18n.ts` and `ui/display-units.ts` |
| French palette | Two tile columns instead of three | Longer French terms must remain readable without splitting words at 1280 × 720 | Keep; rail scrolling and Checks allocation are shared |
| Results device classification | Surface and unknown probe classes; no user-color inference | Recorded quantities and planning hardware have different capabilities; original quantities remain visible | Keep; gas-temperature identity aligned |
| Results camera | FOV 45, near/far 0.01/10000, free orbit; editor FOV 50, 0.05/500, polar limit 0.495π | Simulation coordinates may be below the planning floor; preserve inspection and existing fit | Keep |
| Results geometry | Fill #8a9bac at 0.1 opacity, edges #8091a2 at 0.55, bounds #31475e | Subdued context behind scientific fields, rather than editor hardware materials | Keep |
| Results lighting | Unlit fields and context; editor has lit hardware and a floor | Lighting must not recolor a measured scalar | Keep |
| History renderers | Results canvas; reconstruction SVG | Different interaction/export paths already work | Keep |
| PNG export | Results use current pixel ratio capped at 2 with labels/caption; editor uses 3× without DOM labels | Preserve current export semantics; resolution parity is separate work | Keep |
| Scientific ramps | Slice, smoke/fire and reconstructed-height palettes retain their own meanings | A data scale is not an interaction accent | Keep |
| HRR curve cone | The predicted cone follows Q(t) only once the clock is played or moved; at rest, in checks, coverage and the drawing it is the peak | The 3D view opens on the worst case every verdict uses; the curve is scrubbed on demand | Keep |
| HRR curve sparkline | Solid `--plot-planned` line, not Planned's long dash | At 96 px a 10 4 dash breaks the curve into a few marks; the sparkline stands alone beside its readout, not among measured and simulated lines | Keep |
| New planning instrument glyphs | Tube 0.24 m, ring radius 0.06 m, unstated load platform 0.18 m square are symbolic; a recorded platform uses its actual dimensions | Visible, pickable hardware proxies; these display sizes never enter checks, stored fields or results coordinates | Keep; magnitude probes have no directional tube |
| Print | Paper background and dark ink; instrument defaults still shared | Screen surfaces are unsuitable for paper | Keep |
| As-built camera ghosts | Frustum outline only; other objects use translucent geometry | The survey overlay shows camera pose without duplicating hardware or obscuring the planned view | Keep |
| Length precision | Fixed decimals on dimensions and set-out coordinates; trimmed decimals in inspector fields | Adjacent construction labels need consistent precision; fields stay compact and editable | Keep; fractional ft-in uses the same reduced sixteenths everywhere |
| Rake plots | Bead lines take the ordinal `--plot-ramp-*` colours instead of `--plot-primary`/`--plot-secondary` | Colour encodes bead height; the measured/simulated distinction is carried by dash, as on every instrument plot | Keep |
| Gauge range on plots | Drawn only while within twice the plotted maximum; otherwise an off-scale label | A 50 kW/m² range on a 5 kW/m² reading would flatten the data the plot is for | Keep |

The editor's scene materials and furniture remain in `scene/builders.ts` and
`scene/viewport.ts`; object defaults and camera modality colors are in
`core/plan.ts`. Screen typography is 13 px/1.45 using `--font`, transport controls
12 px/1.2, and scene-label text 11 px. Print layout and ink live in `export/` and
the print block in `styles.css`; the page is A4 portrait with 14 mm margins.

## Checklist for a new scene or panel

- Reuse instrument identity and modality maps; preserve explicit user colors.
- Keep quantity, unit, scale and original coordinates visible where relevant.
- Use root palette tokens for controls, labels, selection and status.
- Read canvas/WebGL theme values from the root, independently of host attachment.
- Give device classes shape or text cues in addition to color.
- Preserve native editing, disclosure, button and slider keyboard behavior.
- Use the shared transport and `SPEEDS`; retain each clock's loading/cancellation rules.
- Verify selection, playback and export in a browser with actual input events.
- Keep scientific ramps and print ink separate from interface status colors.
- Record deliberate differences above and update executable regressions.
- Wrap visible prose, titles and accessible labels in `ui/i18n.ts` literal keys;
  add Canadian French entries in `ui/i18n-fr.ts`, using `plural()` for count forms.
- Preserve user text, names, FDS quantities, codes and unit symbols. Format display
  numbers with the shared helpers; keep machine-readable exports locale independent.
- Verify EN and FR at 1280 × 720, including word wrapping, focus, language repaint
  and print headings. Domain terminology awaiting review is in `french-review.md`.

## Regression checks and color-literal guard

`npm test` includes imported-device color parity across plan, builders and results,
transport key policy, and a zero-private-color-literal guard on the migrated device,
results-dialog, plot-panel, reconstruction and instrument plot, test data dialog,
burner curve editor, playback bar and palette consumers. The guard is focused on
these consumers; it does not claim to count shader data colors, print ink or all
legacy geometry literals. New screen colors belong in `styles.css :root`, and new
instrument defaults in `core/visual.ts`.

See `web/browser-tests/README.md` for the repeatable DOM/WebGL and native-key checks.
Screenshots and run logs can stay local in the ignored `review/` directory; reusable
fixtures and runners belong under `web/browser-tests/` so checks can be rerun.
