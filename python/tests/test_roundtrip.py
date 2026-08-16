"""Round-trip and canonical-serialisation guarantees.

Plans are revised by editing into a new file and tracked in git, so 'a re-save
produces no diff' and 'nothing is silently dropped' are load-bearing properties,
not cosmetics.
"""

from __future__ import annotations

import json
import os

import pytest

from fireplan import Plan, PlanError
from fireplan.serialize import dumps as canonical_dumps

FIXTURES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fixtures"
)
CAMERA_ROW = os.path.join(FIXTURES, "pool-fire-camera-row.ftp.json")


@pytest.fixture
def plan():
    return Plan.load(CAMERA_ROW)


def test_fixture_on_disk_is_already_canonical(plan):
    """Guards the build script as much as the writer: if `build_fixtures.py` ever
    emits non-canonical output, the committed fixture would diff against itself."""
    with open(CAMERA_ROW, "r", encoding="utf-8") as fh:
        on_disk = fh.read()
    assert plan.dumps() == on_disk


def test_resave_is_byte_identical(plan):
    once = plan.dumps()
    twice = Plan.loads(once).dumps()
    assert once == twice


def test_semantic_content_survives_a_round_trip(plan):
    reloaded = Plan.loads(plan.dumps())
    assert reloaded.title == plan.title
    assert list(reloaded.cameras) == list(plan.cameras)
    for cid, cam in plan.cameras.items():
        other = reloaded.cameras[cid]
        assert cam.K.tolist() == other.K.tolist()
        assert cam.extrinsics().tolist() == other.extrinsics().tolist()


def test_unknown_object_types_are_preserved_verbatim():
    """A v1.1 plan opened in a v1.0 tool must not lose its new objects."""
    plan = Plan.new("forward compat")
    plan.add({
        "id": "tc-tree-1",
        "type": "thermocoupleTree",          # not in format 1.0
        "name": "TC tree A",
        "transform": {"position_m": [1.0, 0.0, 0.0]},
        "heights_m": [0.5, 1.0, 1.5, 2.0],   # unknown keys too
        "junctionType": "K",
    })
    reloaded = Plan.loads(plan.dumps())
    raw = reloaded.data["objects"][0]
    assert raw["type"] == "thermocoupleTree"
    assert raw["heights_m"] == [0.5, 1.0, 1.5, 2.0]
    assert raw["junctionType"] == "K"
    # And it is exposed rather than hidden, just untyped.
    assert type(reloaded.objects[0]).__name__ == "UnknownObject"


def test_unknown_keys_on_known_objects_survive():
    plan = Plan.new("forward compat")
    plan.add({
        "id": "burner-1",
        "type": "burner",
        "footprint": {"shape": "circle", "diameter_m": 0.3},
        "someFutureKey": {"nested": [1, 2, 3]},
    })
    reloaded = Plan.loads(plan.dumps())
    assert reloaded.data["objects"][0]["someFutureKey"] == {"nested": [1, 2, 3]}


def test_key_order_is_canonical_regardless_of_input_order():
    plan = Plan.new("ordering")
    plan.add({
        "notes": "written last, must serialise last",
        "type": "burner",
        "footprint": {"size_m": [0.3, 0.3], "shape": "square"},
        "id": "burner-1",
    })
    text = plan.dumps()
    obj = json.loads(text)["objects"][0]
    assert list(obj) == ["id", "type", "footprint", "notes"]
    assert list(obj["footprint"]) == ["shape", "size_m"]
    # Top level too.
    assert list(json.loads(text))[:2] == ["format", "version"]


def test_coordinate_arrays_stay_on_one_line(plan):
    text = plan.dumps()
    assert '"position_m": [-2.7432, -0.75, 1.5]' in text
    assert '"size_m": [0.3048, 0.3048]' in text


def test_floats_are_rounded_so_noise_never_diffs():
    plan = Plan.new("rounding")
    plan.add({
        "id": "b",
        "type": "burner",
        "transform": {"position_m": [2.74320000000001, 0.1234567891, -0.0]},
        "footprint": {"shape": "circle", "diameter_m": 0.3},
    })
    text = plan.dumps()
    # Integral floats are demoted to int: JSON has one number type, and the
    # TypeScript writer cannot emit a trailing ".0" at all.
    assert '"position_m": [2.7432, 0.123457, 0]' in text
    assert "-0.0" not in text  # negative zero collapsed


def test_booleans_are_not_mangled_into_numbers():
    """bool subclasses int in Python; the rounding pass has to test it first."""
    plan = Plan.new("bools")
    plan.add({
        "id": "b",
        "type": "burner",
        "footprint": {"shape": "circle", "diameter_m": 0.3},
        "display": {"visible": False, "locked": True},
    })
    text = plan.dumps()
    assert '"visible": false' in text
    assert '"locked": true' in text


def test_numeric_looking_text_in_notes_is_untouched():
    """The array-collapsing pass is a regex over serialised text, so a string that
    looks like an array must not be rewritten."""
    plan = Plan.new("regex safety")
    plan.meta["notes"] = "measured at [1,2] and [3, 4] on the grid"
    reloaded = Plan.loads(plan.dumps())
    assert reloaded.meta["notes"] == "measured at [1,2] and [3, 4] on the grid"


def test_save_updates_modified_timestamp(tmp_path, plan):
    out = tmp_path / "out.ftp.json"
    plan.save(out)
    assert Plan.load(out).meta["modified"] != "2026-08-15T00:00:00Z"


def test_save_can_leave_the_timestamp_alone(tmp_path, plan):
    out = tmp_path / "out.ftp.json"
    plan.save(out, update_modified=False)
    assert Plan.load(out).meta["modified"] == "2026-08-15T00:00:00Z"
    with open(out, "r", encoding="utf-8") as fh:
        assert fh.read() == plan.dumps()


def test_files_are_written_with_unix_newlines(tmp_path, plan):
    """Otherwise every plan saved on Windows diffs wholesale against one saved
    elsewhere."""
    out = tmp_path / "out.ftp.json"
    plan.save(out)
    with open(out, "rb") as fh:
        assert b"\r\n" not in fh.read()


def test_canonical_dumps_is_reachable_without_a_plan_object(plan):
    assert canonical_dumps(plan.data) == plan.dumps()


# -- rejection -----------------------------------------------------------

def test_a_non_plan_json_file_is_rejected_clearly():
    with pytest.raises(PlanError, match="not a fire test plan"):
        Plan.loads('{"format": "something-else"}')


def test_malformed_json_is_rejected_clearly():
    with pytest.raises(PlanError, match="invalid JSON"):
        Plan.loads("{not json")


def test_fixture_passes_schema_validation(plan):
    plan.validate_schema()


def test_schema_rejects_a_camera_missing_intrinsics():
    plan = Plan.new("bad")
    plan.add({
        "id": "cam",
        "type": "camera",
        "camera": {"modality": "RGB", "resolution_px": [640, 480]},  # no sensor/focal
    })
    with pytest.raises(PlanError, match="schema validation"):
        plan.validate_schema()


def test_schema_rejects_a_populated_recording_block_in_v1():
    """Reserved means reserved: writing to it must fail until the design lands."""
    plan = Plan.new("bad")
    plan.add({
        "id": "cam",
        "type": "camera",
        "camera": {
            "modality": "RGB", "resolution_px": [640, 480],
            "sensor_mm": [6.0, 4.5], "focalLength_mm": 4.0,
        },
        "recording": {"path": "video.mp4"},
    })
    with pytest.raises(PlanError, match="schema validation"):
        plan.validate_schema()


def test_schema_rejects_a_circle_without_a_diameter():
    plan = Plan.new("bad")
    plan.add({"id": "b", "type": "burner", "footprint": {"shape": "circle", "size_m": [1, 1]}})
    with pytest.raises(PlanError, match="schema validation"):
        plan.validate_schema()
