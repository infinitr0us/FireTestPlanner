"""Shared reviewer corpus and format-boundary regressions, independent of review/."""
import builtins
import copy
import json
from pathlib import Path
import shutil

import numpy as np
import pytest

from fireplan.flame import read_frame
from fireplan.flame_analysis import (
    FlameAnalysis, FlameAnalysisError, _inside, _validate, ANALYSIS_FORMAT, EVENT_FORMAT,
    fill_template, read_mesh, read_series_csv, write_mesh,
)

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "fixtures/flame-analysis-validation"
CASES = json.loads((CORPUS / "cases.json").read_text(encoding="utf-8"))
MESHES = json.loads((CORPUS / "meshes.json").read_text(encoding="utf-8"))
PATHS = json.loads((CORPUS / "paths.json").read_text(encoding="utf-8"))


@pytest.fixture
def folder(tmp_path):
    target = tmp_path / "analysis"
    shutil.copytree(CORPUS / "baseline", target)
    return target


def edit(path, mutate):
    data = json.loads(path.read_text(encoding="utf-8"))
    mutate(data)
    path.write_bytes((json.dumps(data) + "\n").encode("utf-8"))


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_shared_folder_verdicts(folder, case):
    for name in case["files"]:
        target = folder / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(CORPUS / "cases" / case["name"] / name, target)
    try:
        issues = FlameAnalysis.load(str(folder)).check(deep=True)
        accepted = not any(i.severity == "error" for i in issues)
    except FlameAnalysisError as exc:
        accepted, issues = False, str(exc)
    assert accepted == case["accept"], issues


@pytest.mark.parametrize("case", MESHES, ids=lambda c: c["name"])
def test_shared_ply_verdicts(case):
    path = CORPUS / "meshes" / (case["name"] + ".ply")
    if case["accept"]:
        vertices, faces = read_mesh(str(path))
        assert vertices.tolist()[0] == ([0, 0, 0] if case["name"] == "writer_fractional_faces" else [1, 2, 3])
        assert faces.tolist() == [[0, 1, 2]]
    else:
        with pytest.raises(FlameAnalysisError):
            read_mesh(str(path))


@pytest.mark.parametrize("case", PATHS, ids=lambda c: repr(c["path"]))
def test_shared_paths_in_schemas_and_runtime(folder, case):
    a = json.loads((folder / "analysis.json").read_text(encoding="utf-8"))
    e = json.loads((folder / "event.json").read_text(encoding="utf-8"))
    a["sitePlan"] = e["series"][0]["file"] = case["path"]
    operations = [lambda: _inside(str(folder), str(folder), case["path"]),
                  lambda: _validate(ANALYSIS_FORMAT, a, "analysis.json")]
    for version in ("1.0.0", "1.1.0"):
        data = copy.deepcopy(e)
        data["version"] = version
        operations.append(lambda data=data: _validate(EVENT_FORMAT, data, "event.json"))
    for operation in operations:
        if case["accept"]:
            operation()
        else:
            with pytest.raises(FlameAnalysisError):
                operation()


@pytest.mark.parametrize("template", ["a//{cam}/{stem}", "{cam}/../{stem}", "a\n/{cam}/{stem}",
                                     "a/{unknown}/{stem}", "a/{cam}/{stem}}", "/{cam}/{stem}"])
def test_templates_validate_before_substitution(template):
    with pytest.raises(FlameAnalysisError):
        fill_template(template, "camA", "0")


def test_duplicate_series_checks_each_descriptor(folder):
    edit(folder / "event.json", lambda d: d["series"][1].update(id="hood"))
    (folder / "volume.csv").write_bytes(b"t,v\n0,-1\n1,-2\n")
    issues = FlameAnalysis.load(str(folder)).check(deep=False)
    duplicate = next(i for i in issues if i.code == "series-duplicate")
    assert "E" in duplicate.message and "hood" in duplicate.message
    assert any(i.code == "series-negative" for i in issues)


@pytest.mark.parametrize("mutate, codes", [
    (lambda e: e.update(id="different"), {"event-id"}),
    (lambda e: e["images"].update(extra=e["images"]["camA"]), {"images-cameras"}),
    (lambda e: e["files"].update(closeup="frames/{cam}/{stem}.png"), {"closeup"}),
    (lambda e: e["images"]["camA"].update(closeup={"rect_px": [240, 180, 10, 10], "display_px": [10, 10]}), {"closeup"}),
    (lambda e: e.update(quality={"noHull": [3], "outsideFrame": {"camZ": [999]}}), {"quality-camera", "quality-index"}),
    (lambda e: e.update(quality={"noHull": [0, 2], "outsideFrame": {"camA": [0, 2]}}), set()),
])
def test_file_independent_semantics_match_the_board(folder, mutate, codes):
    edit(folder / "event.json", mutate)
    issues = FlameAnalysis.load(str(folder)).event("E").check(deep=False)
    assert {i.code for i in issues if i.severity == "error"} == codes


def test_closeup_touching_the_picture_boundary_is_valid(folder):
    def mutate(e):
        e["files"]["closeup"] = "frames/{cam}/{stem}.png"
        e["images"]["camA"]["closeup"] = {"rect_px": [0, 0, 240, 180], "display_px": [240, 180]}
    edit(folder / "event.json", mutate)
    assert FlameAnalysis.load(str(folder)).check() == []


@pytest.mark.parametrize("quantity, unit", [("volume", "m3"), ("area", "m2")])
def test_negative_volume_and_area_but_signed_hrr_and_missing_values(folder, quantity, unit):
    edit(folder / "event.json", lambda e: e["series"][1].update(quantity=quantity, unit=unit))
    (folder / "series.csv").write_bytes(b"t,v\n0,-1\n1,\n")
    (folder / "volume.csv").write_bytes(b"t,v\n0,\n1,-1\n")
    assert [i.code for i in FlameAnalysis.load(str(folder)).check() if i.severity == "error"] == ["series-negative"]
    (folder / "volume.csv").write_bytes(b"t,v\n0,\n1,-0\n")
    assert FlameAnalysis.load(str(folder)).check() == []


@pytest.mark.parametrize("version", [[], {}, 1, None])
def test_wrong_version_type_is_an_issue(folder, version):
    edit(folder / "event.json", lambda d: d.update(version=version))
    issues = FlameAnalysis.load(str(folder)).check()
    assert any(i.code == "event" and "event.json" in i.message and "version" in i.message for i in issues)


@pytest.mark.parametrize("file", ["event.json", "series.csv", "outlines/camA.json"])
def test_undecodable_utf8_is_an_issue(folder, file):
    (folder / file).write_bytes(b"\xff")
    issues = FlameAnalysis.load(str(folder)).check()
    assert any(file.replace("/", "\\") in i.message.replace("/", "\\") for i in issues)


@pytest.mark.parametrize("file", ["event.json", "series.csv", "outlines/camA.json", "hull/0.npz"])
def test_unreadable_file_is_an_issue(folder, file, monkeypatch):
    original = builtins.open
    target = folder / file
    def denied(path, *args, **kwargs):
        if Path(path) == target:
            raise PermissionError("injected unreadable file")
        return original(path, *args, **kwargs)
    monkeypatch.setattr(builtins, "open", denied)
    issues = FlameAnalysis.load(str(folder)).check()
    assert any(target.name in i.message for i in issues)


@pytest.mark.parametrize("file", ["analysis.json", "event.json", "outlines/camA.json"])
def test_json_bom_is_accepted(folder, file):
    path = folder / file
    path.write_bytes(b"\xef\xbb\xbf" + path.read_bytes())
    assert FlameAnalysis.load(str(folder)).check() == []
    path.write_bytes(b"\xef\xbb\xbf" + path.read_bytes())
    if file == "analysis.json":
        with pytest.raises(FlameAnalysisError):
            FlameAnalysis.load(str(folder))
    else:
        assert any(i.severity == "error" for i in FlameAnalysis.load(str(folder)).check())


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity", "1e999"])
def test_nonfinite_json_is_an_issue(folder, constant):
    path = folder / "event.json"
    path.write_bytes(path.read_bytes().replace(b'"onset_s": 0', ('"onset_s": ' + constant).encode()))
    issues = FlameAnalysis.load(str(folder)).check()
    assert any("event.json" in i.message for i in issues)


@pytest.mark.parametrize("text, row", [('t,v\n\n0,1\n\n1,bad\n', 5), ('t,v\r\n\r\n0,1\r\n,\r\n', 4),
                                     ('t,v\r0,1\r\r0,2', 4), ('t,v\n\n0,"12', 3),
                                     ('t,v\n0,"1"x', 2)])
def test_csv_errors_name_physical_lines(folder, text, row):
    path = folder / "series.csv"
    path.write_bytes(text.encode())
    with pytest.raises(FlameAnalysisError, match="row {}".format(row)) as caught:
        read_series_csv(str(path), "t", "v")
    assert "series.csv" in str(caught.value)


@pytest.mark.parametrize("text", ["", "\n\r\n", "t,v\n\n"])
def test_csv_without_samples_is_refused(folder, text):
    path = folder / "series.csv"
    path.write_bytes(text.encode())
    with pytest.raises(FlameAnalysisError, match="no samples"):
        read_series_csv(str(path), "t", "v")


@pytest.mark.parametrize("record", [" ", ",", '\"\",\"\"'])
def test_csv_only_completely_empty_lines_are_skipped(folder, record):
    path = folder / "series.csv"
    path.write_bytes(('t,v\n0,1\n' + record + '\n1,2').encode())
    with pytest.raises(FlameAnalysisError, match="row 3"):
        read_series_csv(str(path), "t", "v")


def test_csv_decimal_quoting_and_multiline_physical_lines(folder):
    path = folder / "series.csv"
    path.write_bytes(b't,v\r0, " +1.2e2 " \r1,.5\r2,1.\r3,-0\r')
    assert read_series_csv(str(path), "t", "v")[1].tolist() == [120, 0.5, 1, -0.0]
    path.write_bytes(b'"t\ntime",v\n0,1\n\n1,bad')
    with pytest.raises(FlameAnalysisError, match="row 5"):
        read_series_csv(str(path), "t\ntime", "v")


@pytest.mark.parametrize("size, accepted", [(0.03, True), (0.03 * (1 + 0.5e-9), True),
                                         (0.03 * (1 - 0.5e-9), True), (0.03 * (1 + 2e-9), False), (0.015625, False)])
@pytest.mark.parametrize("empty", [False, True])
def test_every_hull_size_matches_even_when_empty(folder, size, accepted, empty):
    path = folder / "hull/1.npz"
    voxels, _ = read_frame(str(path))
    np.savez(path, voxels=np.empty((0, 3)) if empty else voxels, voxel_size=np.array(size))
    issues = FlameAnalysis.load(str(folder)).check()
    assert (not any("voxel_size" in i.message for i in issues)) == accepted


@pytest.mark.parametrize("vertices, faces", [
    ([[float("nan"), 0, 0]], []), ([[float("inf"), 0, 0]], []), ([[1e100, 0, 0]], []),
    ([[0, 0, 0]], [[0, 0, 1]]), ([[0, 0, 0]], [[-1, 0, 0]]),
    ([[0, 0, 0]], [[0.9, 0, 0]]), ([[0, 0, 0]], [[float("nan"), 0, 0]]),
])
def test_mesh_writer_refuses_invalid_geometry_before_writing(tmp_path, vertices, faces):
    path = tmp_path / "mesh.ply"
    path.write_bytes(b"keep")
    with pytest.raises(FlameAnalysisError):
        write_mesh(str(path), np.array(vertices), np.array(faces))
    assert path.read_bytes() == b"keep"


def test_default_npz_writer_is_byte_identical(tmp_path):
    from test_flame_analysis import generator
    writer = generator._synthetic_flame
    voxels = np.array([[0., 0., 0.]], dtype="<f8")
    implicit, explicit = tmp_path / "implicit.npz", tmp_path / "explicit.npz"
    writer.write_npz(implicit, voxels)
    writer.write_npz(explicit, voxels, voxel_size=writer.SIZE)
    assert implicit.read_bytes() == explicit.read_bytes()
    assert read_frame(str(implicit))[1] == writer.SIZE
