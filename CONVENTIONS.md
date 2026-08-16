# Conventions

Normative reference for `fire-test-plan` format 1.0.0. If code and this document
disagree, this document is wrong and should be fixed — but check the tests first,
because they encode these rules directly.

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

## 4. Intrinsics

`sensor_mm` and `focalLength_mm` are the authoritative pair. **Field of view is derived
and never stored**, so the two cannot drift apart. The UI lets you type an FOV; it
back-solves the focal length and stores that.

```
fx = focalLength_mm × res_x / sensor_w_mm       [pixels]
fy = focalLength_mm × res_y / sensor_h_mm       [pixels]

hfov = 2·atan( sensor_w_mm / (2·focalLength_mm) )
vfov = 2·atan( sensor_h_mm / (2·focalLength_mm) )
```

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
(`polyline_m`, `polygon_m`, hood openings, rectangular burner footprints) are in the
object's **local** frame, so anything that consumes them — the 3D scene, the semantic
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
  block added to a v1.1 *camera* is preserved and kept in order, but its numbers go
  through the 1 µm rounding that applies to the rest of that object — this version has
  no way to tell a new coefficient from a new length. Anything whose precision matters
  should arrive as its own object type until a later format version teaches the writer
  about it, and that is a decision to take before the first v1.1 field lands.

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
- **`recording` and `hrrCurve` are reserved and must be `null` in 1.0.** Reserving the
  keys now means the post-test-record design can land later without a format version
  bump, and `cam.recording is None` already works.
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
- `meta.modified` updates on save; nothing else changes without user action.
