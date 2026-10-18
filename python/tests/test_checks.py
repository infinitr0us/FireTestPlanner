"""Semantic checks: hood capture, framing, and plan hygiene."""

from __future__ import annotations

import math
import os

import numpy as np
import pytest

from fireplan import Plan
from fireplan._math import look_at_quat
from fireplan.objects import MODALITY_COLORS

FIXTURES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fixtures"
)
CAMERA_ROW = os.path.join(FIXTURES, "pool-fire-camera-row.ftp.json")


def codes(issues):
    return {i.code for i in issues}


def _plan_with_hood(hood_height_m, opening_m, hrr_kw=130.0, skirt_m=0.0,
                    hood_position=(0.0, 0.0, 0.0), hood_quat=None):
    plan = Plan.new("hood test")
    plan.add({
        "id": "burner-main",
        "type": "burner",
        "transform": {"position_m": [0.0, 0.0, 0.0]},
        "footprint": {"shape": "square", "size_m": [0.3048, 0.3048]},
        "rimHeight_m": 0.1,
        "fire": {"fuel": "n-heptane", "hrr_kw": hrr_kw, "hrrCurve": None},
    })
    transform = {"position_m": [float(v) for v in hood_position]}
    if hood_quat is not None:
        transform["rotation_quat"] = [float(v) for v in hood_quat]
    plan.add({
        "id": "hood-main",
        "type": "hood",
        "transform": transform,
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


def test_a_hood_moved_down_in_z_is_judged_where_it_is_drawn():
    """The 3D view applies the transform and then the local opening height, so a
    hood with height_m 4 at z = -3 has its intake at 1 m. The check read height_m
    alone and cleared a 1.44 m flame that was visibly inside the canopy."""
    plan = _plan_with_hood(hood_height_m=4.0, opening_m=[4.0, 4.0],
                           hood_position=(0.0, 0.0, -3.0))
    hood = plan.hoods[0]
    assert hood.opening_z_m == pytest.approx(1.0)
    assert hood.intake_height_m == pytest.approx(1.0)
    assert "flame-impingement" in codes(plan.hood_checks())
    # And the equipment table prints the same plane.
    row = next(r for r in plan.equipment_table() if r["category"] == "hood")
    assert row["height_m"] == pytest.approx(1.0)


def test_hood_checks_take_every_fire_into_account():
    """A second burner beside the hood is a plume it does not capture -- a fire the
    HRR measurement will miss -- and used to go unmentioned."""
    plan = _plan_with_hood(hood_height_m=3.0, opening_m=[2.0, 2.0])
    plan.add({
        "id": "burner-2", "type": "burner", "name": "Second pan",
        "transform": {"position_m": [5.0, 0.0, 0.0]},
        "footprint": {"shape": "square", "size_m": [0.3, 0.3]},
        "rimHeight_m": 0.1,
        "fire": {"hrr_kw": 100.0, "hrrCurve": None},
    })
    found = plan.hood_checks()
    offset = [i for i in found if i.code == "hood-offset"]
    assert len(offset) == 1
    assert "Second pan" in offset[0].message


# -- hood placement ------------------------------------------------------
#
# A hood only captures the plume it is actually over. Judging capture from the
# opening size alone lets a hood parked in the next bay report clean, which is a
# false negative on a measurement-validity check. Mirrors the TypeScript cases in
# web/src/core/core.test.ts.

def test_a_hood_in_the_next_bay_captures_nothing():
    plan = _plan_with_hood(hood_height_m=3.0, opening_m=[3.0, 3.0],
                           hood_position=(100.0, 100.0, 0.0))
    found = codes(plan.hood_checks())
    assert "hood-offset" in found
    # And it does not also report the plume as merely short of margin.
    assert "plume-margin" not in found


def test_the_opening_edge_is_where_offset_starts():
    inside = _plan_with_hood(hood_height_m=3.0, opening_m=[3.0, 3.0],
                             hood_position=(1.49, 0.0, 0.0))
    outside = _plan_with_hood(hood_height_m=3.0, opening_m=[3.0, 3.0],
                              hood_position=(1.51, 0.0, 0.0))
    assert "hood-offset" not in codes(inside.hood_checks())
    assert "hood-offset" in codes(outside.hood_checks())


def test_an_off_centre_fire_spills_a_hood_that_would_pass_centred():
    """What has to fit is a disk centred on the burner, not on the opening."""
    centred = _plan_with_hood(hood_height_m=3.0, opening_m=[1.6, 1.6])
    shifted = _plan_with_hood(hood_height_m=3.0, opening_m=[1.6, 1.6],
                              hood_position=(0.7, 0.0, 0.0))
    assert "plume-spillage" not in codes(centred.hood_checks())
    assert "plume-spillage" in codes(shifted.hood_checks())


def test_the_offset_is_measured_in_the_hoods_own_frame():
    """A long narrow opening presents its short side once it is yawed 90 degrees."""
    yaw90 = [0.0, 0.0, 2 ** -0.5, 2 ** -0.5]
    flat = _plan_with_hood(hood_height_m=3.0, opening_m=[4.0, 0.8],
                           hood_position=(-1.2, 0.0, 0.0))
    turned = _plan_with_hood(hood_height_m=3.0, opening_m=[4.0, 0.8],
                             hood_position=(-1.2, 0.0, 0.0), hood_quat=yaw90)
    assert "hood-offset" not in codes(flat.hood_checks())
    assert "hood-offset" in codes(turned.hood_checks())


def test_hood_offset_matches_the_reference_plan_when_the_hood_is_moved():
    """The reference layout is clean; moving its hood away must not stay clean."""
    plan = Plan.load(CAMERA_ROW)
    assert plan.hood_checks() == []
    plan.hoods[0].position = [100.0, 100.0, 0.0]
    assert "hood-offset" in codes(plan.hood_checks())


# -- ceiling checks ------------------------------------------------------

def _plan_with_ceiling(height_m, half_extent_m=3.0, offset_m=0.0, hrr_kw=130.0):
    plan = Plan.new("ceiling test")
    plan.add({
        "id": "burner-main",
        "type": "burner",
        "transform": {"position_m": [0.0, 0.0, 0.0]},
        "footprint": {"shape": "square", "size_m": [0.3048, 0.3048]},
        "rimHeight_m": 0.1,
        "fire": {"fuel": "n-heptane", "hrr_kw": hrr_kw, "hrrCurve": None},
    })
    h = half_extent_m
    plan.add({
        "id": "ceiling-main",
        "type": "ceiling",
        "transform": {"position_m": [offset_m, 0.0, 0.0]},
        "polygon_m": [[-h, -h], [h, -h], [h, h], [-h, h]],
        "height_m": height_m,
        "thickness_m": 0.15,
    })
    return plan


def test_flame_reaching_the_ceiling_is_an_error():
    """130 kW on a 1 ft pan gives a ~1.30 m flame tip; a 1.2 m ceiling is inside it."""
    plan = _plan_with_ceiling(height_m=1.2)
    assert "ceiling-impingement" in codes(plan.ceiling_checks())


def test_marginal_ceiling_clearance_is_a_warning():
    plan = _plan_with_ceiling(height_m=1.6)
    found = codes(plan.ceiling_checks())
    assert "ceiling-clearance" in found
    assert "ceiling-impingement" not in found


def test_a_ceiling_moved_down_in_z_is_judged_where_it_is_drawn():
    """Same as the hood: a slab with height_m 4 at z = -3 has its soffit at 1 m."""
    plan = _plan_with_ceiling(height_m=4.0)
    plan.ceilings[0].raw["transform"]["position_m"] = [0.0, 0.0, -3.0]
    assert plan.ceilings[0].soffit_z_m == pytest.approx(1.0)
    assert "ceiling-impingement" in codes(plan.ceiling_checks())
    row = next(r for r in plan.equipment_table() if r["category"] == "ceiling")
    assert row["height_m"] == pytest.approx(1.0)


def test_ceiling_checks_take_every_fire_into_account():
    plan = _plan_with_ceiling(height_m=6.0, half_extent_m=10.0)
    plan.add({
        "id": "burner-2", "type": "burner", "name": "Big pan",
        "transform": {"position_m": [5.0, 0.0, 0.0]},
        "footprint": {"shape": "square", "size_m": [0.3, 0.3]},
        "rimHeight_m": 0.1,
        "fire": {"hrr_kw": 5000.0, "hrrCurve": None},   # a 5 MW fire reaches 6 m
    })
    found = plan.ceiling_checks()
    assert "ceiling-impingement" in codes(found)
    assert "Big pan" in next(i.message for i in found if i.code == "ceiling-impingement")


def test_a_high_ceiling_is_silent():
    assert codes(_plan_with_ceiling(height_m=6.0).ceiling_checks()) == set()


def test_a_ceiling_that_does_not_cover_the_fire_is_ignored():
    """A slab off to one side is not a ceiling for this burner, however low it is."""
    plan = _plan_with_ceiling(height_m=1.0, half_extent_m=1.0, offset_m=10.0)
    assert plan.ceiling_checks() == []


def test_ceiling_containment_is_exact_at_the_edges():
    plan = _plan_with_ceiling(height_m=3.0, half_extent_m=2.0)
    ceiling = plan.ceilings[0]
    assert ceiling.contains_xy(0.0, 0.0)
    assert ceiling.contains_xy(1.99, 1.99)
    assert not ceiling.contains_xy(2.01, 0.0)
    assert not ceiling.contains_xy(0.0, -2.5)


def test_ceiling_area_uses_the_shoelace_formula():
    plan = _plan_with_ceiling(height_m=3.0, half_extent_m=2.5)
    assert plan.ceilings[0].area_m2 == pytest.approx(25.0)  # 5 m x 5 m


# -- object frames -------------------------------------------------------
#
# The 3D editor applies rotation_quat to every object group, so anything reading
# geometry back out has to apply it too, or the picture and the verdict disagree
# about the same plan. Mirrors 'object frames' in web/src/core/core.test.ts.

def _slab_plan(quat=None):
    plan = _plan_with_ceiling(height_m=1.2)
    ceiling = plan.ceilings[0]
    # Long in X, narrow in Y, and shifted so only the long arm reaches the burner.
    ceiling.raw["polygon_m"] = [[-1.0, -0.5], [7.0, -0.5], [7.0, 0.5], [-1.0, 0.5]]
    ceiling.raw["transform"]["position_m"] = [0.0, 0.0, 0.0]
    if quat is not None:
        ceiling.raw["transform"]["rotation_quat"] = list(quat)
    return plan


YAW90 = [0.0, 0.0, 2 ** -0.5, 2 ** -0.5]


def test_footprint_vertices_go_through_the_object_frame():
    ceiling = _slab_plan(YAW90).ceilings[0]
    x, y = ceiling.footprint_xy([4.0, 0.0])
    assert x == pytest.approx(0.0, abs=1e-9)
    assert y == pytest.approx(4.0, abs=1e-9)


def test_to_world_and_to_local_round_trip():
    obj = _slab_plan(look_at_quat(np.zeros(3), np.array([1.0, 2.0, 3.0]))).ceilings[0]
    back = obj.to_local(obj.to_world([0.4, -1.2, 2.0]))
    assert back == pytest.approx([0.4, -1.2, 2.0], abs=1e-9)


def test_containment_follows_the_rotated_footprint():
    assert _slab_plan().ceilings[0].contains_xy(3.0, 0.0)
    assert not _slab_plan(YAW90).ceilings[0].contains_xy(3.0, 0.0)
    assert _slab_plan(YAW90).ceilings[0].contains_xy(0.0, 3.0)


def test_impingement_follows_the_orientation_actually_drawn():
    """A slab yawed off the fire stops being this burner's ceiling."""
    plan = _slab_plan()
    plan.burner.position = [3.0, 0.0, 0.0]
    assert "ceiling-impingement" in codes(plan.ceiling_checks())

    turned = _slab_plan(YAW90)
    turned.burner.position = [3.0, 0.0, 0.0]
    assert "ceiling-impingement" not in codes(turned.ceiling_checks())


def test_ceiling_area_handles_a_non_rectangular_slab():
    plan = Plan.new("L-shaped")
    plan.add({
        "id": "c", "type": "ceiling",
        "polygon_m": [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]],
        "height_m": 3.0,
    })
    # 4x2 leg plus 2x2 leg = 12 m2.
    assert plan.ceilings[0].area_m2 == pytest.approx(12.0)


def test_ceiling_checks_stay_silent_without_hrr():
    plan = _plan_with_ceiling(height_m=1.0)
    plan.burner.raw["fire"]["hrr_kw"] = None
    assert plan.ceiling_checks() == []


def test_ceiling_appears_in_the_equipment_table():
    plan = _plan_with_ceiling(height_m=3.0, half_extent_m=2.0)
    row = next(r for r in plan.equipment_table() if r["category"] == "ceiling")
    assert "16.0 m2" in row["detail"]
    assert row["height_m"] == pytest.approx(3.0)


def test_ceiling_round_trips_and_validates():
    plan = _plan_with_ceiling(height_m=3.0)
    plan.validate_schema()
    reloaded = Plan.loads(plan.dumps())
    assert reloaded.dumps() == plan.dumps()
    assert reloaded.ceilings[0].height_m == 3.0


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
    assert flagged == {"cam-gopro", "cam-iphone"}
    # Both IR cameras are seeded from a datasheet, so neither may be flagged --
    # and `datasheet` is still not good enough to reconstruct from.
    for cid in ("cam-lwir-t650", "cam-mwir"):
        assert cid not in flagged
        assert plan.cameras[cid].is_reconstruction_ready is False


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

def test_narrow_lwir_optics_cannot_frame_the_flame_at_nine_feet():
    """The finding the reference layout exists to demonstrate.

    The T650's 18.8 degree vertical field at a ~3.1 m slant range covers only about
    1.04 m, so it clips the 1.30 m flame at BOTH ends -- it misses the base as well
    as the tip, by about 130 mm each.
    """
    plan = Plan.load(CAMERA_ROW)
    report = plan.framing(plan.cameras["cam-lwir-t650"])
    assert report["flame_base_visible"] is False
    assert report["flame_tip_visible"] is False
    assert 0.5 < report["plume_fraction_visible"] < 0.85


def test_the_mwir_camera_does_better_and_still_clips_the_flame():
    """The other half of the finding.

    The A8303sc's wider 22.8 degree field catches 89 percent of the plume against
    the T650's 72, and still misses both ends. Worth pinning because a flat-plane
    estimate -- vertical field angle times standoff, compared against flame height
    -- says it fits with millimetres to spare, and that estimate is wrong: the
    camera looks DOWN at mid-flame from 1.5 m, so the tip sits nearly level with the
    lens and falls much further off-axis than its height above the pan suggests.
    Only projecting gets this right, which is why `framing` projects.
    """
    plan = Plan.load(CAMERA_ROW)
    cam = plan.cameras["cam-mwir"]

    report = plan.framing(cam)
    assert report["flame_base_visible"] is False
    assert report["flame_tip_visible"] is False
    # Far more of the plume than the T650 gets, and still not all of it.
    assert 0.85 < report["plume_fraction_visible"] < 0.95

    # The flat-plane estimate that would have said otherwise.
    covered_m = 2 * math.tan(cam.vfov_rad / 2) * cam.standoff_m
    flame_m = plan.burner.flame_tip_z_m() - plan.burner.fuel_surface_z_m
    assert covered_m == pytest.approx(flame_m, abs=0.01)   # "it fits" -- but it does not

    # What it actually costs, at the top of the flame: tens of millimetres.
    uv, _ = cam.project(np.array([0.0, 0.0, plan.burner.flame_tip_z_m()]))
    tip_v = float(uv[1])
    assert tip_v < 0.0                                     # above the top pixel row
    missed_mm = -tip_v / cam.fy * cam.standoff_m * 1000.0
    assert 50.0 < missed_mm < 100.0, missed_mm


def test_the_wide_rgb_cameras_cover_the_whole_plume_from_where_they_are():
    plan = Plan.load(CAMERA_ROW)
    for cid in ("cam-gopro", "cam-iphone"):
        report = plan.framing(plan.cameras[cid])
        assert report["flame_base_visible"] is True, cid
        assert report["flame_tip_visible"] is True, cid
        assert report["plume_fraction_visible"] == pytest.approx(1.0)


def test_backing_the_ir_cameras_off_fixes_the_framing():
    """And the fix the report implies actually works -- otherwise the check is only
    half useful. Both IR cameras frame the whole plume at 4.5 m, with margin."""
    plan = Plan.load(CAMERA_ROW)
    for cid, y in (("cam-lwir-t650", -0.25), ("cam-mwir", -0.75)):
        cam = plan.cameras[cid]
        cam.position = [-4.5, y, 1.5]
        cam.aim_at([0.0, 0.0, 0.75])
        report = plan.framing(cam)
        assert report["flame_base_visible"] is True, cid
        assert report["flame_tip_visible"] is True, cid
        assert report["plume_fraction_visible"] == pytest.approx(1.0), cid


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
        # nerfstudio puts a pixel's centre at index + 0.5 (cameras.py,
        # get_image_coords(pixel_offset=0.5)); the plan's principal point is in the
        # OpenCV convention of centres at integers, so a centred camera is w/2 there.
        assert frame["cx"] == pytest.approx(cam.principal_point[0] + 0.5)
        assert frame["cy"] == pytest.approx(cam.principal_point[1] + 0.5)
        if cam.spec.get("principalPoint_px") is None:
            assert (frame["cx"], frame["cy"]) == pytest.approx((frame["w"] / 2, frame["h"] / 2))
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
    # Every object in the plan, of every type -- an object the table cannot
    # describe is one that quietly disappears from the sheet taken to site.
    assert {r["id"] for r in rows} == {o["id"] for o in plan.data["objects"]}
    assert {r["category"] for r in rows} == {
        "burner", "hood", "wall", "camera", "heat flux", "thermocouple",
    }
    gopro = next(r for r in rows if r["id"] == "cam-gopro")
    assert gopro["standoff_m"] == pytest.approx(2.755, abs=1e-3)
    assert gopro["hfov_deg"] == pytest.approx(122.0, abs=0.5)


def test_equipment_table_means_what_the_report_means():
    """Review 2026-09-22, EXP-5/EXP-10: obstructions and reconstructed flames were
    missing, and a burner's standoff and height disagreed with the editor's table
    (3D distance and origin here, plan distance and flame tip there). Both now read
    standoff as plan distance and height as the object's own extent above the floor.
    Mirror of 'prints heights as each object's own extent' in export.test.ts."""
    plan = Plan.load(os.path.join(FIXTURES, "flame", "flame-test.ftp.json"))
    plan.add({
        "id": "obst-1", "type": "obstruction", "name": "Box",
        "transform": {"position_m": [1.0, 1.0, 0.5]}, "size_m": [1.0, 0.5, 0.8],
    })
    plan.add({
        "id": "wall-up", "type": "wall", "name": "Upstand",
        "transform": {"position_m": [0.0, 0.0, 0.0]},
        "polyline_m": [[1.0, 0.0], [2.0, 0.0]], "height_m": 0.6, "baseHeight_m": 2.0,
    })
    rows = {r["id"]: r for r in plan.equipment_table()}
    assert set(rows) == {o["id"] for o in plan.data["objects"]}

    burner = rows["burner-main"]
    assert burner["height_m"] == pytest.approx(0.1)      # the fuel surface
    assert "80 kW" in burner["detail"] and "mean flame tip" in burner["detail"]
    assert rows["obst-1"]["category"] == "obstruction"
    assert rows["obst-1"]["height_m"] == pytest.approx(1.3)
    assert rows["wall-up"]["height_m"] == pytest.approx(2.6)

    flame = rows["flame-main"]
    assert flame["category"] == "reconstructed flame"
    assert flame["detail"] == "80 frames, 0-395 s, 15.7 mm voxels"
    assert flame["height_m"] == pytest.approx(1.534)
    assert flame["standoff_m"] is not None and flame["standoff_m"] < 0.05  # centred on its pan

    # A hood's standoff is its plan distance too, as the editor now prints it.
    hood = rows["hood-main"]
    assert hood["standoff_m"] == pytest.approx(0.0)


def test_modality_drives_the_default_colour():
    plan = Plan.load(CAMERA_ROW)
    assert plan.cameras["cam-lwir-t650"].color != plan.cameras["cam-gopro"].color
    assert plan.cameras["cam-mwir"].color != plan.cameras["cam-lwir-t650"].color


@pytest.mark.parametrize("stored", [
    '"><script>alert(1)</script>',
    "red; background: url(x)",
    "#abc",          # short form: allowed by CSS, not by this schema
    "#12345g",
    12,
    None,
])
def test_a_hostile_display_colour_never_leaves_this_property(stored):
    """A plan is someone else's file, and this value is what a report interpolates
    into markup. Mirror of the `cameraColor` tests on the TypeScript side."""
    plan = Plan.load(CAMERA_ROW)
    cam = plan.cameras["cam-gopro"]
    cam.raw.setdefault("display", {})["color"] = stored
    assert cam.color == MODALITY_COLORS["RGB"]


def test_a_valid_display_colour_is_used_as_given():
    plan = Plan.load(CAMERA_ROW)
    cam = plan.cameras["cam-gopro"]
    cam.raw.setdefault("display", {})["color"] = "#A1b2C3"
    assert cam.color == "#A1b2C3"


def test_cameras_can_be_selected_by_modality():
    plan = Plan.load(CAMERA_ROW)
    assert len(plan.cameras_by_modality("RGB")) == 2
    assert [c.id for c in plan.cameras_by_modality("LWIR")] == ["cam-lwir-t650"]
