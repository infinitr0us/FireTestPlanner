# Measured test data on the instruments: design (M16, format 1.6)

Status: design, 2026-11-02. Phase B of [PLAN.md section 9](../PLAN.md#9-next-round-2026-11).

## What it is for

A plan predicts what each instrument will read: a gauge's incident flux, a bead's plume
temperature, the burner's heat release rate. After the test the same instruments have
recorded what they did read, and often an FDS run has predicted it a second way. Today
the plan can link a spreadsheet to a gauge or a rake, but only to open it in another
program; only a burner's reconstruction CSV is plotted. This milestone puts the three
answers to one question side by side, on the instrument they belong to:

- **planned** (the plan's own correlation, CONVENTIONS section 5b),
- **simulated** (an FDS device of the same instrument),
- **measured** (a data-acquisition channel).

It also gives the crew an instrument schedule to wire the logger from.

## What the data looks like

A test's data arrives in one of four shapes. The reader detects the shape and shows
its guess; every guess can be overridden.

| Shape | Recognised by | Header | Time |
|---|---|---|---|
| **Logger export, paired time** | header cells `<name>_Time` (optionally with a trailing `*`) beside `<name>` | one row of names | a time column per channel, seconds from the start of logging |
| **Processed sheet** | several header rows above the first row whose leading cells are numbers | names in one of them, units in another (`[kW/m2]`, `[C]`) | one time column for the sheet, often already shifted to ignition |
| **FDS output** (`_devc.csv`, `_hrr.csv`) | first row of units starting `s`, second row starting `Time` | names in row 2, units in row 1 | the first column, seconds from the start of the simulation |
| **Plain table** | one header row | names in row 1; a units row if row 2 is all text | a column the user names, default the first |

A workbook holds several sheets, typically a raw logger sheet and hand-processed ones.
A source names the sheet it reads. Cells hold cached values: formulas are never
evaluated, and an error value (`#NUM!`, `#DIV/0!`) or an empty cell is a missing
sample, not zero. A time column that stops increasing (formula rows filled past the
end of the data are common) ends the series there, and the reader says at which row.

Supported files: `.xlsx` and `.xlsm` (Office Open XML), `.csv`, `.tsv` and `.txt`.
Not `.xls` (the binary format) or `.ods`: the reader says so and asks for one of the
others. Neither engine gains a dependency: an `.xlsx` is a ZIP of XML, the editor
already reads ZIP for flame frames, and Python has `zipfile` and `xml.etree`.

## The model (format 1.6)

A plan gains a root-level `testData` array. Each entry is a **source**:

```jsonc
"testData": [
  {
    "id": "td-1",
    "name": "Logger export",
    "file": { "id": "f-1", "kind": "spreadsheet", "path": "data/test-07.xlsx" },  // a linkedFile
    "table": { "sheet": "Log", "shape": "paired-time", "headerRow": 1, "unitsRow": null,
               "dataRow": 2, "timeColumn": null, "unitsSheet": null },
    "timeOffset_s": 420,          // the file's own time at ignition; plan time = file time - offset
    "role": "measured",           // "measured" | "simulated"
    "channels": [
      { "channel": "HF east 1.5 m", "object": "hf-east",
        "scale": 23170, "offset": 0 },               // V -> kW/m2 through the gauge's constant
      { "channel": "TC tree 1.5 m", "object": "tc-tree", "bead": 1 }
    ],
    "manifest": { "size": 16476599, "modified": "2026-09-03T15:02:11Z",
                  "rows": 5225, "channels": [ { "name": "HF east 1.5 m", "unit": "V",
                  "samples": 5225, "t0": 0, "t1": 5224 } ] }
  }
]
```

Decisions, and why:

- **A root-level list, not an object.** A data file is not anywhere in the room. As an
  object it would need a transform it does not have, a place in the scene graph and
  the outliner, and every spatial code path would learn to skip it. Its `file` is the
  existing `linkedFile` definition, so Save As rebases it like every other link
  (CONVENTIONS section 10); the rebasing in both engines learns one more location.
- **The mapping lives on the source, not on the instrument.** One instrument is
  usually recorded by one logger channel and simulated by one FDS device: two sources,
  each saying which of its columns is which instrument. Linking a second run of the
  same test is then one more source with its own mapping, and removing a source
  removes everything it brought.
- **A channel maps to an object, and to a bead of a rake.** The quantity is the
  object's: kW/m² for a gauge, °C for a bead, kW for a burner. `scale` and `offset`
  turn the column's own unit into it (`value = raw × scale + offset`), so a gauge
  logged in volts plots in kW/m² once its calibration constant is entered. A channel
  name carrying a constant in a recognisable form (`23.17kW/m2permV`) pre-fills it.
- **The plan stores the reference, the mapping and a manifest, never the samples.**
  The same rule as voxel sequences (CONVENTIONS section 11), for the same reason: a
  test's data is megabytes, and the plan is a diffable file. The manifest records what
  was read (size, modification time, rows, each mapped channel's unit, count and time
  span), so reopening a plan whose file has changed says so instead of silently
  plotting something else. **Share** embeds the mapped series, decimated to at most
  2,000 points each with the extremes of every interval kept, so a collaborator sees
  the plots with nothing installed.
- **Plan time is seconds from ignition.** Each source's `timeOffset_s` (the key
  CONVENTIONS section 10 reserved on links) is its own time at ignition. A processed
  sheet already shifted to ignition has 0; a logger sheet that started seven minutes
  early has 420. The flame playback clock, the burner's reconstruction plot and these
  series share that axis, so a cursor in one is a cursor in all.
- **Missing is missing.** No interpolation, no resampling between sources, no
  smoothing: each series is plotted on its own times. The plot reports gaps.

A plan requires 1.6.0 only when it has a non-empty `testData`; a higher existing
declaration is retained. Empty arrays are omitted on write.

### Model implementation decisions (part 2)

CONVENTIONS section 12 records the normative source schema and API contract.
The following details resolve points the initial design left open:

- `table.unitsSheet` is omitted for no metadata fallback, a sheet name for one
  metadata sheet, or null for merging the workbook. It is absent on delimited
  sources. The saved layout is authoritative, including overridden rows and columns.
- Thermocouples require an explicit bead, including 0 for a single bead; other
  instruments omit it. Duplicate object/bead targets within one source are warnings
  while editing and errors during extraction. One channel can map to distinct targets.
- Source files cannot carry `plot` or `sequence`. The inherited link-level offset
  stays reserved; only the source-level offset is applied, by subtraction.
- Calibration coefficients, time offsets and manifest values keep recorded precision.
  Negative non-zero scale is allowed. Output unit spellings are `kW/m2`, `°C`, `kW`.
- Manifest rows count the dense grid, including headers and trailing formulas.
  Manifest channels are unique by extracted name and describe raw units/file times.
  Zero samples require null endpoints, one sample equal endpoints, and multiple
  samples increasing finite endpoints. No read automatically refreshes the manifest.
- TS `sourceSeries(source, grid, {channels, targets})` accepts metadata units and
  target units separately. `targetUnits(plan.objects)` supplies target units; object
  IDs alone cannot distinguish a calibrated gauge from a burner. A mapping with a
  bead can infer °C; other mappings require the target map. Keys encode the JSON
  tuple `[objectId, beadOrNull]`. Python resolves target units from the plan and
  returns one series per source for the requested object and exact bead.
- Manifest helpers accept metadata units in `fileInfo.units`; mismatch checks use
  `fileInfo.table` for the saved layout, falling back to detection if absent.
- Min/max decimation partitions interior sample indices, preserves endpoints and
  extrema in time order, and returns `{t, values}` float64 arrays. Budgets below 2
  or non-integer budgets are errors; odd budgets may leave a slot unused.
- The model fixture reuses part 1 bytes. Its FDS device names `HF east` and `TC low`
  equal the mapped object names; `TC low` names the five-bead rake and maps bead 0.
  The existing CSV has no HRR channel, so the fixture burner has no mapped series.
  Independent tests exercise burner calibration and kW output.

## In the editor

- **Test data…** in the toolbar opens the sources: add a file, pick the sheet, check the
  detected shape against a preview of the first rows, set the ignition offset, and map
  channels to instruments in a table (channel, unit, span → instrument, bead, scale).
  FDS device IDs that equal an instrument's name (an imported plan keeps them) map
  themselves; nothing else is guessed.
- **Selecting an instrument** with mapped series shows its plot in the viewport's
  upper right, the place the burner's reconstruction plot already uses: measured and
  simulated series, the planned value as a dashed line labelled as such, and for a
  gauge its full-scale range. A rake plots one line per bead, coloured by height on a
  sequential ramp, with the source told apart by dash, never by hue alone. A burner
  plots measured and simulated heat release rate against its design value.
- The desktop app reads a linked source as the plan opens, except from a network
  share, where it waits for **Load data** (the flame rule). A browser tab asks for the
  file again, as it does for linked CSVs and flame folders.
- **Instrument schedule** (in the drawing, and as a CSV download): every gauge, bead
  and camera with its position, aim, range and the channel each source maps to it.

### Editor plumbing (part 3a)

`main.ts` owns one `TestDataStore` alongside `FlameStore`. The test-data store
subscribes to the document store itself: mapping, calibration and target edits
rederive from cached grids; file or table changes invalidate that source. A changed
`documentId` clears all entries, including pending reads. Local desktop reads are
queued after a page yield. Network paths use the existing `isNetworkPath` predicate
and wait for `load`; browser sources wait for `attachFile`. Desktop open already
resolves paths with `mapLinkedPaths`, including paths relative to a network plan.

The UI should receive the existing instance from `main.ts`, not create a second
session. Public API (`web/src/state/test-data-store.ts`):

```ts
new TestDataStore(store: Store, reader?: TestDataReader)
setReader(reader?: TestDataReader): void
get(sourceId: string): TestDataEntry | undefined
seriesFor(objectId: string, bead?: number): Series[]
subscribe(listener: () => void): () => void
load(sourceId: string): Promise<TestDataEntry>
attachFile(sourceId: string, file: File): Promise<TestDataEntry>
attachBytes(sourceId: string, name: string, data: TestDataBytes): Promise<TestDataEntry>
draftFromFile(name: string, bytes: Uint8Array, options?: DraftOptions): Promise<Draft>
attachEmbedded(sourceId: string, series: Series[]): void
clear(): void
dispose(): void
```

`TestDataReader` is `(path: string) => Promise<TestDataBytes>`, where the result is
`{bytes: Uint8Array, modified: string | null}`. The constructor and `setReader`
enable automatic local loading. Explicit reads reject on failure and expose the
reason through the entry's `error`. `load` joins a pending read and returns an
already loaded entry. `attachFile` and `attachBytes` replace the entry's data.
`clear` cancels adoption of pending reads; `dispose` also unsubscribes.
Completed entries survive undoable source removal within the same plan. Attached
browser Files or supplied bytes are retained for table changes, so changing the
sheet does not require another file selection. Changing the linked path does.

Entries expose `status`, `series`, `mismatches`, optional `grid`, `units`,
`unitsGrid`, `fileInfo` and `error`. Status is `unloaded`, `needs-load`, `needs-file`,
`loading`, `loaded`, `embedded` or `error`. `unitsGrid` exists when one metadata
sheet was selected; workbook-wide metadata retains the merged `units` map.
`seriesFor` returns sources in document order and uses an exact bead match; pass
0 for a single thermocouple. Deleted or incompatible targets produce no series.
Manifests remain unchanged until an explicit document edit by the future UI.

Drafts contain `name`, `size`, `sheets`, `defaultSheet`, `defaultSheetIndex`,
`preview`, `channels`, `shiftHint` and `suggestedMappings`. Each sheet includes its
`table`, full `grid`, metadata `units`, first 12 rows as `preview`, `channelCount`,
channel summaries and reader warnings. Summaries carry `name`, `unit`, `samples`,
`span: [t0, t1] | null` and `calibration`. Hints are advisory. No-series files have
a null default index. The standalone `draftFromFile(name, bytes, doc?)` helper is
in `io/test-data-sources.ts`; the store method supplies the active plan for FDS
suggestions. Exact instrument names map directly, with a bare thermocouple name
selecting bead 0 as in the model fixture. Rake names suffixed `_1`, `_2`, etc.
select the corresponding bead. Ambiguous instrument names produce no suggestion.

`embedTestData(doc, id => testDataStore.get(id))` in `io/test-data-embed.ts` returns
`{payload, bytes, included, omitted, unloaded, warnings}`. Lists contain source
IDs. Whole sources are considered in document order; a source that does not fit
is skipped, and later smaller sources may fit. The cap is 5,000,000 UTF-8 bytes
of compact, script-escaped JSON, including metadata. Every series has at most
2,000 points. The HTML-only `embeddedTestData` block is stripped before plan
validation. Omission counts produce a warning when the shared page opens.
Embedded samples are already calibrated and decimated: edits can reuse included
channels, but a channel that was not embedded requires the original file.

`plannedValue` in `core/planned-value.ts` returns null for an unsupported target.
A valid target with no applicable prediction returns `{value: null, unit, note}`,
so the plot can explain why there is no planned line. `instrumentScheduleCsv` in
`core/instrument-schedule.ts` returns a BOM-prefixed, CRLF CSV. Bead IDs use
`objectId[zeroBasedBead]`; names use one-based suffixes for rakes. Positions and
aim points use the requested display unit, and facing comes from the authoritative
quaternion. The Drawing button uses the normal browser download or the desktop
CSV save route.

### Editor UI (part 3b)

**Test data…** in the toolbar opens a native modal dialog (`ui/test-data.ts`), the
same frame as the FDS export preview. Opening it pauses playback and suspends the
viewport; Escape closes it and returns the keyboard to the toolbar. While it is open,
Ctrl+Z / Ctrl+Y undo and redo plan edits unless a text field has focus.

- **The sources list** shows each source's role, file, sheet and ignition offset, its
  session status (loaded, needs the file in this browser tab, waits for Load data on a
  network share, reading, error) and how many of its mappings plot. A loaded file that
  differs from the manifest lists the reasons, with **Accept the file as read**. The
  source's own `test-data-dangling` and `test-data-duplicate` findings are repeated on
  its card. A browser tab offers **Choose file…** (a file input, so a session can
  attach files without a native dialog); the desktop offers **Reload**, or **Load
  data** for a network path. Reading a file is never an edit.
- **Add a source** picks a file (the native picker through the bridge, or a file
  input), drafts every sheet with a progress bar and Cancel (`DraftOptions` on
  `draftFromFile`: `onProgress` before each step, `signal` aborting at the next one),
  and opens the editor on a pending source. Nothing changes in the plan until **Add
  source**, which adds the source, its mappings and a manifest computed from the read
  as one edit, then attaches the bytes already read. The default sheet, the detected
  layout, `unitsSheet: null` for workbooks, the role (simulated for FDS output) and
  the name (the file name) come from the draft; exact FDS names are pre-selected and
  marked *suggested*.
- **The editor** sets name, role and ignition offset (with the workbook's shift hint
  as one click, naming its sheets), the sheet, shape, names, units and first data rows
  and time column, against a preview of the sheet that marks the names, units and
  first data rows and the time columns in text, not colour alone. A draft of the file
  is kept for the session, so changing the sheet never reads the file again; an
  existing source without one works on its loaded sheet and offers **Read all
  sheets…**. Without the file, the mapping table lists the manifest's channels.
- **Mapping** is a table of channel, unit, samples, file-time span and an instrument
  select (gauges, every bead labelled with its rake and height in display units,
  burners for HRR), scale and offset, with a filter. Mapping a gauge pre-fills the
  constant from the channel name (`23.17 kW/m² per mV, from the channel name`), or 1
  for a channel already in kW/m²; other targets keep the row's calibration. A row says
  when the channel's unit is not the target's and nothing converts it, when two
  channels map one target, and when its target is gone.

Every change to an existing source is one undoable edit, and keeps the manifest
valid. A mapping edit keeps the recorded entries and describes a newly mapped channel
from the file as read (`updateManifestChannels`); it does not refresh size or time.
A layout or sheet change describes a different read, so it records the manifest
again from that read and drops mappings whose channels the layout does not have,
saying how many. **Accept the file as read** records the manifest from the loaded
file (dropping mappings whose channels are gone). Removal is one edit, and an
emptied list is omitted.

Checks: a test data finding carries the source's `sourceId` (an editor-only field on
`Issue`, not in Python), and clicking it opens the dialog at that source with the
first flagged mapping in view and focused.

**Plots** share the viewport panel the reconstruction CSV uses (`ui/plot-panel.ts`):
one panel for the selected object, with a Reconstruction / Test data selector when a
burner has both. The test data plot (`ui/instrument-plot.ts`) draws plan time from
ignition, in minutes when the span passes 30 min. A gauge or burner draws measured
series solid in `--plot-primary` and simulated dashed in `--plot-secondary`; a rake
draws one line per bead and source, coloured by height rank on the ordinal
`--plot-ramp-*` ramp, with the source still told by dash. The planned value is a
long-dashed line labelled Planned (per bead on a rake, in the bead's colour, the
highest one labelled); a null planned value is explained under the plot. A gauge's
range is a dotted line labelled Range while it is at most twice the plotted maximum,
and otherwise an off-scale label, so it never flattens the data. The legend is also
the readout: each series' last sample at or before the cursor, and none outside its
span. A run of samples breaks where the step exceeds three times the series' median
step, and missing samples are counted under the plot. A loaded flame sequence drives
the cursor through the shared clock, and the slider seeks it. A source whose file
differs from its manifest, or that maps the object but is not loaded, says so.

## In Python

```python
p = Plan.load("test-07.ftp.json")
for s in p.series(p.heat_flux_sensors[0]):     # one per source that maps it
    s.source, s.role, s.unit                     # 'Logger export', 'measured', 'kW/m2'
    s.t, s.values                                # numpy arrays, plan time (s from ignition)
fireplan.tables.read("test-07.xlsx", sheet="Log")   # the reader on its own
```

## Parity

Both engines read the same synthetic fixtures (`fixtures/test-data/`: a workbook with a
paired-time logger sheet and a processed sheet with several header rows, error cells
and rows filled past the data, an FDS `_devc.csv`, a plain CSV), and an
`expected.json` pins names, units, counts, first and last samples and warnings for
both suites. The fixtures are generated by `tools/build_test_data_fixture.py` from
made-up channels; no real test's data is in the repository.

## Deferred

- `.xls` and `.ods`.
- A time-of-day time column (absolute clock times rather than seconds).
- Derived channels (a gauge computed from two thermocouples, an HRR computed from gas
  analysis). The processed sheet that computed them is the place they come from.
- Video synchronisation: the clock takes a video follower without change.
