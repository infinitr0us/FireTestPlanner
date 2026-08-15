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


def build_camera_row() -> Plan:
    """The layout in example.jpg: a four-camera row at 9 ft, pan under a hood.

    Dimensions are an interpretation of the sketch, not a transcription -- the
    handwriting is ambiguous in places. They are meant to be edited.
    """
    plan = Plan.new("Pool fire — 4-camera row under calorimeter hood")
    plan.meta.update({
        "testId": "EX-001",
        "siteName": "Fire test bay",
        "revision": "A",
        "notes": (
            "Reference fixture reconstructed from the hand sketch in example.jpg. "
            "The camera row sits 9 ft back from the pan centre in X and is spread in Y, "
            "so each camera's radial standoff is a little over 9 ft. "
            "Note the framing consequence: an 18-19 degree vertical field at a ~3.1 m "
            "slant range covers barely a 1 m slice, so both IR cameras clip the 1.30 m "
            "flame at BOTH ends -- they miss the base as well as the tip, catching only "
            "about 70 percent of the plume. The two wide RGB cameras cover it entirely. "
            "Backing the IR row out to about 4.5 m frames the whole flame."
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
    # standard mass-loss correlation, not a guess.
    plan.add({
        "id": "burner-main",
        "type": "burner",
        "name": "Heptane pan, 1 ft square",
        "transform": {"position_m": [0.0, 0.0, 0.0]},
        "footprint": {"shape": "square", "size_m": [FT, FT]},
        "rimHeight_m": 0.10,
        "fire": {"fuel": "n-heptane", "hrr_kw": 130.0, "hrrCurve": None},
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

    row_x = -9 * FT
    plan.add(camera("cam-mwir", "MWIR", "mwir-640-25mm", [row_x, -0.75, 1.50]))
    plan.add(camera("cam-lwir-t650", "FLIR T650 LWIR", "flir-t650sc-25deg", [row_x, -0.25, 1.50]))
    plan.add(camera("cam-gopro", "GoPro", "gopro-hero-wide", [row_x, 0.25, 1.20]))
    plan.add(camera("cam-iphone", "iPhone", "iphone-main-26mm", [row_x, 0.75, 1.20]))

    return plan


def main() -> None:
    out_dir = os.path.join(ROOT, "fixtures")
    os.makedirs(out_dir, exist_ok=True)

    plan = build_camera_row()
    plan.validate_schema()
    # Fixed timestamps: a rebuild that changes nothing should produce no diff.
    plan.meta["created"] = "2026-08-15T00:00:00Z"
    plan.meta["modified"] = "2026-08-15T00:00:00Z"

    path = os.path.join(out_dir, "pool-fire-camera-row.ftp.json")
    plan.save(path, update_modified=False)
    print("wrote {}".format(path))

    for issue in plan.check():
        print("  " + str(issue))


if __name__ == "__main__":
    main()
