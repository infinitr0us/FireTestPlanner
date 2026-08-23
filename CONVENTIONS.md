# Conventions

Normative reference for `fire-test-plan` formats 1.0.0 and 1.1.0. If code and this
document disagree, this document is wrong and should be fixed — but check the tests
first, because they encode these rules directly.

**What 1.1 added**, all of it additive: `camera.zoomFactor`, `burner.fire.
radiativeFraction`, and the `heatFluxSensor` and `thermocouple` object types.
Nothing 1.0 allowed became invalid, and a 1.1 plan opened in a 1.0 tool keeps its
sensors through the unknown-object path in section 6. Which version a file declares
is *derived*, not authored — see section 8.

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
orientation matters (outdoor tests, wind direction). Null when it does not.

## 2. Units

Stored values are **always** SI: metres, radians, kilowatts, degrees Celsius.
The `units` block is fixed for format 1.x — it exists so a reader can *assert*
rather than assume, and so the file is self-describing to someone who has never
read this document.

`units.display` is a UI preference. It never affects a stored number. A user working
in feet sees feet and types feet; the file stays metric.

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

Storage is OpenGL and the reader default is OpenCV. That is deliberate, not an
oversight: storage matches the tool that writes it, reading matches the tools that
consume it. Both ends are explicit, and neither has to remember the other's choice.

### `aimTarget_m`

Advisory. It records authoring intent — *"point this at the flame base"* — so that
moving the burner can re-aim the camera, and so a human reading the JSON can see why
a camera is oriented as it is.

**`rotation_quat` is authoritative.** A writer must keep the two consistent.
`Plan.validate()` warns when they disagree by more than 0.1°, which catches a
hand-edited file where someone changed the target and forgot the quaternion.

### Aimed instruments (1.1)

A **`heatFluxSensor`** uses this same frame: its sensing face looks down local `−Z`,
so `forward` is the outward normal and `aimTarget_m` records what it was pointed at.

That is deliberate reuse, not coincidence. One frame definition, one `look_at`
helper, one aim-mismatch check, and the object's `forward` is exactly the vector the
`cos θ` term in section 5b needs. The object origin is the **sensing surface**, which
is the point every distance in that model is measured from.

`camera` and `heatFluxSensor` are the two aimable types — `isAimable` in
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

COLMAP instead places the origin at the image corner and writes `w/2`. `to_colmap()`
applies the `+0.5` shift; nothing else should.

**`intrinsicsSource`** tells a consumer how much to trust the numbers:

| Value | Meaning |
|---|---|
| `nominal` | Plausible placeholder. Good enough to check framing, **not** good enough to reconstruct from. |
| `datasheet` | Manufacturer figures for the model. Correct to within unit-to-unit variation. |
| `calibrated` | Measured from this physical unit. Trustworthy. |

Seeded presets are `datasheet` where a real spec was used and `nominal` otherwise. A
data scientist should treat `nominal` as a red flag before using a plan as a
reconstruction prior — which is exactly why the field exists.

**`distortion`** is `null` for an ideal pinhole, or OpenCV `[k1, k2, p1, p2, k3]`.
Wide-angle action cameras are badly served by a pinhole model; populate this after a
real calibration if the plan will feed a reconstruction.

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
  both count). A burner outside the opening footprint is `hood-offset`: this hood
  captures nothing, and the two checks below are not meaningful for it.
- **Flame impingement** — `L_f` approaching or exceeding `hood.height_m` means flame in
  the canopy, not a free plume. Only for a hood that is actually over the burner.
- **Plume capture** — the span the plume demands along an opening axis is
  `2·(offset + r(hood.height_m))`; exceeding that axis's opening dimension means the
  hood spills plume, and oxygen-consumption HRR will read low. A large hood parked to
  one side spills exactly as badly as a small one centred. This is a
  measurement-validity problem, not a cosmetic one.

## 5a. Object frames

`transform.rotation_quat` applies to every object, not just cameras. Vertex lists
(`polyline_m`, `polygon_m`, hood openings, rectangular burner footprints, and a
thermocouple's `beadOffsets_m` along local `+Z`) are in the object's **local** frame, so anything that consumes them — the 3D scene, the semantic
checks, the SVG drawings, the equipment table — must put them through the object's
full transform. One helper does it everywhere: `toWorld`/`footprintXY` in
`web/src/core/plan.ts`, mirrored by `PlanObject.to_world`/`footprint_xy` in
`python/fireplan/objects.py`.

A rotation that shows in the 3D view but not in the printed plan, or in the plan but
not in the containment check, is the failure mode this rule exists to prevent.

**Yaw is the case that is honoured everywhere. Pitch and roll are 3D-only.** Nothing
stops the rotate gizmo tilting a wall, hood or ceiling, and the 3D view renders the
tilt faithfully — but `footprintXY` drops z, so the checks and the plan view see the
projected footprint, and the elevations still draw an upright extrusion. A hood's
`opening_offset` is likewise evaluated at `z = 0` in the hood's own axes, which skews
for a pitched hood. Cameras are exempt: a camera's full orientation is authoritative
and used as stored. Tilting anything else produces a drawing that does not match the
scene, so treat it as unsupported rather than as a feature.

## 5b. Instrument models (1.1)

Both are first-order estimates for **sizing and placement**, not measurements, and
both are reported with that caveat attached wherever they appear.

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

It assumes an **unobstructed view**. The model knows nothing about walls in the plan,
so a gauge behind one still reads a full flux. Shape factors and shadowing are out of
scope for a planning tool.

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
| `tc-over-temperature` | error | A bead is past its letter type's limit, in flame or in plume |
| `tc-in-flame` | warning | A bead the type survives, but reading flame rather than plume |
| `tc-outside-plume` | info | No bead sees the fire. Legitimate for a wall rake; stated, not judged |

## 6. Forward compatibility

- **Unknown object types round-trip verbatim.** An object whose `type` this version does
  not recognise is preserved on load and re-emitted byte-identical on save — including
  its key order and the full precision of its numbers. The canonical rounding and
  reordering in section 7 apply only to types this version defines. A newer plan opened
  in an older tool does not silently lose objects, and does not silently lose digits off
  a calibration coefficient either.

  One narrow exception, and it is two format 1.0 blocks this version genuinely owns and
  can edit: an unknown object's `transform` and `display` are canonicalised normally,
  because the editor can drag, hide and lock one, and raw gizmo output is float noise.
  Every other number is re-emitted digit for digit.

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
  rather than written.
- **`recording` and `hrrCurve` are reserved and must be `null` throughout 1.x.**
  Reserving the keys means the post-test-record design can land later without a format
  version bump, and `cam.recording is None` already works.
- **`display` is advisory.** Ignoring the whole block must never change the meaning of a
  plan. Anything that changes meaning belongs outside it.

## 7. Writing files

Plans are revised by **editing into a new file**, not by storing planned-versus-as-built
in one file. Git history is the audit trail, so the writer optimises for readable diffs:

- Keys are emitted in a **fixed order**, never hash order.
- Floats are rounded to **1 µm** (6 decimal places) and emitted in the shortest form that
  round-trips, so a value that did not change never appears in a diff as
  `2.7432 → 2.74320000001`.
- Arrays of coordinates stay on one line; objects break across lines.
- `meta.modified` updates on save, and `version` is re-derived from the contents
  (section 8). Nothing else changes without user action.

## 8. Declaring a version

**The version a file declares is derived from its contents, not chosen.** A writer
emits the lowest version that describes what is actually in the file, and never lower
than the file already said:

```
version = max(declared, required(contents))
```

`required` is 1.1.0 if the plan holds a `heatFluxSensor`, a `thermocouple`, a camera
with a `zoomFactor` or a burner with a `radiativeFraction`; otherwise 1.0.0. It is
`requiredFormatVersion` in `web/src/core/types.ts`, mirrored by `required_version` in
`python/fireplan/serialize.py`.

Three consequences, and all three are the point:

- A plan that uses nothing past 1.0 keeps saying `"1.0.0"` however new the tool that
  saved it, so it still opens — and still *validates* — in a 1.0 build.
- The claim is checkable. There is one schema per version, and
  `Plan.validate_schema("1.0.0")` is how you ask "would this still open in a 1.0
  tool?" and get a reason when the answer is no.
- The version never goes down, and a version this build does not recognise is left
  alone rather than downgraded. A 2.0 file re-saved here still says 2.0.

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
