# Manufacturer datasheets

Source documents for the seeded entries in `presets/cameras.json`, listed so that
`intrinsicsSource: "datasheet"` is a claim someone can check rather than one they have
to take on trust. That holds only if every number here can be found in *these*
documents, so anything derived or assumed is labelled as such below. The `nominal`
presets that do have a source are listed too, so their derivations can be checked the
same way.

The documents are their publishers' copyrighted material and are not redistributed in
this repository. Download them from the pages below (on a FLIR product page the
datasheet is under *Resources*). For the first two sheets, the SHA-256 identifies the
exact revision the presets were checked against; a later revision may differ. The
documents added on 2026-11-02 are pinned by the revision or date each one carries
rather than by a checksum, because they were checked as published, without a local
copy to hash. Where a manufacturer's own document is hosted by a distributor, the
table says so.

| Document | Where to get it | What it actually is | Preset(s) it backs |
|---|---|---|---|
| FLIR A8300sc datasheet (`flir-a8303sc.pdf`, SHA-256 `db28d573112ed24ee44ce684d4027456f3a2f749e70194fa52406e5a58f5c839`) | [FLIR A8300sc product page](https://www.flir.com/products/a8300sc/) | Marked "Updated 09/28/15". The A8303sc is a temperature-range variant of this body; the imaging specifications the preset uses are the family's, and the sheet does not name the `03` variant. | `flir-a8303sc-17mm`, `-25mm`, `-50mm`, `-100mm` |
| FLIR A8303sc datasheet, P/N 29244-203 | [FLIR PDF](https://support.flir.com/DsDownload/Assets/29244-203-en-US_A4.pdf) | Modified 2018-11-13, formatted 2019-05-02. Specific to the A8303sc: prints 1280 × 720 at 14 µm, f/4.0, 60 Hz, "Available Lenses: 17 mm, 25 mm, 50 mm, 100 mm, 200 mm" and "Close-up Lenses/Microscopes: 1X, 4X". | All five `flir-a8303sc-*` presets; the only source of `-200mm` |
| FLIR A700 24° Professional Science Kit, P/N 85902-0102 | [FLIR datasheet page](https://support.flir.com/DsDownload/Assets/85902-0102-en-US.html) | Revision 93984, modified 2023-11-01. A second 24° kit: prints its lens as 17 mm, f/1.3, 24° × 18°, the 12 µm pitch, and lists T300239 (10 mm, 42°), T300240 (17 mm, 24°), T300241 (29 mm, 14°), T300586 (dual FOV, 17/29 mm) and T300095 (70 mm, 6°). | `flir-a700-24deg-17mm`; cross-check of the 10, 29 and 70 mm lenses |
| FLIR T300240, IR lens f=17 mm (24°) | [FLIR product page](https://www.flir.com/products/t300240/) | Undated web page. Names the lens by focal length and angle. | `flir-a700-24deg-17mm` |
| FLIR T650sc datasheet ("updated 5/14") | Formerly hosted by the University of Cambridge at `cambeep.eng.cam.ac.uk/system/files/documents/flir-t650sc-datasheet-updated-5-14.pdf`, now redirected to an archive; a FLIR-authored copy | Read from its indexed text on 2026-11-02, not opened. Prints 640 × 480, 17 µm pitch, f/1.0 and "Available Lenses: 88.9 mm (7°), 41.3 mm (15°), 24.6 mm (25°), 13.1 mm (45°), 6.5 mm (80°)". The A655sc sheet prints the same five lenses on the same array. | All five `flir-t650sc-*` presets |
| FLIR T650sc support page | [FLIR support page](https://www.flir.com/support/products/t650sc/) | Undated; read on 2026-11-02. Marks the T650sc **Discontinued** and lists the lenses as accessories with their part numbers: T198166 (7°, 88.9 mm), T197914 (15°, 41.3 mm), T197922 (25°, 24.6 mm), T197915 (45°, 13.1 mm), T198065 (80°, 6.5 mm), and three close-up lenses. It calls the integrated lens "18 mm (25°)", which its own T197922 entry contradicts. | Part numbers of the `flir-t650sc-*` presets |
| FLIR T197914, IR lens 15° | [Datasheet](https://tester.co.uk/files/get/download/id/2612/flir-t197914-thermal-camera-lens-datasheet.pdf), a FLIR-authored copy hosted by the distributor Tester | Read from its indexed text. Prints 41.3 mm, 15° × 11° (19° diagonally) and a 500 mm minimum focus distance. | `flir-t650sc-15deg` |
| FLIR A400 / A500 / A700 Science Kits datasheet (`flir-a400-a500-a700-science-kits.pdf`, SHA-256 `ec7b4b65ce871d8f746368fb0b98d66fedac755f749738864d3a425a48a1e406`) | [FLIR A400/A700 Science Kits product page](https://www.flir.com/products/a400-a700-science-kits/) | Rev. 10/26/23. One sheet for three bodies, so several rows read "camera dependent" without saying which value belongs to the A700. | The A700's resolution, band and frame rate, which agree with sheet 85903-0102 below. No longer the source of its pitch or of any focal length. |
| FLIR A700 24° f/1.0 Professional Science Kit datasheet, P/N 85903-0102 | [FLIR datasheet page, with PDF download links](https://support.flir.com/dsdownload/assets/85903-0102-en-us.html) | Revision 98866, modified 2024-08-21. Specific to the A700 body: prints 640 × 480, the 12 µm pitch, 7.5–14 µm, 30 Hz and the 18 mm lens. | The A700 body (all five `flir-a700-*` presets); the focal length of `flir-a700-24deg` |
| FLIR T300095, IR lens 6° with case | [FLIR product page](https://www.flir.com/products/t300095-lens-6-degree-with-case/) (undated); [datasheet](https://assets.testequity.com/te1/Documents/pdf/flir/flir-t300095-datasheet.pdf), a FLIR-authored copy hosted by the distributor TestEquity | Datasheet revision 79192, modified 2021-09-08. Prints 70 mm, 6° × 4.5° and distortion below 4.2%. | `flir-a700-6deg` |
| FLIR T300241, IR lens 14° | [FLIR product page](https://www.flir.com/products/t300241/) (undated); [datasheet](https://www.apliter.com/wp-content/uploads/2022/02/lente-IR-14o-A400-A500-A700-ficha-tecnica.pdf), a FLIR-authored copy hosted by the distributor Apliter | Datasheet revision 79639, © 2022. Prints 29 mm and 14° × 10°. The copy could not be fetched directly when it was checked; its indexed text was read. | `flir-a700-14deg` |
| FLIR T300239, IR lens 42° | [FLIR product page](https://www.flir.com/products/t300239/) | Undated web page with no revision. Prints 10 mm and 42° × 32°. | `flir-a700-42deg` |
| FLIR T300805, IR lens 80° | [FLIR product page](https://www.flir.com/products/t300805_ir-lens-f4.7mm-deg-80) (undated); [datasheet](https://www.datatec.eu/media/ea/98/b3/1702462303/Teledyne%20FLIR-T300805-DB-1_DE.pdf), a FLIR-authored copy hosted by the distributor dataTec | Datasheet revision 93944, modified 2023-10-31; read from its indexed text. Prints 5 mm and 80° × 63°. The product page's address says `f4.7mm`, but its displayed name and the datasheet both say 5 mm, and an address is not a specification. | `flir-a700-80deg` |
| FLIR support answer 6493, lens table for the A50/A70 and A400/A500/A700 smart sensors | [FLIR knowledge base](https://flir.custhelp.com/app/answers/detail/a_id/6493/~/flir---a50%252F-a70-%2526-a400%252F-a500%252F-a700--series---smart-sensor) | Undated manufacturer page, read from its indexed text. Lists the A-series lenses with focal lengths, including two 24° lenses: 17 mm f/1.3 and 18 mm f/1.04. | Cross-check of `flir-a700-42deg` (10 mm); the 17 mm alternative noted for `flir-a700-24deg` |
| FLIR *Product Catalog 2018: FLIR Fire Products*, publication T810221-en-US | [FLIR PDF](https://support.flir.com/DSDownload/Assets/T810221-en-US_USL-lr.pdf) | Updated 2018-03-12. Its K65 sheet (pp. 71–73) is P/N 72202-0303, revision 46856, modified 2017-12-12. | `flir-k65-9mm` |
| FLIR ONE Pro datasheet, document 17-1746-OEM-FLIROne_Pro | [Datasheet](https://pim-resources.coleparmer.com/data-sheet/39756-77-79-flir-one-pro-datasheet.pdf), a FLIR-authored copy hosted by the distributor Cole-Parmer | Dated 2017-06-06; the specifications are on page 2. | `flir-one-pro-55deg` |
| Canon *VIXIA HF R50/R52/R500 HD Camcorder Instruction Manual*, PUB. DIE-0448-000A | [Canon PDF](https://gdlp01.c-wss.com/gds/7/0300013657/02/hfr50-52-500-im2-n-en.pdf), linked from the [Canon USA support page](https://www.usa.canon.com/support/p/vixia-hf-r50) | Canon's support page dates this download 2014-03-05. The specifications used are on pp. 79, 140 and 184–185. | `canon-vixia-hf-r50-optical-wide` (nominal) |
| Canon Camera Museum, *VIXIA HF R52/R50/R500* | [Canon page](https://global.canon/en/c-museum/product/dhc770.html) | Undated page for a camcorder marketed in January 2014. | Cross-check of the 2.8–89.6 mm lens |
| Apple, *iOS Device Compatibility Reference: Cameras* | [Apple developer archive](https://developer.apple.com/library/archive/documentation/DeviceInformation/Reference/iOSDeviceCompatibility/Cameras/Cameras.html) | Updated 2017-10-30. Table 4-4 prints the field of view of each capture format; table 4-3 defines it as horizontal. | `iphone-x-rear-wide-1080p` (nominal) |
| Apple, *iPhone X Technical Specifications* | [Apple support page](https://support.apple.com/en-my/111864) | Undated support page for a 2017 phone. Lists the video modes. | `iphone-x-rear-wide-1080p`, frame rate |
| Digital Camera Watch, iPhone X review | [Review](https://dc.watch.impress.co.jp/docs/review/special/1089748.html) | Published 2017-11-03. A third-party review, not an Apple document. | `iphone-x-rear-wide-1080p`, focal length |

`sensor_mm` is printed on none of these. Where a pitch is printed, it is
`resolution_px × detector pitch`, both of which are printed, and that is the whole
reason the pitch is quoted. Where no pitch is printed (the Canon and the iPhone), it is
inferred from an angle and labelled as such.

## FLIR A8300sc / A8303sc, 17, 25, 50, 100 and 200 mm lenses

| Preset field | Value | Where it comes from |
|---|---|---|
| `resolution_px` | 1280 × 720 | printed — "Resolution" |
| detector pitch | 14 µm | printed — "Detector Pitch" |
| `sensor_mm` | 17.92 × 10.08 | derived — 1280 × 14 µm, 720 × 14 µm |
| `focalLength_mm` | 17, 25, 50, 100, 200 | printed — "Available Lenses: 17 mm, 25 mm, 50 mm, 100 mm, 200 mm" on the A8303sc sheet (P/N 29244-203); the 2015 A8300sc sheet stops at 100 mm |
| `spectralBand_um` | 3.0 – 5.0 | printed — "Spectral Range" |
| `framerate_hz` | 60 | printed — "Max Frame Rate: 60Hz @ Full Window" |
| field of view | per lens, below | derived from the sensor and the lens; the sheets print no field of view |

Nothing is back-solved here: the lenses are designated by focal length, and the pitch
and the designations are mutually consistent. The A8300sc sheet of 2015 lists four
lenses; the A8303sc's own sheet of 2018 adds a 200 mm one. Each lens is its own preset,
and all five
carry `"body": "FLIR A8303sc"`, so the editor lists the camera once and offers the lens
as a separate choice. They differ in focal length and nothing else. The 25 mm preset is
the one the palette places (`"bodyDefault": true`).

| Lens | Field of view (H × V) | IFOV |
|---|---|---|
| 17 mm | 55.6° × 33.0° | 0.82 mrad/px |
| 25 mm | 39.4° × 22.8° | 0.56 mrad/px |
| 50 mm | 20.3° × 11.5° | 0.28 mrad/px |
| 100 mm | 10.2° × 5.8° | 0.14 mrad/px |
| 200 mm | 5.1° × 2.9° | 0.07 mrad/px |

All derived: `2·atan(sensor / 2f)` for the field of view and `pitch / f` for the IFOV.

The sheet's 1X and 4X microscopes are close-up optics for small targets at short range,
not lenses for a standoff, and are not presets. The A8303sc sheet also
prints its temperature ranges: −20 to 350 °C as standard, and 250 to 2000 °C (ND1) or
500 to 3000 °C (ND2) as options with band-matched optics. A camera meant to read a
flame needs one of the optional ranges; that is a radiometric choice the plan does not
model.

## FLIR A700, 6°, 14°, two 24°, 42° and 80° lenses

The body, from the A700's own science-kit sheet (P/N 85903-0102, revision 98866):

| Preset field | Value | Where it comes from |
|---|---|---|
| `resolution_px` | 640 × 480 | printed on 85903-0102, and on the multi-body sheet as "640 × 480 (A700)" |
| detector pitch | 12 µm | printed on 85903-0102. The multi-body sheet prints only "24 µm, 17 µm, or 12 µm - camera dependent", which is why this README used to call the pitch assumed |
| `sensor_mm` | 7.68 × 5.76 | derived from 640 × 12 µm and 480 × 12 µm |
| `spectralBand_um` | 7.5 – 14.0 | printed on both sheets |
| `framerate_hz` | 30 | printed on both sheets |
| `focalLength_mm` | per lens, below | printed for every lens |

FLIR designates these lenses by angle, and the multi-body sheet names them only that
way (24° included; 6°, 14°, 42° and 80° optional). The "17 mm" on that sheet is a
minimum focus distance in macro mode, not a focal length. FLIR does print a focal length
for every one of them elsewhere: the 24° lens on the A700 sheet, and each optional lens
on its own product page and, except the 42°, its own datasheet; the second 24° lens,
T300240, on its product page and on kit sheet 85902-0102. All six presets therefore
store a printed focal length, and nothing is back-solved. They carry
`"body": "FLIR A700"` and differ in focal length only; the palette lists the camera
once and places the 18 mm 24° lens (`"bodyDefault": true`), and the inspector offers
the others under **Lens**.

| Preset | Lens | `focalLength_mm` (printed) | Printed source | IFOV (derived, pitch / f) |
|---|---|---|---|---|
| `flir-a700-80deg` | T300805, 80° | 5 | T300805 datasheet, revision 93944; product page | 2.40 mrad/px |
| `flir-a700-42deg` | T300239, 42° | 10 | T300239 product page; FLIR lens table | 1.20 mrad/px |
| `flir-a700-24deg-17mm` | T300240, 24° f/1.3 | 17 | A700 science-kit sheet 85902-0102, revision 93984; product page | 0.71 mrad/px |
| `flir-a700-24deg` | 24° f/1.0 | 18 | A700 science-kit sheet 85903-0102, revision 98866 | 0.67 mrad/px |
| `flir-a700-14deg` | T300241, 14° | 29 | T300241 datasheet, revision 79639; product page | 0.41 mrad/px |
| `flir-a700-6deg` | T300095, 6° | 70 | T300095 datasheet, revision 79192; product page | 0.17 mrad/px |

**The printed focal lengths and the printed angles do not all agree.** The editor
derives the field of view from the sensor and the focal length, so for each lens it
shows the third column below and not the angle FLIR prints:

| Lens | Printed focal length | Pinhole field of view on 7.68 × 5.76 mm (H × V) | Printed field of view (H × V) | Focal length the printed horizontal angle needs |
|---|---|---|---|---|
| 6° | 70 mm | 6.28° × 4.71° | 6° × 4.5° | 73.27 mm |
| 14° | 29 mm | 15.09° × 11.34° | 14° × 10° | 31.27 mm |
| 24° (f/1.3) | 17 mm | 25.46° × 19.23° | 24° × 18° | 18.07 mm |
| 24° (f/1.0) | 18 mm | 24.09° × 18.18° | 24° (designation) | 18.07 mm |
| 42° | 10 mm | 42.01° × 32.13° | 42° × 32° | 10.00 mm |
| 80° | 5 mm | 75.05° × 59.88° | 80° × 63° | 4.58 mm |

All derived: `2·atan(sensor / 2f)` for the field of view, and `7.68 / (2·tan(h / 2))`
for the last column. The 24° and 42° lenses agree with their angles to within
rounding. The 6°, 14° and 80° lenses do not: under an ideal pinhole the printed focal
length and the printed angle differ by 0.3° to 5° horizontally, and no source found
says whether the angles are rounded, include distortion or follow another convention.
The T300095 sheet allows distortion below 4.2%. The presets keep the printed focal
length, because that is the lens on the camera. Read the field of view of these three
as a framing estimate, and calibrate before using them for reconstruction.

**The two 24° lenses.** FLIR sells two lenses designated 24° for this body, and both are
presets. The palette places the f/1.0 lens of science kit 85903-0102, which that sheet
prints as 18 mm. Before 2026-11-02 the preset stored 18.07 mm, back-solved from the 24°
designation because the multi-body sheet prints no focal length. The other is T300240,
17 mm f/1.3, the lens of science kit 85902-0102 and of FLIR's lens table; under a pinhole
it gives 25.46° × 19.23°, about 1.5° wider than its printed 24° × 18°. Only the lens
itself says which of the two is fitted, so check the barrel and pick it under **Lens**.

The same kit sheet lists a dual-FOV lens, T300586 (17/29 mm, 24°/14°). It is the 17 mm
and the 29 mm lens in one barrel, so a camera fitted with it takes one of those two
entries under **Lens**, whichever setting is used. The 2.0× macro lens (T300238) and the
24° lens's macro mode are close-up options for small targets, not standoff lenses, and
are not presets.

## FLIR K65

From the K65 sheet in FLIR's 2018 Fire Products catalog (P/N 72202-0303, revision 46856):

| Preset field | Value | Where it comes from |
|---|---|---|
| `resolution_px` | 320 × 240 | printed |
| detector pitch | 25 µm | printed |
| `sensor_mm` | 8.0 × 6.0 | derived from 320 × 25 µm and 240 × 25 µm |
| `focalLength_mm` | 9 | printed, here and on the current product page |
| `spectralBand_um` | 8 – 14 | printed on this sheet. The current [K65 product page](https://www.flir.com/products/k65/) (undated) lists 7.5–13 µm instead |
| `framerate_hz` | 60 | printed image frequency. The cadence of the recorded MPEG-4 video is not specified |
| field of view | 47.9° × 36.9° | derived. The sheet and the product page print 51° × 38° |

The printed 9 mm and the printed 51° × 38° disagree under a pinhole. The horizontal
angle would need 8.39 mm and the vertical one 8.71 mm, so no single focal length
reproduces both. The preset keeps the printed focal length, which makes its field of
view about 3° narrower than FLIR's horizontally. The band follows the dated,
model-specific sheet. The K65 records non-radiometric video, and its 2× digital zoom
belongs in the **Zoom** field.

## FLIR ONE Pro

From the 2017 FLIR ONE Pro datasheet (17-1746-OEM-FLIROne_Pro, dated 2017-06-06):

| Preset field | Value | Where it comes from |
|---|---|---|
| `resolution_px` | 160 × 120 | printed thermal resolution |
| detector pitch | 12 µm | printed |
| `sensor_mm` | 1.92 × 1.44 | derived from 160 × 12 µm and 120 × 12 µm |
| `focalLength_mm` | 1.84414 | **derived.** The sheet prints no focal length; 1.92 / (2·tan 27.5°) = 1.84414 mm reproduces the printed 55° horizontal field |
| `spectralBand_um` | 8 – 14 | printed |
| `framerate_hz` | 8.7 | printed |
| field of view | 55.0° × 42.7° | derived. The sheet prints 55° ± 1° × 43° ± 1°, so the vertical falls inside its tolerance |

The preset describes the thermal detector. The app records 1440 × 1080 video, processed
from the 160 × 120 array (MSX adds edges from the visible camera), so its pixels are
not extra thermal samples. The current [FLIR ONE Pro product page](https://www.flir.com/products/flir-one-pro/)
(undated) prints 50° ± 1° × 43° ± 1° for the same array. A 50° horizontal field would
need 2.06 mm and give only 38.6° vertically, outside its own tolerance, and no source
found explains the change, so the preset follows the dated sheet. That this is the 2017
ONE Pro rests on the name. The older, non-Pro second-generation FLIR ONE prints
46° × 35° on the same array ([FLIR ONE datasheet](https://www.instrumart.com/assets/FLIR-ONE-datasheet.pdf),
updated 07/15, a FLIR-authored copy hosted by the distributor Instrumart) and is not
this preset.

## Nominal presets with a source

These two are `nominal` because one stored quantity is inferred rather than printed, but
each inference is written out so that it can be checked or replaced.

### Canon VIXIA HF R50, optical wide

From the instruction manual (PUB. DIE-0448-000A), cross-checked against Canon's museum page:

| Preset field | Value | Where it comes from |
|---|---|---|
| `resolution_px` | 1920 × 1080 | printed, MP4 recording |
| `focalLength_mm` | 2.8 | printed, the wide end of the 2.8–89.6 mm zoom |
| `sensor_mm` | 2.74255 × 1.54269 | **inferred** from the 35 mm equivalent, below. The manual gives the sensor only as a 1/4.85-inch CMOS, which is a size class rather than a dimension |
| `spectralBand_um` | none | a visible camera; no band is stored |
| `framerate_hz` | 30 | printed, Canon's 30P mode (24P and 60P are also offered) |
| field of view | 52.2° × 30.8° | derived; Canon prints no angle |

The manual prints 38.5 mm equivalent at the wide end with Advanced Zoom off. Assuming
the equivalence is matched on the diagonal of a 36 × 24 mm frame:

```
D = hypot(36, 24) × 2.8 / 38.5 = 3.1467 mm
W = D × 16 / √337              = 2.7426 mm
H = D × 9 / √337               = 1.5427 mm
```

Canon does not say how its equivalent is matched, and this is the extent of the recorded
image, not of the silicon, which is why the preset is `nominal`. With Advanced Zoom on,
the widest view is 32.5 mm equivalent (about 60° horizontally under the same
assumption); this preset is the optical-only view. Image stabilisation may crop further.

### iPhone X, rear wide, 1080p

| Preset field | Value | Where it comes from |
|---|---|---|
| `resolution_px` | 1920 × 1080 | printed, Apple's capture-format reference, table 4-4 |
| `focalLength_mm` | 4.0 | **third-party.** Reported by the Digital Camera Watch review; Apple does not print it |
| `sensor_mm` | 4.71076 × 2.6498 | **fitted**: W = 2 × 4 × tan(60.983° / 2), H = W × 9 / 16 |
| `spectralBand_um` | none | a visible camera; no band is stored |
| `framerate_hz` | 30 | printed, 1080p at 30 or 60 fps (iPhone X technical specifications) |
| field of view | 60.98° × 36.65° | the horizontal is printed (table 4-4, 60.983°); the vertical is derived |

The extent is the effective image plane of the 1080p video, fitted so that the review's
focal length reproduces Apple's horizontal angle. It is not the size of the sensor. The
generic `iphone-main-26mm` preset gives 69.4° horizontally, so on an iPhone X it
overstates the horizontal field by about 8°. Apple's reference says cinematic video
stabilisation reduces the field of view; lock the format and the stabilisation setting
when checking a plan against footage.

## FLIR T650sc, 7°, 15°, 25°, 45° and 80° lenses

From the T650sc datasheet ("updated 5/14") and FLIR's T650sc support page:

| Preset field | Value | Where it comes from |
|---|---|---|
| `resolution_px` | 640 × 480 | printed on the datasheet |
| detector pitch | 17 µm | printed on the datasheet |
| `sensor_mm` | 10.88 × 8.16 | derived from 640 × 17 µm and 480 × 17 µm |
| `focalLength_mm` | 88.9, 41.3, 24.6, 13.1, 6.5 | printed on the datasheet with each lens's angle, and in each lens's name on the support page |
| `spectralBand_um` | 7.5 – 14.0 | FLIR's T650sc specification, unchanged from the earlier preset |
| `framerate_hz` | 30 | FLIR's T650sc specification, unchanged from the earlier preset |

The five presets carry `"body": "FLIR T650sc"`; the palette places the standard 25°
lens. Unlike the A700's, every T650sc focal length reproduces its designation under a
pinhole:

| Preset | Lens | `focalLength_mm` (printed) | Pinhole field of view on 10.88 × 8.16 mm (H × V) | IFOV (pitch / f) |
|---|---|---|---|---|
| `flir-t650sc-80deg` | T198065, 80° | 6.5 | 79.85° × 64.23° | 2.62 mrad/px |
| `flir-t650sc-45deg` | T197915, 45° | 13.1 | 45.10° × 34.60° | 1.30 mrad/px |
| `flir-t650sc-25deg` | T197922, 25° (standard) | 24.6 | 24.94° × 18.83° | 0.69 mrad/px |
| `flir-t650sc-15deg` | T197914, 15° | 41.3 | 15.01° × 11.28° (printed 15° × 11°) | 0.41 mrad/px |
| `flir-t650sc-7deg` | T198166, 7° | 88.9 | 7.00° × 5.26° | 0.19 mrad/px |

FLIR's support page calls the integrated lens "18 mm (25°)". On this array 18 mm would
give 33.6°, and the same page lists the 25° lens as T197922, 24.6 mm, so the preset keeps
24.6 mm. The support page marks the T650sc as discontinued while still listing these
lenses; whether a lens can still be bought, and whether one bought separately must be
calibrated with the camera body, is a question for FLIR or a distributor. The close-up
lenses (1.5×, 2.9× and 5.8×; T198066, T198059, T198060) are for small targets at short
range and are not presets.

The band and frame rate were not on a sheet referenced here before 2026-11-02 and were
not re-read from the datasheet copy, which could only be read from its indexed text.
Check them against a FLIR copy before treating those two fields as checkable.

`CONVENTIONS.md` section 4 is the normative statement of which quantities are stored and
which are derived.
