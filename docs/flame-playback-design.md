# Reconstructed flame playback — design (M12, format 1.4)

Status: **implemented, 2026-09-19** (commits `4db780c`, `a21df3a` and the docs that
followed). The open questions of the first draft were answered the same day and
are recorded as decisions in section 12; section 13 records where the build
departed from this text. A second opinion (a separate model, reading the same
code) was taken on the first draft; where it changed a decision the reason is
given inline. `docs/flame-playback.md` is the usage guide; CONVENTIONS.md
section 11 is the normative statement of the format.

This is the last major feature in `ideas.md` and the milestone PLAN.md has carried as
M8 since M0: *import reconstructed 3D flame; time sequence playback — blocked on
format decision.* The format is now decided by `fixtures/flame/reconstruct_revised.py`, so this document turns M8 into a buildable spec.

---

## 1. What the data is

`reconstruct_revised.py` computes a **visual hull** (shape-from-silhouette) on a
regular cubic voxel grid and writes one file per timestep:

| File | Contents |
|---|---|
| `voxels/t_0000055.0s.npz` | `voxels`: M×3 float64, world coordinates of occupied voxel **centres**, metres, C order. `voxel_size`: 0-d float64. Empty frames are `(0, 3)`. **The timestamp exists only in the file name.** |
| `voxels/t_….ply` | The same points as ASCII PLY, coloured by height. Ten times the size of the NPZ; not needed. |
| `volumes.csv` | One row per timestep on the same `timestamp_s`: volume, surface area, `occupied_voxels`, `num_valid_views`, `mean_flame_height_m`, `heskestad_hrr_kw`, … Already linkable to a burner (format 1.3) and plotted. |

Facts measured on the fixture (`fixtures/flame/`):

- 192³ grid over a 3 m cube, **80 frames at 5 s** (0–395 s), 0 to 36k occupied
  voxels per frame, 931k in total; extents ±0.4 m in x/y, 0.01–0.9 m in z. The hull
  flickers hard between frames (16 → 8 920 → 2 848 → 14 732 voxels).
- **The lattice pitch is not `voxel_size`.** `linspace` is endpoint-inclusive, so the
  pitch is `volume_size/(res−1)` = 15.707 mm while the stored `voxel_size` is
  `volume_size/res` = 15.625 mm. Half a percent is invisible, but
  `round((x − x₀)/voxel_size)` is off by one from about 100 voxels out, and cubes
  drawn at `voxel_size` leave a 0.08 mm gap that reads as moiré. The pitch must be
  inferred from the coordinates, sequence-wide (a 16-voxel frame cannot define it).
- Only **21 % of occupied voxels are surface voxels** (have an empty 6-neighbour):
  195k cubes for the whole sequence. Bounding-box-cropped, bit-packed occupancy is
  **0.25 MB for all 80 frames (50 KB gzipped)**, against 2.6 MB of NPZ and 37.5 MB
  of PLY.
- A second, earlier run is already in the repo as `fixtures/linked-files/volumes.csv`:
  200³ grid at 10 mm, 100 frames at 2 s, **up to 2.0 million voxels in one frame**,
  77.6 M over the run (~36 MB packed, ~48 MB of surface cubes). The design has to
  hold from 10⁴ to 10⁶⁺ voxels per frame.
- Parsing all 80 NPZ files with no library — ZIP local headers + the browser's own
  `DecompressionStream('deflate-raw')` + the `.npy` dict header — takes **100 ms** in
  Node 22. WebView2 is Chromium, so the page reads the pipeline's own output
  directly and the exe still carries no numpy.

The coordinates are in the **reconstruction rig's frame**: Z-up, origin at the
centre of the camera ring. In the fixture that coincides with the plan frame (x and y
symmetric about 0, z from the floor up), and it should whenever the camera config
came from `cam.extrinsics()` — but nothing enforces it, so the design carries a
correction (section 3) and checks (section 8) rather than an assumption.

## 2. Where it goes: integrated, not a second interface

The flame plays **inside the existing viewport**, and a playback bar docks along the
viewport's bottom edge whenever the plan holds a flame sequence. No separate
"review" window.

The reason is what the feature is for. On its own the reconstruction is a blob; its
value here is seeing it **in the layout** — against the hood the plume has to enter,
inside the frustums of the cameras that produced it, beside the gauge that read
50 kW/m² at 55 s. Three things then come free from how the viewport is built:

- `Viewport.renderPreview()` already renders the same scene through the selected
  plan camera's exact projection (`applyPlanCameraProjection`). A flame on
  `LAYER_DEFAULT` therefore appears in the **picture-in-picture** with no new code:
  what the T650 saw at t = 55 s, to be held against the linked video of the same
  moment. The later video feature becomes "show the linked video in that frame at
  the playhead" — measured against reconstructed from one viewpoint.
- The **plan, front and side views** show the hull in elevation with the predicted
  Heskestad cone over it: a measured flame height beside a predicted one, in the
  views the engineers already read.
- The burner's **`volumes.csv` plot** (M11) has a sample slider on the same
  `timestamp_s`. One session clock drives both: scrubbing the flame moves the plot
  cursor, dragging the plot cursor seeks the flame.

A separate interface would have to rebuild all three, and would drift from the
editor the way PLAN.md §2 argues two renderers always do.

The Heskestad cone stays, under its own toggle (renamed **Predicted**): overlaying
the correlation on the observation is the comparison a thesis wants, and hiding one
when the other appears would remove it.

Two hazards of living in an editor, both handled: selecting the object attaches the
gizmo (`syncSelection`), so an accidental drag would silently shift measured data —
the object is created with **`display.locked: true`**, which the store already
honours (the inspector's transform fields still work for a deliberate correction).
And the transport must not be a store event: `main.ts`'s subscriber rebuilds the
toolbar on any event it does not name, so the clock has its own subscription
(section 6).

## 3. Document model: a `reconstructedFlame` object, format 1.4.0

A new **object type** whose data reference is an ordinary `linkedFiles` entry:

```jsonc
{
  "id": "flame-run3",
  "type": "reconstructedFlame",
  "name": "Run 3 visual hull",
  "transform": { "position_m": [0, 0, 0], "rotation_quat": [0, 0, 0, 1] },
  "burnerId": "burner-main",                 // optional; null = the primary burner
  "representation": "voxels",                // reserved: PLAN.md still promises NeRF / 3DGS
  "linkedFiles": [{                           // exactly one
    "id": "voxels",
    "kind": "voxelSequence",
    "path": "reconstruction/voxels",         // the folder; same path rules as every link
    "label": "Run 3",
    "timeOffset_s": 0,                       // reserved; omitted when 0
    "sequence": {                            // the manifest, like a burner link's `plot`
      "importedAt": "2026-09-19T12:00:00Z",
      "grid": { "voxelSize_m": 0.015625, "pitch_m": 0.015707, "resolution": 192 },
      "bounds_m": [[-0.401, -0.401, 0.01], [0.401, 0.401, 0.905]],
      "frames": [[0, 0], [5, 16], [10, 8920], "…"]   // [timestamp_s, occupiedVoxels], 1–20,000
    }
  }],
  "display": { "visible": true, "locked": true, "opacity": 1, "colorMode": "height" },
  "notes": null
}
```

**Why an object, not a burner attachment.** The hull is world-anchored, in rig
coordinates; hanging it under the burner's transform would drag it along when the
burner moves, which is exactly wrong, and a secondary burner's reconstruction is in
the same world frame as the primary's. The object's own transform is the correction
knob for a rig frame that is not the plan frame, and it needs to be a thing in the
outliner: hidden, shown, selected, inspected, deleted, listed. Two reconstructions
of one test are two objects. And the 1.3 schema pins burner links to
`kind: "spreadsheet"` with closed entries, so a new kind *on the burner* would make
every 1.3 build refuse the file — whereas a new object *type* goes through the
unknown-object path 1.1 and 1.2 already proved: `linkedFilesProblem` returns null
for unknown types, the writer re-emits everything but `transform` and `display`
verbatim, and the viewport draws a placeholder.

**Why the reference is a `linkedFiles` entry and not a bespoke `source.path`.** The
first draft had `source.path`. `mapLinkedPaths` (web) and `for_destination`
(Python) rebase **only** `linkedFiles[].path` on `LINK_TYPES` objects, so a second
path-bearing field would have broken silently on the first Save As — the bug class
M11 spent a release closing. Holding it as a link gives Relink, Show in folder,
rebasing, the browser's basename-only semantics and the shell's `checked_path`
for free (each extended to accept a directory for this kind), and the manifest
lives on the link the way `plot` does, so relinking a different folder replaces it
and cannot be mislabelled as describing the new one.

What the file holds is **a reference and a manifest, never the voxels.** The plan is
the diffable product; a 40 MB base64 blob in it is not a diff anyone reads. The
manifest is small, says what the plan expects ("80 frames, 0–395 s, 15.7 mm
pitch"), lets a relinked folder be checked against what was linked, and carries
enough — `bounds_m`, `grid` — for the checks in section 8 to run on the document
alone, in both engines, with the data absent. It goes through the 1 µm rounding
like the rest of a known object; timestamps, counts and pitch survive that.

Rules, extending CONVENTIONS §10:

- `reconstructedFlame` joins `LINK_TYPES`; its links are `kind: "voxelSequence"`,
  `maxItems: 1`, and only they may carry `sequence`. `path` names a directory (or,
  later, a packed file — section 10) and obeys every existing path rule.
- `frames` timestamps strictly increase; counts are non-negative integers. `bounds_m`
  is two `vec3`; `pitch_m` and `voxelSize_m` are positive; `resolution` is a
  positive integer.
- `display.opacity` (0–1, default 1) and `display.colorMode` (`height` | `solid`) are
  advisory, in `display` because that is what `display` is for: a 1.3 build keeps
  them (the writer emits known keys, then the rest) and ignoring them changes nothing.
- `representation` is `"voxels"`, the only value; `timeOffset_s` is reserved for
  clock synchronisation between the reconstruction timebase and the test clock —
  the same question the reserved `camera.recording` is about — and is omitted at 0
  the way `zoomFactor` is omitted at 1.
- Writer key order: object `id, type, name, transform, burnerId, representation,
  linkedFiles, display, notes`; link `id, kind, path, label, timeOffset_s, plot,
  sequence`; sequence `importedAt, grid, bounds_m, frames`; grid `voxelSize_m,
  pitch_m, resolution`; display gains `opacity, colorMode` after `locked`. Both
  writers, byte-identical, held by a fixture plan.
- `requiredFormatVersion` / `required_version`: a `reconstructedFlame` present →
  `1.4.0`, the new top tier. Schema `fire-test-plan-1.4.0.schema.json`, mirrored
  into the wheel.
- `boundsPoints` (web) and its Python mirror include the transformed `bounds_m`, so
  **Fit** and the drawing's extent work without the frames loaded. Unknown types
  today contribute only their position.

## 4. Loading: one reader for both shells

`web/src/core/flame.ts` — pure, DOM-free, unit-tested, run in a **Web Worker** with
transferred buffers so a large run does not freeze the page (Vite's
`?worker&inline` keeps it inside the single-file build; verify that in the first
spike):

- `parseNpz(bytes)` → entries; `parseNpy(bytes)` → dtype, shape, data. Accepts
  `<f8` and `<f4`, C order, 2-D `(M, 3)`; refuses anything else by name.
- `frameTimestamp(name)` from `^t_(\d+(?:\.\d+)?)s\.npz$`; frames sort
  numerically; a duplicate timestamp is an error, not a merge.
- `inferGrid(frames)`: pitch from the smallest positive gap between sorted unique x
  of the largest frame; origin from any voxel of the first non-empty frame;
  `resolution = round(pitch / (pitch − voxel_size))` (from the `linspace` identity;
  informational). Every frame is checked to sit on the lattice (residual < 1 % of
  pitch); one that does not fails the import with its name.
- `packFrame(voxels, grid)` → `{ origin: [i,j,k], dims: [nx,ny,nz], bits }` —
  bounding-box-cropped, bit-packed occupancy: the resident form (0.25 MB for the
  fixture, ~0.5 MB/frame for the 200³ run).
- `surfaceCells(frame)` → a `Uint8Array` (or `Uint16Array` when a box axis exceeds
  256) of bbox-local `(i, j, k)` triples for voxels with an empty 6-neighbour (the
  box boundary counts as empty). 3 B per cube, 48 MB worst case for the big run —
  and it is the render buffer directly (section 5).
- `FlameSequence`: `grid`, `frames[]`, `bounds`, `frameAt(t)` (binary search; a
  frame **holds** until the next timestamp), `manifest()` → the `sequence` block.
- Empty `(0, 3)` frames are legal and the fixture has them: count 0, no cubes.

Two byte sources feed it:

| Shell | Pick | Read |
|---|---|---|
| Browser tab | `<input type="file" webkitdirectory>` (Chrome/Edge/WebView2; not `showDirectoryPicker`) or a multi-select of `.npz` | `File.arrayBuffer()`; handles kept for the session like `LinkedFilesPanel.browserFiles`; relink after reopening |
| Desktop | native folder dialog (`webview.FileDialog.FOLDER`) | `POST /api/flame/list {path}` → `t_*.npz` names, sizes, mtimes; `GET /api/flame/frame?path&name` → bytes, through a 4–6-way fetch pool (`call()` in `files.ts` is JSON-only, so a bytes variant is added). The shell confines both to folders it has registered, in the `read_fds_include` style; no numpy, no parsing in Python |

Frames load up front with a progress line in the playback bar and are cancellable.
A frame that fails is reported by name; the sequence is not adopted with holes.
Loading is session work: the document holds only the reference and manifest, so
undo snapshots (`JSON.stringify(doc)` × 100) stay small. The loaded sequence is
cached by **link path + manifest fingerprint**, not object id, so undoing "Link
sequence", or `duplicateSelected`, finds the frames already there; the cache is
evicted when `documentId` changes (the `cacheDocumentId` pattern).

For the fixture this is 0.1–0.3 s. For the 2 M-voxel run it is 10–25 s of
inflating 4.8 GB of float64 and packing it, on every open — the case the packed
form in section 10 exists for.

## 5. Rendering: surface voxels as instanced cubes

Cubes are the honest representation of a visual hull: the blockiness *is* the
resolution, and the argument `buildBurner` makes for the cone — it "should not read
as solid geometry" — applies in reverse here. Points are cheaper but stop reading as
a volume when zoomed; surface nets or marching cubes on a binary field imply
sub-voxel precision the hull does not have (offer them later in `fireplan` with
scikit-image for thesis figures, not in the page); volume ray-marching has no scalar
to march.

`web/src/scene/flame.ts` — a `FlameLayer` owning one mesh per flame object, in a
`flameRoot` beside `measureRoot` that **`rebuild()` never disposes**: `rebuild()`
runs on every edit and disposing 48 MB of instance buffers per keystroke would
stall. The layer re-syncs transform, visibility, opacity and colour mode from the
document on each rebuild and disposes a mesh only when its link's manifest identity
or the `documentId` changes.

- `THREE.Mesh(InstancedBufferGeometry(box at pitch), ShaderMaterial)` with one
  `InstancedBufferAttribute(ijk, 3)` **per frame, all resident on the GPU**, and
  uniforms `origin`, `pitch`, `zRange`, `opacity`, `colorMode`. The vertex shader
  places the cube at `origin + (ijk + 0.5) × pitch`. A frame switch is
  `setAttribute('ijk', frames[n])` plus `instanceCount`: no allocation, no upload.
  Not `InstancedMesh`: 64 B per instance, and its `computeBoundingBox` walks every
  instance — which `tick()` triggers through `selectionBox.update()` every frame
  while the object is selected.
- `geometry.boundingBox` / `boundingSphere` set once from the manifest bounds;
  `raycast` overridden to a no-op; a `colorWrite: false` bounding-box proxy makes
  `pick()` work. `castShadow = false` — a flame does not cast a shadow, and 10⁶
  instances in the shadow pass would cost for a wrong picture.
- Colour: **height ramp, blue → yellow → red**, the pipeline's own formula
  (`color_voxels_by_height`) so the tool agrees with the PLYs the engineers already
  open — but on a **fixed scale over the sequence's z-range** with a legend in the
  bar, not per frame: the PLY's per-frame ramp is a rank, not a height, and a
  16-voxel frame painted full-scale red misleads. **Solid** mode uses
  `COLORS.flame`. Opacity through `material.alphaHash` (Three 0.185 has it); sorted
  transparency on 400k self-overlapping cubes is not viable. Default opaque: a hull
  is a bound on the shape, and a wispy volume would overstate what it knows.
- On `LAYER_DEFAULT`, so the camera preview shows it. The preview renders the scene
  a second time per tick; above a cube-count threshold the layer skips the preview
  pass while playing, which is the laptop safeguard before any points mode.
- A **PNG snapshot** button in the bar renders the viewport at 3× pixel ratio to an
  offscreen target and downloads it. Cheap, and it is the thesis-figure deliverable.

## 6. Time: one clock, three followers

`web/src/state/playhead.ts` — session state, deliberately not in the store (not
undoable, not in the file; the reasoning behind `setDisplayUnit` not being an edit):

```
time_s, playing, speed (×1 … ×60 real time), loop
range = union of every loaded sequence's timestamps
subscribe(fn)   seek(t)   step(±1)   play()  pause()
```

- Built in `main.ts` and handed to the `FlameLayer`, the `ReconstructionPlotPanel`
  and the bar. `Viewport.tick()` advances it from `performance.now()` deltas while
  playing; each flame maps `time_s` to the last frame with `t ≤ time_s` and calls
  `setFrame` only when the index changes — no per-frame work while a 5 s frame is
  held.
- **Hold, do not interpolate.** Binary hulls 5 s apart cannot be morphed honestly.
  This is ParaView's *Snap to TimeSteps* mode: transport in seconds, frames held to
  the next timestep. Smokeview's bottom time bar gives the layout — `t = 55.0 s` is
  the primary readout, `frame 12/80 · 35 960 cubes` secondary.
- Real time at ×1 makes the fixture a 6.6-minute watch and one frame every 5 s; the
  default is **×10**, and ×60 gives 12 fps on 5 s data and 30 fps on 2 s data, which
  covers the flicker study without a separate frames-per-second mode (dropped from
  the first draft: it was a second way to say the same thing).
- The **playback bar** (`web/src/ui/playback-bar.ts`): ⏮ ⏪ ▶/⏸ ⏩ ⏭, a scrubber that
  snaps to frames, the readout, speed, loop, the colour legend, the snapshot button,
  and the loading/error line. Keys: Space, `,` / `.`, Home / End — all free today.
  Hidden when no flame object exists, like the plot panel.
- The **plot panel** follows the clock when a sequence is present (cursor at the last
  sample with `t ≤ time_s`) and seeks it when its slider moves (`time_s =
  samples[i][0]`). Neither feature imports the other; both read the clock. A plan
  with a CSV and no voxels behaves exactly as in 1.3.
- Linked video (PLAN M11: "no playback synchronization") is a fourth follower for a
  later milestone; `timeOffset_s` is reserved for it and nothing else has to change.

## 7. UI surfaces

- **Creating one.** Palette tile **3D flame** → folder picker → object created at
  identity, locked, linked to the primary burner. The burner inspector's Linked files
  section gets the same button (**Link 3D flame sequence…**), because that is where
  the same run's `volumes.csv` is linked. One function, two entry points.
- **Inspector section** for the object (the existing `LinkedFilesPanel`, extended for
  the new kind): path with **Show in folder** on the desktop, frames, span, pitch,
  resolution, import date, load status; **Relink…**; **Refresh manifest** (re-scan;
  a changed frame set is an undoable edit, like Refresh plot); burner selector;
  opacity and colour mode. Transform fields come from the generic section.
- **Outliner** icon `✶`; the object hides and shows like any other; the checks panel
  lists its issues.
- **Toolbar**: the **Flame** toggle becomes **Predicted**.
- **Drawing export**: draws nothing for the flame in v1 and says so under Known
  limitations; the equipment list names the object. The addition worth making later
  is a time-invariant **envelope** — the union of all frames — as a dashed outline
  beside the Heskestad cone in the elevations: prediction against measurement on a
  sheet.

## 8. Checks (`checkPlan` / `Plan.check()`)

On the document alone, both engines:

| Code | Severity | Means |
|---|---|---|
| `flame-below-floor` | warning | Transformed `bounds_m` reaches more than one pitch below `fuelSurfaceZM` of its burner: a rig-frame offset, not a flame under the pan |
| `flame-off-burner` | warning | The hull's plan-view centre is further than `max(D_eff, 0.25 m)` from its burner: the rig frame is probably not the plan frame; correct the transform |
| `flame-csv-mismatch` | info | The burner's `plot` and this manifest disagree — timestamps not the same set, or a sample's `round(volume_m3 / voxelSize_m³)` off by more than one from the frame's count: the CSV is not from this run |

Session-side, after a load (desktop only, where the folder can be read):

| Code | Severity | Means |
|---|---|---|
| `flame-source-changed` | warning | The folder's frames differ from the manifest; **Refresh manifest** clears it |
| `flame-source-missing` | info | The folder cannot be resolved; **Relink…** |

Nothing about the flame changes the planned HRR, the predicted flame geometry, the
hood checks or the instrument verdicts. As with 1.3, reconstruction results are
recorded data, drawn beside the plan and never fed back into it.

## 9. Python mirror (`python/fireplan/flame.py`)

```python
from fireplan import Plan
from fireplan.flame import FlameSequence, scan_folder

plan = Plan.load("run3.ftp.json")
flame = plan.reconstructed_flames[0]
seq = plan.flame_sequence(flame)          # resolves the link like linked_file_path; loads with numpy
seq.timestamps                            # (N,)
seq.voxels(55.0)                          # (M, 3) as the pipeline wrote them
grid, origin = seq.occupancy(55.0)        # bool (nx, ny, nz) on the inferred lattice, and its origin
plan.add_reconstructed_flame("reconstruction/voxels")   # scans, writes the link and manifest
```

`scan_folder()` computes the same manifest the editor writes, and a parity test holds
the two to identical output on the fixture — the discipline of the FDS importer and
the CSV reader. Schema 1.4 validation, `required_version`, writer key order, the
`LINK_TYPES` extension and Save-As rebasing all mirror the TypeScript side.

## 10. The packed form: Share payload, and the large-run path

One lossless encoding, `web/src/core/flame-pack.ts` mirrored by `fireplan/flame.py`:
a header (grid, timestamps, bounds), then per frame `origin (int32 ×3)`, `dims
(uint16 ×3)` and the bit-packed occupancy; gzip over the whole. About 0.3–0.6 B per
occupied voxel before gzip — the fixture's 0.25 MB / 50 KB. It is in v1 because
**Share needs it**: the exporter embeds it, base64, in a second script block next to
the plan (whose link paths it already strips), under a **25 MB cap on the gzipped
payload**. Over the cap the export says so before writing, and the viewer shows the
timeline with "sequence not included — open the plan in the desktop app". The saved
`.ftp.json` never carries it. The numpy side writes the same bytes, held
byte-identical by a parity test, so `python -m fireplan.flame pack voxels/ -o
run3.flame` costs a CLI wrapper.

The same bytes give the **Example** its flame. The fixture run was recorded on the
site the reference plan describes, so the bundled Example plan gains a
`reconstructedFlame` whose packed sequence (~70 KB base64) is imported as an asset
beside `pool-fire-camera-row.ftp.json` — the README's "click Example" walk-through
then reaches the flame with nothing on disk, through the same embedded-payload path
the shared viewer uses. On the desktop, **Show in folder** for that link reports the
folder as missing, which is true.

Two further uses of the same bytes are deferred (section 11, phase F), because the
fixture's scale is the typical one and loads in well under a second from NPZ:

- (a) `kind: "voxelSequence"` accepting a **packed file** as well as a folder, so a
  large run is converted once and loads in well under a second at any size.
- (b) A **desktop cache** the shell keeps under `settings_path()`'s folder, keyed by
  folder path plus the frames' sizes and mtimes; the page produces the bytes and
  POSTs them, and the next open reads them back. Invisible, desktop-only, and never
  written beside the user's data.

## 11. Phasing and tests

| Phase | Contents | Held by |
|---|---|---|
| **A — Format** | Types, schema 1.4.0 + mirror, writer orders, the version tier, `LINK_TYPES` and the per-kind rule, `display` extension, `boundsPoints`; `fixtures/flame/` plan | Byte-identical parity from both writers; forward compatibility (a 1.3-style round-trip keeps the object and its extra display keys verbatim); Save-As rebasing of the new kind through `path-cases.json`; schema refusals |
| **B — Codec** | `flame.ts` reader (NPZ/NPY, timestamps, grid inference, packing, surface cells, manifest) and `flame-pack.ts`; `fireplan/flame.py` with `scan_folder` and the same pack writer | Shared JSON cases for pitch inference (including the `res−1` trap), filename timestamps, empty frames, boxes over 256; manifest and packed bytes identical between engines on the 80 fixture frames; surface counts pinned against numpy's 6-neighbour test |
| **C — Scene and clock** | `FlameLayer`, `Playhead`, playback bar, plot linkage, snapshot | Vitest for the `t ≤` mapping, hold, loop, speed, range union, and for the clock emitting no store events; the bar's DOM with a stub sequence. WebGL is not mocked: verified in the browser and logged in PLAN.md as M11 was |
| **D — Shells** | Browser folder picker; shell routes (folder dialog, list, frame bytes) with confinement; inspector section; relink and refresh; checks; outliner | `test_shell.py` against a temp folder of tiny NPZs numpy writes in the test, with dialogs mocked; check cases in both engines |
| **E — Share, Example and docs** | Embedding with the cap; the Example plan's bundled flame; `docs/flame-playback.md`; README, PLAN (M8 → done), CONVENTIONS §11; exe rebuild and `--selftest`; browser verification with the fixture, including the PIP from the GoPro at t = 55 s | Export tests (embedded under the cap, absent over it, never in a saved plan); the Example loads its flame with no folder |
| **F — Later** | Packed-file source and cache (10 a/b) if not pulled forward; envelope outline in the drawing; video as a clock follower; measured-vs-predicted `L_f` from the CSV; surface-nets export in `fireplan` | — |

## 12. Decisions

The first draft ended in eight open questions. They were answered on 2026-09-19:

1. **Run sizes.** The fixture (192³, 5 s, 80 frames) is typical. NPZ reading is the
   whole v1 data path; the packed-file source and the desktop cache stay in phase F.
   The fixture run was recorded on the same site as the reference plan, which is
   what makes the bundled Example flame (section 10) honest.
2. **The rig frame is the plan frame by construction.** Reconstructions will use the
   camera config derived from the plan this tool wrote (`cam.extrinsics()`). The
   object's transform therefore stays a rarely-touched correction, the two geometric
   checks in section 8 are the safety net, and there is no "centre on burner" action.
3. **Integrated playback** and **reference-only plan files** — confirmed.
4. **Colour and speed** were left to this document: the pipeline's ramp on a fixed
   sequence-wide scale, opaque, ×10, hold-until-next-frame.
5. **Fixtures moved** to `fixtures/flame/` — `voxels/`, the run's own `volumes.csv`
   (supplied afterwards; it matches the 80 frames row for row) and the producing
   script as the reference for the format. The PLYs stay on disk but are not committed. Nothing in this design needs the script changed; if it
   ever writes a manifest of its own, `sequence` is the shape to write.
6. **Video sync is the next step, not this one.** The engineers' interest in linked
   videos is managing and finding the recordings of a test; the visualisation is
   about the reconstructed flame. `timeOffset_s` is reserved so that step is
   additive.


## 13. What the build changed

- **No worker.** Section 4 planned a Web Worker with `?worker&inline`. Frames are
  parsed on the main thread with a yield between them: the fixture's 80 frames take
  a tenth of a second, and a worker inside the single-file build was a spike not
  worth making before a run that needs it exists. PLAN.md lists it as a limitation.
- **The embedded payload rides on the link**, as `linkedFiles[].embedded`, not on a
  `source.embedded` — there is no `source` block, per section 3's own revision.
- **One instance buffer per flame, refilled on a frame switch**, rather than one
  attribute per frame resident on the GPU (section 5). Three.js frees a geometry's
  buffers when the geometry is disposed and never frees a swapped-out attribute's,
  so per-frame attributes would have leaked GPU memory on every sequence change.
  Six bytes a cube refilled per switch costs nothing at any scale seen.
- **The clock applies frames synchronously on its own event**, not from the render
  loop, so the bar's readout — registered after the viewport — never lags a step.
- **The transport keys leave a focused button alone.** Space on the toolbar's
  Example button activated it *and* toggled playback, which reloaded the plan.
- **No frames-per-second mode** (section 6 already dropped it), and no
  "centre on burner" action (section 12, decision 2).
- **The fixture moved** to `fixtures/flame/`, with the run's own `volumes.csv` and
  a `flame-test.fvs` (the packed frames, gzipped) that the Example imports. Its
  burner carries the test record's 80 kW, not the reference layout's 130 kW.

The review pass of 2026-09-19 (seventeen findings, all taken) then tightened the
seams the build left:

- **The loop holds the last frame** for the previous interval before wrapping
  (section 6 said a frame holds until the next; the last had no next and was never
  shown). `Playhead.time_s` never reports past the last mark.
- **The plot follows the clock only for the reconstruction's own CSV**
  (`plotFollowsFlame`: the flame's burner, and rows matching the manifest), not
  for any burner plot the moment any flame is loaded.
- **The flame proxy is selection-only.** The measure tool skips it and lands on the
  room behind; it is the envelope of every frame, not a surface.
- **The packed reader refuses what the writer could not have written** — count
  against set bits, bytes against the box, bits past the last cell, boxes outside
  the bounds, frames out of order — in both engines with one message, and both
  writers refuse a box axis past the u16 field rather than one wrapping it.
- **Drift detection compares the whole manifest**, bounds and resolution included.
- **Share serialises the plan before it compresses the frames** and aborts if the
  document changed meanwhile; folder linking takes the document's identity before
  the picker, not after; a cancelled read owns only its own bookkeeping.
- **The load gate covers the top-level blocks** (`environment`, `units.display`,
  `meta.title`, `northAzimuth_rad`), and lifting embedded frames out of a shared
  page's plan happens inside the startup boundary that rejects a bad plan.
- **Smaller:** the bar no longer swallows keys (Ctrl+S from a focused Play button
  went to the browser); the inspector follows the frame cache; the large-flame
  preview fallback blanks the frame and says why instead of showing the main view;
  the drawing's equipment list has a row for the flame.

The reviewer's verification of that pass (2026-09-20) closed fourteen findings and
narrowed three, which were then finished:

- **The unlinked placeholder is selection-only too.** The manifest-backed envelope
  had the flag; the 0.25 m wireframe for a link not yet made did not, and a
  measurement at its centre read z = 0.25 m where the floor is.
- **Document shortcuts work from any form control.** The window handler returned
  for every `INPUT`/`SELECT`, so after a click on the scrubber, the speed select or
  the Loop checkbox, Ctrl+S went to the browser's Save Page As. Save and Open are
  now the document's from any control (a text field commits what is typed in it
  first, so the file holds the value on screen); undo, redo and duplicate are the
  document's from every control but a text field, whose Ctrl+Z is its own; every
  other key stays with the control (type-ahead on the select, arrows on the
  slider). The scrubber itself takes Space, `,` and `.` for the transport, since
  it keeps the focus after a drag.
- **Both packed readers check that the bounds sit a whole number of pitches
  apart** (within the lattice tolerance the frames are held to) before rounding
  to an integer extent. A maximum rewritten to 0.6 of a pitch past the origin
  rounded up to one cell and admitted a box whose last cell decoded past it.
