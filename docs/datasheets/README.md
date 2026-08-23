# Manufacturer datasheets

Source documents for the seeded entries in `presets/cameras.json`. Kept in the repo so
that `intrinsicsSource: "datasheet"` is a claim someone can check rather than one they
have to take on trust — which is only true if every number here can be found in *these*
files, so anything derived or assumed is labelled as such below.

| File | What it actually is | Preset(s) it backs |
|---|---|---|
| `flir-a8303sc.pdf` | FLIR **A8300sc** datasheet, marked "Updated 09/28/15". The A8303sc is a temperature-range variant of this body; the imaging specifications the preset uses are the family's, and the sheet does not name the `03` variant. | `flir-a8303sc-25mm` |
| `flir-a400-a500-a700-science-kits.pdf` | FLIR A400 / A500 / A700 Science Kits, rev. 10/26/23. One sheet for three bodies, so several rows read "camera dependent" without saying which value belongs to the A700. | `flir-a700-24deg` |

`sensor_mm` is printed on neither sheet. It is `resolution_px × detector pitch`, both of
which are — that is the whole reason the pitch is quoted.

## FLIR A8300sc / A8303sc, 25 mm lens

| Preset field | Value | Where it comes from |
|---|---|---|
| `resolution_px` | 1280 × 720 | printed — "Resolution" |
| detector pitch | 14 µm | printed — "Detector Pitch" |
| `sensor_mm` | 17.92 × 10.08 | derived — 1280 × 14 µm, 720 × 14 µm |
| `focalLength_mm` | 25 | printed — "Available Lenses: 17mm, 25mm, 50mm, 100mm" |
| `spectralBand_um` | 3.0 – 5.0 | printed — "Spectral Range" |
| `framerate_hz` | 60 | printed — "Max Frame Rate: 60Hz @ Full Window" |
| field of view 39.4° × 22.8° | derived from the sensor and the lens | the sheet prints no field of view |

Nothing is back-solved here: the lens is designated by focal length, and the pitch and
the designation are mutually consistent. Note the bundled sheet lists **four** lenses —
17, 25, 50 and 100 mm. A 200 mm option is not on it.

## FLIR A700, 24° lens

| Preset field | Value | Where it comes from |
|---|---|---|
| `resolution_px` | 640 × 480 | printed — "IR resolution … or 640 × 480 (A700)" |
| detector pitch | 12 µm | **assumed.** The sheet prints "24 µm, 17 µm, or 12 µm - camera dependent" and does not say which body takes which; 12 µm is the one that fits the A700 array |
| `sensor_mm` | 7.68 × 5.76 | derived — 640 × 12 µm, 480 × 12 µm |
| `focalLength_mm` | 18.07 | **derived.** FLIR designates this lens by angle, not focal length — "Included Lenses: 24°" — so there is no focal length on the sheet to use as printed. 7.68 / (2·tan 12°) = 18.07 mm is the one that reproduces 24° |
| `spectralBand_um` | 7.5 – 14.0 | printed — "Spectral range" |
| `framerate_hz` | 30 | printed — "Frame Rate" |
| field of view 24.0° × 18.1° | 24° horizontal is the printed lens designation; the vertical follows from the array | |
| IFOV 0.65 mrad/px | derived — 24° ÷ 640 px | not printed on this sheet |

The optional lenses are printed the same way (6°, 14°, 42°, 80°), which is the pattern:
the A-series sheet names lenses by field of view throughout. The "17 mm" that appears on
the page is a **minimum focus distance** in macro mode, not a focal length.

## Not backed by a bundled sheet

`flir-t650sc-25deg` carries `intrinsicsSource: "datasheet"` but has no PDF here. Its
numbers — 640 × 480 at 17 µm, 24.6 mm standard lens — come from FLIR's published T650sc
specification. Bundle that sheet or downgrade the preset before treating it as
checkable; today it is the one seeded preset whose audit trail stops at this sentence.

`CONVENTIONS.md` section 4 is the normative statement of which quantities are stored and
which are derived.
