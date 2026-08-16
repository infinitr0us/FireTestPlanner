"""Round-trip and canonical-serialisation guarantees.

Plans are revised by editing into a new file and tracked in git, so 'a re-save
produces no diff' and 'nothing is silently dropped' are load-bearing properties,
not cosmetics.
"""

from __future__ import annotations

import io
import json
import os

import pytest

from fireplan import Plan, PlanError
from fireplan.serialize import dumps as canonical_dumps

FIXTURES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fixtures"
)
CAMERA_ROW = os.path.join(FIXTURES, "pool-fire-camera-row.ftp.json")
FORWARD_COMPAT = os.path.join(FIXTURES, "forward-compat.ftp.json")


@pytest.fixture
def plan():
    return Plan.load(CAMERA_ROW)


def test_fixture_on_disk_is_already_canonical(plan):
    """Guards the build script as much as the writer: if `build_fixtures.py` ever
    emits non-canonical output, the committed fixture would diff against itself."""
    with open(CAMERA_ROW, "r", encoding="utf-8") as fh:
        on_disk = fh.read()
    assert plan.dumps() == on_disk


def test_source_path_is_answerable_even_for_a_plan_that_came_from_text(plan):
    """`Plan.loads` has no file behind it; asking where it came from should say so
    rather than raising AttributeError."""
    assert plan.source_path == CAMERA_ROW
    assert Plan.loads(plan.dumps()).source_path is None
    assert Plan.new("in memory").source_path is None


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


def test_unknown_objects_keep_their_precision_and_key_order():
    """CONVENTIONS.md section 6 says byte-identical, and means it.

    Rounding a coefficient whose units this version does not know, or sorting a
    newer schema's fields into an order chosen for 1.0, is data loss dressed up as
    tidiness -- and it is silent, which is worse.
    """
    plan = Plan.new("forward compat")
    plan.add({
        "zzz_trailingKey": "must stay last",
        "id": "spec-1",
        "type": "spectrometer",
        "calibration": {"coefficient": 1.23456789, "gain": 12.0},
    })
    raw = Plan.loads(plan.dumps()).data["objects"][0]

    assert raw["calibration"]["coefficient"] == 1.23456789
    assert list(raw.keys()) == ["zzz_trailingKey", "id", "type", "calibration"]
    # Integral floats still normalise: JavaScript cannot write 12.0, and byte
    # parity between the two writers is a hard requirement.
    assert isinstance(raw["calibration"]["gain"], int)


def test_unknown_objects_still_get_their_transform_rounded():
    """The editor can drag an unrecognised object, and gizmo output is float noise.

    `transform` is a format 1.0 block this version genuinely owns, so it is the one
    part of an unknown object that is canonicalised.
    """
    plan = Plan.new("forward compat")
    plan.add({
        "id": "spec-1",
        "type": "spectrometer",
        "transform": {"position_m": [0.123456789, 0.0, 0.0]},
    })
    raw = Plan.loads(plan.dumps()).data["objects"][0]
    assert raw["transform"]["position_m"][0] == 0.123457


def test_the_forward_compat_fixture_round_trips_unchanged():
    """The fixture the TypeScript writer is checked against, checked from this side."""
    with io.open(FORWARD_COMPAT, encoding="utf-8") as fh:
        text = fh.read()
    assert Plan.loads(text).dumps() == text


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


# -- number spelling -----------------------------------------------------

@pytest.mark.parametrize("value, expected", [
    (12.0, "12"),                        # repr: 12.0
    (-0.0, "0"),                         # repr: -0.0
    (0.0, "0"),
    (1.23e-8, "1.23e-8"),                # repr: 1.23e-08 -- zero-padded exponent
    (1e-7, "1e-7"),                      # repr: 1e-07
    (1e-6, "0.000001"),                  # repr: 1e-06 -- and a different notation
    (1e-5, "0.00001"),                   # repr: 1e-05
    (0.0001, "0.0001"),
    (1e15, "1000000000000000"),          # repr: 1000000000000000.0
    (1e16, "10000000000000000"),         # repr: 1e+16
    (2.0 ** 60, "1152921504606847000"),  # repr: 1.152921504606847e+18
    (1e21, "1e+21"),                     # the point where JavaScript gives up on
    (1e22, "1e+22"),                     # fixed notation, and so must this writer
    (5e-324, "5e-324"),
    (0.1 + 0.2, "0.30000000000000004"),
    (-2.7432, "-2.7432"),
])
def test_floats_are_spelled_the_way_javascript_spells_them(value, expected):
    """`repr` is not JSON.stringify, and CONVENTIONS section 6 promises byte parity.

    Every case here is one where the two disagree -- the digits always match, because
    both languages emit the shortest decimal that round-trips, but Python pads
    exponents, switches to exponential notation a million times earlier, and writes a
    trailing `.0` that JavaScript cannot produce at all.
    """
    from fireplan.serialize import _js_number
    assert _js_number(value) == expected
    # And the value survives: this is a spelling change, never a precision one. Read
    # back as a number rather than compared directly, because JSON has one number type
    # and Python does not -- `10000000000000000` comes back from json as an int.
    assert float(json.loads(_js_number(value))) == value


def test_an_unknown_object_keeps_exotic_numbers_through_a_round_trip():
    """The end-to-end version: these reach the file inside a type we do not define,
    so nothing rounds them, and the spelling is all that stands between the two
    writers and a spurious diff."""
    plan = Plan.new("exotic numbers")
    plan.add({
        "id": "spec-1",
        "type": "spectrometer",
        "calibration": {"dark": 1.23e-8, "floor": 1e-6, "scale": 1e16, "big": 2.0 ** 60},
    })
    text = plan.dumps()
    assert '"dark": 1.23e-8' in text
    assert '"floor": 0.000001' in text
    assert '"scale": 10000000000000000' in text
    assert '"big": 1152921504606847000' in text
    assert Plan.loads(text).data["objects"][0]["calibration"]["dark"] == 1.23e-8


def test_the_writer_agrees_with_json_dumps_on_everything_but_floats():
    """The writer is hand-rolled so it can spell floats JavaScript's way. Indentation,
    separators and string escaping must still be exactly what json.dumps produces --
    a plan is ordinary JSON, and only the numbers needed reconciling."""
    from fireplan.serialize import _encode

    data = {
        "empty_obj": {},
        "empty_list": [],
        "unicode": 'café — 火 "quoted" back\\slash\ttab\nnewline',
        "control": "",
        "ints": [0, -1, 10 ** 25],
        "scalars": [True, False, None],
        "nested": {"a": [{"b": [1, 2]}, []]},
        "floats": [0.5, -2.7432, 1.25],  # spelled the same by both writers
    }
    assert _encode(data, 0) == json.dumps(data, indent=2, ensure_ascii=False)


def test_numbers_that_arrived_from_numpy_serialise_as_numbers():
    """`fireplan` hands out numpy arrays (`look_at_quat`, `extrinsics`), so a plan
    assembled from them can hold numpy scalars. numpy 2 gives them a repr of
    `np.float64(1.5)`, which is not a JSON number -- the writer must not use it."""
    import numpy as np

    plan = Plan.new("numpy")
    quat = np.array([0.0, 0.0, 0.3826834, 0.9238795])
    plan.add({
        "id": "b",
        "type": "burner",
        "transform": {"position_m": [np.float64(1.5), np.float64(-0.25), np.float64(0.0)],
                      "rotation_quat": [q for q in quat]},
        "footprint": {"shape": "circle", "diameter_m": np.float64(0.3)},
    })
    text = plan.dumps()
    assert "np.float64" not in text
    assert '"position_m": [1.5, -0.25, 0]' in text
    assert json.loads(text)["objects"][0]["footprint"]["diameter_m"] == 0.3


def test_non_finite_numbers_are_refused_rather_than_written():
    """`NaN` and `Infinity` are not JSON. Python would happily write them; the
    TypeScript writer turns them into `null`, which silently corrupts the plan."""
    plan = Plan.new("not a number")
    plan.add({
        "id": "b", "type": "burner",
        "footprint": {"shape": "circle", "diameter_m": float("inf")},
    })
    with pytest.raises(ValueError, match="not JSON compliant"):
        plan.dumps()


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
