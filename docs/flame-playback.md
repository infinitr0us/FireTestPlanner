# Play back a reconstructed flame

The reconstruction pipeline (`fixtures/flame/reconstruct_revised.py`) turns the
test's camera footage into a visual hull: one file per timestep,
`voxels/t_<seconds>s.npz`, holding the centres of the voxels the flame occupied.
The editor plays that folder back inside the layout — under the hood, inside the
frustums of the cameras that produced it, beside the gauges — as a
**reconstructed flame** object.

Click **Example** and press play to see one: the reference layout with a flame
reconstructed from a test on its site, 80 frames at 5 s.

## Linking a folder

Three ways in, all the same result:

- The palette's **3D flame…** tile.
- **Link 3D flame sequence…** in a burner's Linked files section, which is where
  the same run's `volumes.csv` is linked. The flame is tied to that burner.
- **Link voxel folder…** in a flame object's own inspector, or **Relink…** later.

Pick the pipeline's `voxels/` folder. The desktop app opens a folder dialog; a
browser tab asks for the folder through the file picker (Chrome and Edge) and
takes the `.npz` files in it. The frames are read first — the bar shows the
progress — and only then does the plan gain the object, so a folder that cannot
be read links nothing: the reason is shown under the burner or the flame it was
linked from, or in a dialog from the palette. Reading the 80-frame example takes
well under a second.

The object is created **at the identity and locked**: the voxels are in the
reconstruction rig's frame, and when the rig was set up from this plan (the
cameras' `extrinsics()` fed to the pipeline) that frame *is* the plan frame.
If a reconstruction was set up some other way, unlock the object and move it; the
checks below say when that is needed.

## Playing

A bar docks along the bottom of the viewport whenever the plan holds a flame:

| Control | Does |
|---|---|
| ⏮ ◀ ▶ ▶\| ⏭ | First frame, previous, play/pause, next, last. Keys: Home, `,`, Space, `.`, End |
| Scrubber | Snaps to the frames. `t = 55.0 s · frame 12/80 · 6,132 cubes` is the readout |
| ×1 … ×60 | Playback speed as a multiple of test time. ×1 shows one 5 s frame every 5 s; ×10 is the default |
| Loop | Start over at the end. The last frame is held for one interval first — a frame holds until the next, and the last has no next — so a loop never skips it |
| PNG | Save the viewport at 3× resolution, for a figure. Object labels are HTML and are not in it |

A frame **holds until the next timestamp**; nothing is interpolated between
hulls 5 s apart, because nothing honest can be. The predicted Heskestad cone stays
under the toolbar's **Predicted** toggle, so the correlation can be compared with
the measurement.

Select the burner and its **volumes.csv** plot follows the same clock: the cursor
sits on the sample at the playback time, and dragging the plot's slider seeks the
playback. That is only for the reconstruction's own CSV — the one on the flame's
burner whose rows match the manifest frame for frame, while that flame's frames
are loaded; a CSV from another run, or on another burner, keeps its own slider
and says so under the chart. Select a
camera and the picture-in-picture shows the hull from that camera's own view at
that moment; above 400,000 cubes it is blanked while the flame plays and resumes
on pause.

The measure tool looks past the flame. The object is picked through an invisible
box over the envelope of every frame, which is not a surface a ruler can land on,
so a measurement aimed at the hull lands on whatever is behind it — the pan, the
floor — rather than on the top of that box.

## The inspector

The flame's inspector shows the linked folder, what it held when it was linked
(frames, span, voxel pitch, grid resolution, date) and whether the frames are
loaded. **Show in folder** reveals the folder in Explorer; **Refresh** reads it
again after the pipeline is re-run; **Relink…** points at a moved folder;
**Remove** drops the link and leaves the folder alone. **Burner** names the fire
the hull belongs to; **Colour** switches between the pipeline's height ramp (blue
at the base, red at the tip, on a fixed scale over the whole sequence) and a solid
flame colour; **Opacity** is hashed transparency — grainy on purpose, and honest
about a thousand overlapping cubes.

Cubes are what is drawn: a visual hull is a set of voxels, and the blockiness is
the resolution. Only the surface cells are drawn, a fifth of them.

## Checks

| Code | Means |
|---|---|
| `flame-below-floor` | The hull reaches more than a voxel below the burner's floor: the rig frame is offset. Correct the object's position |
| `flame-off-burner` | The hull is centred further than the pan's diameter from its burner: the rig frame is not the plan frame. Correct the transform |
| `flame-csv-mismatch` | The burner's CSV snapshot does not match the frames (timestamps or voxel counts): it is from another run |
| `flame-burner-unknown` | `burnerId` names no burner; the primary is used |

The bar also says when the folder no longer matches what the plan recorded —
frames added, dropped or re-run — and **Refresh** adopts it as it is now.

Recorded data changes nothing planned: not the HRR, the predicted flame, the hood
checks or the instrument verdicts.

## Files and portability

The plan stores a reference and a manifest, never the voxels: the folder's path
(relative to the plan when possible, like every link), the grid, the bounds and
one `[timestamp, voxel count]` per frame. The desktop app reads the frames when
the plan opens. A browser tab keeps the folder's name and asks for the folder again
after reopening (**Load frames…**).

**Share…** embeds the loaded frames in the exported page, packed and compressed —
the example is 49 KB — up to 25 MB; over that, the page is exported without them
and says so. A viewer opened from such a page plays with nothing on disk.

## Python and the file format

Format **1.4.0** adds the `reconstructedFlame` object and the `voxelSequence` link
kind. Everything an earlier version reads, this one reads unchanged, and a 1.3 tool
opens a 1.4 plan through its unknown-object path with the flame preserved.

```python
from fireplan import Plan
from fireplan.flame import FlameSequence, scan_folder

plan = Plan.load("fixtures/flame/flame-test.ftp.json")
flame = plan.reconstructed_flames[0]
seq = plan.flame_sequence(flame)      # reads the linked folder
seq.timestamps                        # (80,)
seq.voxels(55.0)                      # (35960, 3) centres, as the pipeline wrote them
grid, origin = seq.occupancy(55.0)    # bool (nx, ny, nz) on the inferred lattice
seq.pack()                            # the compact form a shared page embeds

plan.add_reconstructed_flame("voxels", "/data/run3/voxels", burner_id="burner-main")
```

`scan_folder()` writes the same manifest the editor does, and the two engines are
held to identical manifests and identical packed bytes on the fixture. See
CONVENTIONS.md section 11 for the rules and [the design](flame-playback-design.md)
for the reasoning.

## Deliberate limits

- **The drawing export does not draw the flame.** The equipment list has a row for
  it — the run, its span and voxel pitch, the burner it belongs to, how far its
  envelope stands from that burner's centre and how high it reaches — but the
  elevations do not show the hull. A time-invariant envelope beside the predicted
  cone is the natural addition.
- **No video sync.** Linked videos are still files to find and open; the clock is
  ready for a video follower, and `timeOffset_s` is reserved on links for it.
- **The lattice pitch is inferred from the coordinates**, not taken from the
  pipeline's `voxel_size`: the grid is an endpoint-inclusive `linspace`, so the
  two differ by half a percent, enough to mis-index a voxel a hundred cells out.
- **Large runs are read on every open.** A run of two million voxels a frame takes
  tens of seconds to read from NPZ; the packed form exists, and a packed-file
  source or a desktop cache is the step if such runs become common.
- **Above 400,000 cubes the camera preview pauses while playing**, and catches up
  when playback pauses. The main view does not.
