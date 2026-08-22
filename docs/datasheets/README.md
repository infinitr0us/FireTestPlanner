# Manufacturer datasheets

Source documents for the seeded entries in `presets/cameras.json`. Kept in the repo so
that `intrinsicsSource: "datasheet"` is a claim someone can check rather than one they
have to take on trust.

| File | Covers | Preset(s) it backs |
|---|---|---|
| `flir-a8303sc.pdf` | FLIR A8303sc (P/N 29244-203, publ. 29244-203, 2018-11-13) | `flir-a8303sc-25mm` |
| `flir-a400-a500-a700-science-kits.pdf` | FLIR A400 / A500 / A700 Science Kits (rev. 10/26/23) | `flir-a700-24deg` |

## Deriving intrinsics from these

`sensor_mm` is not printed on either datasheet. It is `resolution_px × detector pitch`,
both of which are — that is the whole reason the pitch is quoted.

**FLIR A8303sc.** 1280 × 720 at 14 µm gives 17.92 × 10.08 mm. The nominal focal lengths
(17, 25, 50, 100, 200 mm) are used as printed: with this sensor a 25 mm lens works out
at 39.4° × 22.8°, which is what FLIR publishes for the A8300sc family, so the pitch and
the lens designations are mutually consistent and nothing needs back-solving.

**FLIR A700.** 640 × 480 at 12 µm gives 7.68 × 5.76 mm. Here the datasheet's own numbers
do *not* close: it names the standard lens "17 mm" but publishes 24° × 18° and
0.66 mrad/pixel, and 7.68 mm at 17 mm focal length is 25.4°, not 24°. The published FOV
and the published IFOV agree with each other (24° ÷ 640 px = 0.65 mrad), so the "17 mm"
is a nominal lens designation — the same one FLIR prints for the A500, whose array is a
different size. The preset therefore back-solves the focal length from the published
field of view, 7.68 / (2·tan 12°) = 18.07 mm, which reproduces 24.0° × 18.1° and
0.66 mrad/px exactly. An engineer holding the datasheet sees the numbers on it.

`CONVENTIONS.md` section 4 is the normative statement of which quantities are stored and
which are derived.
