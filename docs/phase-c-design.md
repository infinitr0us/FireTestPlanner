# Fires that change, more instruments, and the plan after setup: design (M17, format 1.7)

Status: design, 2026-11-02. Phase C of [PLAN.md section 9](../PLAN.md#9-next-round-2026-11).

Sections 3 and 5 implemented on `feat/asbuilt-series`: as-built poses extend 1.7.0;
series remains open metadata. Pose provenance is `cam.pose_used(pose)`, and
nerfstudio records every camera's selected pose and survey date in `metadata.poses`.
Survey dates are calendar dates or null; Set-out check compares object origins
and authoritative facing directions. Next-test copies retain ID zero padding,
clear revision to null and remove survey poses as well as the previous test's
data. With no trailing ID number they append `-2`, including an empty ID.

Five pieces, one format version. Each is small on its own; they share a version so a
plan written by this release declares 1.7.0 only when it uses one of them.

## 1. A heat release rate curve on the burner

**Why.** The lab's tests are routinely transient: a growing room fire that reaches
flashover in minutes, a fire that changes abruptly. One constant `hrr_kw` is a design
figure, and today it is the only figure every prediction uses.

**Model.** `fire.hrrCurve`, reserved as `null` since 1.0, becomes:

```jsonc
"hrrCurve": {
  "points": [[0, 0], [60, 42.2], [120, 168.8], [300, 1000], [600, 1000], [900, 0]],
  "source": "t2-fast"      // free text: "t2-fast", "fds-ramp:FIRE_RAMP", "measured:td-1", "design"
}
```

- One representation: piecewise-linear points, seconds from ignition and kW, times
  strictly increasing, values non-negative. Nothing else to interpret in either engine
  or in a data scientist's script. A t² growth, an FDS `&RAMP` or a measured curve are
  ways to **make** the points, not kinds of curve.
- `hrr_kw` stays, and equals the curve's peak. The editor keeps them equal; a reader
  that finds them unequal reports `hrr-curve-peak` and believes the curve.
- Before the first point and after the last, the rate is the end value (0 after a
  decay to 0).

**What uses it.**
- **Checks keep using the peak**, so every verdict a plan gives today it still gives:
  the question "will this gauge over-range" is a question about the worst moment.
- **Playback**: when the clock runs (a flame sequence, or the new "Fire" clock below),
  the predicted cone takes Heskestad's height at `Q(t)`.
- **Planned series** (M16 plots): with a curve, the planned value of a gauge or a bead
  is a curve over time, not a line, so measured, simulated and planned are compared
  over the whole test.
- **A Fire clock without a flame sequence**: a plan with a curve gets the playback bar
  even when no reconstruction is linked, so the cone can be scrubbed through the test.

**Making a curve** (inspector, burner): *Steady* (no curve), *t² growth* (slow, medium,
fast, ultra-fast: α = 0.00293, 0.01172, 0.0469, 0.1876 kW/s², or α typed; a peak, a hold
time and a linear decay), *From FDS* (the `&RAMP` an import found), *From test data*
(a mapped HRR series, thinned to at most 200 points keeping its extremes), *Table*
(paste two columns). The FDS import starts writing the curve: `RAMP_Q` with `T`/`F`
pairs gives points `F × HRRPUA × area`, and a negative `TAU_Q` gives t² growth to the
steady rate at `|TAU_Q|`.

**Python.** `burner.hrr_at(t)`, and `Plan.heat_flux_estimate(g, t=None)`,
`Plan.thermocouple_beads(tc, t=None)` evaluate at `Q(t)` when a time is given.

## 2. Instruments the lab mounts that the format cannot hold

From the lab's published room-fire reports and its logger exports:

| Object | Fields | Checks |
|---|---|---|
| `velocityProbe` (bi-directional probe) | transform with an axis (aimed like a gauge), `range_m_s` | `probe-not-in-opening` (info) when it is not within 0.1 m of a wall opening's plane: probes are usually there to measure flow through a doorway or window |
| `gasSampling` | transform, `species` (`O2`, `CO`, `CO2`, ...), optional `inDuct` | none |
| `loadCell` | transform, `capacity_kg` | `load-cell-not-under-fuel` (info) when no burner footprint is above it |

Heat flux gauges gain kinds `plate-thermometer` and `thin-skin` (documentation, like
the existing kinds: the predicted incident flux is the same quantity). All three new
objects can be targets of a test-data mapping (velocity in m/s, gas in its own unit as
mapped, mass in kg).

## 3. As built

**Why.** Reconstruction needs the poses the cameras actually had (PLAN open question 1),
and an instrument that was set up 200 mm off the plan reads differently.

**Model.** Any placed object may carry `asBuilt: { transform, measured, note }` beside
its planned `transform`: the same transform shape, the date it was measured, and a note.
The planned layout stays the plan: checks, drawings and coverage are about the plan.

- The editor shows an as-built object as a ghost at its measured place with a line to
  the planned one, and the inspector shows the offset (plan and height) and lets the
  measured values be typed or copied from the planned ones.
- A **Set-out check** table in the drawing lists planned against measured and the
  difference, for the crew's sign-off.
- Python: `cam.extrinsics(pose="best")` uses the as-built pose when there is one, and
  says which it used; `pose="planned"` and `pose="as-built"` are explicit. A data
  scientist reconstructing from a plan gets the measured poses without asking.

## 4. Instruments to FDS

PLAN open question 7 deferred an FDS exporter because a model needs a mesh, cells and
surfaces this format does not hold. **Devices do not**: an `&DEVC` is a quantity at a
point. **Export to FDS…** writes the plan's instruments as `&DEVC` lines in the source
file's frame (undoing `meta.source.originOffset_m`), named by object name so an import
of the run's output maps them back by name (M16):

- a gauge on a surface (within 0.05 m of a wall, ceiling or obstruction face, facing
  away from it): `QUANTITY='GAUGE HEAT FLUX'` with the face's `IOR`; a free-standing
  gauge: `QUANTITY='RADIATIVE HEAT FLUX GAS'` with `ORIENTATION`;
- each thermocouple bead: `QUANTITY='THERMOCOUPLE'` (a rake becomes one line per bead,
  `ID='<name>_<n>'`);
- a velocity probe: the velocity component its axis is closest to, with a comment
  when the axis is not one of FDS's.

Nothing else is written: no `&OBST`, `&MESH`, `&SURF`. The output says so in its header
comment. Both engines produce identical text for the shared fixtures.

## 5. Test series

PLAN open question 2 asked for one file per test or a campaign file. One file per test
stays: it is what the logger, the videos and the reconstruction already produce. A
series is light metadata and one command:

- `meta.series` (free text, e.g. the project and series name) and `meta.testId`
  already exists; no version bump for `meta` (it is open in every 1.x schema).
- **Next test…** saves a copy for the next test of the series: the same rig, the next
  test ID (a trailing number is incremented), revision reset, and the test's own data
  (`testData`, flame sequences, linked videos and spreadsheets) left behind.

## Order

1 and 4 first (they change predictions and close the FDS loop), then 2, then 3, then 5.
