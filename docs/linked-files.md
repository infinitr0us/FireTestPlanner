# Link a layout to its test data

The distributed `fixtures/linked-files/linked-test.ftp.json` uses synthetic data.
`tools/build_synthetic_flame.py` generates its independent CSV-only large run:
100 rows at 2 s (0–198 s), a 200³ grid at 10 mm, two illustrative valid views,
and a broad two-view hull reaching 2.028915 m³. Column definitions are in that
generator's docstring; only the three columns below are plotted. This large run
is separate from the generator's synthetic 80 kW flame example.

Its linked video is a 6 s, 640×360 H.264 test pattern with no audio, captioned
“FireTestPlanner synthetic example video”. It is assigned to GoPro only to
demonstrate linking, with no camera provenance or synchronization with the CSV.

Select a burner, camera, heat flux gauge or thermocouple. **Linked files** appears
near the top of the inspector. Cameras accept multiple videos; the other three
types accept multiple spreadsheets. A thermocouple rake links its data at the
object level, so a workbook can contain one column per bead.

1. Click **Link spreadsheets…** or **Link videos…** and select the original files.
2. Optionally give each link a label, such as “Run 2” or “Radiometric recording”.
3. Save the plan. Links, labels and reconstruction snapshots participate in undo,
   redo, object duplication and ordinary plan saving.

In the desktop app, **Open** launches the file in its registered default program.
**Show in folder** selects it in Windows Explorer. **Relink…** replaces a missing or
moved reference, and **Remove** removes only the reference. None of these controls
deletes or modifies the original data. Unsupported file types and missing files
produce a message in the inspector.

## Reconstruction plots

Link a UTF-8 CSV or TSV to a burner with these named columns, in any order:

```csv
timestamp_s,volume_m3,surface_area_m2
0,0,0
2,0.005168,0.1798
```

Extra columns are retained in the external file and ignored by the plot. Quoted
fields, BOM, CRLF, comma, tab and semicolon delimiters are supported. The three
plotted fields must be finite numbers, with non-negative volume and area. Times must
increase strictly and may be negative for pre-ignition measurements.
Missing values, duplicate timestamps, invalid rows and missing headers are reported;
the importer does not silently drop measurements. A plot accepts up to 20,000
samples from a file of up to 5 MiB. Larger files can still be linked and opened.

Selecting the burner shows two aligned plots in the upper-right of the viewport:
volume in m³ and surface area in m², each with its own vertical scale. Move the
sample slider with the mouse or keyboard to inspect both measurements at the same
time. With several datasets, choose one from the plot's selector. **Collapse** keeps
the viewport available on smaller screens.

The plot is a saved snapshot with an import date. It remains available after
reopening the plan and in a shared HTML viewer. **Refresh plot** in the desktop
inspector reads the source again; in a browser, **Relink…** selects the updated CSV.
A failed refresh preserves the previous snapshot. Relinking to a different file
removes the old snapshot and imports a replacement if the new file is valid.

Reconstruction results are recorded data. They do not change the planned HRR,
predicted flame geometry, instrument checks or camera framing. Video playback and
CSV time are not synchronized.

## Files and portability

Supported spreadsheets: CSV, TSV, XLSX, XLS and ODS. Workbooks can be linked and
opened in their default application; export a workbook to UTF-8 CSV to plot it.
Supported videos: MP4, M4V, MOV, AVI, MKV, WMV, WebM, MPG, MPEG, MTS and M2TS.
The default video application determines codec support, including proprietary IR
recordings converted to one of these formats.

Desktop saves store paths relative to the `.ftp.json` file when the files are on
the same drive/share. Save As rebases them to continue referring to the same
original files. Different drives or shares require absolute paths. Moving or
copying a test folder preserves the links if the plan and its data move together
with the same relative layout. Copying only the plan does not copy its data.

A browser cannot recover a selected file's full path, open the system's default
application, or reveal Explorer. It saves the file name and plot snapshot. Its
**Download** control is available for files selected during the current session;
after reopening, select the original using **Relink…**. For a portable folder of
external files, save it once in the desktop app and relink originals there.

Shared HTML carries the plan, linked file names, labels and plot snapshots. Directory
components are removed from linked paths in the exported copy, including paths on
other drives or network shares. Relink originals to access them in the viewer. It
does not bundle videos or workbooks. Names, labels and other plan text are retained;
review those before sharing if they contain private information.
No external file opens or refreshes automatically when a plan is loaded, and a
reconstructed flame's frames are read on opening only from a local folder (see
[flame playback](flame-playback.md)). Explicit Open, Show in folder, Refresh, Relink
and Load frames actions on network paths contact that host.

## Python and the file format

Format **1.3.0** adds `linkedFiles` to these four object types. Older plans keep
their existing version unless they use the new feature. `camera.recording` remains
reserved: clock synchronization, checksums and a reconstruction pipeline are separate
from these file references.

```python
from fireplan import Plan
from fireplan.linked_files import parse_reconstruction_csv

plan = Plan.load("fixtures/linked-files/linked-test.ftp.json")
link = plan.burners[0].linked_files[0]
path = plan.linked_file_path(link)  # resolves; never opens the source
samples = link["plot"]["samples"]  # [seconds, m³, m²]
plan.save("revision.ftp.json")     # rebase references for the new location
```

`linked_files` is a read-only tuple of live link dictionaries. Edit a dictionary to
update a link, or use `burner.add_linked_file({"id": "run2", "kind": "spreadsheet",
"path": "run2.csv"})` to append a copied record. Reading an empty collection does not
change the plan version. Call `plan.validate_schema()` after editing.
`parse_reconstruction_csv(text, imported_at=None)` imports the same strict CSV/TSV
format as the editor and returns a plot dictionary; assign it to `link["plot"]`
only after parsing succeeds. An omitted import date uses the current UTC time.

`Plan.loads()` has no file location: relative references need a `source_path` or a
first Save destination. `Plan.dumps()` emits references as held; `Plan.save()`
rebases them. The desktop editor holds absolute paths in memory and rebases only
the saved copy, so Save As cannot redirect files in undo history or later edits.
