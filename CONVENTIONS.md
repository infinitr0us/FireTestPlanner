# Conventions

Normative reference for `fire-test-plan` formats 1.0.0 through 1.7.0, and (section 13)
for the separate flame analysis folder format 1.0.0. If code and
this document disagree, this document is wrong and should be fixed — but check the
tests first, because they encode these rules directly.

**What 1.1 added**, all of it additive: `camera.zoomFactor`, `burner.fire.
radiativeFraction`, and the `heatFluxSensor` and `thermocouple` object types.
Nothing 1.0 allowed became invalid, and a 1.1 plan opened in a 1.0 tool keeps its
sensors through the unknown-object path in section 6.

**What 1.2 added**: one object type, `obstruction` — the box that is neither wall nor
slab. `meta.source` is documented in the 1.2 schema but is *not* a 1.2 feature and
does not bump anything: `meta` is open in every 1.x schema, so a plan imported from
FDS that holds nothing past 1.0 still declares 1.0.0. Section 9 covers the import.

**What 1.3 added**: `linkedFiles` on burners, cameras, heat flux sensors and
thermocouples. These are external file references and optional burner reconstruction
snapshots; they do not populate the reserved `camera.recording` block or alter any
planned-fire correlation. See section 10 and [the usage guide](docs/linked-files.md).

**What 1.4 added**: the `reconstructedFlame` object type — a measured flame, the
visual hull the pipeline reconstructs from the test's cameras, played back in the
layout — and the `voxelSequence` link kind that carries its manifest. `display`
gains the advisory `opacity` and `colorMode`; `timeOffset_s` is reserved on links.
Section 11.

**What 1.5 added**: the `ft-in` display length preference, feet and fractional
inches. Stored quantities and geometry remain SI. Section 2.

Which version a file declares is *derived*, not authored — see section 8.

This file is about the *file*. How the editor looks — its colours, labels, transport
bar and print palette, and the checklist for any new scene or panel — is
[docs/visual-language.md](docs/visual-language.md), the same kind of reference for
the screen as this one is for the format.

---

## 1. World frame

**Z-up, right-handed.** `+X` and `+Y` horizontal, `+Z` vertically up.

**Origin is the centre of the primary burner, at floor level.**

Two things follow, and both are used throughout the codebase:

- Camera standoff is simply `norm(position_m)`. No reference object to look up.
- The dimension callouts that dominate a hand sketch (*9 ft to the camera row*,
  *9 ft to the hood*) are read directly off coordinates, so the dimensioning tool can
  generate them rather than making you place them.

`coordinateSystem.northAzimuth_rad` gives the compass bearing of `+Y` when the site
orientation matters (outdoor tests, wind direction). Null when it does not. The
drawings read it: the plan view carries a north arrow and the elevation headings
name the compass direction they look in; without it they say `+Y` / `+X` rather than
assume north.

The equipment table — the report's and `Plan.equipment_table()` alike — gives each
object's **standoff** as its plan distance from this origin (a reconstructed flame's,
from its burner) and its **height** as its own extent above the floor: an
instrument's lens or sensing face, a rake's top bead, a burner's fuel surface, a
hood's intake, a ceiling's soffit, the top of a wall, box or flame envelope.

## 2. Units

Stored values are **always** SI: metres, radians, kilowatts, degrees Celsius.
The `units` block is fixed for format 1.x — it exists so a reader can *assert*
rather than assume, and so the file is self-describing to someone who has never
read this document.

`units.display` is a UI preference. It never affects a stored number. A user working
in feet sees feet and types feet; the file stays metric.

Display lengths are `m`, `cm`, `mm`, `ft`, `ft-in`, or `in`. `ft-in` (format 1.5)
prints feet and inches to the nearest **1/16 inch**, with reduced fractions:
`9' 0 7/16"`, `0' 7 1/4"`, `12' 0"`, `-2' 5 1/2"`. Round the absolute length
once to sixteenths, ties away from zero, then split feet and inches; rounding
carries through 12 inches to the next foot. A value rounding to zero has no
minus sign. This is display rounding only, independent of the writer's 1 µm
rounding in section 7.

In `ft-in`, a bare input number means feet. Explicit suffixes override the display
unit, and fractional inches are accepted both with feet (`5' 6 1/2"`,
`5ft 6 1/2in`) and alone (`6 1/2"`, `1/2"`). Every formatted string parses back
to its displayed length. Inspector fields may trim decimal zeros. Dimensions
(viewport, measure tool, drawing) and set-out coordinates use fixed decimals:
3 for `m` and `ft`, 1 for `cm`, 0 for `mm`, 2 for `in`; `ft-in` always uses the
fractional form above.

## 3. Camera frames — the part that bites

Three frames are in play. They are all right-handed; they differ in where the axes point.

| Frame | +X | +Y | +Z | Used by |
|---|---|---|---|---|
| **OpenGL / Three.js** | right | up | **backward** (out of the scene) | **stored in the file**, Three.js, nerfstudio |
| **OpenCV / COLMAP** | right | **down** | **forward** (into the scene) | `fireplan` default, most SfM and calibration tooling |

### What is stored

`transform.rotation_quat` is a unit quaternion in **XYZW** order representing the
**object-to-world** (for a camera, **camera-to-world**) rotation, in the
**OpenGL-style local frame**: the camera looks down its local `−Z`, with local `+Y` up.

This is stored rather than the OpenCV frame for one reason: the editor is Three.js, so
`camera.quaternion` round-trips with zero conversion at authoring time — which is where
almost every object gets created, and therefore where a conversion bug would do the most
damage. Consumers convert once, deliberately, at the boundary.

### Converting

Let `R` be the stored rotation matrix. Its columns are the world-space directions of the
camera's local axes, so:

```
right    =  R[:, 0]
up       =  R[:, 1]
forward  = -R[:, 2]        # the camera looks down local -Z
```

To OpenCV (`x` right, `y` down, `z` forward), flip the last two axes:

```
R_opencv = R @ diag(1, -1, -1)
```

Position is unchanged by the flip. The camera-to-world matrix is then

```
        [ R_opencv   t ]
c2w  =  [ 0  0  0    1 ]

        [ R_opencvᵀ   -R_opencvᵀ t ]
w2c  =  [ 0   0   0        1       ]
```

`fireplan` does this for you and **defaults to OpenCV**:

```python
cam.extrinsics()                       # OpenCV, camera-to-world
cam.extrinsics(world_to_camera=True)   # OpenCV, world-to-camera (COLMAP images.txt)
cam.extrinsics("opengl")               # as stored, no flip
```

`cam.extrinsics(convention="opencv", world_to_camera=False, pose="best")`
selects the as-built transform when present, otherwise the planned transform.
`pose="planned"` always selects the plan; `pose="as-built"` raises `ValueError`
if no survey exists. `cam.pose_used(pose="best")` returns `"planned"` or
`"as-built"` using the same selection and errors. This leaves the return value
of `extrinsics` an ordinary NumPy 4x4 array. Every convention applies its usual
axis flip after selecting the transform, and world-to-camera inverts that pose.
Position, rotation, projection, framing and checks still read the planned pose.

`Plan.to_nerfstudio()` explicitly selects `best` in the OpenGL frame. Its
`metadata.poses` maps every camera ID to `{pose: "as-built" | "planned",
measured: "YYYY-MM-DD" | null}`. A null measured date does not prevent selection
of an existing as-built pose. Intrinsics and the pixel-centre conversion do not
change.

Storage is OpenGL and the reader default is OpenCV. That is deliberate, not an
oversight: storage matches the tool that writes it, reading matches the tools that
consume it. Both ends are explicit, and neither has to remember the other's choice.

### Roll

Roll is the angle about the camera's view direction from its level orientation
(the one `lookAtQuat` / `look_at_quat` gives for the same view direction, including
the existing fallback when looking straight up or down) to its actual orientation.
It is right-handed about the forward (view) direction, clockwise as seen from
behind the camera. With stored OpenGL columns `[right, up, back]`:

```
up = up0 cos(roll) + right0 sin(roll)
```

Thus +90 degrees puts the camera's top edge on the right as seen from behind.
Roll is derived from the quaternion, never stored separately, and is reported in
(-180, 180] degrees. `rollOf` / `roll_of` and `withRoll` / `with_roll` use radians;
the inspector and Python `Camera.roll_deg` / `set_roll_deg` use degrees.
Re-aiming keeps the current roll, including when moving an object with an aim
target in the editor. An object with no quaternion starts with roll zero.

### `aimTarget_m`

Advisory. It records authoring intent — *"point this at the flame base"* — so that
moving the burner can re-aim the camera, and so a human reading the JSON can see why
a camera is oriented as it is.

**`rotation_quat` is authoritative.** A writer must keep the two consistent.
`Plan.check()` (and the editor's checks list) warns `aim-mismatch` when they disagree
by more than 0.1°, which catches a hand-edited file where someone changed the target
and forgot the quaternion. This comparison uses view direction only, so a rolled
camera aimed at its target does not raise `aim-mismatch`.

### Aimed instruments (1.1)

A **`heatFluxSensor`** uses this same frame: its sensing face looks down local `−Z`,
so `forward` is the outward normal and `aimTarget_m` records what it was pointed at.

That is deliberate reuse, not coincidence. One frame definition, one `look_at`
helper, one aim-mismatch check, and the object's `forward` is exactly the vector the
`cos θ` term in section 5b needs. The object origin is the **sensing surface**, which
is the point every distance in that model is measured from.

`camera`, `heatFluxSensor` and `velocityProbe` are the aimable types. `isAimable` in
`web/src/core/types.ts` is the single list. A `thermocouple` is not aimable: a bead
has no facing.

## 4. Intrinsics

`sensor_mm` and `focalLength_mm` are the authoritative pair. **Field of view is derived
and never stored**, so the two cannot drift apart. The UI lets you type an FOV; it
back-solves the focal length and stores that.

### `zoomFactor` (1.1)

Zoom is stored **separately from the lens**, as a multiplier on the effective focal
length:

```
f_eff = focalLength_mm × zoomFactor
```

`focalLength_mm` therefore always means the lens — the number on the barrel and in
the datasheet — and `zoomFactor` means the setting the operator dialled in. Folding
them together would lose which 50 mm a file meant. Absent or null is 1×, and a writer
**must omit it rather than write 1**: 1× is the absence of a zoom, and omitting it is
what keeps a plan that does not use the feature declaring format 1.0.

Everything derived goes through `f_eff`, so a zoomed camera is zoomed everywhere or
nowhere — fields of view, `fx`/`fy`, the drawn frustum, the picture-in-picture
preview, the coverage verdict and the printed drawing:

```
fx = f_eff × res_x / sensor_w_mm                [pixels]
fy = f_eff × res_y / sensor_h_mm                [pixels]

hfov = 2·atan( sensor_w_mm / (2·f_eff) )
vfov = 2·atan( sensor_h_mm / (2·f_eff) )
```

**What this does and does not claim.** Optical and digital zoom narrow the field by
the same factor, so the fields of view above are right either way, and so is every
framing question the tool exists to answer. A *digital* zoom, though, crops and
interpolates: the derived `fx` describes the output pixels, not detail the detector
resolved, so the ground sample distance is optimistic by roughly the zoom factor. The
inspector says so on any camera above 1×. Cooled FLIR bodies in particular list zoom
as digital (the A8303sc offers 1× and 2×).

**Principal point.** `null` means the exact image centre under the OpenCV pixel
convention, where pixel *centres* sit at integer coordinates:

```
cx = (res_x − 1) / 2
cy = (res_y − 1) / 2
```

COLMAP and nerfstudio instead place the origin at the image corner, so a pixel's
centre is at index + 0.5 and a centred principal point is `w/2`. An exporter for such
a tool applies the `+0.5` shift on the way out -- `to_nerfstudio()` does -- and
nothing else should.

**`intrinsicsSource`** tells a consumer how much to trust the numbers:

| Value | Meaning |
|---|---|
| `nominal` | Plausible placeholder. Good enough to check framing, **not** good enough to reconstruct from. |
| `datasheet` | Manufacturer figures for the model. Correct to within unit-to-unit variation. |
| `calibrated` | Measured from this physical unit. Trustworthy. |

Seeded presets are `datasheet` where a real spec was used and `nominal` otherwise. A
data scientist should treat `nominal` as a red flag before using a plan as a
reconstruction prior — which is exactly why the field exists.

**A preset is never `calibrated`.** A calibration belongs to one physical unit — its
principal point and distortion — and a preset carries neither: it is a reusable
specification applied to whatever body turns up. Lifting a preset out of a calibrated
camera (**Save as preset**) steps the label down to `datasheet`, and so does reading
a stored library entry that claims otherwise. The camera it was lifted from keeps its
own calibration and its own label.

**`distortion`** is `null` for an ideal pinhole, or OpenCV `[k1, k2, p1, p2, k3]`.
Wide-angle action cameras are badly served by a pinhole model; populate this after a
real calibration if the plan will feed a reconstruction.

### Lenses of one body

A seeded preset may name a `body`. Presets that share one are the lenses of one
camera (the A8303sc's 17 to 200 mm; the A700's 5 to 70 mm, which FLIR designates 80°
to 6° and which include two 24° lenses of 17 and 18 mm; the T650sc's 6.5 to 88.9 mm,
80° to 7°) and differ in focal length only. This is
a property of the preset library, not of the file. A camera placed with one of them
stores its intrinsics inline like any other, and its `presetId` names the lens
(`flir-a8303sc-50mm`), so a plan still records which lens it was planned with. The
format does not change and no version is bumped.

Changing the lens writes less than changing the preset. It sets `focalLength_mm` and
`presetId`, and keeps what the body owns (resolution, frame rate, band) and the
`zoomFactor`, which belongs to the shot. A principal point and distortion are
cleared, and a `calibrated` source steps down to the preset's grade, because a
calibration was measured through the lens that came off. Which lens a camera has is
read from its focal length, so a value typed by hand or calibrated (25.13 mm) is
reported as not a listed lens rather than rounded to one.

## 5. Fire correlations

Heskestad, as given in the SFPE Handbook. `Q̇` in kW, lengths in m.

**Effective diameter** — non-circular pans are converted by equal area, so a square and
a circle of the same burning area give the same flame height:

```
D = sqrt(4A / π)
```

**Mean flame height:**

```
L_f = 0.235 · Q̇^(2/5) − 1.02 · D
```

**Virtual origin** (may be negative, i.e. below the fuel surface):

```
z₀ = 0.083 · Q̇^(2/5) − 1.02 · D
```

**Plume radius** at height `z` above the fuel surface, as a straight-sided cone from the
virtual origin:

```
r(z) = tan(α) · (z − z₀),     α = 15° by default
```

The 15° half-angle is an engineering rule of thumb for visualisation, not a rigorous
Gaussian plume half-width. It is a parameter so it can be changed.

These drive three checks against the hood, which is why the hood needs a height, an
opening size and a **position**, but not an accurate shape:

- **Placement** — the plume rises from the burner, so capture is judged against a disk
  centred on the *burner*, evaluated in the hood's own opening axes (position and yaw
  both count). A fire that no hood's opening covers is `hood-offset`, filed once,
  against the hood nearest to covering it; the two checks below are not meaningful for
  a hood that is not over the fire, nor for one whose intake is below the fuel surface.
- **Flame impingement** — the mean tip reaching the hood intake means flame in the
  canopy, not a free plume; a flame filling more than 80 % of the gap between the fuel
  surface and the intake is `flame-clearance`. (The ceiling checks use the same rule,
  measured from the fuel surface, not the floor.) Only for a hood that is actually over
  the burner.
- **Plume capture** — the span the plume demands along an opening axis is
  `2·(offset + r(hood.height_m))`; exceeding that axis's opening dimension means the
  hood spills plume, and oxygen-consumption HRR will read low. A large hood parked to
  one side spills exactly as badly as a small one centred. This is a
  measurement-validity problem, not a cosmetic one.

### A heat release rate that changes

Format 1.7 makes `fire.hrrCurve` either null or `{points: [[t_s, kW], ...],
source?: string}`. There are 2 to 10,000 finite, non-negative pairs, with strictly
increasing times. The optional source describes provenance, not a curve type.
The readers check ordering as well as the schema's shape and bounds.

`hrr_kw` equals the maximum curve value. Writers set it to that maximum with the
usual six-place number formatting, also applied to the curve's kW values. Times
retain their supplied precision so distinct knots cannot collapse on save. Curve
keys are ordered `points, source`. A reader reports `hrr-curve-peak` with both
values when they disagree; calculations always believe the curve's peak. A curve
may have a zero peak, so the 1.7 schema permits `hrr_kw: 0`.

`hrrAt(burner, t)` / `burner.hrr_at(t)` interpolates linearly, holding the first
value before the first time and the last value after the last time. Without a
curve it returns `hrr_kw`. Negative query times are allowed; non-finite times are
rejected. Checks, coverage and the drawing use the peak. The editor's 3D cone uses
the peak too while the playback clock is at rest (paused at its first mark, where
a plan opens), and each burner's Q(t) once the clock is played or moved: the fire
clock over the curves' span when no flame sequence is loaded, otherwise the
flame's clock. Optional `t` arguments on
flame height/tip, heat-flux estimates and thermocouple beads evaluate each burner's
own Q(t), including its source height, plume envelope and gauge line of sight.
Omitting time preserves the existing peak predictions. At zero HRR the flame
height is zero, radiation is zero, and no plume-temperature correlation applies.

`plannedValue(doc, id, bead?, t?)` uses the same predictions. `plannedSeries`
samples the union of relevant curve times, with up to 20 subdivisions per segment
and a 2,000-sample budget. A burner target uses its own curve; instruments use all
burners. It returns null without a relevant curve. All original knots fit when
there are at most 2,000; larger unions are thinned by interval min/max of summed
HRR before prediction. Unavailable temperatures remain null gaps.

`t2Curve` / `t2_curve` makes Q = alpha t² up to `peak_kW`, holds for `hold_s`, then
decays linearly to zero over `decay_s`. It samples every `step_s` (default 10 s)
and includes the exact growth, hold and decay corners. Alpha, peak, decay and step
must be positive; hold may be zero. Oversized or unrepresentable curves are
rejected. The shared `GROWTH_RATES` constants in kW/s² are:

| Name | alpha |
|---|---|
| slow | 0.00293 |
| medium | 0.01172 |
| fast | 0.0469 |
| ultra-fast | 0.1876 |

These are the NFPA 72 Annex B / SFPE Handbook t² design-fire rates (nominal times
600, 300, 150 and 75 s to 1,055 kW, with the tabulated coefficients rounded).
See [NFPA 72](https://www.nfpa.org/codes-and-standards/nfpa-72-standard-development/72)
and the [SFPE Handbook](https://doi.org/10.1007/978-1-4939-2565-0).

`curveFromSeries(t, values, maxPoints=200)` / `curve_from_series(t, values,
max_points=200)` returns `{curve, notes}`. It requires finite samples at increasing,
non-negative times, keeps endpoints and each interior interval's minimum and
maximum in time order, and clamps negative HRR to zero with a counted note. An
odd budget can leave one slot unused; a budget of two keeps only the endpoints.
These helpers produce ordinary curves.

The editor's burner **Curve** control makes curves these ways, each one undoable
edit that also sets `hrr_kw` to the peak, and records the way in `source`:

| Way | `source` |
|---|---|
| t² growth at a named rate | `t2-slow`, `t2-medium`, `t2-fast`, `t2-ultra-fast` |
| t² growth with a typed alpha | `t2` (as `t2Curve` writes) |
| Table pasted from a spreadsheet | `table` |
| From test data | `measured:<source id>`, or `simulated:<source id>` for a simulated source |

A pasted table has two columns, seconds and kW, split by tab, else semicolon, else
comma, else spaces; one header row of text is skipped. Beside a tab or semicolon a
comma inside a cell is a decimal comma, or a thousands separator when the table's
decimals are points. From test data drops samples before ignition (t < 0), since a
curve starts at 0 s or later, then thins with `curveFromSeries` (200 points). A
curve made elsewhere, such as `fds-ramp:<ID>`, keeps its source until replaced.

## 5a. Object frames

### As-built transforms (1.7)

Any object with a planned `transform`, including an unknown type, may carry
`asBuilt: {transform, measured, note}`. All three fields are required: transform
has the same position, optional XYZW quaternion and optional aim target shape as
the planned transform; measured is a valid ISO calendar date (`YYYY-MM-DD`) or
null; note is text or null. Null `asBuilt` is invalid; remove the key to clear it.
The stored OpenGL frame and authoritative quaternion rule apply to both poses.
Survey transforms receive the same six-decimal rounding as planned geometry.

The planned transform remains authoritative for checks, coverage, drawings and
set-out. The editor copies it into a survey with today's local calendar date as
one undoable edit, then edits only that copy. The offset readout uses world X/Y
when no north bearing is known, or east/north when one is recorded; height remains
world Z. The measured aim fields maintain quaternion/target consistency.

`setOutCheck(doc)` and `Plan.set_out_check()` return object-origin coordinates,
horizontal plan distance, signed measured-minus-planned height difference, the
angle between facing directions in degrees for aimed objects, and survey date.
A velocity probe with an unstated axis in either pose has no aim difference.
The drawing appends these rows as **Set-out check**, only when surveys exist.
The instrument CSV adds measured X/Y/Z in display units, empty without a survey;
each rake bead uses the measured transform including its rotation.

Writer order places `asBuilt` immediately after `transform`, with child keys
`transform, measured, note`. On an unknown object these owned pose blocks are
canonicalized, while unrelated keys retain their order and full precision.

`transform.rotation_quat` applies to every object, not just cameras. Vertex lists
(`polyline_m`, `polygon_m`, hood openings, rectangular burner footprints, and a
thermocouple's `beadOffsets_m` along local `+Z`) are in the object's **local** frame, so anything that consumes them — the 3D scene, the semantic
checks, the SVG drawings, the equipment table — must put them through the object's
full transform. One helper does it everywhere: `toWorld`/`footprintXY` in
`web/src/core/plan.ts`, mirrored by `PlanObject.to_world`/`footprint_xy` in
`python/fireplan/objects.py`.

A rotation that shows in the 3D view but not in the printed plan, or in the plan but
not in the containment check, is the failure mode this rule exists to prevent.

### An obstruction's origin (1.2)

An `obstruction` is a box, and its origin is the **centre of its base**: it spans
`±size_m[0]/2` and `±size_m[1]/2` in its own axes and rises from 0 to `size_m[2]`.

That is deliberately unlike a wall, whose height above the floor lives in
`baseHeight_m`. A wall's geometry is a polyline with no z of its own, so it needs
somewhere to put one; a box already has an origin. Two things follow, and both are
the point: dragging a box along the floor keeps it on the floor, and the rotate
gizmo yaws it about its own vertical axis rather than swinging it around a point in
the air.

**A hood's and a ceiling's heights are local to the object.** `hood.height_m` and
`ceiling.height_m` are measured from the object's own origin, and the origin is
wherever `transform.position_m` puts it — normally on the floor, but the gizmo moves
it in Z like anything else and the 3D view draws the canopy or the slab where the
transform says. Everything that judges or prints those planes therefore goes through
the world-space helpers — `hoodOpeningZM`, `hoodIntakeHeightM`, `ceilingSoffitZM` in
`web/src/core/plan.ts`, mirrored by `Hood.opening_z_m`, `Hood.intake_height_m`,
`Ceiling.soffit_z_m` in `python/fireplan/objects.py` — never `height_m` on its own. A
hood with `height_m: 4` at `z = −3` has its intake at 1 m, and a check that read the
4 cleared a flame that was visibly inside the canopy.

**Yaw is the case that is honoured everywhere. Pitch and roll are 3D-only.** Nothing
stops the rotate gizmo tilting a wall, hood or ceiling, and the 3D view renders the
tilt faithfully — but `footprintXY` drops z, so the checks and the plan view see the
projected footprint, and the elevations still draw an upright extrusion. A hood's
`opening_offset` is likewise evaluated at `z = 0` in the hood's own axes, which skews
for a pitched hood. Cameras are exempt: a camera's full orientation is authoritative
and used as stored. Tilting anything else produces a drawing that does not match the
scene, so treat it as unsupported rather than as a feature.

Instruments are the other exemption. The plan view lays a camera's frustum (from
its image-plane extents), a gauge's view cone and a rake's beads flat through their
full orientation, so a camera looking straight down covers the floor around its
tripod, a gauge facing the ceiling is marked as facing up, and a horizontal rake is
drawn bead by bead.

## 5b. Instruments and prediction models (1.1, 1.7)

Both are first-order estimates for **sizing and placement**, not measurements, and
both are reported with that caveat attached wherever they appear.

### Additional instruments (1.7)

These have no prediction model. They share `id`, `name`, `transform`, `display`,
`notes` and optional spreadsheet `linkedFiles` with the existing instruments.

| Type | Fields and meaning |
|---|---|
| `velocityProbe` | Bi-directional probe. `range_m_s` is a positive full-scale speed or null/absent. Its axis is transform forward (local -Z); `aimTarget_m` is advisory. An absent quaternion means a magnitude point with no recorded axis. |
| `gasSampling` | `species` is an array of distinct strings from `O2`, `CO`, `CO2`, `H2O`, `HCN`, `soot`, `other`; an empty array means unstated. `inDuct` is a required boolean. |
| `loadCell` | `capacity_kg` is positive or null/absent. `platform_m` is positive `[width, depth]` or null/absent for a point support. The platform is centred at the origin in local XY and follows the full transform. |

The gauge's documentary `kind` also accepts `plate-thermometer` and `thin-skin`
in 1.7. Neither changes the incident-flux estimate.

Probe proximity uses distance to the finite rectangle of each opening, split at
polyline corners, with wall yaw, translation, base and sill applied. The tolerance
is inclusive at 0.1 m. This avoids accepting a probe elsewhere on the same wall
plane. **Align with opening** uses the nearest such patch within 1 m and its
normal toward the right of the directed polyline segment. Ties use file order.
It records a target one metre along that normal and is disabled outside that reach.
The probe never offers **Aim at fire**.

A load cell passes its placement check when a burner footprint overlaps its
platform in world XY (or contains its position without a platform), with the
fuel surface at or above the overlapping part of the platform. Circular and rotated
rectangular burners count, including unlit fuel. Hidden geometry still counts. There are no range,
flow, gas-composition or mass predictions.

Writer key order after `transform`: probe `range_m_s`; gas `species, inDuct`;
load cell `capacity_kg, platform_m`; then `linkedFiles, display, notes` for each.
The ordinary six-place writer rounding applies.

### More than one burner

A plan can hold several burners (section 1 calls the one at the origin the primary,
and an FDS import keeps every face the burner surface burns on), and the scene draws a
flame on each. What is judged against which fire:

| | Fires considered |
|---|---|
| Hood placement, impingement, capture | **every** burner with an HRR, one verdict per burner, named when there is more than one |
| Ceiling impingement and clearance | every burner, likewise |
| Thermocouple bead region | every burner: inside any flame cone is `flame`; else inside any plume envelope is `plume`, reading the **hotter** centreline; else `outside`. A `plume` bead at or below that burner's mean flame tip is in the flame's height band and is judged against flame temperature for survival (`flameZone`), as a bead in the cone is |
| Incident heat flux | the **sum** over every burner inside the gauge's acceptance cone — radiation from independent sources adds, and a view-limiting tube admits only what it can see. The distance, angle, view-cone and near-field figures refer to the admitted source contributing most of the flux (the primary on a tie; the strongest outside the cone when none is admitted) |
| Camera framing, "aim at fire", the point-source position | the **primary only** |

The last row is the asymmetry, and `checkPlan` / `Plan.check()` file
`secondary-burner` on every other lit burner so a coverage table reading 100% is not
taken to cover a fire the camera never looked at. `fireBurners` /
`Plan.fire_burners` is the single list, primary first.

### Incident heat flux — point source

The fire collapses to one isotropic emitter at **mid-flame height** on the burner
axis, `(fuel surface + L_f) / 2`. That is the same point `defaultAimTarget` uses, so
"aim at the fire" and "where the radiation comes from" cannot drift apart.

```
q″ = χ_r · Q̇ · cos θ / (4π r²)          [kW/m²]
```

- `χ_r` is `burner.fire.radiativeFraction`, **0.3 when unstated**. Strongly fuel
  dependent — roughly 0.35 for heptane, 0.2 for methanol — which is why it is a
  stored field rather than a constant.
- `r` is from the **sensing surface** (the gauge's object origin) to the point source.
- `θ` is between the gauge's outward normal and the line to the source. A gauge
  facing away receives **zero**, reported as zero rather than as a negative flux.

Valid in the far field only. Inside `POINT_SOURCE_MIN_DIAMETERS` (2) effective
diameters the fire is plainly not a point, and the figure is an order of magnitude
rather than a number to size a gauge on; `gauge-near-field` says so.

The point-source figure is scaled by the line of sight below. Shape factors,
reflections and indirect radiation remain outside this placement estimate.

### Line of sight

A wall between an instrument and a fire matters even when it is hidden in the
editor: `display.visible` is a view preference, not a hole in the room. Walls,
ceiling slabs, obstructions and hood skirts are opaque. Burners, reconstructed
flames, cameras and instruments never block a view.

Each wall segment is a box centred on its polyline, with the recorded thickness,
base and height. Openings cut through its full thickness, measured by distance
along the polyline from its start, including across corners. Overlapping openings
form a single hole; sill height is above the wall's base. A ceiling is its polygon
extruded from its soffit through its thickness. An obstruction is its base-centred
box (section 5a), using the full object transform. Line-of-sight checks use only
yaw for walls, hoods and ceilings; pitch and roll are ignored.

The hood skirt is four panels around the opening, from `height_m - skirtDepth_m`
to `height_m`, translated by the hood's origin. The drawn collar has no thickness,
so these checks use **0.01 m** panels centred on its edges
(`HOOD_SKIRT_PANEL_THICKNESS_M`). The opening stays open; the canopy and duct do
not block these rays.

Both engines use **9** evenly spaced points on each lit burner's centreline, from
`fuelSurfaceZM` to `flameTipZM` inclusive (`FLAME_SAMPLE_COUNT`). A straight segment
from the instrument to each sample finds the first blocking object. Intersections
within **0.05 m** of either endpoint, measured along the segment, are ignored
(`OCCLUSION_ENDPOINT_TOLERANCE_M`). This lets a flush-mounted gauge see out from its
wall and a flame sample sit on a supporting surface without shadowing itself.
Material beyond that distance still blocks, including when an endpoint is inside
a thick object.

For a gauge, `visibleFraction` (`visible_fraction` in Python) is the clear share
of those nine samples. Multiply each admitted burner's existing point-source flux
by its own share before summing. For several fires the returned aggregate share is
weighted by their unshadowed contributions, so it states how much of the original
total remains. If all contributions are zero, use the mean share of the admitted
fires (all lit fires when none is admitted). A single fire retains the exact k/9
value; a fully clear view leaves the existing flux unchanged. Low-signal and
over-range checks use the scaled result.

For a camera, `unobstructed` is the clear share of the primary burner's centreline
samples that are **inside its frame**, or null when none are in frame. The existing
base, tip and plume framing numbers do not change. This separates a lens that
misses the flame from a wall that hides a correctly framed flame.

| Code | Severity | Means |
|---|---|---|
| `gauge-no-line-of-sight` | error | No direct view of the flame; only indirect radiation can reach the gauge |
| `gauge-partly-shadowed` | warning | Part of the flame is hidden; the visible percentage scales the prediction |
| `camera-view-blocked` | warning | At least one in-frame centreline sample is hidden; the message names the first one or two blocking objects |

### Thermocouple beads in a camera image

`thermocoupleViewOf` / `Plan.thermocouple_view` reports every bead in plan order,
then bead-offset order, using the camera's and thermocouple's **planned poses**.
Beads are points projected through the ideal pinhole model into OpenCV pixels;
distortion is not applied, and pixels behind the camera are NaN. Seen means in
frame with no occluder; outside means out of frame; hidden means in frame with a
first blocking object. The usual **5 cm trim at both ray endpoints** applies:
a bead flush with a box's near face is clear, while its far face can be hidden.
The report gives slant distance and millimetres per pixel at that distance, each
seen bead's nearest other seen bead, and the closest seen pair in Euclidean
pixels. Pair distances are null with fewer than two seen beads; the whole view
is null without thermocouples. No burner or HRR is needed.

A radiometric reading needs a uniform **3 × 3 px** target spot (`IR_SPOT_PX = 3`,
FLIR guidance). Separation is good at **6 px or more**, with a spot's width of
clear pixels between spots; warn from **3 px up to but excluding 6 px** (spots
touch); bad below **3 px** (spots overlap). The inspector's spot size is three
times the mean mm/px of the seen beads, converted to the display length unit.
These are geometry checks only: they do not judge emissivity, target uniformity,
or flame or smoke in the line of sight, and they do not model bead diameter.

### Gas temperature — Heskestad plume centreline

```
ΔT₀ = 25.0 · Q̇_c^(2/3) · (z − z₀)^(−5/3)        [K above ambient]
```

`Q̇_c` is the convective part, `(1 − χ_r)·Q̇`. The 25.0 is not fitted: it is
`9.1·(T_∞/(g·c_p²·ρ_∞²))^(1/3)` for air at 20 °C.

Quoted **only** for a bead that is above the mean flame tip *and* inside the plume
envelope. Inside the flame the plume correlation is not merely imprecise, it is the
wrong correlation, so the honest output is none. It is a **centreline** value, so a
bead inside the envelope but off the axis reads lower — an upper bound, labelled as
one.

### What the checks catch

| Code | Severity | Means |
|---|---|---|
| `gauge-in-fire` | error | The gauge is on the point source itself; the flux is unbounded |
| `gauge-facing-away` | error | The normal is more than 90° off the fire; the gauge sees background |
| `gauge-view-restricted` | warning | A view-limiting tube's acceptance cone misses the flame |
| `gauge-over-range` | error | Predicted flux exceeds full scale; the gauge pins |
| `gauge-low-signal` | warning | Under 5% of full scale — the reading is in the gauge's own noise |
| `gauge-near-field` | warning | Inside 2 effective diameters, where the model stops holding |
| `tc-over-temperature` | error | A bead is past its letter type's limit, in flame (or below the mean tip inside the plume) or in plume |
| `tc-in-flame` | warning | A bead the type survives, but reading flame rather than plume: in the cone, or below the mean tip inside the plume |
| `tc-outside-plume` | info | No bead sees the fire. Legitimate for a wall rake; stated, not judged |
| `probe-not-in-opening` | info | No opening patch is within 0.1 m; probes usually measure flow through a doorway or window |
| `load-cell-not-under-fuel` | info | No burner footprint is directly above the platform or point support |

## 6. Forward compatibility

- **Unknown object types round-trip verbatim.** An object whose `type` this version does
  not recognise is preserved on load and re-emitted byte-identical on save — including
  its key order and the full precision of its numbers. The canonical rounding and
  reordering in section 7 apply only to types this version defines. A newer plan opened
  in an older tool does not silently lose objects, and does not silently lose digits off
  a calibration coefficient either.

  The editor-owned `transform`, `asBuilt` and `display` blocks are canonicalised
  normally, because the editor can move, survey, hide and lock an unknown object.
  Every unrelated number is re-emitted digit for digit. An as-built block follows
  transform; the relative order of all other unknown keys is preserved.

  **Unknown keys on a *known* object type are not covered by this.** A `calibration`
  block added to a v1.2 *camera* is preserved and kept in order, but its numbers go
  through the 1 µm rounding that applies to the rest of that object — this version has
  no way to tell a new coefficient from a new length. Anything whose precision matters
  should arrive as its own object type until a later format version teaches the writer
  about it.

  **This is the path 1.1 took, and it worked.** `heatFluxSensor` and `thermocouple`
  are new object *types*, so a 1.0 build round-trips them verbatim rather than
  dropping them. `zoomFactor` and `radiativeFraction` are new keys on known types, so
  a 1.0 build would round them — harmless at 1 µm for a multiplier and a fraction, and
  the reason neither is a coefficient.

  `fixtures/forward-compat.ftp.json` is the regression fixture for all of this, checked
  from both languages.
- **Both writers spell numbers the same way**, which is JavaScript's way:
  `JSON.stringify` is the reference and `python/fireplan/serialize.py` reproduces it
  (`_js_number`). This matters because `repr` does not agree with it — Python writes
  `1.23e-08`, `1e-06`, `1e+16` and `12.0` where JavaScript writes `1.23e-8`,
  `0.000001`, `10000000000000000` and `12` — and a plan that changes bytes depending on
  which tool last saved it is not byte-identical in any useful sense. The digits are
  never touched: both languages already emit the shortest decimal that round-trips, so
  only the layout needed reconciling. `NaN` and `Infinity` are not JSON and are refused
  rather than written -- by both writers, and by `Plan.loads` on the way in.

  The precision promise is about doubles. JavaScript reads every number as one, so an
  integer beyond 2^53 in an unknown object reaches the web writer already rounded to
  its nearest double; `fireplan` spells such an integer the same way (`12345678901234567890`
  is written `12345678901234567000`) rather than writing bytes the other engine cannot.
- **`recording` remains reserved and must be `null` throughout 1.x.**
  `hrrCurve` is null-only through 1.6; format 1.7 defines its non-null form in
  section 5. `cam.recording is None` continues to work.
- **`display` is advisory.** Ignoring the whole block must never change the meaning of a
  plan. Anything that changes meaning belongs outside it.

## 7. Writing files

Plans are revised by **editing into a new file**. A survey may sit beside its planned
pose in `asBuilt`; it does not replace the plan. Git history is the audit trail,
so the writer optimises for readable diffs:

- Keys are emitted in a **fixed order**, never hash order.
- Geometry floats are rounded to **1 µm** (6 decimal places) and emitted in the shortest form that
  round-trips, so a value that did not change never appears in a diff as
  `2.7432 → 2.74320000001`. Recorded `linkedFiles` samples retain their supplied
  precision (section 10). The rounding is of the number's **exact binary value, ties
  away from zero** -- JavaScript's `toFixed(6)`, `Decimal.quantize(ROUND_HALF_UP)` in
  Python (`roundMicro` / `_round_micro`). One sixteenth of an inch, 0.0015875 m, is
  stored in binary just below the tie and is written `0.001587` by both.
- Arrays of coordinates stay on one line; objects break across lines.
- `meta.modified` updates on save, and `version` is re-derived from the contents
  (section 8). Nothing else changes without user action.

### Series metadata and the next test

`meta.series` is free text naming the project and test series. It follows `testId`
in canonical metadata order and costs no version bump because meta is open in
every 1.x schema. One file still represents one test.

`Plan.next_test()` and `nextTest(doc)` return independent deep copies. A trailing
ASCII decimal number in `testId` is incremented with its zero padding retained
(`T-007` to `T-008`, `EX-001` to `EX-002`, `T-999` to `T-1000`). Without one,
append `-2`; absent, null or empty IDs therefore become `-2`. The revision becomes
null, created and modified become the same current UTC timestamp, and series and
rig geometry remain. Remove root `testData`, all reconstructed flame objects,
and every object's `linkedFiles` and `asBuilt`, including unknown object types.
The original plan and its file destination remain unchanged.

**Next test…** uses a new native save destination on desktop and a download in a
browser, then opens the new copy and names the data left behind. Cancellation or
failure keeps the current plan. If the current plan changes while saving, the
copy is saved but the newer editor state is retained with an explanation.

## 8. Declaring a version

**The version a file declares is derived from its contents, not chosen.** A writer
emits the lowest version that describes what is actually in the file, normally never
lower than the file already said:

```
version = max(declared, required(contents))
```

Format 1.7 is the explicit exception: it is declared only while a 1.7 feature is
present. Removing the last such feature writes the version required by the
remaining contents. Unknown higher declarations remain untouched.

`required` is the highest applicable row:

| Version | Contents requiring it |
|---|---|
| 1.0.0 | Baseline, when none of the following features is present |
| 1.1.0 | `heatFluxSensor`, `thermocouple`, a camera's non-default `zoomFactor`, or a burner's `radiativeFraction` |
| 1.2.0 | `obstruction` |
| 1.3.0 | Any object's `linkedFiles` |
| 1.4.0 | `reconstructedFlame`, any object's `display.opacity` or `display.colorMode`, or a link's non-zero `timeOffset_s` |
| 1.5.0 | `units.display.length` is `ft-in` |
| 1.6.0 | Non-empty root `testData` |
| 1.7.0 | Any object's `asBuilt`, non-null `fire.hrrCurve`, `velocityProbe`, `gasSampling`, `loadCell`, or a `plate-thermometer` / `thin-skin` gauge kind |

The 1.3 schema closes `linkedFile` and earlier schemas close `display`, which is
why the 1.4 keys count even on an older object type. Only the `ft-in` preference
adds a 1.5 requirement; every other unit retains its previous required version.
A `zoomFactor` of 1 (after
rounding) is the absence of a zoom: writers omit it, and it raises nothing. It is
`requiredFormatVersion` in `web/src/core/types.ts`, mirrored by `required_version` in
`python/fireplan/serialize.py`.

`meta.source` is in none of those tiers, and that is not an oversight. `meta` is open
(`additionalProperties: true`) in every 1.x schema, so provenance costs no version
bump — an imported plan that uses nothing past 1.0 still declares 1.0.0 and still
opens in a 1.0 tool, carrying its origin offset along untouched.

Three consequences, and all three are the point:

- A plan that uses nothing past 1.0 keeps saying `"1.0.0"` however new the tool that
  saved it, so it still opens — and still *validates* — in a 1.0 build.
- The claim is checkable. There is one schema per version, and
  `Plan.validate_schema("1.0.0")` is how you ask "would this still open in a 1.0
  tool?" and get a reason when the answer is no.
- Apart from removing 1.7 with the last 1.7 feature, the version never goes down. A
  version this build does not recognise is left alone. A 2.0 file still says 2.0.

A file whose label understates its contents is a hand edit or a broken writer.
`check()` reports it as `version-understated` rather than refusing the file, and
saving corrects it.

**A 1.1-only key that is present but `null` is dropped on write.** `required` reads
null as absent, which is right — null and absent mean the same thing to every reader
of this format — but the 1.0 schema closes `camera.camera` and `burner.fire` with
`additionalProperties: false`, so it rejects the *key*, whatever its value. Keeping
one would have produced a file declaring `1.0.0` that fails the 1.0 schema, which is
the version invariant defeating itself. Both writers strip `zoomFactor` and
`radiativeFraction` when null, matching the inspector, which deletes them at their
defaults for the same reason.

---

## 9. Reading FDS input (1.2)

An FDS input describes a simulation; a plan describes what will be built and where
the instruments go. The overlap is real but partial, and the importer is about the
overlap only. `python/fireplan/fds.py` and `web/src/core/fds.ts` are mirrors, and
`fixtures/fds/room_corner.ftp.json` is the golden fixture both are held to **byte for
byte** — two importers that agree about the syntax but not about which box is a wall
would hand a fire safety engineer and a data scientist two different rooms from one
file.

**fdsreader is not usable for this.** The library reads simulation *output*, driven
by the `.smv` file FDS writes after a run; it cannot open a `.fds` input at all.
Everything an import needs is in the input, before any simulation runs.

### HRR time histories (1.7)

A time-based `RAMP_Q` becomes `F * steady rate * exposed area` at each `T`.
The existing peak includes `max(F)` already; that factor is divided out before
applying each F, so it is never applied twice. `MLRPUA * HEAT_OF_COMBUSTION` uses
the same mapping. Source is `fds-ramp:<RAMP ID>`. A non-time or controlled ramp
(`TMP`, `CTRL`, `DEVC`, external or spatial input), missing pairs, negative values
or duplicate times retains the existing peak conversion and reports
`fds-hrr-curve-skipped`. No time history is invented for an unstated ramp.

Explicit negative `TAU_Q` gives `Q0 * min((t/abs(TAU_Q))², 1)`: 20 samples from
zero through abs(TAU_Q), then the endpoint is held. Explicit positive `TAU_Q`
gives `Q0 * tanh(t/TAU_Q)`: 20 samples at quarter-tau intervals through 4.75 tau,
plus the endpoint at 20 tau where tanh rounds to one in binary64, then held.
This finite piecewise-linear representation approximates the function between
samples; positive tau does not mean full power at one tau. Source is `fds-tau_q`.
The equations follow the [FDS 6.9.1 User's Guide, User-Specified Functions, Time-Dependent Functions](https://github.com/firemodels/fds/blob/FDS-6.9.1/Manuals/FDS_User_Guide/FDS_User_Guide.tex#L3834-L3847)
and [EVALUATE_RAMP](https://github.com/firemodels/fds/blob/FDS-6.9.1/Source/func.f90#L3240-L3261).

Exposed side-face contributions are summed at the union of their curve knots,
with steady faces held constant. The source names the first contributing curve.
The resulting peak is the sum's actual maximum. The preview's `fds-hrr-curve`
note reports the point count, peak, first peak time and source. The room-corner
burner imports as `[[0,0],[1,100],[25,100],[26,300],[60,300]]`, peak 300 kW at 26 s,
source `fds-ramp:burner_steps`.

### The syntax rules that matter

Five of them, and the sample input in `fixtures/fds/` exercises the first three:

- **A record ends at the first `/` outside a string.** The sample's `&HEAD` title
  contains `Public room corner / shortened two-stage propane fire`; stopping at
  its slash truncates the very first record in the file.
- **Parameters separate on commas *or* whitespace.** Its `&SURF`, `&MATL` and
  `&PROP` records use newlines and no commas, so a comma-splitter silently loses
  `HRRPUA` and a thermocouple's `DIAMETER`.
- **A line without a leading `&` is a comment.** That is how an FDS line gets
  disabled, and the sample does it to a `REAC` carrying `RADIATIVE_FRACTION=0.32`.
  Reading it would change every predicted heat flux in the plan.
- **`!` starts a comment, outside a string, anywhere on a line.** That is the
  Fortran namelist rule and FDS reads these records with Fortran's own namelist
  `READ`, so it inherits it. The other way to disable a line is to put a `!` in
  front of it, and real inputs are full of `! &OBST` and `! &MULT` lines — the
  official `FM_Burner` validation cases among them. A reader that takes one as live
  input has geometry, devices or a reaction in its model that the simulation
  never had.
- **A record opens only where a line does.** FDS finds a record by walking a line
  from its first character and giving up at the first one that is neither `&` nor a
  space, so `&GROUP` in mid-sentence is prose. Searching the text for the next `&`
  instead does worse than read prose as input: `R&D` opens a `&D` record whose body
  runs to the next `/`, and the real record in between is swallowed as that body and
  disappears. A comment can otherwise delete an obstruction.

### What maps

| FDS | → | plan |
|---|---|---|
| `&OBST` thin in x or y, tall in z | | `wall` on its centreline |
| `&OBST` thin in z, above the floor | | `ceiling`, soffit at `z1` |
| `&OBST` thin in z, lowest | | **the floor** — the `z = 0` plane, not an object |
| anything else | | `obstruction` |
| a face whose `SURF` has `HRRPUA` or `MLRPUA` | | `burner`, `hrr_kw = rate × area × max(RAMP F)` — `MLRPUA` × `HEAT_OF_COMBUSTION` (from the `&SURF` or the `&REAC`); with none stated, the burner is imported with no HRR and `fds-hrr-unknown` says so. A burning box's side faces add to its HRR (`fds-burner-sides`). Every obstruction face counts only its exposed area: whatever another `&OBST` sits flush against or runs through is taken off, so two touching burning boxes do not burn the face they share |
| `&HOLE` ∩ a wall | | a wall `opening`, by arc length along the polyline |
| `&DEVC` + a heat-flux quantity, `IOR` | | `heatFluxSensor`, `IOR` as the outward normal |
| `&DEVC` + a temperature quantity | | `thermocouple`; a vertical run at one XY is one rake |
| `&DEVC` + `U-VELOCITY`, `V-VELOCITY`, `W-VELOCITY` | | `velocityProbe` with the positive X, Y, Z axis |
| `&DEVC` + `VELOCITY` | | `velocityProbe` with no quaternion; notes and preview identify velocity magnitude |
| `&DEVC` + `VOLUME FRACTION` / `MASS FRACTION` and supported `SPEC_ID` | | `gasSampling`; exact coincident points merge distinct species, retaining source quantities in notes |
| `&HEAD`, `&REAC`, `&TIME`, `&MISC`, `&MESH` | | title, fuel, notes, ambient, floor extent |

Classification is by aspect ratio: a box is a slab when its height is at most
`SLAB_ASPECT` (0.5) of its smaller plan dimension, and a wall when its thin plan
dimension is at most `WALL_ASPECT` (0.5) of both its length and its height.

A face's surface follows FDS's three spellings, each overriding the one before for the
faces it names: `SURF_ID` for every face, `SURF_IDS` for top, sides and bottom,
`SURF_ID6` face by face.

`&MULT` is expanded — for `&OBST`, `&VENT`, `&HOLE` **and `&MESH`**, including the
`*_SKIP` ranges that carve a hole out of the array, because a multiplied mesh moves
the domain and the domain is what the origin falls back to when nothing burns. The
expansion transcribes FDS's `READ_MULT`: `DX`/`DY`/`DZ` override `DXB` pairs in both
forms, the form is sequential whenever `N_LOWER` or `N_UPPER` is non-zero, `DX0`/`DY0`/
`DZ0` offset every copy, and skip bounds default to −999/999, so `I_LOWER_SKIP=3` alone
skips from 3 to the top of the array. `DXB` is read by position: a null repeat
(`DXB=2*,1,1,2*`) leaves those entries at zero rather than shifting the rest along.

`&CATF` includes are read and spliced in **at the position of the `&CATF` record**,
because a split input with a geometry file and a devices file is the normal shape
for anything past a demo. The position is the point: `&CATF` belongs in the body,
before `&TAIL`, and reading stops at `&TAIL` — so a child appended after the parent's
last line is a child nobody reads. Each included file is copied as FDS copies it
(`COPY_FILE_TO_CAT`): without its `&HEAD`, and only up to its own first `&TAIL` or
`&CATF`. A child's `&TAIL` therefore ends the child, not the model, and nested includes
are not followed (`fds-catf-nested` says so). That needs a filesystem, so it is the
desktop shell that supplies the sibling files (`/api/read-fds-include`, confined to
the folder the input came from, subfolders included). A browser tab is handed one file's bytes and cannot go
looking: there, an unresolved `&CATF` is a prominent warning naming every file that
went unread, never a silent omission. One file is read once however its name is
spelled (`geometry\part.fds`, `geometry/part.fds`; `fds-catf-repeat` for the rest),
and an include the shell cannot read is reported as missing while the rest of the
input still imports.

**A heat-release surface is not a boundary condition.** A degenerate `&VENT`
coplanar with a mesh face is normally `OPEN`/`MIRROR`/`PERIODIC` and is dropped —
but never one whose `SURF` states `HRRPUA` or `MLRPUA`. A floor fire in a domain
that starts at the floor is written exactly that way.

**A `&VENT` faces the way its solid says.** FDS decides a vent's orientation from
which side of it the solid is, or from an explicit `IOR` whose sign is the direction
of the surface normal (±3 is Z). The import does the same by inspection: `IOR` when
stated; otherwise the `&OBST` the vent lies within the face of — on a box's top face
it burns upward, on its underside downward; otherwise the mesh boundary — the domain
floor faces up, the domain ceiling faces down. Reading every horizontal vent as
upward turned a fire on the underside of a ceiling into an upward-burning pan three
metres high.

**A zero-thickness `&OBST` is drawn 10 mm thick.** FDS allows a plate with no
thickness — glazing, a thin partition, a shelf — and models are full of them. This
format has no planar object, and a box with a zero extent is one the editor refuses
to open, so the plate is given `THIN_M` (0.01 m) in that axis and the import says so
(`fds-thin-geometry`). It is the only dimension the conversion ever invents. A
`&VENT` is not geometry at all: the palette's paste box refuses one and says to paste
the `&OBST` it sits on.

**The burner is a floor-standing source.** Only an **upward-facing** horizontal
heat-release face with a positive plan area can be one. A wall lining burns on a
plane with no plan footprint, and flattening one into `size_m: [w, 0]` produces a
plan the editor refuses to reopen; a ceiling soffit lining — where a compartment
test's lining fire usually is — has a footprint, which is worse, because taken as a
burner its rim height becomes the height of the ceiling and the "burner" is a solid
box the size of the room. Both are reported as burning surfaces instead. A file whose
only fire is one of those imports with no burner and a warning that says so, and
naming such a surface explicitly falls back to the real burner rather than obeying. Where the chosen
surface burns on several faces — one `&SURF` over two `&VENT`s is two burners in a
room — every face becomes a burner and the one at the origin is the primary
(section 1).

### Additional FDS instrument mappings (1.7)

Species IDs accept the plan symbols and FDS names: OXYGEN, CARBON MONOXIDE,
CARBON DIOXIDE, WATER VAPOR, HYDROGEN CYANIDE, SOOT and other. An unsupported or
missing SPEC_ID is skipped and counted in the preview. Gas merging uses exact
XYZ, across both fraction quantities, and counts only newly created objects.

| Plan | FDS device export |
|---|---|
| `velocityProbe` | Within 5 degrees of a world axis, inclusive: `U-VELOCITY`, `V-VELOCITY` or `W-VELOCITY`. A negative axis gets a comment; FDS reports the positive component. Otherwise `VELOCITY`, with an off-axis or unstated-axis comment. |
| `gasSampling` | One `VOLUME FRACTION` per species, ID `<name>_<species>`, SPEC_ID using the FDS names above. A comment states that FDS needs the species defined, including the user-defined `other`. |
| `loadCell` | Omitted with a comment; there is no FDS device equivalent. |

All use the existing source-frame offset and collision-safe device naming.

### The origin moves, and the move is recorded

This format's origin is the burner centre at floor level (section 1); an FDS file's
is arbitrary. So an import always translates, and writes the shift to
`meta.source.originOffset_m` — **the position of the plan origin in the source
file's coordinates**, so `source_xyz = plan_xyz + originOffset_m`.

The floor is the **top face of the lowest horizontal slab below the burner**, not
the bottom of the mesh. The distinction is not academic: the sample's meshes start at
`z = 0.3` while its floor slab's top is at `z = 0.5`, so taking the mesh would put
every height in the plan 200 mm out and leave the burner floating. A burner's own pan
is excluded from that search, or a model with no floor slab would put the floor at
the top of the burner — whether the pan burns itself or carries a fire `&VENT` on its
top. A box under a fire vent is its pan when the box's footprint is at most four times
the vent's (a room's floor slab under a small vent stays the floor); the pan is part of
the burner, not drawn separately, and its base is where the burner stands. **Below the burner** is load-bearing too: when every slab in
the model is above the fire — a floor-level fire under a ceiling, with no floor slab
drawn — the floor is the burner's own base (`fds-floor-inferred` says so) and the
slabs stay ceilings. Falling back to "any slab" took the ceiling as the floor,
dropped it from the plan as floor geometry, and put every device two metres below
ground.

That offset is what the inspector's **Fields / FDS** switch is built on: it shows a
box as `XB` and a device as `XYZ` + `IOR`, in the source file's own coordinates, so
the six numbers can be compared against the `.fds` line for line. A wall on a
diagonal, a wall with three points, a non-rectangular slab, a circular pan and
anything yawed have no `XB`; those show the bounding box read-only, with the reason,
rather than being quietly squared off.

### Writing devices back

`devicesToFds(doc)` and `Plan.to_fds_devices()` write reproducible UTF-8 text with
LF endings: heat flux gauges and one `THERMOCOUPLE` device per bead, with shared
`DIAMETER` properties when a diameter is recorded. Import accepts both `DIAMETER`
and the older `BEAD_DIAMETER` spelling. Cameras, geometry and all
other object types are omitted. This is a device fragment, not a runnable model.
The header identifies the plan, test and coordinate frame, and says
"Written by FireTestPlanner" without a version or timestamp.

Wall- or ceiling-mounted thermocouple beads instead write `WALL TEMPERATURE` with
the nearest mounting face's `IOR` within 0.05 m and no `PROP_ID`; a bead with no
such face writes `THERMOCOUPLE` with a comment identifying the missing surface.

Coordinates are `plan_xyz + meta.source.originOffset_m`, with a zero offset when
absent, using section 7's metre rounding. A plan imported from FDS therefore writes
in its source frame; other plans use the burner-centred plan frame. To import a
fragment back into that plan frame, supply the same offset as `originM` / `origin_m`:
a fragment has no burner or mesh from which the importer could infer it.

A gauge gets `GAUGE HEAT FLUX` and the face's `IOR` when an axis-aligned wall,
ceiling or obstruction face lies behind it within 0.05 m measured perpendicular
to the face, and its facing is within 45 degrees of the outward face normal. The
shared occlusion solids honour wall openings and transformed boxes; hood skirts are excluded. The plan floor at z = 0
is also a mounting face: a gauge from 0 to 0.05 m above it facing up within
45 degrees gets `IOR=3`. Re-origination puts it on the source floor slab's top.
A tilted mounted gauge also carries its four-decimal `ORIENTATION`, preserving
the recorded facing on re-import while IOR identifies the mounting face. Above
5 degrees, a comment states that FDS reports flux normal to the face, a factor
cos(tilt) on the direct component. This export rule does not change the occlusion
rule or its 5 degree tolerance. All other gauges use `RADIATIVE HEAT FLUX GAS` and a four-decimal unit `ORIENTATION`.

Device IDs use names, falling back to object IDs. Apostrophes become underscores
and control characters become spaces; collisions gain `_2`, `_3`, and so on.
Multi-bead rakes use every bead's transformed world position. An imported range
name `<p><a>-<p><b>` with the same prefix, increasing integer indices and exactly
`b - a + 1` beads recovers the device IDs `<p><a>` through `<p><b>`. Other rakes
append `_1`, `_2`, and so on to their unique name. Colliding recovered IDs fall
back to a suffixed rake name. Single beads keep their object's name.
The existing importer's vertical-run grouping still names a rake from its first
and last device IDs, and can combine coincident runs. Disable `groupRakes` /
`group_rakes` when inspecting individual exported names and bead properties.
Neither export changes the stored plan or its format version.

Run `python tools/check_fds_device_export.py` for an FDS setup check outside pytest.
It combines the room corner source geometry with the current writer's devices and
`T_END=0.`, runs in a temporary directory under `local/`, and requires `Set-up only`
with no `ERROR` line. Set `FDS_BIN` to an executable or bin directory; without it
the tool uses the `fds` on PATH, where the FDS installer puts it. On Windows it
calls the adjacent `fdsinit.bat` first. No FDS on PATH is reported as skipped; an
invalid explicit `FDS_BIN` fails. The tool leaves the source fixtures unchanged.

### Nothing is guessed that the file does not say

`RADIATIVE_FRACTION` is imported only when `&REAC` states it — never defaulted to
FDS's own default, because a wrong radiative fraction silently changes every
predicted heat flux in the plan. A gauge's full scale is left null, because FDS
reports a flux at a point and has no gauge to over-range; inventing 50 kW/m² would
make every over-range and low-signal verdict a fiction. The import says so, as a
`fds-gauge-range` warning.

Everything not imported is reported by name rather than dropped quietly: the records
the mapping dropped, and the judgements it had to make — which surface was taken to
be the burner, which `&HOLE` cut nothing, which `&DEVC` quantity has no counterpart,
which surface a zero `&RAMP` switches off. Per-object classification (this box became
a wall, that one a ceiling) is reported as counts in the preview instead, because one
issue per object would bury everything else in a model with two hundred of them.

The conversion is then checked against this format before it is offered: an import
that produced a plan the editor could not open again would save cleanly and fail on
reopen, a long way from the import that caused it. Failures appear in the preview as
errors, and the preview will not adopt while one is present.

An import that loses half a model is worse than one that refuses, so this one neither
loses nor refuses: it converts, and then says what it did.


## 10. Linked test files (1.3)

`linkedFiles` is an optional array of at most 100 entries per supported object.
Each entry has `id` (unique within that object), `kind`, `path`, optional `label`
and optional `plot`. Cameras accept `kind: "video"`; burners, heat flux sensors
and thermocouples accept `kind: "spreadsheet"`, as do velocity probes, gas sampling
points and load cells in 1.7. Other known types do not carry it.
The IDs travel with the document; removal and relinking are undoable edits.

`path` names a local file, never a URL. On disk it is relative to the plan file
when possible, with `/` separators; absolute paths are allowed across drives or
shares. It is a reference, not bundled content. Consumers never launch references
automatically. Save As must preserve each target by rebasing against the destination.
Browser-selected files have only a basename and require reselection for access.

Only a burner spreadsheet may contain `plot`, an object with `importedAt` and
`samples`. Each sample is `[time_s, volume_m3, surface_area_m2]`: three finite
numbers, with non-negative volume and area. Time may be negative for pre-ignition
measurements. There are 1–20,000 samples with strictly increasing times; duplicates,
including identical rows, are rejected so measurements are never silently merged.
These recorded numbers retain their supplied precision; geometry's six-decimal
rounding does not apply. The snapshot is independent of the original file and
remains available without it. Refresh is explicit and all-or-nothing; a failed
refresh leaves the previous snapshot. Relinking to different source data replaces
or removes the old snapshot, so it cannot be mislabeled as coming from the new file.

The writer raises the declared format to at least 1.3.0 when `linkedFiles` is
present (including an explicit empty array). Removing the final UI link omits the
property. Existing declared versions never go downward. Both writers use entry
key order `id, kind, path, label, plot` and plot key order `importedAt, samples`.

A link does not imply a recording timebase, a particular CSV column's bead identity,
or correspondence between a video frame and a reconstruction sample. Those remain
future recording metadata. This avoids confusing simulation exports, reconstructed
measurements and the plan's own predicted fire geometry.


## 11. Reconstructed flames (1.4)

A `reconstructedFlame` is a voxel sequence drawn beside the plan, normally a
visual hull reconstructed from camera silhouettes. The distributed Example is a
synthetic 80 kW design fire generated by `tools/build_synthetic_flame.py`. Neither
imported nor synthetic frames change the planned HRR, predicted flame geometry,
hood checks or instrument verdicts.

**Frame format.** One `t_<seconds>s.npz` per timestep; the timestamp exists only in
the filename. The fixture uses `t_0000055.0s.npz` at 55 s and samples every 5 s
from 0 to 395 s (80 frames). Each ZIP-deflated NPZ contains `voxels.npy` and
`voxel_size.npy`: `voxels` is an M×3 float64 C-order array of occupied voxel
centres in metres, with shape (0, 3) for an empty frame; `voxel_size` is a 0-d
float64 scalar. Coordinates are in the right-handed, Z-up rig frame. The fixture
rig equals the plan frame, with the burner centred at x=y=0. Its 192³ grid has
endpoint-inclusive `linspace(-1.5, 1.5, 192)` centres in x/y and that same array
plus 1.4 m in z: grid extents [-1.5, 1.5], [-1.5, 1.5], [-0.1, 2.9] m. Only
positive-z centres are occupied. Array indexing is ijk, with k varying fastest.

**It is an object, not a burner attachment**, because the hull is world-anchored:
the voxels are in the reconstruction rig's frame, and the object's `transform` maps
that frame onto the plan's. It is the identity when the rig was set up from this
plan — the cameras' `extrinsics()` fed to the pipeline — and the correction when it
was not. The editor creates one locked, so the gizmo cannot shift measured data by
accident. `burnerId` names the fire it belongs to; null or absent means the
primary. `representation` is reserved and `"voxels"`.

**Its data is a `linkedFiles` entry of `kind: "voxelSequence"`**, at most one, whose
`path` names the **folder** of frames and obeys every rule in section 10 —
relative to the plan when possible, rebased on Save As, basename-only in a browser
and in a shared page, never opened automatically. Holding it as a link rather than
a bespoke field is what makes Save As rebase it: `mapLinkedPaths` and
`for_destination` know only `linkedFiles`. The link carries a `sequence` manifest
the way a burner's spreadsheet carries `plot`:

```jsonc
"sequence": {
  "importedAt": "2026-09-19T20:00:00Z",
  "grid": { "voxelSize_m": 0.015625, "pitch_m": 0.015707, "resolution": 192 },
  "bounds_m": [[-0.227749, -0.227749, 0.009948], [0.227749, 0.227749, 1.533508]],
  "frames": [[0, 0], [5, 0], [10, 1636], "…"]        // [timestamp_s, occupiedVoxels]
}
```

A manifest, never the voxels: the plan stays diffable, and the manifest is enough to
describe the run without the folder, to notice when the folder no longer matches,
and to run the placement checks with the data absent. `frames` timestamps strictly
increase and come from the file names; counts are non-negative integers; 1–20,000
frames. Recorded data keeps its supplied precision, as `plot` does.

**The pitch is not `voxel_size`.** The fixture builds its grid with an
endpoint-inclusive `linspace`, so neighbouring centres are `volume / (res − 1)`
apart while `voxel_size` is `volume / res` — half a percent less, and enough to
mis-index a voxel a hundred cells from the origin. Readers infer `pitch_m` from the
coordinates (the smallest gap between distinct x values of the fullest frame) and
`resolution` from the two (`pitch / (pitch − voxel_size)`, null when they are
equal); cubes are drawn at the pitch. The fixture's pitch is 3/191 m and its
stored `voxelSize_m` is 3/192 m. Bounds above are abbreviated for readability;
saved manifests preserve full precision. A frame whose centres are not on the sequence's lattice, or two frames with
one timestamp, fail the import by name.

**Packed form.** Both engines pack a sequence to identical bytes — a little-endian
header (grid, bounds, frame count) and per frame a bounding box on the lattice with
one bit per cell, in numpy `packbits` order — held byte for byte by
`fixtures/flame/expected.json`. It is what a shared page embeds (gzipped, base64,
under `linkedFiles[].embedded` in the page's plan copy only; a saved plan never holds
that key) and what the bundled Example carries. A frame's box is `u16` per axis, so
an axis longer than 65,535 cells cannot be packed and both writers refuse it with
the same sentence. Both readers refuse the same streams — anything the writer could
not have produced: a count that is not the number of set bits, bits that do not fit
the box or are set past its last cell, a box outside the bounds, frames out of time
order, or a grid the manifest rules reject — so a corrupt payload is a load error,
never a frame. The per-frame refusals are worded identically in both engines, with
the timestamp spelled as JavaScript spells a number.

**Display.** `display.opacity` (0–1, default 1) and `display.colorMode` (`height`,
a blue/yellow/red ramp on a fixed scale over the sequence, or `solid`) are advisory and
live in `display` because that is what `display` is for. Cubes over the surface
cells are the representation: a visual hull is a set of voxels and the blockiness is
the resolution.

**Checks**, from the manifest alone, in both engines: `flame-below-floor` (the
transformed bounds reach more than a pitch below the burner's floor),
`flame-off-burner` (the transformed bounds are centred further than the pan's
effective diameter, or 0.25 m, from the burner), `flame-csv-mismatch` (a burner
plot's timestamps or voxel counts — volume over voxel volume, to within a voxel —
are not this sequence's), `flame-burner-unknown`.

Writer key order: object `id, type, name, transform, burnerId, representation,
linkedFiles, display, notes`; link `id, kind, path, label, timeOffset_s, plot,
sequence`; sequence `importedAt, grid, bounds_m, frames`; grid `voxelSize_m,
pitch_m, resolution`; display `color, visible, locked, opacity, colorMode`.
`timeOffset_s` is reserved for clock synchronisation — the same question the
reserved `camera.recording` is about — and is dropped by both writers at null or 0.


## 12. Test data (1.6)

A root `testData` array links measured or simulated table channels to instruments.
A source has `id` (unique among sources), `name`, `role` (`measured` or `simulated`),
`file`, `table`, `channels` and `manifest`, with optional `timeOffset_s`. It has no
position. Burners, heat flux sensors, thermocouples and the three 1.7 instruments
can be targets. Velocity uses `m/s`, load uses `kg`. Gas retains the extracted
column's own unit, including null when unstated; its inspector shows the mapped
manifest unit. `targetUnits` uses null to mark a free gas unit, distinct from a
missing target. `plannedValue` returns a null value with `No prediction model.`
for these instruments. Their planned series is absent. The existing one-channel
per object per source rule remains: several gas species require separate sources
or sampling objects to map simultaneously. Automatic suggestions do not choose
between several gas channels for one object.

**A source file is a linked file.** `file` uses the section 10 `linkedFile` definition,
with `kind: "spreadsheet"`. It may carry `label` and the reserved link-level
`timeOffset_s`, but no `plot` or `sequence`: a source stores references and a manifest,
never samples. Source-level `timeOffset_s` alone controls its clock. Paths resolve
relative to the plan and rebase on Save As in both engines; shared pages strip
private directories to a basename. The desktop editor queues local reads after
opening a plan; network paths wait for explicit Load data. A browser needs reselection.

**The saved layout reproduces the read.** `table` has `sheet` (a non-empty workbook
sheet name, or null for delimited text), `shape` (`paired-time`, `processed`, `fds`
or `plain`), `headerRow`, `unitsRow`, `dataRow` and `timeColumn`. Rows are 1-based;
`unitsRow` may be null. Columns are 0-based; `timeColumn` may be null only for
paired-time, whose time columns come from its header pairs. The reader's processed
header composition still uses all rows before `dataRow` (see docs/test-data-readers.md).
Optional `unitsSheet` selects metadata units: a string names one workbook sheet,
null merges all sheets in workbook order, and omission means no metadata fallback.
Delimited sources omit it. Local column units take precedence. This records the
metadata lookup, not a stale copy of its values.

**A mapping** has `channel` (the exact extracted series name) and `object` (an object
ID), plus optional `bead`, `scale` and `offset`. A thermocouple requires a 0-based
bead index, including 0 for a point thermocouple; other targets omit `bead`.
Missing objects, incompatible types, absent or out-of-range rake beads, and beads on
other types produce `test-data-dangling` warnings. Repeating an object and bead in
one source produces `test-data-duplicate`; the same target in different sources
is expected. Duplicate targets remain editable, but series extraction refuses them
rather than choosing one. A single channel may map to multiple different targets.

**Plan time is seconds from ignition.** `t = file time - timeOffset_s`, with 0 as
the absent offset. `value = raw * scale + offset`, with defaults 1 and 0. Scale is
finite and non-zero; negative calibration is allowed. The output quantity is the
target's: `kW/m2` for a heat flux sensor, `°C` for a thermocouple, `kW` for a
burner, `m/s` for a velocity probe, and `kg` for a load cell. Gas sampling retains
the column's unit, including null when unstated. These are API unit spellings.
No automatic conversion is inferred from the raw unit, and no resampling or
interpolation occurs. Missing samples and time
cutoffs retain the reader's meaning. Calibration overflow is an error.

**The manifest describes the original read.** `size` is file bytes; `modified` is
a string timestamp or null when unknown; `rows` is the dense grid row count,
including headers and trailing formula rows. `channels` contains exactly one entry
per distinct mapped name, in first-mapping order: `name`, `unit` (the reader's
normalized raw unit, or null), `samples`, `t0`, `t1`. Counts are non-negative integers.
An empty series has null endpoints; one sample has equal finite endpoints; more
samples have increasing endpoints. Times and units precede calibration and ignition
shift. File size, missing mapped channels, changed units, sample counts and time
spans are compared without altering the stored manifest; the modification time alone
is not, because a copied or browser-attached file carries another one with the same
data. Reopening or reading does not silently refresh the manifest.

The pure TypeScript helper takes target quantities through
`sourceSeries(source, grid, {channels, targets})`: `channels` is the metadata unit
map and `targets` normally comes from `targetUnits(plan.objects)`. A bead identifies
°C on its own; other object IDs require a target unit. The key is the JSON tuple
`[objectId, beadOrNull]`, so separators inside IDs cannot collide. `manifestFor`
receives metadata units in `fileInfo.units`; `manifestMismatch` receives those units
and the saved layout in `fileInfo.table` (detection is the fallback). Python
`Plan.series(objectOrId, bead=None)` resolves the target quantity and linked file
itself, returning one series per matching source in source order. It reads only
sources mapping that target and raises a missing-file error naming the path tried.
Neither API caches samples. A rake requires an explicit bead index.

**Writing.** `testData` follows `objects`. Empty arrays are omitted and do not
require 1.6; a non-empty array requires at least 1.6.0, and a higher declared version
never decreases. Calibration coefficients, source time offsets and manifest numbers
retain their supplied precision, as recorded linked-file data does. Section 7's
number spelling and layout still apply. Existing object and unknown-key behavior
is unchanged; writers retain unknown source keys, while the 1.6 schema closes the
new blocks, as it closes linked files.

Writer order: source `id, name, role, file, table, timeOffset_s, channels, manifest`;
table `sheet, shape, headerRow, unitsRow, dataRow, timeColumn, unitsSheet`; mapping
`channel, object, bead, scale, offset`; manifest `size, modified, rows, channels`;
manifest channel `name, unit, samples, t0, t1`. Files use the existing link order.
Explicit source defaults remain written; no default values are inserted on load.

`decimateMinMax` prepares future shared-page series. It preserves first and last,
then each interior bucket's minimum and maximum in original time order, within
`maxPoints` (default 2,000). Its output is `{t, values}` with float64 arrays. Buckets
partition sample indices equally; ties keep the first occurrence. Budgets must be
integers of at least 2, and an odd budget may leave one slot unused. Only finite
samples at strictly increasing times are accepted. This helper does not change
stored data. Shared pages carry these decimated series in an HTML-only
`embeddedTestData` block, removed before document validation and never written to
a plan. The session and sharing APIs are documented in
`docs/test-data-design.md` under Editor plumbing, and the editor's Test data dialog
and instrument plots, including what each edit does to the manifest, under Editor UI.

## 13. Flame analysis folders (flame analysis 1.0, events 1.0 and 1.1)

A separate format beside the plan, with its own version and schemas
(`schema/flame-analysis-1.0.0`, `flame-event-1.0.0`, `flame-event-1.1.0` and
`flame-outlines-1.0.0`, mirrored in `python/fireplan/schemas/`). It holds one processed test filmed by
calibrated cameras, for the flame analysis board
([design](docs/flame-analysis-board-design.md)); `fireplan.flame_analysis` reads and
checks it. It describes results, not how they were made: no field carries a
pipeline's thresholds, coefficients or file layout. A plan never refers to it, and
nothing in it changes the plan format.

**Two manifests.** `analysis.json` (`format` `fireplan-flame-analysis`) names the site
plan, the cameras (`id`, the site plan's `planCameraId`, an optional `label`), the time
base (`label`, optional `description`), optional step texts and the events.
Each event's manifest (`format` `fireplan-flame-event`) names its cameras in display
order, its instants (`t_s` finite and strictly increasing, a unique file `stem` each), path
templates, picture sizes, the hull's voxel size, its series and optional quality
indices, key moments and notes. `analysis.json` is version `1.0.0`. An event is
`1.0.0` or `1.1.0` and is checked against the schema of its own version, so a folder
may mix them; 1.1 adds only optional fields (`files.mesh`, `series[].responseTime_s`),
a 1.0 event carrying one is an error, and a reader shows a 1.0 event without what 1.1
adds. Every schema closes every object: an unknown field is an error, not something to
keep. JSON files are UTF-8, with an optional BOM. Invalid UTF-8 and the
non-JSON constants `NaN`, `Infinity` and `-Infinity` are refused, as are numeric
values outside the finite range, a whole number too large for a float included
(JavaScript reads it as infinity). A pattern in the schemas ends at the end of the
text, as in ECMAScript: an id, a stem or a date followed by a line break is refused
by both readers, although Python's own `$` would let it pass. The time base label's
limit of 40 counts characters, not UTF-16 units. Each event id must equal its entry in
`analysis.json`. Series ids must be unique within each event; duplicate ids are
refused with the event and the repeated id in the problem message.

**Paths** are relative to the manifest that holds them, and are validated before
normalization. A path consists of `/`-separated segments: none may be empty, `.` or
`..`. Absolute paths, drives, backslashes, colons and control characters U+0000
through U+001F or U+007F are refused. Resolving a path must keep it inside the folder
that holds `analysis.json`. Literal `{` and `}` are refused outside templates.
**Templates** permit only `{cam}` and `{stem}`: `display`, `frame` and `closeup`
need both, `outlines` needs `{cam}` only, and `hull` and `mesh` need `{stem}` only.
Other characters are permitted by the format; the host filesystem must also be
able to represent the name.

**Time.** Every time in a folder is seconds on its test's time base, the same clock for
every event and file. `onset_s` marks the event's start; the board shows time from it,
negative before. A picture or hull holds from its instant until the next one: nothing
is interpolated between instants.

**Pictures.** `images.<cam>.size_px` is the full-resolution size; it must equal the
site plan camera's `resolution_px` for the hull to be drawn over the picture (a
warning otherwise, since the pictures are still worth showing). `display_px` is the
size of the display copies. An optional `closeup` is a fixed rectangle `rect_px`
(`x, y, w, h` of the full-resolution picture) with its own copies (`files.closeup`,
`closeup.display_px`). The `images` keys must equal the event cameras exactly.
`files.closeup` is present if and only if every camera has `images.<cam>.closeup`;
partial close-ups are refused. Each rectangle must stay inside `size_px`, including
its right and bottom edges. Quality indices are zero-based integers within the
instants, and `quality.outsideFrame` may name only event cameras.

**Outlines** (`fireplan-flame-outlines`) give each camera's flame as closed rings, one
list per instant in instant order. A ring is a flat `[x0, y0, x1, y1, ...]` of at least
three points in full-resolution pixel coordinates: x right, y down, the centre of a
pixel at integer coordinates, the convention of `Camera.project`. Rings are filled
even-odd, so a ring inside another is a hole. A region one pixel wide has no area and
no ring. The document's `size_px` must equal `images.<cam>.size_px`; a mismatch is
an error, never an implicit rescaling.

**Hulls** use the section 11 frame format (`voxels` M x 3 float64, metres, and
`voxel_size`) in the plan frame (`hull.frame` is `plan`). The instant's time comes from
`instants`, not the file name. Every hull's stored `voxel_size`, including an empty
hull's, must equal `hull.voxelSize_m` with relative tolerance 1e-9 and zero absolute
tolerance. This checks the recorded size, separately from inferred lattice pitch
(section 11). Python's deep check and the board's hull reads refuse a mismatch.

**Meshes** (event 1.1, optional) are a smoothed surface of the same 3-D flame, one file
per instant (`files.mesh`), for drawing only: volume and area come from the series, not
from the mesh. The file is a binary little-endian PLY in metres in the plan frame, with
exactly these nine header lines in this order, with LF endings only:

```text
ply
format binary_little_endian 1.0
element vertex N
property float x
property float y
property float z
element face M
property list uchar int vertex_indices
end_header
```

N and M are unsigned decimal integers (ASCII digits, leading zeros accepted).
The terminating LF of `end_header` must be within the first 65,536 bytes.
Comments, extra lines, CRLF, other declarations or property orders are refused.
The body is N records of three finite float32 coordinates and M records of one
byte 3 and three int32 indices of existing vertices, with no trailing bytes
(`N x 12 + M x 13` bytes). An instant without a flame has an empty mesh (N and M
zero), not a missing file. `write_mesh` also refuses non-finite float32 coordinates,
out-of-range faces and non-integer indices before writing anything.

**Series** name a CSV file and two of its columns: `time` (strictly increasing, no
gaps) and `value`. The file is UTF-8 (a BOM is accepted), comma separated, with one
header row and at least one data row. A file without data rows is an error
("no samples"). CRLF, LF and CR line endings are accepted. Completely empty lines
are skipped; whitespace-only lines, comma-only records and quoted empty records
are data rows, so a missing time in them is an error. Diagnostics give physical
line numbers, including skipped lines and line breaks inside quoted fields.
Numbers use `[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?` and must be finite;
underscores, non-ASCII digits, hexadecimal, `inf` and `nan` are refused. Values may
be quoted with whitespace outside the quotes, and doubled quotes escape a quote
inside a field. Quotes in unquoted text, text after a closing quote, and unclosed
quotes are errors. An empty value cell is a missing sample and breaks the line;
an empty time is an error. Column names and values are trimmed. `quantity` fixes
the unit: `hrr` kW, `volume` m3, `area` m2, `height` m. `role` is `measured`,
`reconstructed` or `estimated`;
`basis` (`convective` or `total`) is for heat release rate only. Volume and area may
not be negative. `responseTime_s` (event 1.1, a positive number of seconds) is the
first-order response time of a `measured` heat release rate, the hood's lag; the
board uses it to pass the estimates through the same lag (`y' = (x - y) / tau`, stepped
exactly between samples), on the plot when asked and for the percentages that
compare an estimate with the hood, and no other series may carry it. It is a lag
only: the format has no transport delay. When an event has several measured heat
release rates, the first is the hood: the key numbers, the response time and the
Heskestad height refer to it, and a response time on a later one is not used. The
response at an event is worked out from the unbroken run of an estimate's samples
that reaches the event's first instant: what lies before a missing sample is not
carried across it.

**Text** is a string or `{"en": ..., "fr": ...}` with English required. Step ids are
`cameras`, `frames`, `segmentation`, `reconstruction`, `size`, `hrr` and
`limitations`; an event's `notes` use the same ids and add to the test's text.

`FlameAnalysis.check()` returns every problem as an `Issue` (the plan's type): the
schemas, unknown or duplicate ids, cameras missing from the site plan, instants out of
order, quality indices out of range, close-ups outside the picture, unreadable or
out-of-order series, and missing files (meshes counted, with the first missing one
named); `deep` also opens every outline, hull and mesh. The
synthetic test in `fixtures/flame-analysis/` is built by
`tools/build_synthetic_flame_event.py` and regenerates exactly: the same bytes for its
text files, the same pixels for its PNGs and the same arrays for its NPZ files (their
compressed bytes vary with the zlib build).
