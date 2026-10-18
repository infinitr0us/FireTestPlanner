# Manufacturer datasheets

Source documents for the seeded entries in `presets/cameras.json`, listed so that
`intrinsicsSource: "datasheet"` is a claim someone can check rather than one they have
to take on trust. That holds only if every number here can be found in *these*
documents, so anything derived or assumed is labelled as such below.

The datasheets are Teledyne FLIR's copyrighted documents and are not redistributed in
this repository. Download them from the product pages below (the datasheet is under
*Resources*). The SHA-256 identifies the exact revision the presets were checked
against; a later revision may differ.

| Document | Where to get it | What it actually is | Preset(s) it backs |
|---|---|---|---|
| FLIR A8300sc datasheet (`flir-a8303sc.pdf`, SHA-256 `db28d573112ed24ee44ce684d4027456f3a2f749e70194fa52406e5a58f5c839`) | [FLIR A8300sc product page](https://www.flir.com/products/a8300sc/) | Marked "Updated 09/28/15". The A8303sc is a temperature-range variant of this body; the imaging specifications the preset uses are the family's, and the sheet does not name the `03` variant. | `flir-a8303sc-17mm`, `-25mm`, `-50mm`, `-100mm` |
| FLIR A400 / A500 / A700 Science Kits datasheet (`flir-a400-a500-a700-science-kits.pdf`, SHA-256 `ec7b4b65ce871d8f746368fb0b98d66fedac755f749738864d3a425a48a1e406`) | [FLIR A400/A700 Science Kits product page](https://www.flir.com/products/a400-a700-science-kits/) | Rev. 10/26/23. One sheet for three bodies, so several rows read "camera dependent" without saying which value belongs to the A700. | `flir-a700-24deg` |

`sensor_mm` is printed on neither sheet. It is `resolution_px × detector pitch`, both of
which are — that is the whole reason the pitch is quoted.

## FLIR A8300sc / A8303sc, 17, 25, 50 and 100 mm lenses

| Preset field | Value | Where it comes from |
|---|---|---|
| `resolution_px` | 1280 × 720 | printed — "Resolution" |
| detector pitch | 14 µm | printed — "Detector Pitch" |
| `sensor_mm` | 17.92 × 10.08 | derived — 1280 × 14 µm, 720 × 14 µm |
| `focalLength_mm` | 17, 25, 50, 100 | printed — "Available Lenses: 17mm, 25mm, 50mm, 100mm" |
| `spectralBand_um` | 3.0 – 5.0 | printed — "Spectral Range" |
| `framerate_hz` | 60 | printed — "Max Frame Rate: 60Hz @ Full Window" |
| field of view | per lens, below | derived from the sensor and the lens; the sheet prints no field of view |

Nothing is back-solved here: the lenses are designated by focal length, and the pitch
and the designations are mutually consistent. The referenced sheet lists **four** lenses;
a 200 mm option is not on it. Each lens is its own preset, and all four carry
`"body": "FLIR A8303sc"`, so the editor lists the camera once and offers the lens as
a separate choice. They differ in focal length and nothing else. The 25 mm preset is
the one the palette places (`"bodyDefault": true`).

| Lens | Field of view (H × V) | IFOV |
|---|---|---|
| 17 mm | 55.6° × 33.0° | 0.82 mrad/px |
| 25 mm | 39.4° × 22.8° | 0.56 mrad/px |
| 50 mm | 20.3° × 11.5° | 0.28 mrad/px |
| 100 mm | 10.2° × 5.8° | 0.14 mrad/px |

All derived: `2·atan(sensor / 2f)` for the field of view and `pitch / f` for the IFOV.

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

## Not backed by a referenced sheet

`flir-t650sc-25deg` carries `intrinsicsSource: "datasheet"` but has no sheet listed here. Its
numbers — 640 × 480 at 17 µm, 24.6 mm standard lens — come from FLIR's published T650sc
specification. Reference that sheet or downgrade the preset before treating it as
checkable; today it is the one seeded preset whose audit trail stops at this sentence.

`CONVENTIONS.md` section 4 is the normative statement of which quantities are stored and
which are derived.
