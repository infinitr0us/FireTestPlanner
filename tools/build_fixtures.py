"""Regenerate the reference fixtures.

Kept in the repo so the fixtures are reproducible rather than hand-maintained --
in particular the quaternions, which nobody should be writing by hand.

    python tools/build_fixtures.py
"""

from __future__ import annotations

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "python"))

from fireplan import Plan  # noqa: E402
from fireplan import fds  # noqa: E402
from fireplan._math import look_at_quat  # noqa: E402

FT = 0.3048
PRESETS = {
    p["id"]: p
    for p in json.load(open(os.path.join(ROOT, "presets", "cameras.json"), encoding="utf-8"))["presets"]
}

# Aim everything at mid-flame rather than the pan, so the framing check reflects
# how these cameras would actually be pointed on the day.
AIM = [0.0, 0.0, 0.75]


def camera(obj_id, name, preset_id, position, mount_type="tripod"):
    p = PRESETS[preset_id]
    q = look_at_quat(position, AIM)
    return {
        "id": obj_id,
        "type": "camera",
        "name": name,
        "transform": {
            "position_m": [float(v) for v in position],
            "rotation_quat": [float(v) for v in q],
            "aimTarget_m": list(AIM),
        },
        "camera": {
            "modality": p["modality"],
            "presetId": p["id"],
            "resolution_px": list(p["resolution_px"]),
            "sensor_mm": list(p["sensor_mm"]),
            "focalLength_mm": p["focalLength_mm"],
            "principalPoint_px": None,
            "distortion": None,
            "intrinsicsSource": p["intrinsicsSource"],
            "spectralBand_um": p["spectralBand_um"],
            "framerate_hz": p["framerate_hz"],
        },
        "mount": {"type": mount_type, "height_m": round(float(position[2]), 4)},
        "recording": None,
    }


def heat_flux_sensor(obj_id, name, position, aim, range_kw_m2, mount_type="wall"):
    """A gauge aimed at the fire.

    Aimed rather than axis-aligned because the orientation is not decoration: the
    cos(theta) it contributes is a first-order term in what the gauge reads, so a
    gauge facing an arbitrary direction would report a number that means nothing.
    """
    q = look_at_quat(position, aim)
    return {
        "id": obj_id,
        "type": "heatFluxSensor",
        "name": name,
        "transform": {
            "position_m": [float(v) for v in position],
            "rotation_quat": [float(v) for v in q],
            "aimTarget_m": [float(v) for v in aim],
        },
        "gauge": {
            "kind": "schmidt-boelter",
            "range_kw_m2": float(range_kw_m2),
            "viewAngle_deg": 180.0,
            "waterCooled": True,
            "serial": None,
        },
        "mount": {"type": mount_type, "height_m": round(float(position[2]), 4)},
    }


def thermocouple(obj_id, name, position, bead_offsets, mount_type="wall", tc_type="K"):
    """A rake. A single bead is the one-element case, so there is one object type."""
    return {
        "id": obj_id,
        "type": "thermocouple",
        "name": name,
        "transform": {"position_m": [float(v) for v in position]},
        "beadOffsets_m": [float(v) for v in bead_offsets],
        "thermocouple": {
            "tcType": tc_type,
            "beadDiameter_mm": 1.5,
            "sheathed": True,
            "maxTemperature_C": None,
        },
        "mount": {"type": mount_type, "height_m": round(float(position[2]), 4)},
    }


def build_camera_row() -> Plan:
    """The layout in example.jpg: a four-camera row at 9 ft, pan under a hood.

    Extended past the sketch with a wall corner and the instrumentation that
    normally goes with it, so the reference plan exercises every object type the
    format defines and every check the tool runs.

    Dimensions are an interpretation of the sketch, not a transcription -- the
    handwriting is ambiguous in places. They are meant to be edited.
    """
    plan = Plan.new("Pool fire — 4-camera row under calorimeter hood")
    plan.meta.update({
        "testId": "EX-001",
        "siteName": "Fire test bay",
        "revision": "B",
        "notes": (
            "Reference fixture reconstructed from the hand sketch in example.jpg, with a "
            "wall corner and instrumentation added. "
            "The camera row sits 9 ft back from the pan centre in X and is spread in Y, "
            "so each camera's radial standoff is a little over 9 ft. "
            "Note the framing consequence: NEITHER IR camera frames the 1.30 m flame at "
            "9 ft, though they miss by different amounts. The T650's 18.8 degree vertical "
            "field clips the flame base by 131 mm and the tip by 209 mm, catching 72 percent "
            "of the plume. The A8303sc's wider 22.8 degree field does much better and is "
            "still short: it clips the base by only 3 mm but the tip by 76 mm, for 89 "
            "percent. The asymmetry is perspective, not aim -- both cameras stand at 1.5 m "
            "and look DOWN at mid-flame, so the flame tip is nearly level with the lens and "
            "falls much further off-axis than a flat-plane estimate suggests. Backing the IR "
            "row out to about 4.5 m frames the whole plume for both, at 2.7 and 3.3 mm/px. "
            "The two wide RGB cameras cover it entirely from where they are. "
            "The gauges make the same kind of point about instrument selection: at 1.5 m "
            "from a 130 kW fire the east-wall gauge sees under 2 kW/m2, which is 3 percent "
            "of a 50 kW/m2 gauge and lost in its noise, while the 10 kW/m2 gauge further "
            "away on the north wall reads usefully. Bringing the gauges you own rather than "
            "the gauges the fire calls for is the commonest way to waste a test day."
        ),
    })
    plan.data["units"]["display"] = {"length": "ft", "angle": "deg"}
    plan.environment.update({
        "floorSize_m": [12.0, 12.0],
        "ceilingHeight_m": None,
        "ambientTemperature_C": 20.0,
        "notes": "Open bay; hood is the only overhead structure.",
    })

    # 1 ft square heptane pan. 130 kW is the steady HRR for this area from the
    # standard mass-loss correlation, not a guess. 0.35 radiated is heptane's
    # figure rather than the 0.3 default, and it is what the gauges are sized on.
    plan.add({
        "id": "burner-main",
        "type": "burner",
        "name": "Heptane pan, 1 ft square",
        "transform": {"position_m": [0.0, 0.0, 0.0]},
        "footprint": {"shape": "square", "size_m": [FT, FT]},
        "rimHeight_m": 0.10,
        "fire": {
            "fuel": "n-heptane",
            "hrr_kw": 130.0,
            "radiativeFraction": 0.35,
            "hrrCurve": None,
        },
    })

    # 8 ft square opening at 9 ft, with a 1 ft skirt.
    plan.add({
        "id": "hood-main",
        "type": "hood",
        "name": "Calorimeter hood",
        "transform": {"position_m": [0.0, 0.0, 0.0]},
        "opening_m": [8 * FT, 8 * FT],
        "height_m": 9 * FT,
        "skirtDepth_m": 1 * FT,
        "duct": {"diameter_m": 0.6, "length_m": 2.0},
    })

    # An L of walls on the far side of the pan from the cameras, so they read as a
    # backdrop rather than an obstruction. Clear of the hood footprint (+/-1.22 m)
    # as well, so the canopy is not resting on them.
    EAST_X, NORTH_Y, WALL_T = 1.5, 2.0, 0.10
    plan.add({
        "id": "wall-east",
        "type": "wall",
        "name": "East wall",
        "transform": {"position_m": [0.0, 0.0, 0.0]},
        "polyline_m": [[EAST_X, -2.0], [EAST_X, NORTH_Y]],
        "height_m": 2.4,
        "thickness_m": WALL_T,
        "baseHeight_m": 0.0,
        "openings": [],
    })
    plan.add({
        "id": "wall-north",
        "type": "wall",
        "name": "North wall",
        "transform": {"position_m": [0.0, 0.0, 0.0]},
        "polyline_m": [[EAST_X, NORTH_Y], [-2.0, NORTH_Y]],
        "height_m": 2.4,
        "thickness_m": WALL_T,
        "baseHeight_m": 0.0,
        "openings": [],
    })

    row_x = -9 * FT
    plan.add(camera("cam-mwir", "FLIR A8303sc MWIR", "flir-a8303sc-25mm", [row_x, -0.75, 1.50]))
    plan.add(camera("cam-lwir-t650", "FLIR T650 LWIR", "flir-t650sc-25deg", [row_x, -0.25, 1.50]))
    plan.add(camera("cam-gopro", "GoPro", "gopro-hero-wide", [row_x, 0.25, 1.20]))
    plan.add(camera("cam-iphone", "iPhone", "iphone-main-26mm", [row_x, 0.75, 1.20]))

    # Gauges sit on the inner face of each wall, half a thickness proud of the
    # centreline, and are aimed at the point source the model actually uses --
    # taken from the plan rather than written down twice.
    fire = plan.fire_point_source()
    east_face = EAST_X - WALL_T / 2
    north_face = NORTH_Y - WALL_T / 2
    plan.add(heat_flux_sensor(
        "hf-east", "East wall gauge", [east_face, 0.0, 0.90], fire, range_kw_m2=50.0))
    plan.add(heat_flux_sensor(
        "hf-north", "North wall gauge", [0.0, north_face, 0.90], fire, range_kw_m2=10.0))

    # One rake up the east wall for the near-wall gas temperature, and one in the
    # plume, offset just far enough off the axis to stay out of the flame cone.
    plan.add(thermocouple(
        "tc-east-wall", "East wall rake", [east_face, 0.0, 0.0], [0.3, 0.9, 1.5, 2.1]))
    plan.add(thermocouple(
        "tc-plume", "Plume rake", [0.25, 0.0, 0.0], [1.6, 1.9, 2.2], mount_type="floor"))

    return plan


def build_forward_compat():
    """A plan carrying objects from a format version this build does not know.

    Deliberately awkward: an unrecognised `type`, keys in an order no 1.0 writer
    would choose, and coefficients with more precision than the 1 um rounding known
    fields get. CONVENTIONS.md section 6 promises all of it survives a load/save
    cycle unchanged, and both writers have to agree on that byte for byte -- so this
    is the fixture that would break if either of them started tidying data it does
    not understand.
    """
    plan = Plan.new("Forward compatibility")
    plan.add({
        "id": "burner-main",
        "type": "burner",
        "name": "Fuel pan",
        "transform": {"position_m": [0.0, 0.0, 0.0]},
        "footprint": {"shape": "square", "size_m": [FT, FT]},
        "rimHeight_m": 0.1,
        "fire": {"fuel": "n-heptane", "hrr_kw": 130.0, "hrrCurve": None},
    })
    plan.add({
        # Key order is intentionally not the canonical one.
        "zzz_trailingKey": "must stay last",
        "id": "spec-1",
        "type": "spectrometer",              # not in format 1.0
        "calibration": {
            "coefficient": 1.23456789,       # finer than FLOAT_DECIMALS
            "gain": 12.0,                    # integral float: 12, never 12.0
            "counts": 4096,
            # Values whose two languages spell them differently unless the writers
            # agree on JavaScript's rules: Python's repr gives 1.23e-08, 1e-06 and
            # 1e+21 where JSON.stringify gives 1.23e-8, 0.000001 and 1e+21.
            "darkCurrent_a": 1.23e-8,
            "noiseFloor_a": 1e-6,
            "fullScale_counts": 1e21,
        },
        "transform": {"position_m": [1.5, -0.25, 1.0]},
        "name": "Future device",
        "sampleRate_hz": 1000,
    })
    return plan


def build_fds_import() -> Plan:
    """The sample FDS input, converted.

    Committed as a fixture because it is the readable form of the mapping: every
    rule in `fireplan.fds` shows up here as a wall, an opening or a rake, and a
    change to any of them shows up as a diff a reviewer can judge. It is also the
    reference the TypeScript importer is held against.
    """
    result = fds.load(
        os.path.join(ROOT, "fixtures", "fds", "IR401_0.fds"),
        fds.ImportOptions(imported_at="2026-08-15T00:00:00Z"),
    )
    for issue in result.issues:
        print("  " + str(issue))
    return result.plan


def main() -> None:
    out_dir = os.path.join(ROOT, "fixtures")
    os.makedirs(out_dir, exist_ok=True)

    for name, plan in [
        ("pool-fire-camera-row.ftp.json", build_camera_row()),
        ("forward-compat.ftp.json", build_forward_compat()),
        (os.path.join("fds", "IR401_0.ftp.json"), build_fds_import()),
    ]:
        plan.validate_schema()
        # Fixed timestamps: a rebuild that changes nothing should produce no diff.
        plan.meta["created"] = "2026-08-15T00:00:00Z"
        plan.meta["modified"] = "2026-08-15T00:00:00Z"

        path = os.path.join(out_dir, name)
        plan.save(path, update_modified=False)
        print("wrote {}".format(path))

        for issue in plan.check():
            print("  " + str(issue))


if __name__ == "__main__":
    main()
