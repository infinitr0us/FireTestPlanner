"""Flame analysis folders (format 1.0): the reader, its checks and the synthetic test."""
import importlib.util
import json
import shutil
import zipfile
from pathlib import Path

import numpy as np
import pytest

from fireplan.flame_analysis import (
    FlameAnalysis, FlameAnalysisError, fill_template, read_series_csv, trace_outlines)

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "fixtures" / "flame-analysis"

spec = importlib.util.spec_from_file_location(
    "synthetic_flame_event", ROOT / "tools/build_synthetic_flame_event.py")
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


@pytest.fixture
def copy(tmp_path):
    """A writable copy of the synthetic test."""
    target = tmp_path / "analysis"
    shutil.copytree(FIXTURE, target)
    return target


def edit_json(path, change):
    data = json.loads(path.read_text(encoding="utf-8"))
    change(data)
    path.write_text(json.dumps(data), encoding="utf-8")


# -- the synthetic test ------------------------------------------------------

def test_the_synthetic_test_passes_every_check():
    analysis = FlameAnalysis.load(str(FIXTURE))
    assert analysis.event_ids == ["E1", "E2"]
    assert analysis.check(deep=True) == []
    e1, e2 = analysis.event("E1"), analysis.event("E2")
    assert e1.cameras == ["camA", "camB", "camC"] and e2.cameras == ["camA", "camB"]
    assert len(e1.times) == len(e1.stems) == 36
    # One portrait camera, so the board meets mixed orientations.
    sizes = {c: tuple(e1.data["images"][c]["size_px"]) for c in e1.cameras}
    assert sizes["camC"][0] < sizes["camC"][1] and sizes["camA"][0] > sizes["camA"][1]


def test_one_event_regenerates_byte_for_byte(tmp_path):
    generator.build(tmp_path, events=["E2"])
    fresh = sorted(p for p in (tmp_path / "E2").rglob("*") if p.is_file())
    kept = sorted(p for p in (FIXTURE / "E2").rglob("*") if p.is_file())
    assert [p.relative_to(tmp_path) for p in fresh] == [p.relative_to(FIXTURE) for p in kept]
    for path in fresh + [tmp_path / "site.ftp.json", tmp_path / "analysis.json"]:
        committed = FIXTURE / path.relative_to(tmp_path)
        if path.suffix != ".npz":
            assert path.read_bytes() == committed.read_bytes(), path.name
            continue
        # As in test_synthetic_flame: compare the decoded .npy members, not the ZIP.
        with zipfile.ZipFile(path) as a, zipfile.ZipFile(committed) as b:
            assert a.namelist() == b.namelist()
            for member in b.namelist():
                assert a.read(member) == b.read(member), (path.name, member)


def _inside_or_near(points, rings, tolerance):
    """Even-odd inside any ring set, or within `tolerance` px of a ring edge."""
    inside = np.zeros(len(points), dtype=bool)
    near = np.zeros(len(points), dtype=bool)
    x, y = points[:, 0], points[:, 1]
    for ring in rings:
        a, b = ring, np.roll(ring, -1, axis=0)
        for (x0, y0), (x1, y1) in zip(a, b):
            crosses = ((y0 > y) != (y1 > y)) & (x < x0 + (y - y0) * (x1 - x0) / ((y1 - y0) or 1e-12))
            inside ^= crosses
            dx, dy = x1 - x0, y1 - y0
            length2 = dx * dx + dy * dy or 1e-12
            s = np.clip(((x - x0) * dx + (y - y0) * dy) / length2, 0, 1)
            near |= np.hypot(x - (x0 + s * dx), y - (y0 + s * dy)) <= tolerance
    return inside | near


@pytest.mark.parametrize("event_id", ["E1", "E2"])
def test_the_hull_projects_inside_every_cameras_outline(event_id):
    """What the board's hull check draws: the 3-D flame through each site-plan
    camera lands on that camera's outline (to the pixel rounding of the carving)."""
    analysis = FlameAnalysis.load(str(FIXTURE))
    event = analysis.event(event_id)
    plan = analysis.site_plan()
    plan_id = {c["id"]: c["planCameraId"] for c in analysis.data["cameras"]}
    outlines = {cam: event.outlines(cam) for cam in event.cameras}
    checked = 0
    for i in range(0, len(event.stems), 2):
        voxels = event.hull(i)
        if not len(voxels):
            continue
        for cam in event.cameras:
            uv, visible = plan.cameras[plan_id[cam]].project(voxels)
            assert visible.all()
            assert _inside_or_near(uv, outlines[cam][i], tolerance=1.0).all(), (cam, i)
            checked += 1
    assert checked >= 10


def test_fewer_cameras_give_a_larger_hull_for_a_similar_flame():
    analysis = FlameAnalysis.load(str(FIXTURE))
    _, v1 = analysis.event("E1").read_series("volume")
    _, v2 = analysis.event("E2").read_series("volume")
    assert v1.max() > 0 and v2.max() > 0
    # E2's flame is 0.7 times E1's in every dimension, yet only two cameras carve it.
    assert v2.max() / v1.max() > 0.7 ** 3


# -- reader details ------------------------------------------------------------

def test_a_frame_holds_until_the_next_instant():
    event = FlameAnalysis.load(str(FIXTURE)).event("E1")
    first = event.times[0]
    assert event.index_at(first - 0.01) is None
    assert event.index_at(first) == 0
    assert event.index_at(first + 0.05) == 0
    assert event.index_at(event.times[-1] + 100) == len(event.times) - 1


def test_series_csv_rules(tmp_path):
    path = tmp_path / "s.csv"
    path.write_text("\ufefft,v\n0,1\n1,\n2,3.5\n", encoding="utf-8")
    t, v = read_series_csv(str(path), "t", "v")
    assert t.tolist() == [0, 1, 2] and v[0] == 1 and np.isnan(v[1]) and v[2] == 3.5
    path.write_text("t,v\ns,kW\n0,1\n", encoding="utf-8")
    with pytest.raises(FlameAnalysisError, match="row 2"):
        read_series_csv(str(path), "t", "v")
    path.write_text("t,v\n0,inf\n", encoding="utf-8")
    with pytest.raises(FlameAnalysisError, match="not finite"):
        read_series_csv(str(path), "t", "v")
    with pytest.raises(FlameAnalysisError, match="no column"):
        read_series_csv(str(path), "t", "w")


def test_templates_take_cam_and_stem_only():
    assert fill_template("frames/{cam}/{stem}.png", "a", "t_1") == "frames/a/t_1.png"
    with pytest.raises(FlameAnalysisError):
        fill_template("frames/{camera}/{stem}.png", "a", "t_1")
    with pytest.raises(FlameAnalysisError):
        fill_template("frames/{cam}/{stem}.png", "a", None)


# -- the schemas ---------------------------------------------------------------

@pytest.mark.parametrize("change, message", [
    (lambda d: d["files"].update(display="frames/{stem}.png"), "display"),
    (lambda d: d["series"][3].update(unit="kW"), "series/3"),
    (lambda d: d["series"][3].update(basis="convective"), "series/3"),
    (lambda d: d["series"][0].update(file="../outside.csv"), "series/0/file"),
    (lambda d: d["files"].update(hull="C:/hull/{stem}.npz"), "hull"),
    (lambda d: d.update(surprise=1), "surprise"),
    (lambda d: d.update(version="1.1.0"), "version"),
])
def test_the_event_schema_refuses(copy, change, message):
    edit_json(copy / "E1" / "event.json", change)
    with pytest.raises(FlameAnalysisError, match="schema validation") as caught:
        FlameAnalysis.load(str(copy)).event("E1")
    assert message in str(caught.value)


def test_the_analysis_schema_refuses_an_unknown_step(copy):
    edit_json(copy / "analysis.json", lambda d: d["steps"].update(tuning={"text": "x"}))
    with pytest.raises(FlameAnalysisError, match="schema validation"):
        FlameAnalysis.load(str(copy))


def test_the_schemas_are_mirrored_in_the_package_byte_for_byte():
    for name in ("flame-analysis-1.0.0", "flame-event-1.0.0", "flame-outlines-1.0.0"):
        normative = (ROOT / "schema" / (name + ".schema.json")).read_bytes()
        shipped = (ROOT / "python/fireplan/schemas" / (name + ".schema.json")).read_bytes()
        assert normative == shipped, name


# -- the checks ----------------------------------------------------------------

def codes(analysis, **kwargs):
    return sorted({i.code for i in analysis.check(**kwargs)})


def test_check_names_an_event_camera_missing_from_analysis(copy):
    edit_json(copy / "analysis.json", lambda d: d.update(cameras=d["cameras"][:2]))
    assert "camera-unknown" in codes(FlameAnalysis.load(str(copy)))


def test_check_names_a_site_plan_camera_that_does_not_exist(copy):
    edit_json(copy / "analysis.json", lambda d: d["cameras"][0].update(planCameraId="nope"))
    assert "plan-camera" in codes(FlameAnalysis.load(str(copy)))


def test_check_counts_missing_pictures_and_hulls(copy):
    (copy / "E2" / "frames" / "camB" / "t_0161.00.png").unlink()
    (copy / "E2" / "hull" / "t_0161.00.npz").unlink()
    issues = [i for i in FlameAnalysis.load(str(copy)).check(deep=False) if i.code == "file"]
    text = " ".join(i.message for i in issues)
    assert "camB display: 1 of 36 files missing" in text and "hull t_0161.00: missing" in text


def test_check_refuses_outlines_of_the_wrong_length(copy):
    edit_json(copy / "E2" / "outlines" / "camA.json", lambda d: d["outlines"].pop())
    issues = FlameAnalysis.load(str(copy)).check(deep=True)
    assert any("35 instants, the event has 36" in i.message for i in issues)


def test_check_warns_when_pictures_do_not_match_the_plan_camera(copy):
    edit_json(copy / "E2" / "event.json", lambda d: d["images"]["camA"].update(size_px=[480, 360]))
    issues = FlameAnalysis.load(str(copy)).check(deep=False)
    assert [i.severity for i in issues if i.code == "image-size"] == ["warning"]


def test_check_refuses_series_times_out_of_order(copy):
    path = copy / "E1" / "series" / "hood.csv"
    lines = path.read_text(encoding="utf-8").splitlines()
    lines[2], lines[3] = lines[3], lines[2]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert "series-time" in codes(FlameAnalysis.load(str(copy)), deep=False)


def test_check_refuses_a_closeup_that_leaves_the_picture(copy):
    def add(d):
        d["files"]["closeup"] = "frames/{cam}/{stem}.png"
        for cam, image in d["images"].items():
            image["closeup"] = {"rect_px": [0, 0, 10, 10], "display_px": [10, 10]}
        d["images"]["camA"]["closeup"]["rect_px"] = [200, 0, 100, 10]
    edit_json(copy / "E1" / "event.json", add)
    issues = [i for i in FlameAnalysis.load(str(copy)).check(deep=False) if i.code == "closeup"]
    assert len(issues) == 1 and "leaves the 240 x 180 picture" in issues[0].message


def test_paths_may_not_leave_the_analysis_folder(copy):
    edit_json(copy / "analysis.json", lambda d: d["events"][0].update(path="E1/../../E1/event.json"))
    with pytest.raises(FlameAnalysisError):
        FlameAnalysis.load(str(copy))


# -- outlines --------------------------------------------------------------------

def test_outlines_of_a_rectangle_a_hole_and_specks():
    m = np.zeros((12, 12), dtype=bool)
    m[2:10, 2:10] = True
    m[4:7, 5:8] = False          # a 3 x 3 hole
    m[0, 11] = True              # a speck: no area, left out
    m[0:12, 0] = True            # a one-pixel line: no area, left out
    assert trace_outlines(m) == [[2, 2, 9, 2, 9, 9, 2, 9], [5, 4, 7, 4, 7, 6, 5, 6]]


def test_outlines_follow_8_connected_regions():
    m = np.zeros((8, 8), dtype=bool)
    m[1:3, 1:3] = True
    m[3:5, 3:5] = True           # touches the first square at a corner only
    rings = trace_outlines(m)
    assert len(rings) == 1
    xs, ys = rings[0][0::2], rings[0][1::2]
    assert (min(xs), max(xs), min(ys), max(ys)) == (1, 4, 1, 4)


def test_outlines_of_two_regions_come_in_raster_order():
    m = np.zeros((10, 10), dtype=bool)
    m[6:9, 1:4] = True
    m[1:4, 6:9] = True
    rings = trace_outlines(m)
    assert [r[:2] for r in rings] == [[6, 1], [1, 6]]
