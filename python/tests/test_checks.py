"""Semantic checks: hood capture, framing, and plan hygiene."""

from __future__ import annotations

import os

import numpy as np
import pytest

from fireplan import Plan
from fireplan._math import look_at_quat

FIXTURES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fixtures"
)
CAMERA_ROW = os.path.join(FIXTURES, "pool-fire-camera-row.ftp.json")


def codes(issues):
    return {i.code for i in issues}


def _plan_with_hood(hood_height_m, opening_m, hrr_kw=130.0, skirt_m=0.0):
    plan = Plan.new("hood test")
    plan.add({
        "id": "burner-main",
        "type": "burner",
        "transform": {"position_m": [0.0, 0.0, 0.0]},
        "footprint": {"shape": "square", "size_m": [0.3048, 0.3048]},
        "rimHeight_m": 0.1,
        "fire": {"fuel": "n-heptane", "hrr_kw": hrr_kw, "hrrCurve": None},
    })
    plan.add({
        "id": "hood-main",
        "type": "hood",
        "transform": {"position_m": [0.0, 0.0, 0.0]},
        "opening_m": list(opening_m),
        "height_m": hood_height_m,
        "skirtDepth_m": skirt_m,
        "duct": None,
    })
    return plan


# -- hood checks ---------------------------------------------------------

def test_reference_layout_has_no_hood_problems():
    plan = Plan.load(CAMERA_ROW)
    assert codes(plan.hood_checks()) == set()


def test_flame_reaching_the_canopy_is_an_error():
    """130 kW on a 1 ft pan gives a ~1.3 m mean flame; a hood at 1.0 m is inside it."""
    plan = _plan_with_hood(hood_height_m=1.0, opening_m=[3.0, 3.0])
    assert "flame-impingement" in codes(plan.hood_checks())


def test_marginal_flame_clearance_is_a_warning_not_an_error():
    plan = _plan_with_hood(hood_height_m=1.6, opening_m=[3.0, 3.0])
    found = codes(plan.hood_checks())
    assert "flame-clearance" in found
    assert "flame-impingement" not in found


def test_undersized_hood_spills_plume():
    """A hood that cannot capture the plume under-reads HRR by oxygen consumption --
    a measurement-validity failure, so it is an error rather than a warning."""
    plan = _plan_with_hood(hood_height_m=3.0, opening_m=[0.5, 0.5])
    assert "plume-spillage" in codes(plan.hood_checks())


def test_plume_margin_warns_before_it_spills():
    plan = _plan_with_hood(hood_height_m=3.0, opening_m=[1.5, 1.5])
    found = codes(plan.hood_checks())
    assert "plume-margin" in found
    assert "plume-spillage" not in found


def test_the_narrow_side_of_a_rectangular_hood_governs():
    """A long, narrow hood still spills across its short dimension."""
    plan = _plan_with_hood(hood_height_m=3.0, opening_m=[6.0, 0.5])
    assert "plume-spillage" in codes(plan.hood_checks())


def test_a_skirt_lowers_the_plane_the_plume_must_reach():
    """The skirt hangs below the opening, so capture is judged there, not at the
    canopy -- a hood that passes without a skirt can fail with one."""
    high = _plan_with_hood(hood_height_m=1.9, opening_m=[3.0, 3.0], skirt_m=0.0)
    skirted = _plan_with_hood(hood_height_m=1.9, opening_m=[3.0, 3.0], skirt_m=0.6)
    assert "flame-impingement" not in codes(high.hood_checks())
    assert "flame-impingement" in codes(skirted.hood_checks())


def test_hood_checks_stay_silent_when_hrr_is_unknown():
    """No HRR means no flame geometry; the tool must not invent a verdict."""
    plan = _plan_with_hood(hood_height_m=1.0, opening_m=[3.0, 3.0])
    plan.burner.raw["fire"]["hrr_kw"] = None
    assert plan.hood_checks() == []


def test_hood_checks_stay_silent_with_no_hood():
    plan = Plan.new("no hood")
    plan.add({
        "id": "b", "type": "burner",
        "footprint": {"shape": "circle", "diameter_m": 0.3},
        "fire": {"hrr_kw": 100.0},
    })
    assert plan.hood_checks() == []


# -- plan hygiene --------------------------------------------------------

def test_duplicate_ids_are_an_error():
    plan = Plan.new("dupes")
    for _ in range(2):
        plan.add({"id": "same", "type": "burner", "footprint": {"shape": "circle", "diameter_m": 0.3}})
    assert "duplicate-id" in codes(plan.check())


def test_a_quaternion_disagreeing_with_its_aim_target_warns():
    """Catches a hand-edited file where someone moved the target and forgot the
    quaternion. The quaternion wins, so the user needs telling."""
    plan = Plan.load(CAMERA_ROW)
    plan.cameras["cam-gopro"].raw["transform"]["aimTarget_m"] = [5.0, 5.0, 0.0]
    assert "aim-mismatch" in codes(plan.check())


def test_a_consistent_aim_target_does_not_warn():
    plan = Plan.load(CAMERA_ROW)
    assert "aim-mismatch" not in codes(plan.check())


def test_a_non_unit_quaternion_warns():
    plan = Plan.load(CAMERA_ROW)
    q = plan.cameras["cam-gopro"].raw["transform"]["rotation_quat"]
    plan.cameras["cam-gopro"].raw["transform"]["rotation_quat"] = [v * 2 for v in q]
    assert "non-unit-quaternion" in codes(plan.check())


def test_nominal_intrinsics_are_flagged_for_the_data_scientist():
    plan = Plan.load(CAMERA_ROW)
    flagged = {i.object_id for i in plan.check() if i.code == "nominal-intrinsics"}
    assert flagged == {"cam-mwir", "cam-gopro", "cam-iphone"}
    # The T650 is marked `datasheet`, so it must not be flagged.
    assert "cam-lwir-t650" not in flagged
    assert plan.cameras["cam-lwir-t650"].is_reconstruction_ready is False


def test_a_burner_away_from_the_origin_warns():
    """The coordinate system is defined as burner-centred, so standoff would lie."""
    plan = Plan.new("off origin")
    plan.add({
        "id": "b", "type": "burner",
        "transform": {"position_m": [2.0, 0.0, 0.0]},
        "footprint": {"shape": "circle", "diameter_m": 0.3},
        "fire": {"hrr_kw": 100.0},
    })
    assert "burner-off-origin" in codes(plan.check())


def test_a_plan_with_no_burner_warns():
    assert "no-burner" in codes(Plan.new("empty").check())


def test_the_primary_burner_is_the_one_at_the_origin():
    plan = Plan.new("two burners")
    plan.add({
        "id": "secondary", "type": "burner",
        "transform": {"position_m": [3.0, 0.0, 0.0]},
        "footprint": {"shape": "circle", "diameter_m": 0.2},
    })
    plan.add({
        "id": "primary", "type": "burner",
        "transform": {"position_m": [0.0, 0.0, 0.0]},
        "footprint": {"shape": "circle", "diameter_m": 0.5},
    })
    assert plan.burner.id == "primary"


# -- framing -------------------------------------------------------------

def test_narrow_ir_optics_cannot_frame_the_flame_at_nine_feet():
    """The finding the reference layout exists to demonstrate.

    An 18-19 degree vertical field at a ~3.1 m slant range covers barely a 1 m
    slice, so both IR cameras clip the 1.30 m flame at BOTH ends -- they miss the
    base as well as the tip. The two wide RGB cameras cover the whole plume.
    """
    plan = Plan.load(CAMERA_ROW)

    for cid in ("cam-lwir-t650", "cam-mwir"):
        report = plan.framing(plan.cameras[cid])
        assert report["flame_base_visible"] is False, cid
        assert report["flame_tip_visible"] is False, cid
        assert 0.5 < report["plume_fraction_visible"] < 0.85, cid

    for cid in ("cam-gopro", "cam-iphone"):
        report = plan.framing(plan.cameras[cid])
        assert report["flame_base_visible"] is True, cid
        assert report["flame_tip_visible"] is True, cid
        assert report["plume_fraction_visible"] == pytest.approx(1.0)


def test_backing_the_ir_cameras_off_fixes_the_framing():
    """And the fix the report implies actually works -- otherwise the check is only
    half useful."""
    plan = Plan.load(CAMERA_ROW)
    for cid, y in (("cam-lwir-t650", -0.25), ("cam-mwir", -0.75)):
        cam = plan.cameras[cid]
        cam.position = [-4.5, y, 1.5]
        cam.aim_at([0.0, 0.0, 0.75])
        report = plan.framing(cam)
        assert report["flame_base_visible"] is True, cid
        assert report["flame_tip_visible"] is True, cid


def test_framing_reports_standoff_both_ways():
    """The camera row sits 9 ft back in X but is spread in Y, so each camera's
    radial standoff is slightly more than the row offset."""
    plan = Plan.load(CAMERA_ROW)
    report = plan.framing(plan.cameras["cam-gopro"])
    assert report["standoff_horizontal_m"] == pytest.approx(2.7546, abs=1e-3)
    assert report["standoff_m"] > report["standoff_horizontal_m"]
    assert plan.cameras["cam-gopro"].position[0] == pytest.approx(-2.7432, abs=1e-4)


def test_framing_degrades_gracefully_without_hrr():
    plan = Plan.load(CAMERA_ROW)
    plan.burner.raw["fire"]["hrr_kw"] = None
    report = plan.framing(plan.cameras["cam-gopro"])
    assert report["flame_tip_visible"] is None
    assert report["plume_fraction_visible"] is None
    assert report["flame_base_visible"] is True


# -- exports -------------------------------------------------------------

def test_nerfstudio_export_uses_opengl_poses_unflipped():
    plan = Plan.load(CAMERA_ROW)
    out = plan.to_nerfstudio()
    assert len(out["frames"]) == 4
    for frame in out["frames"]:
        cam = plan.cameras[frame["file_path"]]
        assert np.allclose(np.array(frame["transform_matrix"]), cam.extrinsics("opengl"))
        assert frame["fl_x"] == pytest.approx(cam.fx)
        assert frame["cx"] == pytest.approx(cam.principal_point[0])
        assert [frame["w"], frame["h"]] == list(cam.resolution)


def test_nerfstudio_export_writes_a_file(tmp_path):
    plan = Plan.load(CAMERA_ROW)
    out = tmp_path / "transforms.json"
    plan.to_nerfstudio(out)
    assert out.exists()


def test_camera_poses_round_trip_through_both_conventions():
    plan = Plan.load(CAMERA_ROW)
    c2w = plan.camera_poses("opencv")
    w2c = plan.camera_poses("opencv", world_to_camera=True)
    for cid in c2w:
        assert np.allclose(c2w[cid] @ w2c[cid], np.eye(4), atol=1e-12)


def test_equipment_table_covers_every_object():
    plan = Plan.load(CAMERA_ROW)
    rows = plan.equipment_table()
    assert {r["id"] for r in rows} == {
        "burner-main", "hood-main", "cam-mwir", "cam-lwir-t650", "cam-gopro", "cam-iphone",
    }
    gopro = next(r for r in rows if r["id"] == "cam-gopro")
    assert gopro["standoff_m"] == pytest.approx(2.755, abs=1e-3)
    assert gopro["hfov_deg"] == pytest.approx(122.0, abs=0.5)


def test_modality_drives_the_default_colour():
    plan = Plan.load(CAMERA_ROW)
    assert plan.cameras["cam-lwir-t650"].color != plan.cameras["cam-gopro"].color
    assert plan.cameras["cam-mwir"].color != plan.cameras["cam-lwir-t650"].color


def test_cameras_can_be_selected_by_modality():
    plan = Plan.load(CAMERA_ROW)
    assert len(plan.cameras_by_modality("RGB")) == 2
    assert [c.id for c in plan.cameras_by_modality("LWIR")] == ["cam-lwir-t650"]
