"""Flame analysis folders (format 1.0): read them and check them.

A flame analysis folder holds one processed fire test filmed by several calibrated
cameras: `analysis.json` names the site plan, the cameras, the clock every file of
the test uses, the text that explains each step, and the events; each event's
`event.json` names its instants (pictures and a 3-D flame at each), the files that
hold them and the series to plot. The flame analysis board reads exactly this, so a
folder this module accepts is a folder the board can show.

The format describes results, not how they were made: nothing here knows a
pipeline's thresholds, coefficients or file layout. Paths in a manifest are relative
to that manifest, use '/', and may not leave the folder `analysis.json` is in.
See CONVENTIONS.md section 13 and docs/flame-analysis-board-design.md.

    from fireplan.flame_analysis import FlameAnalysis
    analysis = FlameAnalysis.load("fixtures/flame-analysis/analysis.json")
    for issue in analysis.check():
        print(issue)
    event = analysis.event("E1")
    t, q = event.read_series("hood")       # seconds on the time base, kW
    rings = event.outlines("camA")[12]      # the flame outline(s) at instant 12
    voxels = event.hull(12)                 # (M, 3) metres, plan frame
"""

from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from .flame import read_frame
from .plan import Issue, Plan, _schema_text

ANALYSIS_FORMAT = "fireplan-flame-analysis"
EVENT_FORMAT = "fireplan-flame-event"
OUTLINES_FORMAT = "fireplan-flame-outlines"
VERSION = "1.0.0"
#: Event manifests: 1.1 adds files.mesh and series[].responseTime_s. A file
#: declares the lowest version its contents need. 1.2 adds heat flux and object links.
EVENT_VERSIONS = ("1.0.0", "1.1.0", "1.2.0")

#: The steps of the explanation, in the order the board shows them.
STEP_IDS = ("cameras", "frames", "segmentation", "reconstruction", "size", "hrr", "limitations")

_SCHEMA_FILES = {
    (ANALYSIS_FORMAT, "1.0.0"): "flame-analysis-1.0.0.schema.json",
    (EVENT_FORMAT, "1.0.0"): "flame-event-1.0.0.schema.json",
    (EVENT_FORMAT, "1.1.0"): "flame-event-1.1.0.schema.json",
    (EVENT_FORMAT, "1.2.0"): "flame-event-1.2.0.schema.json",
    (OUTLINES_FORMAT, "1.0.0"): "flame-outlines-1.0.0.schema.json",
}

_TEMPLATE_FIELD = re.compile(r"\{([a-z]+)\}")


class FlameAnalysisError(Exception):
    """A folder, manifest or data file that cannot be read as format 1.0 through 1.2."""


class _SeriesTimeError(FlameAnalysisError):
    """Keep the check API's series-time code while reporting physical CSV lines."""


def localized(value: Any, language: str = "en") -> str:
    """The text of a localised field: a plain string, or {en, fr?} (English when
    the language is missing)."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return value.get(language) or value["en"]


#: An unescaped `$` in a schema pattern, and what it means in Python's syntax.
_PATTERN_END = re.compile(r"(?<!\\)\$")
_END_OF_TEXT = r"\\Z"
_VALIDATOR: Any = None


def _validator_class() -> Any:
    """Draft 2020-12 with `pattern` read as the schema means it. A JSON Schema pattern
    is ECMAScript's, where `$` is the end of the text; Python's `$` also matches before
    a final line break, which would pass an id or a date with a line break after it.
    The board (ECMAScript) refuses both, and so must this reader."""
    global _VALIDATOR
    if _VALIDATOR is None:
        import jsonschema

        def pattern(validator: Any, wanted: str, instance: Any, schema: Any) -> Any:
            if isinstance(instance, str) and not re.search(_PATTERN_END.sub(_END_OF_TEXT, wanted), instance):
                yield jsonschema.ValidationError("{!r} does not match {!r}".format(instance, wanted))

        _VALIDATOR = jsonschema.validators.extend(jsonschema.Draft202012Validator, {"pattern": pattern})
    return _VALIDATOR


def _validate(kind: str, data: Any, where: str) -> None:
    """Schema validation; the first few violations name their place in the file."""
    version = data.get("version") if isinstance(data, dict) else None
    filename = (_SCHEMA_FILES.get((kind, version)) if isinstance(version, str) else None)
    filename = filename or _SCHEMA_FILES[(kind, "1.0.0")]
    schema = json.loads(_schema_text(filename))
    validator = _validator_class()(schema)
    # Keep an unsupported version visible even if its newer fields also fail the
    # fallback schema and would otherwise fill the five diagnostic slots.
    errors = sorted(validator.iter_errors(data),
                    key=lambda e: (list(e.absolute_path) != ["version"], list(e.absolute_path)))
    if errors:
        lines = []
        for error in errors[:5]:
            place = "/".join(str(p) for p in error.absolute_path) or "(top level)"
            lines.append("{}: {}".format(place, error.message))
        more = "" if len(errors) <= 5 else " (and {} more)".format(len(errors) - 5)
        raise FlameAnalysisError("{} fails schema validation{}:\n  {}".format(
            where, more, "\n  ".join(lines)))


def _reject_constant(value: str) -> None:
    raise ValueError("non-JSON number {}".format(value))


def _finite_json_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("non-finite JSON number {}".format(value))
    return number


def _finite_json_int(value: str) -> int:
    """A whole number too large for a float is as far outside the finite range as
    1e999: JavaScript reads both as infinity, so neither is a number here."""
    number = int(value)
    try:
        float(number)
    except OverflowError:
        raise ValueError("non-finite JSON number {}...".format(value[:24]))
    return number


def _read_json(path: str) -> Any:
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            return json.load(fh, parse_constant=_reject_constant, parse_float=_finite_json_float,
                             parse_int=_finite_json_int)
    except FileNotFoundError:
        raise FlameAnalysisError("{}: no such file".format(path))
    except (OSError, ValueError) as exc:
        raise FlameAnalysisError("{}: not readable as JSON ({})".format(path, exc))


def _path(relative: str, template: bool = False) -> None:
    """Validate the spelling before any filesystem normalization."""
    body = re.sub(r"\{cam\}|\{stem\}", "x", relative) if template else relative
    if (not body or re.search(r"[\\:{}\x00-\x1f\x7f]", body)
            or any(part in ("", ".", "..") for part in body.split("/"))):
        raise FlameAnalysisError("{!r} is not a relative '/' path with nonempty, non-dotted segments".format(relative))


def _inside(root: str, base: str, relative: str) -> str:
    """`relative` joined to the folder `base`, refused if it leaves `root`."""
    _path(relative)
    path = os.path.normpath(os.path.join(base, *relative.split("/")))
    real_root = os.path.normcase(os.path.realpath(root))
    real_path = os.path.normcase(os.path.realpath(path))
    if real_path != real_root and not real_path.startswith(real_root.rstrip(os.sep) + os.sep):
        raise FlameAnalysisError("{!r} leaves the analysis folder".format(relative))
    return path


def fill_template(template: str, cam: Optional[str] = None, stem: Optional[str] = None) -> str:
    """Substitute {cam} and {stem}; any other field, or a missing value, is refused."""
    _path(template, template=True)
    values = {"cam": cam, "stem": stem}

    def field(match: "re.Match[str]") -> str:
        name = match.group(1)
        if name not in values or values[name] is None:
            raise FlameAnalysisError("template {!r} needs {{{}}}".format(template, name))
        return values[name]

    result = _TEMPLATE_FIELD.sub(field, template)
    _path(result)
    return result


# ECMAScript String.trim whitespace, shared with the TypeScript tokenizer.
_CSV_SPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_DECIMAL = re.compile(r"[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")


def _csv_rows(text: str, path: str) -> List[Tuple[int, List[str]]]:
    """Port of delimited.ts quoting, with physical lines and only empty lines skipped."""
    rows: List[Tuple[int, List[str]]] = []
    row: List[str] = []
    cell = ""
    quoted = closed = content = False
    line = start = 1
    i = 0
    while i < len(text):
        ch = text[i]
        newline = ch in "\r\n"
        if quoted:
            if ch == '"':
                if i + 1 < len(text) and text[i + 1] == '"':
                    cell += '"'
                    i += 1
                else:
                    quoted, closed = False, True
            else:
                cell += ch
                if ch == "\r" and i + 1 < len(text) and text[i + 1] == "\n":
                    cell += "\n"
                    i += 1
        elif ch == ",":
            row.append(cell.strip(_CSV_SPACE))
            cell, closed = "", False
        elif newline:
            if content:
                rows.append((start, row + [cell.strip(_CSV_SPACE)]))
            row, cell, closed, content = [], "", False, False
            if ch == "\r" and i + 1 < len(text) and text[i + 1] == "\n":
                i += 1
        elif ch == '"' and not cell.strip(_CSV_SPACE) and not closed:
            cell, quoted = "", True
        elif ch == '"' or (closed and ch.strip(_CSV_SPACE)):
            raise FlameAnalysisError("{} row {}: malformed CSV quoting".format(path, line))
        else:
            cell += ch
        if newline:
            line += 1
            if not quoted:
                start = line
        else:
            content = True
        i += 1
    if quoted:
        raise FlameAnalysisError("{} row {}: unclosed quoted field".format(path, start))
    if content:
        rows.append((start, row + [cell.strip(_CSV_SPACE)]))
    return rows


def read_series_csv(path: str, time_column: str, value_column: str) -> Tuple[np.ndarray, np.ndarray]:
    """Two columns of a series CSV as float arrays; an empty cell is NaN.

    UTF-8 (a BOM is accepted), comma separated, one header row, then numbers. Any
    other text in either column is refused with its row number: a units row or a
    note inside the data is the delivery's to fix, not something to skip silently.
    """
    try:
        with open(path, "r", encoding="utf-8-sig", newline="") as fh:
            rows = _csv_rows(fh.read(), path)
    except FileNotFoundError:
        raise FlameAnalysisError("{}: no such file".format(path))
    except (OSError, UnicodeError) as exc:
        raise FlameAnalysisError("{}: not readable as CSV ({})".format(path, exc))
    if not rows:
        raise FlameAnalysisError("{}: no samples".format(path))
    header = rows[0][1]
    columns = []
    for name in (time_column, value_column):
        if name not in header:
            raise FlameAnalysisError("{}: no column {!r}".format(os.path.basename(path), name))
        columns.append(header.index(name))
    if len(rows) == 1:
        raise FlameAnalysisError("{}: no samples".format(path))
    out = np.full((len(rows) - 1, 2), np.nan)
    for r, (line, row) in enumerate(rows[1:]):
        for k, c in enumerate(columns):
            cell = row[c] if c < len(row) else ""
            if cell == "":
                continue
            value = float(cell) if _DECIMAL.fullmatch(cell) else float("nan")
            if not math.isfinite(value):
                raise FlameAnalysisError("{} row {}: {!r} in column {!r} is not finite".format(
                    path, line, cell, header[c]))
            out[r, k] = value
    for r, value in enumerate(out[:, 0]):
        if not math.isfinite(value) or (r and value <= out[r - 1, 0]):
            raise _SeriesTimeError("{}: times must be present and strictly increasing (row {})".format(path, rows[r + 1][0]))
    return out[:, 0], out[:, 1]


@dataclass(frozen=True)
class Series:
    id: str
    label: Any
    role: str          # measured | reconstructed | estimated
    quantity: str      # hrr | volume | area | height | heatFlux
    unit: str          # kW | m3 | m2 | m | kW/m2
    file: str
    time: str
    value: str
    basis: Optional[str] = None
    note: Any = None
    #: 1.1: the first-order response time of a measured heat release rate.
    responseTime_s: Optional[float] = None
    #: 1.2: the site plan's heatFluxSensor that recorded this heat flux series.
    object: Optional[str] = None


class FlameEvent:
    """One event: instants, files and series. Built by FlameAnalysis.event()."""

    def __init__(self, analysis: "FlameAnalysis", entry: Dict[str, Any]) -> None:
        self.analysis = analysis
        self.entry = entry
        self.path = _inside(analysis.folder, analysis.folder, entry["path"])
        self.folder = os.path.dirname(self.path)
        self.data = _read_json(self.path)
        _validate(EVENT_FORMAT, self.data, self.path)
        self.times = np.asarray(self.data["instants"]["t_s"], dtype=float)
        self.stems: List[str] = list(self.data["instants"]["stem"])
        if len(self.times) != len(self.stems):
            raise FlameAnalysisError("{}: {} times but {} stems".format(
                self.path, len(self.times), len(self.stems)))

    @property
    def id(self) -> str:
        return self.data["id"]

    @property
    def label(self) -> Any:
        return self.data["label"]

    @property
    def onset_s(self) -> float:
        return float(self.data["onset_s"])

    @property
    def cameras(self) -> List[str]:
        return list(self.data["cameras"])

    @property
    def series(self) -> List[Series]:
        return [Series(**s) for s in self.data["series"]]

    def file(self, kind: str, cam: Optional[str] = None, stem: Optional[str] = None) -> str:
        """The path of a `files` entry (display, frame, closeup, outlines, hull) for a
        camera and/or instant stem."""
        template = self.data["files"].get(kind)
        if template is None:
            raise FlameAnalysisError("{}: no {!r} files".format(self.path, kind))
        return _inside(self.analysis.folder, self.folder, fill_template(template, cam, stem))

    def read_series(self, series_id: str) -> Tuple[np.ndarray, np.ndarray]:
        for s in self.series:
            if s.id == series_id:
                return read_series_csv(
                    _inside(self.analysis.folder, self.folder, s.file), s.time, s.value)
        raise FlameAnalysisError("{}: no series {!r}".format(self.path, series_id))

    def outlines(self, cam: str) -> List[List[np.ndarray]]:
        """For each instant, the flame's rings in this camera as (k, 2) pixel arrays."""
        path = self.file("outlines", cam=cam)
        data = _read_json(path)
        _validate(OUTLINES_FORMAT, data, path)
        if data["camera"] != cam:
            raise FlameAnalysisError("{}: holds camera {!r}, not {!r}".format(path, data["camera"], cam))
        image = self.data["images"].get(cam)
        if image is None or data["size_px"] != image["size_px"]:
            raise FlameAnalysisError("{}: size_px does not equal images.{}.size_px".format(path, cam))
        rings = data["outlines"]
        if len(rings) != len(self.stems):
            raise FlameAnalysisError("{}: {} instants, the event has {}".format(
                path, len(rings), len(self.stems)))
        out = []
        for i, instant in enumerate(rings):
            parsed = []
            for ring in instant:
                if len(ring) % 2:
                    raise FlameAnalysisError("{}: instant {} has a ring with an odd number of "
                                             "coordinates".format(path, i))
                parsed.append(np.asarray(ring, dtype=float).reshape(-1, 2))
            out.append(parsed)
        return out

    def hull(self, index: int) -> np.ndarray:
        """The 3-D flame at an instant: occupied voxel centres, metres, plan frame."""
        voxels, _ = read_frame(self.file("hull", stem=self.stems[index]))
        return voxels

    def index_at(self, t_s: float) -> Optional[int]:
        """The instant shown at time t: the last one at or before it (a frame holds
        until the next), or None before the first."""
        i = int(np.searchsorted(self.times, t_s, side="right")) - 1
        return i if i >= 0 else None

    # -- checks ----------------------------------------------------------

    def check(self, deep: bool = True) -> List[Issue]:
        """Problems the board would refuse or show wrongly. Pictures are checked for
        being there, not opened; `deep` also opens every outline, hull and mesh (slow
        on a large event)."""
        try:
            _validate(EVENT_FORMAT, self.data, self.path)
        except FlameAnalysisError as exc:
            return [Issue("error", "event", str(exc), self.entry["id"])]
        issues: List[Issue] = []
        where = self.id

        def add(severity: str, code: str, message: str) -> None:
            issues.append(Issue(severity, code, message, where))

        known = {c["id"]: c for c in self.analysis.data["cameras"]}
        for cam in self.cameras:
            if cam not in known:
                add("error", "camera-unknown", "camera {!r} is not listed in analysis.json".format(cam))
        if set(self.data["images"]) != set(self.cameras):
            add("error", "images-cameras", "images lists {}, the event's cameras are {}".format(
                sorted(self.data["images"]), sorted(self.cameras)))
        if self.data["id"] != self.entry["id"]:
            add("error", "event-id", "event.json says {!r}, analysis.json lists {!r}".format(
                self.data["id"], self.entry["id"]))

        if not np.all(np.isfinite(self.times)) or np.any(np.diff(self.times) <= 0):
            add("error", "instants-order", "instant times must be finite and strictly increasing")
        n = len(self.stems)
        quality = self.data.get("quality", {})
        bad = [i for i in quality.get("noHull", []) if i >= n]
        for cam, indices in quality.get("outsideFrame", {}).items():
            if cam not in self.cameras:
                add("error", "quality-camera", "outsideFrame names camera {!r}".format(cam))
            bad += [i for i in indices if i >= n]
        if bad:
            add("error", "quality-index", "quality indices beyond the {} instants: {}".format(n, sorted(set(bad))[:5]))

        closeups = "closeup" in self.data["files"]
        for cam, image in self.data["images"].items():
            box = image.get("closeup")
            if closeups and box is None:
                add("error", "closeup", "{}: files.closeup is given but images.{}.closeup is not".format(cam, cam))
            if box is not None:
                if not closeups:
                    add("error", "closeup", "{}: a close-up rectangle but no files.closeup".format(cam))
                x, y, w, h = box["rect_px"]
                if x + w > image["size_px"][0] or y + h > image["size_px"][1]:
                    add("error", "closeup", "{}: the close-up {} leaves the {} x {} picture".format(
                        cam, box["rect_px"], *image["size_px"]))

        plan = self.analysis.site_plan_or_none()
        for cam in self.cameras:
            plan_id = known.get(cam, {}).get("planCameraId")
            plan_cam = plan.cameras.get(plan_id) if plan is not None and plan_id else None
            if plan_cam is not None and cam in self.data["images"]:
                size = tuple(self.data["images"][cam]["size_px"])
                if size != tuple(plan_cam.resolution):
                    add("warning", "image-size",
                        "{}: pictures are {} x {} px, the site plan's camera {} x {}: the 3-D "
                        "flame cannot be drawn over them".format(cam, size[0], size[1], *plan_cam.resolution))

        objects = {obj.id: obj for obj in plan.objects} if plan is not None else {}
        seen = set()
        for s in self.series:
            if plan is not None and s.object is not None:
                obj = objects.get(s.object)
                if obj is None:
                    add("error", "series-object-missing",
                        "Event {}: series {!r} names missing site plan object {!r}".format(self.id, s.id, s.object))
                elif obj.type != "heatFluxSensor":
                    add("error", "series-object-type",
                        "Event {}: series {!r} object {!r} must be a heat flux sensor".format(self.id, s.id, s.object))
            if s.id in seen:
                add("error", "series-duplicate", "event {!r}: series id {!r} repeats".format(self.id, s.id))
            seen.add(s.id)
            try:
                t, v = read_series_csv(_inside(self.analysis.folder, self.folder, s.file), s.time, s.value)
            except FlameAnalysisError as exc:
                add("error", "series-time" if isinstance(exc, _SeriesTimeError) else "series", "{}: {}".format(s.id, exc))
                continue
            finite = np.isfinite(t)
            if not finite.any():
                add("error", "series-time", "{}: no times".format(s.id))
            elif np.any(np.diff(t[finite]) <= 0) or not finite.all():
                add("error", "series-time", "{}: times must be present and strictly increasing".format(s.id))
            if s.quantity in ("volume", "area") and np.any(v[np.isfinite(v)] < 0):
                add("error", "series-negative", "{}: negative {}".format(s.id, s.quantity))

        try:
            files = self._file_problems(deep)
        except FlameAnalysisError as exc:
            files = [str(exc)]
        for message in files:
            add("error", "file", message)
        return issues

    def _file_problems(self, deep: bool) -> List[str]:
        problems: List[str] = []
        kinds = ["display"] + [k for k in ("frame", "closeup") if k in self.data["files"]]
        for cam in self.cameras:
            for kind in kinds:
                missing = [s for s in self.stems if not os.path.isfile(self.file(kind, cam=cam, stem=s))]
                if missing:
                    problems.append("{} {}: {} of {} files missing (first: {})".format(
                        cam, kind, len(missing), len(self.stems), missing[0]))
            try:
                if deep:
                    self.outlines(cam)
                elif not os.path.isfile(self.file("outlines", cam=cam)):
                    problems.append("{}: no outlines file".format(cam))
            except FlameAnalysisError as exc:
                problems.append(str(exc))
        for i, stem in enumerate(self.stems):
            path = self.file("hull", stem=stem)
            if not os.path.isfile(path):
                problems.append("hull {}: missing".format(stem))
                continue
            if deep:
                try:
                    _, size = read_frame(path)
                    if not math.isclose(size, self.data["hull"]["voxelSize_m"], rel_tol=1e-9, abs_tol=0):
                        problems.append("{}: voxel_size {} does not equal hull.voxelSize_m {}".format(
                            path, size, self.data["hull"]["voxelSize_m"]))
                except (ValueError, OSError) as exc:
                    problems.append("{}: {}".format(path, exc))
        if "mesh" in self.data["files"]:
            missing = []
            for stem in self.stems:
                path = self.file("mesh", stem=stem)
                if not os.path.isfile(path):
                    missing.append(stem)
                elif deep:
                    try:
                        read_mesh(path)
                    except FlameAnalysisError as exc:
                        problems.append(str(exc))
            if missing:
                problems.append("mesh: {} of {} files missing (first: {})".format(
                    len(missing), len(self.stems), missing[0]))
        return problems

    def mesh(self, index: int) -> Tuple[np.ndarray, np.ndarray]:
        """The smoothed surface at an instant: (V, 3) vertices in metres (plan frame)
        and (F, 3) triangles; both empty when the instant has no flame."""
        return read_mesh(self.file("mesh", stem=self.stems[index]))


_PLY_HEADER = (
    "ply\nformat binary_little_endian 1.0\nelement vertex {v}\n"
    "property float x\nproperty float y\nproperty float z\n"
    "element face {f}\nproperty list uchar int vertex_indices\nend_header\n"
)


def write_mesh(path: str, vertices: np.ndarray, faces: np.ndarray) -> None:
    """A mesh file of format 1.1: binary little-endian PLY, float32 vertices,
    triangles as (uchar 3, int32 x 3) records. Empty arrays write an empty mesh."""
    with np.errstate(over="ignore", invalid="ignore"):
        vertices = np.ascontiguousarray(vertices, dtype="<f4").reshape(-1, 3)
    if not np.isfinite(vertices).all():
        raise FlameAnalysisError("{}: vertices must be finite float32 coordinates".format(path))
    faces = np.asarray(faces).reshape(-1, 3)
    if (faces.dtype.kind not in "iuf" or not np.isfinite(faces).all()
            or np.any(faces != np.floor(faces)) or np.any(faces < 0)
            or np.any(faces >= len(vertices)) or np.any(faces > np.iinfo(np.int32).max)):
        raise FlameAnalysisError("{}: faces must be integer indices of existing vertices".format(path))
    faces = np.ascontiguousarray(faces, dtype="<i4")
    records = np.empty(len(faces), dtype=[("n", "u1"), ("i", "<i4", (3,))])
    records["n"], records["i"] = 3, faces
    with open(path, "wb") as fh:
        fh.write(_PLY_HEADER.format(v=len(vertices), f=len(faces)).encode("ascii"))
        fh.write(vertices.tobytes())
        fh.write(records.tobytes())


def read_mesh(path: str) -> Tuple[np.ndarray, np.ndarray]:
    """Read a format 1.1 mesh file (the exact layout `write_mesh` writes)."""
    name = str(path)
    # Nine complete LF-terminated lines, bounded before reading the payload.
    expected = _PLY_HEADER.format(v="[0-9]+", f="[0-9]+").encode("ascii").splitlines(keepends=True)
    counts = []
    try:
        with open(path, "rb") as fh:
            remaining = 64 * 1024
            for i, pattern in enumerate(expected):
                line = fh.readline(remaining) if remaining else b""
                remaining -= len(line)
                if not re.fullmatch(pattern.replace(b".", b"\\."), line):
                    raise FlameAnalysisError("{}: not an exact-layout PLY header within 64 KiB".format(name))
                if i in (2, 6):
                    digits = line.split(b" ")[-1].strip().lstrip(b"0") or b"0"
                    if len(digits) > 16:
                        raise FlameAnalysisError("{}: PLY count exceeds the file size".format(name))
                    counts.append(int(digits))
            body = fh.read()
    except OSError as exc:
        raise FlameAnalysisError("{}: not readable as PLY ({})".format(name, exc))
    nv, nf = counts
    if len(body) != nv * 12 + nf * 13:
        raise FlameAnalysisError("{}: {} bytes after the header, {} vertices and {} triangles need {}".format(
            name, len(body), nv, nf, nv * 12 + nf * 13))
    vertices = np.frombuffer(body[:nv * 12], dtype="<f4").reshape(nv, 3).astype(np.float64)
    if not np.isfinite(vertices).all():
        raise FlameAnalysisError("{}: vertices must be finite".format(name))
    records = np.frombuffer(body[nv * 12:], dtype=[("n", "u1"), ("i", "<i4", (3,))])
    if nf and (np.any(records["n"] != 3) or records["i"].min() < 0 or records["i"].max() >= nv):
        raise FlameAnalysisError("{}: faces must be triangles of existing vertices".format(name))
    return vertices, records["i"].astype(np.int64).reshape(-1, 3)


class FlameAnalysis:
    """A flame analysis folder, from its analysis.json."""

    def __init__(self, path: str, data: Dict[str, Any]) -> None:
        self.path = os.path.abspath(path)
        self.folder = os.path.dirname(self.path)
        self.data = data
        self._events: Dict[str, FlameEvent] = {}
        self._plan: Optional[Plan] = None

    @classmethod
    def load(cls, path: str) -> "FlameAnalysis":
        if os.path.isdir(path):
            path = os.path.join(path, "analysis.json")
        data = _read_json(path)
        _validate(ANALYSIS_FORMAT, data, path)
        return cls(path, data)

    @property
    def title(self) -> Any:
        return self.data["title"]

    @property
    def event_ids(self) -> List[str]:
        return [e["id"] for e in self.data["events"]]

    def event(self, event_id: str) -> FlameEvent:
        if event_id not in self._events:
            entry = next((e for e in self.data["events"] if e["id"] == event_id), None)
            if entry is None:
                raise FlameAnalysisError("no event {!r}; the folder has {}".format(event_id, self.event_ids))
            self._events[event_id] = FlameEvent(self, entry)
        return self._events[event_id]

    def site_plan(self) -> Plan:
        if self._plan is None:
            self._plan = Plan.load(_inside(self.folder, self.folder, self.data["sitePlan"]))
        return self._plan

    def site_plan_or_none(self) -> Optional[Plan]:
        try:
            return self.site_plan()
        except Exception:  # reported by check()
            return None

    def step_text(self, step: str, event: Optional[FlameEvent] = None,
                  language: str = "en") -> Dict[str, str]:
        """A step's title, text and watch-for, with the event's own note appended."""
        entry = self.data.get("steps", {}).get(step, {})
        out = {key: localized(entry.get(key), language) for key in ("title", "text", "watchFor")}
        if event is not None:
            out["note"] = localized(event.data.get("notes", {}).get(step), language)
        return out

    def check(self, deep: bool = True) -> List[Issue]:
        """Every problem the board would refuse or show wrongly, over all events."""
        try:
            _validate(ANALYSIS_FORMAT, self.data, self.path)
        except FlameAnalysisError as exc:
            return [Issue("error", "analysis", str(exc))]
        issues: List[Issue] = []
        ids = [c["id"] for c in self.data["cameras"]]
        if len(set(ids)) != len(ids):
            issues.append(Issue("error", "camera-duplicate", "camera ids repeat: {}".format(ids)))
        if len(set(self.event_ids)) != len(self.event_ids):
            issues.append(Issue("error", "event-duplicate", "event ids repeat: {}".format(self.event_ids)))
        try:
            plan = self.site_plan()
        except Exception as exc:
            issues.append(Issue("error", "site-plan", "the site plan cannot be read: {}".format(exc)))
            plan = None
        if plan is not None:
            for cam in self.data["cameras"]:
                if cam["planCameraId"] not in plan.cameras:
                    issues.append(Issue("error", "plan-camera", "{}: the site plan has no camera {!r}".format(
                        cam["id"], cam["planCameraId"]), cam["id"]))
        for event_id in self.event_ids:
            try:
                event = self.event(event_id)
            except FlameAnalysisError as exc:
                issues.append(Issue("error", "event", str(exc), event_id))
                continue
            issues.extend(event.check(deep))
        return issues


# -- writers (shared by the synthetic generator and converters) --------------

def outlines_document(camera: str, size_px: Sequence[int],
                      outlines: Sequence[Sequence[Sequence[float]]]) -> Dict[str, Any]:
    """An outlines file's content: rings as flat [x0, y0, ...] lists per instant."""
    return {
        "format": OUTLINES_FORMAT,
        "version": VERSION,
        "camera": camera,
        "size_px": [int(size_px[0]), int(size_px[1])],
        "outlines": [[list(ring) for ring in instant] for instant in outlines],
    }


def dump_compact(data: Any) -> str:
    """JSON with no spaces and integers kept integral: outline files are large."""
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"


def trace_outlines(mask: np.ndarray) -> List[List[int]]:
    """The boundary rings of a binary mask, as flat [x0, y0, x1, y1, ...] lists.

    Each 8-connected region of True pixels gives its outer boundary, and each hole
    in it (4-connected False pixels not reaching the edge) gives an inner one, so
    even-odd filling reproduces the mask's regions. Points are the centres of the
    region's boundary pixels, in tracing order with the collinear runs removed;
    regions one pixel wide enclose no area and are left out.
    Pure NumPy and Python: meant for small masks (fixtures, tests). A converter of
    full-resolution footage can use any tracer that writes the same rings.
    """
    mask = np.asarray(mask, dtype=bool)
    rings: List[List[int]] = []
    rings.extend(_trace_regions(mask, connectivity=8))
    # Holes: background components (4-connected) that do not touch the border.
    padded = np.pad(~mask, 1, constant_values=True)
    labels = _label(padded, connectivity=4)
    outside = labels[0, 0]
    for label in np.unique(labels):
        if label == 0 or label == outside:
            continue
        hole = labels[1:-1, 1:-1] == label
        rings.extend(_trace_regions(hole, connectivity=4))
    return rings


def _label(mask: np.ndarray, connectivity: int) -> np.ndarray:
    """Connected-component labels (0 = background), numbered in raster order of
    each component's first pixel. Every pixel starts with its own raster index and
    takes the smallest index among its neighbours until nothing changes."""
    h, w = mask.shape
    big = np.int64(h * w + 1)
    labels = np.where(mask, np.arange(h * w, dtype=np.int64).reshape(h, w), big)
    if connectivity == 8:
        steps = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    else:
        steps = [(-1, 0), (1, 0), (0, -1), (0, 1)]
    while True:
        padded = np.pad(labels, 1, constant_values=big)
        smallest = labels
        for dy, dx in steps:
            smallest = np.minimum(smallest, padded[1 + dy:1 + dy + h, 1 + dx:1 + dx + w])
        smallest = np.where(mask, smallest, big)
        if np.array_equal(smallest, labels):
            break
        labels = smallest
    out = np.zeros((h, w), dtype=np.int32)
    if mask.any():
        _, inverse = np.unique(labels[mask], return_inverse=True)
        out[mask] = inverse.reshape(-1) + 1
    return out


# Moore neighbourhood, clockwise in image coordinates (y down), starting west.
_MOORE = [(0, -1), (-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1)]


def _trace_regions(mask: np.ndarray, connectivity: int) -> List[List[int]]:
    labels = _label(mask, connectivity)
    rings = []
    for label in range(1, int(labels.max()) + 1):
        region = labels == label
        ys, xs = np.nonzero(region)
        start = (int(ys[0]), int(xs[0]))  # top-most, then left-most pixel
        ring = _simplify(_moore_trace(region, start))
        if ring is not None:
            rings.append(ring)
    return rings


def _moore_trace(region: np.ndarray, start: Tuple[int, int]) -> List[Tuple[int, int]]:
    h, w = region.shape

    def inside(p: Tuple[int, int]) -> bool:
        return 0 <= p[0] < h and 0 <= p[1] < w and bool(region[p])

    boundary = [start]
    # Entered from the west: the start is the top-most, left-most pixel.
    direction = 0
    current = start
    first_move = None
    while True:
        found = None
        for k in range(8):
            d = (direction + k) % 8
            candidate = (current[0] + _MOORE[d][0], current[1] + _MOORE[d][1])
            if inside(candidate):
                found = (d, candidate)
                break
        if found is None:  # a single pixel
            break
        d, nxt = found
        if first_move is None:
            first_move = (current, nxt)
        elif (current, nxt) == first_move:
            break  # Jacob's stopping criterion: the first step repeats
        boundary.append(nxt)
        current = nxt
        direction = (d + 6) % 8  # back up to the neighbour before the one found
    if len(boundary) > 1 and boundary[-1] == boundary[0]:
        boundary.pop()
    return boundary


def _simplify(points: List[Tuple[int, int]]) -> Optional[List[int]]:
    """Drop points in the middle of straight runs; flat [x, y, ...] output. A ring
    through pixel centres needs three distinct points to enclose any area, so a
    region one pixel wide (a speck, a line) gives None and is left out."""
    if len(set(points)) < 3:
        return None
    kept = []
    n = len(points)
    for i, p in enumerate(points):
        a, c = points[i - 1], points[(i + 1) % n]
        if (p[0] - a[0], p[1] - a[1]) == (c[0] - p[0], c[1] - p[1]):
            continue
        kept.append(p)
    area2 = sum(kept[i - 1][1] * kept[i][0] - kept[i][1] * kept[i - 1][0] for i in range(len(kept)))
    if len(kept) < 3 or area2 == 0:
        return None
    flat: List[int] = []
    for y, x in kept:
        flat.extend((int(x), int(y)))
    return flat
