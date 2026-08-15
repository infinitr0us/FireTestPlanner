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

These drive two checks against the hood, which is why the hood needs a height and an
opening size but not an accurate shape:

- **Flame impingement** — `L_f` approaching or exceeding `hood.height_m` means flame in
  the canopy, not a free plume.
- **Plume capture** — `2·r(hood.height_m)` exceeding the smaller opening dimension means
  the hood spills plume, and oxygen-consumption HRR will read low. This is a
  measurement-validity problem, not a cosmetic one.

## 6. Forward compatibility

- **Unknown object types round-trip verbatim.** An object whose `type` this version does
  not recognise is preserved on load and re-emitted byte-identical on save. A newer plan
  opened in an older tool does not silently lose objects.
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
