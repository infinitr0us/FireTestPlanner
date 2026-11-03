"""Shared synthetic pinhole fixture, with the same hand-derived values as TypeScript."""

import math
from pathlib import Path

import pytest

from fireplan import IR_SPOT_PX, Plan

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "thermocouple-view.ftp.json"


def test_canonical_fixture_counts_occlusion_and_closest_pair():
    plan = Plan.load(FIXTURE)
    plan.validate_schema()
    assert plan.dumps() == FIXTURE.read_text(encoding="utf-8")
    view = plan.thermocouple_view(plan.cameras["camera"])
    assert IR_SPOT_PX == 3
    assert [view[k] for k in ("seen", "outside", "hidden", "total")] == [3, 1, 1, 5]
    beads = view["beads"]
    assert [(b["thermocouple_id"], b["index"]) for b in beads] == [(f"tc-{i:02d}", 0) for i in range(1, 6)]
    assert [b["in_frame"] for b in beads] == [True, True, True, True, False]
    assert [b["blocked_by"] for b in beads] == [None, None, None, "pack", None]
    assert view["closest"]["a"] == ("tc-01", 0)
    assert view["closest"]["b"] == ("tc-02", 0)
    assert view["closest"]["px"] == pytest.approx(5, abs=1e-8)
    assert [b["nearest_px"] for b in beads[:3]] == pytest.approx([5, 5, math.hypot(70, 50)], abs=1e-8)
    assert [b["nearest_px"] for b in beads[3:]] == [None, None]


def test_pixels_and_detail_are_hand_derived_at_the_slant_distance():
    plan = Plan.load(FIXTURE)
    beads = plan.thermocouple_view(plan.cameras["camera"])["beads"]
    # fx=fy=2500, centre=(499.5,374.5); near face is 10 m down the axis.
    pixels = [(499.5, 374.5), (504.5, 374.5), (574.5, 324.5), (499.5, 374.5), (2499.5, 374.5)]
    distances = [10, math.hypot(10, .02), math.sqrt(100 + .3**2 + .2**2), 11, math.hypot(10, 8)]
    for bead, uv, distance in zip(beads, pixels, distances):
        assert [bead["u"], bead["v"]] == pytest.approx(uv, abs=1e-6, rel=0)
        assert bead["distance_m"] == pytest.approx(distance, abs=1e-10)
        assert bead["mm_per_px"] == pytest.approx(distance / 2.5, abs=1e-10)
        assert isinstance(bead["world"], list)


def test_planned_poses_rotated_rake_offsets_and_behind_camera():
    plan = Plan.load(FIXTURE)
    camera, tc = plan.cameras["camera"], plan.thermocouples[0]
    plan.data["objects"] = [camera.raw, tc.raw]
    camera.raw["asBuilt"] = {"transform": {"position_m": [100, 0, 0], "rotation_quat": [0, 0, 0, 1]}}
    tc.raw["asBuilt"] = {"transform": {"position_m": [100, 0, 0]}}
    tc.raw["transform"]["rotation_quat"] = [0, math.sqrt(.5), 0, math.sqrt(.5)]
    tc.raw["beadOffsets_m"] = [0, .02]
    view = plan.thermocouple_view(camera)
    assert [b["index"] for b in view["beads"]] == [0, 1]
    assert view["beads"][1]["world"] == pytest.approx([.02, -.5, 1], abs=1e-10)
    assert view["closest"]["a"] == ("tc-01", 0)
    assert view["closest"]["b"] == ("tc-01", 1)
    assert view["closest"]["px"] == pytest.approx(5, abs=1e-8)
    tc.raw["transform"]["position_m"] = [0, -11, 1]
    behind = plan.thermocouple_view(camera)
    assert [behind[k] for k in ("seen", "outside", "hidden")] == [0, 2, 0]
    assert behind["closest"] is None
    for bead in behind["beads"]:
        assert math.isnan(bead["u"]) and math.isnan(bead["v"])
        assert bead["blocked_by"] is None
        assert bead["nearest_px"] is None


def test_no_thermocouples_one_seen_no_fire_and_coincident_beads():
    plan = Plan.load(FIXTURE)
    camera, tc = plan.cameras["camera"], plan.thermocouples[0]
    plan.data["objects"] = [camera.raw]
    assert plan.thermocouple_view(camera) is None
    plan.add(tc.raw)
    single = plan.thermocouple_view(camera)
    assert single["seen"] == 1
    assert single["closest"] is None
    assert single["beads"][0]["nearest_px"] is None
    plan.add({**tc.raw, "id": "duplicate"})
    coincident = plan.thermocouple_view(camera)
    assert coincident["closest"]["px"] == 0
    assert [b["nearest_px"] for b in coincident["beads"]] == [0, 0]
