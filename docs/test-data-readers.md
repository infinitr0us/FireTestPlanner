# Measured table readers (M16 part 1)

These APIs read cached table values independently of the plan model. They do not
change the file format, evaluate formulas, execute macros, convert units, apply
calibration, or interpolate samples. See [the design](test-data-design.md).

| Operation | TypeScript (`web/src/core/`) | Python (`fireplan`) |
| --- | --- | --- |
| Workbook sheet names, in workbook order | `await xlsx.listSheets(bytes)` | `xlsx.list_sheets(raw)` |
| Dense cached-value grid | `await xlsx.readSheet(bytes, sheetName)` | `xlsx.read_sheet(raw, sheet_name)` |
| Delimited text grid | `tables.readDelimited(text)` | `tables.read_delimited(text)` |
| Layout guess | `tables.detectShape(grid)` | `tables.detect_shape(grid)` |
| Units from a sheet's metadata tables | `tables.channelUnits(grid)` | `tables.channel_units(grid)` |
| Units merged across a workbook | `await xlsx.workbookChannelUnits(bytes)` | `xlsx.workbook_channel_units(raw)` |
| Numeric channels and warnings | `tables.extractSeries(grid, layout, unitsMap?)` | `tables.extract_series(grid, layout, units_map=None)` |
| Agreed workbook ignition shift | `await xlsx.workbookTimeShiftHint(bytes)` | `xlsx.workbook_time_shift_hint(raw)` |
| Optional ignition shift hint | `tables.timeShiftHint(grid)` | `tables.time_shift_hint(grid)` |
| Optional calibration hint | `tables.calibrationHint(name, unit)` | `tables.calibration_hint(name, unit)` |

TypeScript accepts `Uint8Array`; Python accepts `bytes`. The TypeScript workbook
operations are asynchronous because ZIP decompression uses `DecompressionStream`.
Python returns dataclasses for layouts, channels, extraction results and hints;
their field names are snake_case. TypeScript uses interfaces and camelCase.
The fixture JSON uses the TypeScript spelling.

Grids are rectangular arrays/lists containing finite numbers, strings or null/None.
Workbook error cells become null and are also recorded in `grid.errors` as
`{row, column, code}`. Rows are 1-based, columns 0-based. TypeScript's metadata is
non-enumerable; Python uses a list subclass. JSON serialization remains a plain
array. Plain arrays/lists also work with the pure interpretation functions.
Keep the returned grid to retain error metadata. Extraction emits a warning for
every recorded error cell in row/column order, including errors outside the chosen
data range. If no channel survives, the extraction warning list is instead exactly
`["No time series on this sheet."]`; the grid still retains every error in its metadata.

`channelUnits` returns a `Map<string, string>`; Python returns a dictionary. It
locates rows containing both `Channel` and `Unit` (case-insensitive, any column
order), then reads until a wholly blank row. Other tables before/after it are
ignored. Names are trimmed; unit values retain their original text. Later nonempty
entries win within a sheet and then in workbook sheet order. Workbook scanning
reuses workbook metadata and shared strings, extracting sheet grids sequentially.
Pass the map to extraction for units missing from the sheet itself; local units
always take precedence. Matching uses the original channel name before duplicate
suffixes are added.

## Detection decisions

These rules are mirrored and tested in both engines. The returned layout is a
guess and is intended to be overridden by the future UI. All layout rows are
1-based and `timeColumn`/`time_column` is 0-based.

1. Before the first row with two leading numeric cells, look for adjacent
   `<name>_Time` or `<name>_Time*` / `<name>` pairs, case-insensitively. Matched
   pairs must cover more than half the nonempty text headers. This is
   `paired-time`; a following units row is optional. Each recognized pair keeps
   its own time column. Unpaired columns are not channels in this shape.
2. Row 1 starting with `s` and row 2 starting with `Time` is `fds`, with names in
   row 2, units in row 1, data from row 3 and time in column 0.
3. A first row with two leading numeric cells below row 2 is `processed`.
   Compose each column from **all rows before the data**, top to bottom. Ignore
   empty/numeric cells, parenthesized notes, the note `Calculated`, and any
   non-unit text repeated in at least three columns of the same row. This last
   rule treats `Free_0`, `Free_0r`, or any other repeated text alike. The first
   remaining non-unit text is the name; the first unit-like text is the unit.
   Unit-like means an entire bracketed token, even an unknown one such as `[mim]`,
   or a bare token from the vocabulary in both `tables` modules. Once found,
   neither name nor unit is replaced by later notes or short symbols.
   `headerRow` and `unitsRow` remain representative preview rows: the non-unit row
   with most distinct nonempty names (earliest on ties) and the nearest majority-unit
   row (following on distance ties). They do not restrict processed header composition.
4. Otherwise use `plain`: row 1 names, row 2 data, or row 2 units and row 3 data
   when row 2 contains text and no numbers. A single names row followed by a
   recognized units row remains `plain`, even though its numeric data starts in
   row 3. This resolves the overlap between the design's plain-units case and
   the processed-sheet heuristic.

Processed/plain default time is the first header containing `time` or identifying
seconds by name/unit, with an
initial increasing numeric pair (one finite sample is sufficient for a one-sample
table). Missing cells are ignored for this check. Prefer a candidate whose composed header
or units identify seconds (`s`, `sec`, `secs`, `second`, `seconds`). Fall back to
column 0. Only the initial pair is tested because filled formulas can reset later;
extraction reports that reset. A missing first data value can make the first
two-number-row heuristic choose a later start, so callers can override `dataRow`.

## Extraction decisions

- All non-time columns with a header or data become candidate channels. Alternate
  time columns remain ordinary channels; selecting seconds does not erase minutes.
  Unnamed columns use `Column A`, `Column B`, etc. Completely blank columns are
  ignored. Plain/FDS/paired-time names still come from their single names row.
  Unit display removes surrounding brackets and normalizes `Volt`/`Volts` to `V`,
  `C`/`ºC` to `°C`, and `sec` to `s`. These aliases are recognized case-insensitively.
  Other unit spelling is retained. `rawUnit` (`raw_unit` in Python) preserves the
  original unit cell or metadata string, including brackets and whitespace. Neither
  normalization nor metadata fallback changes recorded samples.
- A missing, textual, nonfinite or error time/value skips that sample and adds one
  to that channel's `missing`. Missing time does not end a series. Numeric times
  are checked even when the corresponding value is missing.
- The first repeated or decreasing numeric time ends all series sharing that time
  column, before that row. Emit one warning naming the column and sheet row.
  Rows at or after that cutoff are not counted as missing.
- If a duplicated name has different normalized units, all members get unit
  labels, such as `Gauge [V]` and `Gauge [kW/m2]` (`[unknown]` for a missing unit).
  Duplicates with the same unit get `#2`, `#3`, etc. Every changed name gets a warning.
  Literal names and generated labels are reserved to avoid collisions. Channels
  with no numeric samples are warned about and dropped; if all are dropped, emit
  only `No time series on this sheet.` instead of per-column diagnostics.
- Warning order is error cells, time cutoffs in time-column encounter order, then
  duplicate/drop warnings in channel order. Both suites pin the exact text.
- Calibration accepts a positive decimal constant followed by `kW/m2 per mV`
  (spaces optional; `m²` also accepted) only when the supplied input unit is
  V/Volt/Volts, mV, or absent. Bracketed voltage units also work. `23.17` yields
  scale `23170` from V and `23.17` from mV. Already calibrated `kW/m2`/`kW/m²`, other
  known quantities, and unfamiliar but present units are rejected. Only an absent
  unit assumes V. The result's `inputUnit`/`input_unit` states `V` or `mV`; output
  unit is `kW/m2`. Hints are never applied automatically.

`timeShiftHint` looks only above the detected data start, or throughout a sheet
with no leading numeric data pair. A label matching `sh(i)?ft`, `ignition at`, or
`offset` first considers finite numbers directly above and below. Only if neither
vertical neighbour is numeric does it consider numbers immediately beside it.
Different vertical values remain ambiguous, even if a beside value agrees with one.
No candidates or conflicting candidates across labels returns null/None; equal
values agree. The first candidate in row/column order supplies the location.
The returned `{seconds, row, column}` uses a 1-based row and 0-based column.
Thus `420` above `shft time` with an unrelated `0.72` beside it yields 420.
Hints report seconds without changing timestamps.

`workbookTimeShiftHint` scans the sheets detected as `processed` (the shift is
written in the header above their data; a logger's metadata sheet has an `offset`
column of its own, which on a real workbook made three agreeing 420 s hints read as
ambiguous), ignores null sheet hints, and returns `{seconds, sheets}` when all
remaining values agree. Python returns a dataclass
with the same fields. `sheets` lists contributing sheet names in workbook order.
No hints or disagreement returns null/None. Scanning reuses workbook metadata and
shared strings and retains one sheet grid at a time.

## Reader bounds and fixtures

Workbook part relationships determine sheet locations. Only the selected sheet,
workbook metadata and optional shared strings are extracted; styles, other sheets,
images and VBA are ignored. Strings preserve XML whitespace and rich-text runs;
phonetic annotations are excluded. Dates remain their cached numbers (or strings
for explicitly typed ISO dates), with no date/style interpretation. `.xls` and
`.ods` are refused with an instruction to save as `.xlsx` or `.csv`.

The dense workbook grid is limited to 10,000,000 cells and Excel's row/column bounds.
This prevents a stray far-away reference from allocating an unbounded rectangle.
Formatting dimensions do not set the bounds; explicit rows and cell references do.
The shared ZIP reader supports stored/deflated members and retains `readZip` as an
eager compatibility wrapper. ZIP64 and encrypted members are unsupported.

Delimited readers count comma/tab/semicolon separators outside quotes on the first
nonempty logical record; ties prefer tab, then semicolon, then comma, with comma
as the no-separator default. They preserve blank records for sheet-row numbering,
trim fields as the existing reconstruction importer does, and pad short rows with
null. The reconstruction importer shares that parser but retains its previous
blank-row skipping, row limit and stricter measurement validation.

`python -S tools/build_test_data_fixture.py` uses only the stdlib and the reader
modules to generate all files in `fixtures/test-data/`, including `expected.json`.
The workbook has metadata first, 600 logger samples at 0..599 s, processed data
at -120..479 s, errors, duplicate/all-missing channels and a reset at sheet row 605.
Its processed headers mix names across rows, `Free_0`/`Free_0r` fillers, `[mim]`
minutes beside `[sec]` seconds, parenthesized and `Calculated` notes, `[ºC]`,
and gauges in V, mV and kW/m2. The shift hint is 120 seconds at B3; the unrelated
numeric header note is placed at D4 so it does not touch the B4 shift label.
A supplementary metadata sheet tests merging, a constants sheet tests ambiguous
shift values, and the rich/inline-string sheet remains. The instruments total **13** channels
(3 gauges + 5 tree beads + 2 duct thermocouples + O2 + CO2 + pressure); the fixture
preserves all of them despite the original brief's total of 12. The logger has
**no units row**; units come from the metadata tables. All values are synthetic.

Both suites compare every fixture layout, metadata map, channel name, normalized
and raw unit, column, sample count, missing count, first/last pair, shift hint,
calibration hint and warning; numeric tolerance is relative 1e-12.
Unit tests cover independent hand-written XML/table cases, and each suite times
reading an in-memory 5,000-row by 60-column workbook (3 s TypeScript, 15 s Python).
No browser or native UI behavior is changed or verified by this reader-only work.


## Plan sources (part 2)

The format 1.6 model and series API are specified in CONVENTIONS section 12 and
[test-data-design.md](test-data-design.md). Part 1 readers remain independent of
plans and calibration. `python tools/build_test_data_model_fixture.py` builds the
plan and `series-expected.json` from the existing reader fixtures without changing
them. This sibling builder uses the installed numpy/jsonschema dependencies of
fireplan; the original reader-only builder still works with `python -S`.
