"""The Plan container: load, validate, query, export."""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterator, List, Optional

import numpy as np

from . import correlations, serialize
from . import linked_files, test_data
from ._math import normalize
from .occlusion import first_occluder, flame_centreline_samples
from .objects import (
    Burner,
    Camera,
    Ceiling,
    HeatFluxSensor,
    Hood,
    Obstruction,
    ReconstructedFlame,
    PlanObject,
    Thermocouple,
    Wall,
    wrap,
)

FORMAT = "fire-test-plan"

#: Baseline a new, empty plan declares. A plan states the LOWEST version that
#: describes its own contents (serialize.required_version), so this is a floor
#: rather than a stamp -- and a 1.0 plan stays openable in a 1.0 tool.
VERSION = "1.0.0"

#: Highest format version this build can write.
VERSION_LATEST = "1.6.0"

#: One schema per format version, so a 1.0 file is judged by the 1.0 rules. A 1.0
#: plan holding a camera with a zoomFactor really is invalid, and validating it
#: against the 1.1 schema would hide exactly the mislabelling worth catching.
_SCHEMA_FILES = {
    "1.0.0": "fire-test-plan-1.0.0.schema.json",
    "1.1.0": "fire-test-plan-1.1.0.schema.json",
    "1.2.0": "fire-test-plan-1.2.0.schema.json",
    "1.3.0": "fire-test-plan-1.3.0.schema.json",
    "1.4.0": "fire-test-plan-1.4.0.schema.json",
    "1.5.0": "fire-test-plan-1.5.0.schema.json",
    "1.6.0": "fire-test-plan-1.6.0.schema.json",
}

#: Where the schemas live INSIDE the package: `fireplan/schemas/`, shipped as
#: package data. The repository's `schema/` directory is the normative copy that
#: the editor's tests and the documentation point at; this one is a byte-identical
#: mirror of it, and `tests/test_roundtrip.py` fails the build if the two drift.
#: They are read through `importlib.resources` rather than by walking up from
#: `__file__`, because an installed wheel has no repository above it -- a
#: `pip install fireplan` outside this tree used to raise FileNotFoundError from
#: `validate_schema()` and from every FDS conversion, which validates on the way out.
_SCHEMA_PACKAGE = "schemas"


def _schema_text(filename: str) -> str:
    """The text of one shipped schema, wherever this package is installed."""
    try:
        from importlib import resources
        return resources.files(__package__).joinpath(_SCHEMA_PACKAGE, filename).read_text(
            encoding="utf-8")
    except (ImportError, AttributeError):
        # Python < 3.9 has no `resources.files`; the plain path still works for a
        # source checkout and for a wheel unpacked onto a real filesystem.
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), _SCHEMA_PACKAGE, filename)
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()

#: Representative mean temperature inside a flame, for the over-temperature test.
#: A rule of thumb, not a correlation: hydrocarbon pool flames run roughly
#: 800-1200 C. It answers "will this bead survive", which does not need better.
FLAME_TEMPERATURE_C = 1000.0

#: Below 5% of full scale a heat flux gauge is reading in its own noise.
_LOW_SIGNAL_FRACTION = 0.05


class PlanError(Exception):
    """Raised when a file cannot be read as a plan at all."""


@dataclass(frozen=True)
class Issue:
    """A semantic finding. Schema violations raise; these are returned."""

    severity: str  # "error" | "warning" | "info"
    code: str
    message: str
    object_id: Optional[str] = None

    def __str__(self) -> str:
        where = " [{}]".format(self.object_id) if self.object_id else ""
        return "{}: {}{} -- {}".format(self.severity.upper(), self.code, where, self.message)


def _refuse_constant(name: str):
    """`json.loads` hook for NaN / Infinity / -Infinity, which are not JSON.

    Python accepts them by default (and `json.dump` writes them by default), so a
    plan carrying one loaded, passed `validate_schema()`, and failed only when
    saved -- or reached the editor, which refuses the file outright.
    """
    raise PlanError("invalid JSON: {} is not a JSON number".format(name))


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _which_fire(burner: Burner, many: bool) -> str:
    """`` of 'name'`` when a plan has more than one fire, so a finding says which;
    nothing when there is only the one, as there almost always is."""
    return " of {!r}".format(burner.name) if many else ""


def _write_atomic(path: str, text: str) -> None:
    """Write `text` to `path` via a same-directory temporary file and a rename.

    `os.replace` is atomic on one filesystem, so the destination is either the old
    file or the new one and never a truncated half of either. The temporary is
    removed again if anything goes wrong, so a failed save does not leave a
    `.tmp` beside the plan for someone to open by mistake. LF line endings, as the
    canonical writer emits them: letting the platform translate to CRLF would make
    every plan saved on Windows diff wholesale against one saved elsewhere.
    """
    directory = os.path.dirname(os.path.abspath(path)) or "."
    temp = os.path.join(directory, ".{}.{}.tmp".format(os.path.basename(path), os.getpid()))
    try:
        with open(temp, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(temp, path)
    except BaseException:
        try:
            os.remove(temp)
        except OSError:
            pass
        raise


#: Six-decimal cubic-metre rounding in `volumes.csv`: one millilitre.
PLOT_VOLUME_ROUNDING_M3 = 1e-6
#: Half the tenth of a second a frame file's name carries, and a hair more.
FRAME_NAME_TIME_TOLERANCE_S = 0.05 + 1e-9


def plot_sequence_mismatch(samples, manifest) -> Optional[str]:
    """Why a burner's CSV snapshot and a flame's manifest are not from one run, or None.

    Timestamps must be the same set; then each row's volume must be the frame's
    voxel count times the voxel volume, to within a voxel -- the CSV rounds to a
    microlitre and a 10 mm voxel is one, so the tolerance is a voxel rather than
    exactness. Mirror of `plotSequenceMismatch` in web/src/core/plan.ts.
    """
    frames = manifest["frames"]
    if len(samples) != len(frames):
        return "has {} samples against {} frames".format(len(samples), len(frames))
    voxel_volume = float(manifest["grid"]["voxelSize_m"]) ** 3
    # The CSV's volumes are rounded to a microlitre, which below a ~7.9 mm voxel is
    # more than one voxel on its own; frame names carry a tenth of a second while
    # the CSV keeps the full timestamp. Mirror of the web tolerances.
    count_tolerance = 1 + PLOT_VOLUME_ROUNDING_M3 / 2 / voxel_volume
    for sample, frame in zip(samples, frames):
        if abs(sample[0] - frame[0]) > FRAME_NAME_TIME_TOLERANCE_S:
            return "is sampled at {} s where the sequence has a frame at {} s".format(
                _plain(sample[0]), _plain(frame[0]))
        if abs(sample[1] / voxel_volume - frame[1]) > count_tolerance:
            return "records {} m\u00b3 at {} s where the frame holds {} voxels".format(
                _plain(sample[1]), _plain(frame[0]), frame[1])
    return None


def _plain(value) -> str:
    """A number as a message spells it: `5`, not `5.0`; the same as JavaScript's `${x}`."""
    number = float(value)
    return str(int(number)) if number.is_integer() and abs(number) < 1e15 else repr(number)


class Plan:
    #: Where this plan was loaded from, or None for one built or parsed in memory.
    #: Declared here so `Plan.loads(text).source_path` answers rather than raising.
    source_path: Optional[str] = None

    def __init__(self, data: Dict[str, Any]):
        if not isinstance(data, dict):
            raise PlanError("plan data must be a JSON object")
        if data.get("format") != FORMAT:
            raise PlanError(
                "not a fire test plan: expected format {!r}, got {!r}".format(
                    FORMAT, data.get("format")
                )
            )
        self.data = data

    # -- construction ----------------------------------------------------

    @classmethod
    def new(cls, title: str = "Untitled fire test") -> "Plan":
        now = _utc_now_iso()
        return cls(
            {
                "format": FORMAT,
                "version": VERSION,
                "meta": {"title": title, "created": now, "modified": now},
                "units": {
                    "length": "m",
                    "angle": "rad",
                    "power": "kW",
                    "temperature": "C",
                    "display": {"length": "m", "angle": "deg"},
                },
                "coordinateSystem": {
                    "convention": "Z-up-right-handed",
                    "origin": "burner-center-floor",
                },
                "environment": {"floorSize_m": [20.0, 20.0], "ambientTemperature_C": 20.0},
                "objects": [],
            }
        )

    @classmethod
    def loads(cls, text: str) -> "Plan":
        # A byte-order mark from a Windows editor is not part of the JSON; a
        # browser tab already drops it, and the editor's own parser now does too.
        if text.startswith("﻿"):
            text = text[1:]
        try:
            return cls(json.loads(text, parse_constant=_refuse_constant))
        except json.JSONDecodeError as exc:
            raise PlanError("invalid JSON: {}".format(exc)) from exc

    @classmethod
    def from_fds(cls, path, options=None) -> "Plan":
        """Build a plan from an FDS input file.

        The plan only. `fireplan.fds.load` returns the same plan wrapped in a full
        account of the conversion -- what was skipped, which heat-release surface was
        taken to be the burner, where the origin went -- and the editor's import
        preview is built on that. This is the one-liner for a notebook.

            >>> Plan.from_fds("fixtures/fds/room_corner.fds")

        The import re-origins onto the burner centre at floor level, as this format
        requires, and records the shift in `meta.source.originOffset_m` so the source
        file's own coordinates stay recoverable.
        """
        from . import fds  # deferred: fds imports Plan

        return fds.load(path, options).plan

    @classmethod
    def load(cls, path) -> "Plan":
        with open(path, "r", encoding="utf-8-sig") as fh:
            plan = cls.loads(fh.read())
        plan.source_path = os.path.abspath(path)
        return plan

    def dumps(self) -> str:
        return serialize.dumps(self.data)

    def save(self, path, update_modified: bool = True) -> None:
        """Write the plan to `path`, leaving the previous file intact on any failure.

        The text is produced in full before the destination is touched, and it goes
        through a temporary file in the same directory that is renamed over the
        destination. Opening the destination directly first -- which is what a plain
        `open(path, "w")` does -- truncates it before a byte is written, so a
        serialisation error (a NaN that crept into a coordinate), a full disk or a
        crash mid-write left an empty file where the user's plan had been.

        The bookkeeping this method does in memory -- the `modified` timestamp and
        the derived version -- is undone if serialisation or writing fails, so a
        plan that could not be written does not claim a save time it never had.
        """
        meta = self.data.setdefault("meta", {})
        had_modified = "modified" in meta
        old_modified = meta.get("modified")
        had_version = "version" in self.data
        old_version = self.data.get("version")

        if update_modified:
            meta["modified"] = _utc_now_iso()
        # The writer derives the declared version; adopt it in memory too, so a plan
        # that has just been written does not go on reporting `version-understated`
        # about a file where it is no longer true.
        self.data["version"] = self.effective_version
        try:
            rebased = linked_files.for_destination(self.data, self.source_path, str(path))
            text = serialize.dumps(rebased)
            _write_atomic(str(path), text)
        except Exception:
            if had_modified:
                meta["modified"] = old_modified
            else:
                meta.pop("modified", None)
            if had_version:
                self.data["version"] = old_version
            else:
                self.data.pop("version", None)
            raise

        # Retain object wrapper identity while updating the base used by later saves.
        for original, written in zip(self.data.get("objects", []), rebased.get("objects", [])):
            if original.get("type") in linked_files.LINK_TYPES and "linkedFiles" in written:
                original["linkedFiles"] = written["linkedFiles"]
        for original, written in zip(self.data.get("testData", []), rebased.get("testData", [])):
            original["file"] = written["file"]
        self.source_path = os.path.abspath(path)

    def linked_file_path(self, link: Dict[str, Any]) -> str:
        """Resolve an object link or testData source file against this plan."""
        return linked_files.resolve_path(link["path"], self.source_path)

    # -- access ----------------------------------------------------------

    @property
    def test_data(self) -> List[test_data.TestDataSource]:
        return [test_data.TestDataSource(s) for s in self.data.get("testData", [])]

    def series(self, obj, bead=None) -> List[test_data.Series]:
        """One series per source for this instrument and exact bead (0-based).

        Accept an object wrapper or object ID. Rakes require an explicit bead;
        burners and gauges require None. Reads are explicit and never cached.
        """
        oid = obj if isinstance(obj, str) else obj.id
        target = next((o for o in self.objects if o.id == oid), None)
        if target is None or target.type not in test_data.TARGET_UNITS:
            raise PlanError(f"Test data target is missing or unsupported: {oid}")
        if isinstance(target, Thermocouple):
            if (not test_data.tables.is_number(bead) or bead != int(bead)
                    or not 0 <= bead < len(target.bead_offsets_m)):
                raise PlanError(f"Test data needs a valid bead index for thermocouple {oid}")
        elif bead is not None:
            raise PlanError(f"Only a thermocouple accepts a bead index: {oid}")
        result = []
        for source in self.test_data:
            mappings = [c for c in source.channels if c['object'] == oid and c.get('bead') == bead]
            if not mappings:
                continue
            grid, units = test_data.read_source(source, self.linked_file_path(source.file))
            selected = dict(source.raw, channels=mappings)
            result.append(test_data.source_series(selected, grid,
                {oid: test_data.TARGET_UNITS[target.type]}, units)[(oid, bead)])
        return result

    @property
    def meta(self) -> Dict[str, Any]:
        return self.data.setdefault("meta", {})

    @property
    def title(self) -> str:
        # Read without `self.meta`, which creates the block: a read is not an edit,
        # and an inserted `"meta": {}` would change the bytes the plan saves as.
        meta = self.data.get("meta")
        return (meta.get("title") if isinstance(meta, dict) else None) or "Untitled fire test"

    @property
    def environment(self) -> Dict[str, Any]:
        return self.data.setdefault("environment", {})

    @property
    def ambient_temperature_c(self) -> float:
        env = self.data.get("environment")
        t = env.get("ambientTemperature_C") if isinstance(env, dict) else None
        return 20.0 if t is None else float(t)

    @property
    def display_length_unit(self) -> str:
        return (self.data.get("units", {}).get("display") or {}).get("length", "m")

    def add(self, raw: Dict[str, Any]) -> PlanObject:
        self.data.setdefault("objects", []).append(raw)
        return wrap(raw)

    @property
    def objects(self) -> List[PlanObject]:
        return [wrap(o) for o in self.data.get("objects", [])]

    def __iter__(self) -> Iterator[PlanObject]:
        return iter(self.objects)

    def _of_type(self, kind: str) -> List[PlanObject]:
        return [wrap(o) for o in self.data.get("objects", []) if o.get("type") == kind]

    @property
    def cameras(self) -> Dict[str, Camera]:
        """Keyed by id, in file order (dicts preserve insertion order)."""
        return {c.id: c for c in self._of_type("camera")}

    @property
    def burners(self) -> List[Burner]:
        return list(self._of_type("burner"))

    @property
    def hoods(self) -> List[Hood]:
        return list(self._of_type("hood"))

    @property
    def walls(self) -> List[Wall]:
        return list(self._of_type("wall"))

    @property
    def ceilings(self) -> List[Ceiling]:
        return list(self._of_type("ceiling"))

    @property
    def heat_flux_sensors(self) -> List[HeatFluxSensor]:
        return list(self._of_type("heatFluxSensor"))

    @property
    def thermocouples(self) -> List[Thermocouple]:
        return list(self._of_type("thermocouple"))

    @property
    def obstructions(self) -> List[Obstruction]:
        return list(self._of_type("obstruction"))

    @property
    def reconstructed_flames(self) -> List[ReconstructedFlame]:
        return list(self._of_type("reconstructedFlame"))

    def flame_sequence(self, flame: ReconstructedFlame):
        """Load the frames a reconstructed flame links, resolved like any linked
        file. Reads the folder; never launches anything."""
        from .flame import FlameSequence
        link = flame.sequence_link
        if link is None:
            raise PlanError("reconstructed flame {!r} links no voxel sequence".format(flame.id))
        return FlameSequence.load(self.linked_file_path(link))

    def add_reconstructed_flame(self, path: str, folder: Optional[str] = None, *,
                                object_id: Optional[str] = None, name: Optional[str] = None,
                                burner_id: Optional[str] = None, label: Optional[str] = None,
                                imported_at: Optional[str] = None) -> ReconstructedFlame:
        """Scan a folder of frames and add the flame object that links it.

        `path` is what the plan stores -- relative to the plan file when possible;
        `folder` is where to read the frames from now, defaulting to `path` resolved
        against this plan's location. The object is created locked, at the identity,
        the way the editor creates one: the frames are in the rig's frame, and the
        rig was set up from this plan.
        """
        from .flame import FlameSequence
        sequence = FlameSequence.load(folder if folder is not None else self.linked_file_path({"path": path}))
        raw = {
            "id": object_id or self._next_id("flame"),
            "type": "reconstructedFlame",
            "name": name or "Reconstructed flame",
            "transform": {"position_m": [0.0, 0.0, 0.0], "rotation_quat": [0.0, 0.0, 0.0, 1.0]},
            "burnerId": burner_id,
            "representation": "voxels",
            "linkedFiles": [{"id": "voxels", "kind": "voxelSequence", "path": path,
                             **({"label": label} if label else {}),
                             "sequence": sequence.manifest(imported_at)}],
            "display": {"visible": True, "locked": True},
        }
        return self.add(raw)

    def _next_id(self, prefix: str) -> str:
        taken = {o.get("id") for o in self.data.get("objects", [])}
        n = 1
        while "{}-{}".format(prefix, n) in taken:
            n += 1
        return "{}-{}".format(prefix, n)

    def flame_burner(self, flame: ReconstructedFlame) -> Optional[Burner]:
        """The burner a flame was reconstructed from: the one it names, else the
        primary. None only when the plan has no burner at all."""
        if flame.burner_id:
            for b in self.burners:
                if b.id == flame.burner_id:
                    return b
        try:
            return self.burner
        except PlanError:
            return None

    @property
    def burner(self) -> Burner:
        """The primary burner: the one at the origin, which by definition is the
        one the coordinate system was built around."""
        burners = self.burners
        if not burners:
            raise PlanError("plan has no burner")
        if len(burners) == 1:
            return burners[0]
        at_origin = [b for b in burners if float(np.linalg.norm(b.position[:2])) < 1e-6]
        return at_origin[0] if at_origin else burners[0]

    @property
    def fire_burners(self) -> List[Burner]:
        """Every burner with a fire to assess -- an HRR and a footprint -- primary first.

        A plan can hold several (CONVENTIONS section 1 calls the one at the origin
        the primary, and an FDS import keeps every face the burner surface burns
        on), and the editor draws a flame on each. The checks that ask "does this
        fire reach that surface", "what does this bead sit in" or "what does this
        gauge receive" have to ask it of every fire, or a second burner is drawn and
        then silently left out of the verdicts -- a type-T bead half a metre above a
        megawatt fire was being called "outside the plume" because the plume it was
        in belonged to the other burner. Mirror of `fireBurners` in
        web/src/core/plan.ts.
        """
        lit = []
        for b in self.burners:
            try:
                b.flame_tip_z_m()
            except ValueError:
                continue                      # no HRR, or nothing to burn on
            lit.append(b)
        if not lit:
            return lit
        try:
            primary = self.burner
        except PlanError:
            return lit
        first = [b for b in lit if b.raw is primary.raw]
        return first + [b for b in lit if b.raw is not primary.raw]

    @property
    def secondary_burners(self) -> List[Burner]:
        """Burners drawn with a fire that the camera framing does not judge."""
        if not self.burners:
            return []
        primary = self.burner
        return [b for b in self.fire_burners if b.raw is not primary.raw]

    def cameras_by_modality(self, modality: str) -> List[Camera]:
        return [c for c in self.cameras.values() if c.modality == modality]

    # -- validation ------------------------------------------------------

    @property
    def format_version(self) -> str:
        """The format version this file declares."""
        return str(self.data.get("version") or VERSION)

    @property
    def effective_version(self) -> str:
        """The version this plan will declare once written.

        The declared version is derived, not authored: the writer emits the lowest
        version that describes the contents, never lower than what the file already
        said. A plan built in memory therefore still says "1.0.0" the moment after
        a thermocouple is appended to it, and validating that against the 1.0 schema
        would report a violation that saving is about to fix. This is the version to
        judge it by; `check()` reports the disagreement separately, because a file
        on disk whose label understates its contents is worth knowing about.
        """
        return serialize.effective_version(self.data)

    def validate_schema(self, version: Optional[str] = None) -> None:
        """Raise if the document violates the JSON Schema.

        Judged against `effective_version` unless overridden. Pass an explicit
        version to assert compatibility with a particular one -- `validate_schema(
        "1.0.0")` is how you ask whether a plan would still open in a 1.0 tool.
        """
        import jsonschema

        wanted = version or self.effective_version
        filename = _SCHEMA_FILES.get(wanted)
        if filename is None:
            raise PlanError(
                "no schema for format version {!r}; this build knows {}".format(
                    wanted, ", ".join(sorted(_SCHEMA_FILES))
                )
            )
        schema = json.loads(_schema_text(filename))
        validator = jsonschema.Draft202012Validator(schema)
        errors = sorted(validator.iter_errors(self.data), key=lambda e: list(e.absolute_path))
        if errors:
            lines = [
                "  at {}: {}".format("/".join(str(p) for p in e.absolute_path) or "<root>", e.message)
                for e in errors[:10]
            ]
            if len(errors) > 10:
                lines.append("  ... and {} more".format(len(errors) - 10))
            raise PlanError("plan failed schema validation:\n" + "\n".join(lines))
        link_errors = list(linked_files.problems(self.data))
        if link_errors:
            raise PlanError("plan failed linked file validation:\n" + "\n".join(link_errors[:10]))
        data_errors = list(test_data.problems(self.data))
        if data_errors:
            raise PlanError("plan failed test data validation:\n" + "\n".join(data_errors[:10]))

    def check(self) -> List[Issue]:
        """Semantic checks beyond what the schema can express.

        Returns findings rather than raising: a plan mid-edit is legitimately
        incomplete, and the editor wants to show warnings, not refuse to open.
        """
        issues: List[Issue] = []
        raws = self.data.get("objects", [])

        # A file whose label understates its contents. Only a hand edit or a broken
        # writer produces one -- this writer derives the version -- but it matters:
        # the label is what a consumer checks before deciding it can read the file.
        declared, effective = self.format_version, self.effective_version
        if declared != effective:
            issues.append(Issue(
                "warning", "version-understated",
                "the file declares format {} but uses {} features; saving will correct it"
                .format(declared, effective)))

        seen = set()
        for raw in raws:
            oid = raw.get("id")
            if oid in seen:
                issues.append(Issue("error", "duplicate-id", "object id {!r} used more than once".format(oid), oid))
            seen.add(oid)

        for obj in self.objects:
            t = obj.raw.get("transform") or {}
            if "rotation_quat" in t:
                n = float(np.linalg.norm(obj.quaternion))
                if abs(n - 1.0) > 1e-6:
                    issues.append(
                        Issue("warning", "non-unit-quaternion",
                              "rotation_quat has length {:.6f}, expected 1".format(n), obj.id)
                    )
            # Any object whose orientation records what it is pointed at, which
            # since 1.1 is heat flux gauges as well as cameras -- a gauge whose
            # quaternion and target disagree is exactly as wrong, and for exactly
            # the same reason.
            target = obj.aim_target
            # `rotation_quat` has to be present, as the web requires: without one
            # `forward` is the identity orientation, and warning that a stored
            # quaternion disagrees with the target is a claim about a quaternion
            # that is not in the file.
            if (target is not None
                    and isinstance(obj, (Camera, HeatFluxSensor))
                    and "rotation_quat" in t):
                delta = target - obj.position
                if float(np.linalg.norm(delta)) < 1e-9:
                    issues.append(Issue("warning", "degenerate-aim",
                                        "aimTarget_m coincides with the object's own position",
                                        obj.id))
                else:
                    cos = float(np.clip(np.dot(normalize(delta), obj.forward), -1.0, 1.0))
                    off = math.degrees(math.acos(cos))
                    if off > 0.1:
                        issues.append(
                            Issue("warning", "aim-mismatch",
                                  "rotation_quat points {:.2f} deg away from aimTarget_m; "
                                  "the quaternion is authoritative".format(off), obj.id)
                        )

        for cam in self.cameras.values():
            if cam.intrinsics_source == "nominal":
                issues.append(
                    Issue("info", "nominal-intrinsics",
                          "intrinsics are a placeholder -- fine for framing, not for reconstruction",
                          cam.id)
                )

        burners = self.burners
        if not burners:
            issues.append(Issue("warning", "no-burner", "plan has no burner; flame geometry is undefined"))
        else:
            if not any(float(np.linalg.norm(b.position[:2])) < 1e-6 for b in burners):
                issues.append(
                    Issue("warning", "burner-off-origin",
                          "no burner sits at the origin, but the coordinate system is defined "
                          "as burner-centred; camera standoff will be misleading")
                )
            for b in burners:
                if b.hrr_kw is None:
                    issues.append(Issue("info", "no-hrr", "no hrr_kw, so flame and plume geometry cannot be drawn", b.id))
            # The hood, ceiling and instrument checks below take every fire into
            # account. Camera framing does not: it answers "does this lens see THE
            # fire", and the fire it means is the primary at the origin. Say so on
            # each other burner, so a framing report that reads 100 percent is not
            # taken to cover a fire it never looked at.
            for b in self.secondary_burners:
                issues.append(Issue(
                    "warning", "secondary-burner",
                    "{!r} is a second fire. The hood, ceiling and instrument verdicts "
                    "include it, but camera framing and \"aim at fire\" are judged "
                    "against the primary burner at the origin only".format(b.name), b.id))

        issues.extend(self.hood_checks())
        issues.extend(self.ceiling_checks())
        issues.extend(self.instrument_checks())
        issues.extend(self.camera_checks())
        issues.extend(self.flame_checks())
        issues.extend(test_data.checks(self.data))
        return issues

    def flame_checks(self) -> List[Issue]:
        """Placement checks for reconstructed flames, from the manifest alone.

        The voxels are in the reconstruction rig's frame and this format's frame is
        the burner's. When the rig was set up from this plan the two coincide; when
        they do not, the hull lands somewhere a flame cannot be -- under the floor,
        or metres from the pan -- and the object's transform is the correction. Both
        checks read the transformed bounds, so a corrected object passes. The third
        notices a CSV linked to the burner that was not produced by the same
        reconstruction run. Mirror of `flameChecks` in web/src/core/plan.ts.
        """
        issues: List[Issue] = []
        for flame in self.reconstructed_flames:
            manifest = flame.manifest
            if not manifest:
                continue
            corners = flame.bounds_corners()
            if flame.burner_id and not any(b.id == flame.burner_id for b in self.burners):
                issues.append(Issue(
                    "warning", "flame-burner-unknown",
                    "burnerId {!r} names no burner in this plan; the primary burner is used instead"
                    .format(flame.burner_id), flame.id))
            burner = self.flame_burner(flame)
            floor = float(burner.position[2]) if burner else 0.0
            lowest = float(corners[:, 2].min())
            if lowest < floor - float(manifest["grid"]["pitch_m"]):
                issues.append(Issue(
                    "warning", "flame-below-floor",
                    "the reconstructed hull reaches {:.2f} m below the floor. The reconstruction "
                    "frame is probably offset from the plan frame; correct the object's position"
                    .format(floor - lowest), flame.id))
            if burner is None:
                continue
            centre = corners[:, :2].mean(axis=0)
            offset = float(np.linalg.norm(centre - burner.position[:2]))
            allowed = max(burner.diameter_m, 0.25)
            if offset > allowed:
                issues.append(Issue(
                    "warning", "flame-off-burner",
                    "the reconstructed hull is centred {:.2f} m from {!r}. The reconstruction "
                    "frame is probably not the plan frame; correct the object's transform"
                    .format(offset, burner.name), flame.id))
            for link in burner.linked_files:
                plot = link.get("plot")
                if not plot:
                    continue
                mismatch = plot_sequence_mismatch(plot["samples"], manifest)
                if mismatch:
                    issues.append(Issue(
                        "info", "flame-csv-mismatch",
                        "{!r} on {!r} {}, so it is not this reconstruction's volumes.csv"
                        .format(link.get("label") or link["path"], burner.name, mismatch), flame.id))
        return issues

    # -- fire geometry ---------------------------------------------------

    def flame_tip_z_m(self) -> Optional[float]:
        """Absolute height of the mean flame tip, or None if HRR is unknown."""
        try:
            return self.burner.flame_tip_z_m()
        except (PlanError, ValueError):
            return None

    def hood_checks(self) -> List[Issue]:
        """Flame impingement and plume capture.

        Both are measurement-validity questions, not cosmetics: flame in the canopy
        is no longer a free plume, and a hood that spills plume under-reads HRR by
        oxygen consumption.

        Capture is a spatial question, not just a size one. The plume rises from the
        burner, so what has to fit inside the opening is a disk centred on the
        BURNER, offset from the opening centre by however far apart the two are. A
        hood that is merely large is not a hood that captures.
        """
        issues: List[Issue] = []
        hoods = self.hoods
        if not hoods:
            return issues
        # Every fire, not only the primary: a second burner beside the hood is a
        # plume the hood does not capture, and a fire the HRR measurement will miss.
        fires = self.fire_burners
        many = len(fires) > 1

        # A fire no hood covers is one finding, filed once, against the hood nearest
        # to covering it -- not one per (hood, fire) pair, which filed an error for
        # each hood standing over a different fire. Mirror of `hoodChecks`.
        for burner in fires:
            bp = burner.position
            offsets = [(hood, hood.opening_offset(bp[0], bp[1])) for hood in hoods]
            if any(off[2] <= 0.0 for _, off in offsets):
                continue
            nearest, off = offsets[0]
            for hood, candidate in offsets[1:]:
                if candidate[2] < off[2]:
                    nearest, off = hood, candidate
            several = len(hoods) > 1
            issues.append(
                Issue("error", "hood-offset",
                      "{} the burner{} -- the burner centre is {:.2f} m outside {}, so no hood "
                      "captures any of its plume".format(
                          "no hood opening covers" if several else "the hood opening does not cover",
                          _which_fire(burner, many), off[2],
                          "the nearest opening" if several else "the opening"), nearest.id)
            )

        for hood in hoods:
            intake = hood.intake_height_m
            for burner in fires:
                flame_tip = burner.flame_tip_z_m()
                surface = burner.fuel_surface_z_m
                bp = burner.position
                of = _which_fire(burner, many)
                off_u, off_v, overhang = hood.opening_offset(bp[0], bp[1])

                # Nothing else is meaningful about a hood that is not over the fire
                # (filed above, once per fire), nor about one whose intake is at or
                # below the fuel surface.
                if overhang > 0.0 or intake <= surface:
                    continue

                # Clearance on the flame's own height, from the fuel surface.
                if flame_tip >= intake:
                    issues.append(
                        Issue("error", "flame-impingement",
                              "mean flame tip{} reaches {:.2f} m, at or above the hood intake at "
                              "{:.2f} m -- flame in the canopy, not a free plume"
                              .format(of, flame_tip, intake), hood.id)
                    )
                elif flame_tip - surface > 0.8 * (intake - surface):
                    issues.append(
                        Issue("warning", "flame-clearance",
                              "mean flame tip{} at {:.2f} m leaves only {:.2f} m below the hood "
                              "intake; an intermittent tip will reach higher"
                              .format(of, flame_tip, intake - flame_tip), hood.id)
                    )

                radius = burner.plume_radius_m(intake)
                plume_d = 2.0 * radius
                # Span the plume demands along each opening axis, and the axis with
                # the least slack -- which is the one that spills first.
                axes = [
                    (2.0 * (abs(off_u) + radius), hood.opening_m[0]),
                    (2.0 * (abs(off_v) + radius), hood.opening_m[1]),
                ]
                need, avail = min(axes, key=lambda a: a[1] - a[0])
                eccentricity = math.hypot(off_u, off_v)
                eccentric = (
                    ", {:.2f} m off the opening centre".format(eccentricity)
                    if eccentricity > 1e-9 else ""
                )

                if need > avail:
                    issues.append(
                        Issue("error", "plume-spillage",
                              "plume{} is {:.2f} m across at the hood intake{}, needing {:.2f} m "
                              "of a {:.2f} m opening -- the hood will spill and HRR by oxygen "
                              "consumption will read low"
                              .format(of, plume_d, eccentric, need, avail), hood.id)
                    )
                elif need > 0.8 * avail:
                    issues.append(
                        Issue("warning", "plume-margin",
                              "plume{} is {:.2f} m across at the hood intake{}, needing {:.2f} m "
                              "of a {:.2f} m opening -- little margin for draught or an "
                              "off-centre fire".format(of, plume_d, eccentric, need, avail),
                              hood.id)
                    )

        return issues

    def ceiling_checks(self) -> List[Issue]:
        """Flame reaching a ceiling slab above the fire.

        Distinct from the hood check and worth its own: a flame on a ceiling stops
        behaving as a free plume, spreads as a ceiling jet, and invalidates the
        correlations this tool draws everything else with. Only slabs whose
        footprint actually covers the burner count.
        """
        issues: List[Issue] = []
        ceilings = self.ceilings
        if not ceilings:
            return issues
        fires = self.fire_burners
        many = len(fires) > 1

        for ceiling in ceilings:
            soffit = ceiling.soffit_z_m
            for burner in fires:
                tip = burner.flame_tip_z_m()
                bx, by = float(burner.position[0]), float(burner.position[1])
                of = _which_fire(burner, many)
                if soffit <= burner.fuel_surface_z_m:
                    continue  # below the fire; not a ceiling for this burner
                if not ceiling.contains_xy(bx, by):
                    continue  # off to one side

                if tip >= soffit:
                    issues.append(
                        Issue("error", "ceiling-impingement",
                              "mean flame tip{} reaches {:.2f} m, at or above the ceiling soffit "
                              "at {:.2f} m -- the fire will spread as a ceiling jet and the "
                              "free-plume correlations no longer apply"
                              .format(of, tip, soffit), ceiling.id)
                    )
                elif tip - burner.fuel_surface_z_m > 0.8 * (soffit - burner.fuel_surface_z_m):
                    # From the fuel surface: how much of the gap above the fire the
                    # flame fills. Mirror of `ceilingChecks`.
                    issues.append(
                        Issue("warning", "ceiling-clearance",
                              "mean flame tip{} at {:.2f} m leaves only {:.2f} m below the "
                              "ceiling; an intermittent tip will reach higher"
                              .format(of, tip, soffit - tip), ceiling.id)
                    )
        return issues


    # -- instruments -----------------------------------------------------

    def fire_point_source(self) -> Optional[np.ndarray]:
        """Mid-flame point on the burner axis, or None when there is no fire.

        Where the point-source radiation model puts the emitter, and what a camera
        or a gauge means by "aim at the fire" -- one function rather than two
        conventions that could drift.
        """
        try:
            burner = self.burner
            if burner.hrr_kw is None:
                return None
            bp = burner.position
            return np.array([bp[0], bp[1], burner.point_source_z_m()])
        except (PlanError, ValueError):
            return None

    def heat_flux_estimate(self, sensor: HeatFluxSensor) -> Optional[Dict[str, Any]]:
        """What a gauge will read, by the point-source model.

        None when there is no fire to radiate -- no burner, or no HRR -- rather
        than zero, because "nothing to compute" and "computed zero" are different
        answers and only one of them is a placement problem. Mirror of
        `heatFluxEstimate` in web/src/core/plan.ts.
        """
        fires = self.fire_burners
        if not fires:
            return None

        at = sensor.position
        normal = sensor.normal
        rng = sensor.range_kw_m2

        # Every fire in the plan. Incident radiation from independent sources adds,
        # so the flux is a sum; a distance and an angle are to one point, and the
        # source that dominates the reading is the one they refer to.
        parts = []
        for burner in fires:
            bp = burner.position
            source = np.array([bp[0], bp[1], burner.point_source_z_m()])
            delta = source - at
            distance = float(np.linalg.norm(delta))
            samples = flame_centreline_samples(burner)
            visible_fraction = sum(first_occluder(self.objects, at, p) is None for p in samples) / len(samples)
            if distance < 1e-9:
                # Sitting in the fire. There is no direction to the source, so there
                # is no cosine either; say so rather than dividing by zero.
                return {
                    "sensor_id": sensor.id,
                    "distance_m": 0.0,
                    "off_axis_deg": 0.0,
                    "incident_kw_m2": float("inf"),
                    "faces_fire": True,
                    "within_view_angle": True,
                    "near_field": True,
                    "fraction_of_range": None if rng is None else float("inf"),
                    "source_id": burner.id,
                    "visible_fraction": visible_fraction,
                }
            cos_theta = float(np.dot(normal, delta / distance))
            off_axis = math.degrees(math.acos(float(np.clip(cos_theta, -1.0, 1.0))))
            incident = correlations.point_source_flux_kw_m2(
                burner.hrr_kw, distance, cos_theta, burner.radiative_fraction
            )
            parts.append((burner, distance, cos_theta, off_axis, incident * visible_fraction,
                          visible_fraction, incident))

        # A view-limiting tube admits only the fires inside its acceptance cone, and
        # the sum is over those alone; with no fire inside it the figures describe
        # the strongest one outside. The primary is first, so a tie -- and the
        # one-burner case -- keeps it. Mirror of `heatFluxEstimate`.
        half_angle = sensor.view_angle_deg / 2.0
        admitted = [part for part in parts if part[3] <= half_angle]
        pool = admitted or parts
        dominant = pool[0]
        for part in pool[1:]:
            if part[4] > dominant[4]:
                dominant = part
        burner, distance, _, off_axis, _, _, _ = dominant
        incident = float(sum(part[4] for part in admitted))
        unshadowed = sum(part[6] for part in pool)
        if all(p[5] == pool[0][5] for p in pool):
            visible_fraction = pool[0][5]
        elif unshadowed > 0:
            visible_fraction = sum(p[4] for p in pool) / unshadowed
        else:
            visible_fraction = sum(p[5] for p in pool) / len(pool)

        return {
            "sensor_id": sensor.id,
            "distance_m": distance,
            "off_axis_deg": off_axis,
            "incident_kw_m2": incident,
            "visible_fraction": visible_fraction,
            "faces_fire": any(part[2] > 0.0 for part in parts),
            "within_view_angle": bool(admitted),
            "near_field": distance < correlations.POINT_SOURCE_MIN_DIAMETERS * burner.diameter_m,
            "fraction_of_range": None if rng is None else incident / rng,
            "source_id": burner.id,
        }

    def thermocouple_beads(self, rake: Thermocouple) -> List[Dict[str, Any]]:
        """Each bead in world coordinates, and what the fire is doing there.

        `region` is one of "flame", "plume" or "outside". `gas_temperature_c` is
        the PLUME CENTRELINE value and is given only above the mean flame tip and
        inside the envelope -- inside the flame the plume correlation is not merely
        imprecise, it is the wrong correlation, and off the axis it is an upper
        bound. Mirror of `thermocoupleBeads` in web/src/core/plan.ts.
        """
        ambient = self.ambient_temperature_c
        # `fire_burners` already leaves out a burner with no HRR, a non-positive
        # HRR or a zero-area footprint. Every one of them means "no flame geometry
        # to place a bead against", and none of them should cost the caller the
        # whole check list: `check()` is documented for a plan mid-edit.
        fires = self.fire_burners
        try:
            primary = self.burner
        except PlanError:
            primary = None

        def radial_to(burner: Burner, world) -> float:
            bp = burner.position
            return float(math.hypot(world[0] - bp[0], world[1] - bp[1]))

        out: List[Dict[str, Any]] = []
        for index, (offset, world) in enumerate(
            zip(rake.bead_offsets_m, rake.bead_positions)
        ):
            region = "outside"
            gas_c = None
            # Inside a plume envelope at or below that burner's mean tip: the
            # flame's own height band, judged against flame temperature for
            # survival. Mirror of `flameZone` in web/src/core/plan.ts.
            flame_zone = False
            radial = radial_to(primary, world) if primary is not None else float("nan")

            # Every fire in the plan, flame beating plume: a bead inside one burner's
            # flame is in the flame whatever another burner's plume says, and a bead
            # in two plumes reads the hotter centreline -- an upper bound either way,
            # which is what the figure is documented as.
            for burner in fires:
                tip = burner.flame_tip_z_m()
                surface = burner.fuel_surface_z_m
                r = radial_to(burner, world)
                flame_r = burner.flame_radius_m(float(world[2]))
                # Both bounds are load-bearing. `flame_radius_m` reports 0.0 outside
                # the cone's own height band, so without the lower bound a bead
                # exactly on the burner axis -- the default placement of a rake with
                # no transform -- satisfies `r <= 0` at any depth below the pan and
                # is called "flame".
                if flame_r is not None and surface <= world[2] <= tip and r <= flame_r:
                    region, gas_c, radial = "flame", None, r
                    flame_zone = False
                    break
                if world[2] > surface and r <= burner.plume_radius_m(float(world[2])):
                    if world[2] <= tip:
                        flame_zone = True
                    here = None
                    if world[2] > tip:
                        rise = correlations.plume_centreline_rise_k(
                            float(world[2]) - surface,
                            burner.hrr_kw,
                            burner.diameter_m,
                            burner.radiative_fraction,
                        )
                        if rise is not None:
                            here = ambient + rise
                    if region != "plume" or (here is not None and (gas_c is None or here > gas_c)):
                        region, gas_c, radial = "plume", here, r

            out.append({
                "index": index,
                "offset_m": float(offset),
                "world": np.asarray(world, dtype=float),
                "height_m": float(world[2]),
                "radial_m": radial,
                "region": region,
                "gas_temperature_c": gas_c,
                "flame_zone": flame_zone,
            })
        return out

    def instrument_checks(self) -> List[Issue]:
        """Instrument placement.

        The same kind of finding as the hood checks: not style, but whether the
        measurement will mean anything. A gauge pointed at a wall, one that pins at
        full scale, and a type-T bead sitting in the flame are all mistakes that
        cost a test day, and all three are visible in the plan before anyone
        travels. Mirror of `instrumentChecks` in web/src/core/plan.ts.
        """
        issues: List[Issue] = []

        for sensor in self.heat_flux_sensors:
            est = self.heat_flux_estimate(sensor)
            if est is None:
                continue

            # Standing on the point source itself. Everything below would report an
            # unbounded flux, and "inf kW/m2" in a printed report is not a finding.
            if not math.isfinite(est["incident_kw_m2"]):
                issues.append(Issue(
                    "error", "gauge-in-fire",
                    "the gauge sits on the fire's own point source, so the predicted flux "
                    "is unbounded; move it out of the flame", sensor.id))
                continue

            if est["visible_fraction"] == 0:
                issues.append(Issue(
                    "error", "gauge-no-line-of-sight",
                    "{} has no line of sight: nothing in the plan lets it see the flame, "
                    "so it will read only what reaches it indirectly.".format(sensor.name), sensor.id))
                # Facing, view cone, near field and range all judge radiation this gauge
                # cannot receive; "fit a more sensitive gauge" would be the wrong advice.
                continue
            elif est["visible_fraction"] < 1:
                share = est["visible_fraction"] * 100
                description = (
                    "{} has {:.0f}% line of sight, weighted by each fire's unshadowed flux; "
                    if len(self.fire_burners) > 1 else "{} sees {:.0f}% of the flame centreline; "
                ).format(sensor.name, share)
                issues.append(Issue(
                    "warning", "gauge-partly-shadowed",
                    description + "the predicted flux has been scaled by this visible share.", sensor.id))

            if not est["faces_fire"]:
                issues.append(Issue(
                    "error", "gauge-facing-away",
                    "the gauge normal is {:.0f} deg off the line to the fire, so the sensing "
                    "face is turned away from it and will see only background radiation"
                    .format(est["off_axis_deg"]), sensor.id))
                continue

            if not est["within_view_angle"]:
                issues.append(Issue(
                    "warning", "gauge-view-restricted",
                    "the fire is {:.0f} deg off the gauge axis but the view-limiting tube only "
                    "accepts +/-{:.0f} deg -- the flame is outside the acceptance cone"
                    .format(est["off_axis_deg"], sensor.view_angle_deg / 2.0), sensor.id))

            if est["near_field"]:
                source = next(b for b in self.burners if b.id == est["source_id"])
                issues.append(Issue(
                    "warning", "gauge-near-field",
                    "the gauge is {:.2f} m from a fire of effective diameter {:.2f} m; closer "
                    "than {:.0f} diameters the fire is plainly not a point source, so the "
                    "predicted flux is an order of magnitude, not a value to size a gauge on"
                    .format(est["distance_m"], source.diameter_m,
                            correlations.POINT_SOURCE_MIN_DIAMETERS), sensor.id))

            fraction = est["fraction_of_range"]
            if fraction is not None:
                rng = sensor.range_kw_m2
                if fraction > 1.0:
                    issues.append(Issue(
                        "error", "gauge-over-range",
                        "predicted incident flux is {:.1f} kW/m2 against a {:g} kW/m2 gauge -- "
                        "it will pin at full scale and the reading is lost"
                        .format(est["incident_kw_m2"], rng), sensor.id))
                elif fraction < _LOW_SIGNAL_FRACTION:
                    issues.append(Issue(
                        "warning", "gauge-low-signal",
                        "predicted incident flux is {:.2f} kW/m2, only {:.1f}% of the {:g} kW/m2 "
                        "range -- move it in, or fit a more sensitive gauge"
                        .format(est["incident_kw_m2"], fraction * 100.0, rng), sensor.id))

        for rake in self.thermocouples:
            beads = self.thermocouple_beads(rake)
            limit = rake.max_temperature_c
            tc_type = rake.tc_type

            in_flame = [b for b in beads if b["region"] == "flame" or b["flame_zone"]]
            if in_flame:
                which = ("every bead" if len(in_flame) == len(beads)
                         else "{} of {} beads".format(len(in_flame), len(beads)))
                sits = "sits" if len(in_flame) in (1, len(beads)) else "sit"
                if limit < FLAME_TEMPERATURE_C:
                    issues.append(Issue(
                        "error", "tc-over-temperature",
                        "{} {} in the flame or below its mean tip, where gas is roughly {:.0f} C "
                        "-- past the {:.0f} C limit of a type {} thermocouple"
                        .format(which, sits, FLAME_TEMPERATURE_C, limit, tc_type), rake.id))
                else:
                    issues.append(Issue(
                        "warning", "tc-in-flame",
                        "{} {} in the flame or below its mean tip; expect intermittent flame "
                        "temperatures rather than a plume reading, and significant radiation "
                        "error on a bare bead".format(which, sits), rake.id))

            temps = [b["gas_temperature_c"] for b in beads if b["gas_temperature_c"] is not None]
            if temps and max(temps) > limit:
                issues.append(Issue(
                    "error", "tc-over-temperature",
                    "predicted plume centreline reaches {:.0f} C at the hottest bead, past the "
                    "{:.0f} C limit of a type {} thermocouple"
                    .format(max(temps), limit, tc_type), rake.id))

            if all(b["region"] == "outside" for b in beads) and self.fire_burners:
                issues.append(Issue(
                    "info", "tc-outside-plume",
                    "no bead falls inside the flame or the plume envelope of any fire, so "
                    "this rake will read close to ambient", rake.id))

        return issues

    # -- camera framing --------------------------------------------------

    def _camera_line_of_sight(self, camera, burner):
        points = flame_centreline_samples(burner)
        _, visible = camera.project(np.asarray(points))
        hits = [first_occluder(self.objects, camera.position, p)
                for p, in_frame in zip(points, visible) if in_frame]
        blockers = {o.id: o for o in hits if o is not None}
        return (sum(o is None for o in hits) / len(hits) if hits else None), list(blockers.values())

    def camera_checks(self) -> List[Issue]:
        try:
            burner = self.burner
        except PlanError:
            return []
        if not any(lit.raw is burner.raw for lit in self.fire_burners):
            return []
        issues = []
        for camera in self.cameras.values():
            fraction, blockers = self._camera_line_of_sight(camera, burner)
            if fraction is not None and fraction < 1:
                issues.append(Issue(
                    "warning", "camera-view-blocked",
                    "{} frames the flame but {:.0f}% of the centreline it frames is hidden behind {}."
                    .format(camera.name, (1 - fraction) * 100, ' and '.join(o.name for o in blockers[:2])), camera.id))
        return issues

    def framing(self, camera: Camera, samples: int = 24) -> Dict[str, Any]:
        """Does this camera actually frame the fire?

        Samples the plume envelope from the fuel surface to the mean flame tip and
        reports what falls inside the image. This is the question a test plan exists
        to answer: whether the gear, at that standoff, will see what it must.
        """
        result: Dict[str, Any] = {
            "camera_id": camera.id,
            "standoff_m": camera.standoff_m,
            "standoff_horizontal_m": camera.standoff_horizontal_m,
            "ground_sample_distance_mm": camera.ground_sample_distance_m() * 1000.0,
            "hfov_deg": camera.hfov_deg,
            "vfov_deg": camera.vfov_deg,
            "unobstructed": None,
        }
        try:
            burner = self.burner
        except PlanError:
            # No burner: nothing to frame. The web engine answers null here; raising
            # took down a notebook looping over cameras (review 2026-09-22, PHY-12).
            result.update(flame_base_visible=None, flame_tip_visible=None,
                          plume_fraction_visible=None)
            return result
        base_z = burner.fuel_surface_z_m

        _, base_visible = camera.project(np.array([burner.position[0], burner.position[1], base_z]))
        result["flame_base_visible"] = bool(base_visible)

        # No flame to frame: no HRR, or a non-positive one, or a zero-area pan --
        # exactly the burners `fire_burners` leaves out and `check()` treats as unlit.
        if not any(lit.raw is burner.raw for lit in self.fire_burners):
            result["flame_tip_visible"] = None
            result["plume_fraction_visible"] = None
            return result

        tip_z = burner.flame_tip_z_m()
        _, tip_visible = camera.project(np.array([burner.position[0], burner.position[1], tip_z]))
        result["flame_tip_visible"] = bool(tip_visible)
        result["flame_height_m"] = tip_z - base_z

        # Ring of points around the drawn envelope at each sampled height -- the
        # flame cone near the pan, where it is wider than the plume cone, and the
        # plume above -- so a fire that overflows the frame sideways is caught as
        # well as one that overflows the top. The four samples are toward, away
        # from and either side of the camera, so the verdict does not depend on
        # which way the room happens to be drawn. Mirror of `framingOf`.
        bx, by = float(burner.position[0]), float(burner.position[1])
        cx, cy = float(camera.position[0]), float(camera.position[1])
        bearing = math.atan2(cy - by, cx - bx) if math.hypot(cx - bx, cy - by) > 1e-9 else 0.0
        pts = []
        for i in range(samples):
            z = base_z + (tip_z - base_z) * i / max(1, samples - 1)
            r = max(burner.plume_radius_m(z), burner.flame_radius_m(z) or 0.0)
            for k in range(4):
                ang = bearing + k * math.pi / 2
                pts.append([bx + r * math.cos(ang), by + r * math.sin(ang), z])
        _, vis = camera.project(np.asarray(pts))
        result["plume_fraction_visible"] = float(np.mean(vis))
        result["unobstructed"] = self._camera_line_of_sight(camera, burner)[0]
        return result

    # -- export ----------------------------------------------------------

    def camera_poses(self, convention: str = "opencv", world_to_camera: bool = False) -> Dict[str, np.ndarray]:
        """All camera poses as 4x4 matrices, keyed by id."""
        return {
            cid: cam.extrinsics(convention, world_to_camera=world_to_camera)
            for cid, cam in self.cameras.items()
        }

    def to_fds_devices(self) -> str:
        """Write instruments in the source FDS frame (or the plan frame)."""
        from .fds_export import devices_to_fds
        return devices_to_fds(self)

    def to_nerfstudio(self, path=None) -> Dict[str, Any]:
        """Emit a nerfstudio `transforms.json` skeleton.

        Poses are exact; `file_path` is a placeholder holding the camera id, because
        format 1.x reserves `recording` without defining it, so a plan does not yet
        know which footage each camera produced. Fill those in once that lands --
        the poses do not change.
        """
        frames = []
        for cid, cam in self.cameras.items():
            w, h = cam.resolution
            cx, cy = cam.principal_point
            frame: Dict[str, Any] = {
                "file_path": cid,
                "w": w,
                "h": h,
                "fl_x": cam.fx,
                "fl_y": cam.fy,
                # nerfstudio measures pixels from the image corner -- a pixel's
                # centre is at index + 0.5, as in COLMAP -- where this format uses the
                # OpenCV convention of centres at integers (CONVENTIONS section 4).
                # Without the shift every exported ray was half a pixel off.
                "cx": cx + 0.5,
                "cy": cy + 0.5,
                # nerfstudio expects OpenGL-convention camera-to-world, which is
                # exactly what the file stores -- no flip.
                "transform_matrix": cam.extrinsics("opengl").tolist(),
            }
            d = cam.distortion
            if d is not None:
                for key, value in zip(["k1", "k2", "p1", "p2", "k3"], d):
                    frame[key] = float(value)
            frames.append(frame)

        out = {"camera_model": "OPENCV", "frames": frames}
        if path is not None:
            with open(path, "w", encoding="utf-8", newline="\n") as fh:
                json.dump(out, fh, indent=2)
                fh.write("\n")
        return out

    def equipment_table(self) -> List[Dict[str, Any]]:
        """Flat rows for the equipment list in the exported drawing -- one per object,
        in the order and with the meanings of the editor's report
        (web/src/export/report.ts):

        - ``standoff_m`` is the plan distance from the origin (the burner centre);
          for a reconstructed flame, of its envelope's centre from its burner. None
          for walls, ceilings and boxes, which have no single position to measure.
        - ``height_m`` is above the floor: an instrument's lens or sensing face, a
          rake's top bead, a burner's fuel surface, a hood's intake, a ceiling's
          soffit, and the top of a wall, box or flame envelope.
        """
        rows: List[Dict[str, Any]] = []

        def plan_distance(p: Any) -> float:
            return round(float(np.hypot(p[0], p[1])), 3)

        for cam in self.cameras.values():
            rows.append({
                "id": cam.id,
                "name": cam.name,
                "category": "camera",
                "detail": "{} {}x{}".format(cam.modality, *cam.resolution),
                "standoff_m": round(cam.standoff_horizontal_m, 3),
                "height_m": round(float(cam.position[2]), 3),
                "hfov_deg": round(cam.hfov_deg, 1),
                "intrinsics": cam.intrinsics_source,
            })
        for b in self.burners:
            # The fuel surface, not the burner's origin; the mean flame tip is named
            # in the detail. The editor printed the tip in this column and fireplan the
            # origin, both under "height" (review 2026-09-22, EXP-5/EXP-10).
            detail = "{} D_eff {:.3f} m".format(b.shape, b.diameter_m)
            q = b.hrr_kw
            if q is not None and q > 0:
                detail += ", {:g} kW".format(round(q, 2))
                if b.diameter_m > 0:
                    detail += ", mean flame tip {:.3f} m".format(b.flame_tip_z_m())
            rows.append({
                "id": b.id, "name": b.name, "category": "burner",
                "detail": detail,
                "standoff_m": plan_distance(b.position),
                "height_m": round(b.fuel_surface_z_m, 3),
                "hfov_deg": None, "intrinsics": None,
            })
        for hd in self.hoods:
            # World-space planes, as the checks judge them and the editor draws them.
            rows.append({
                "id": hd.id, "name": hd.name, "category": "hood",
                "detail": "{:.2f} x {:.2f} m at {:.2f} m".format(*hd.opening_m, hd.opening_z_m),
                "standoff_m": plan_distance(hd.position),
                "height_m": round(hd.intake_height_m, 3),
                "hfov_deg": None, "intrinsics": None,
            })
        for wl in self.walls:
            # The top of the wall above the floor, base height included.
            top = float(wl.position[2]) + wl.base_height_m + wl.height_m
            rows.append({
                "id": wl.id, "name": wl.name, "category": "wall",
                "detail": "{:.2f} m long, {:.2f} m high".format(wl.length_m, wl.height_m),
                "standoff_m": None, "height_m": round(top, 3),
                "hfov_deg": None, "intrinsics": None,
            })
        for cl in self.ceilings:
            rows.append({
                "id": cl.id, "name": cl.name, "category": "ceiling",
                "detail": "{:.1f} m2 slab, soffit at {:.2f} m".format(cl.area_m2, cl.soffit_z_m),
                "standoff_m": None, "height_m": round(cl.soffit_z_m, 3),
                "hfov_deg": None, "intrinsics": None,
            })
        for ob in self.obstructions:
            dx, dy, dz = (float(v) for v in ob.size_m)
            rows.append({
                "id": ob.id, "name": ob.name, "category": "obstruction",
                "detail": "{:.2f} x {:.2f} x {:.2f} m".format(dx, dy, dz),
                "standoff_m": None, "height_m": round(ob.top_z_m, 3),
                "hfov_deg": None, "intrinsics": None,
            })
        for hf in self.heat_flux_sensors:
            rng = hf.range_kw_m2
            rows.append({
                "id": hf.id, "name": hf.name, "category": "heat flux",
                "detail": "{}{}".format(
                    hf.kind, "" if rng is None else ", 0-{:g} kW/m2".format(rng)),
                "standoff_m": round(float(np.linalg.norm(hf.position[:2])), 3),
                "height_m": round(float(hf.position[2]), 3),
                "hfov_deg": round(hf.view_angle_deg, 1), "intrinsics": None,
            })
        for tc in self.thermocouples:
            heights = [float(p[2]) for p in tc.bead_positions]
            rows.append({
                "id": tc.id, "name": tc.name, "category": "thermocouple",
                "detail": "type {}, {} bead{}".format(
                    tc.tc_type, len(heights), "s" if len(heights) != 1 else ""),
                "standoff_m": round(float(np.linalg.norm(tc.position[:2])), 3),
                "height_m": round(max(heights), 3),
                "hfov_deg": None, "intrinsics": None,
            })
        for fl in self.reconstructed_flames:
            manifest = fl.manifest
            frames = (manifest or {}).get("frames") or []
            if manifest and frames:
                detail = "{} frames, {:g}-{:g} s, {:.1f} mm voxels".format(
                    len(frames), frames[0][0], frames[-1][0], manifest["grid"]["pitch_m"] * 1000.0)
            else:
                detail = "no voxel folder linked"
            corners = fl.bounds_corners()
            burner = self.flame_burner(fl)
            offset = None
            if burner is not None and len(corners):
                centre = corners.mean(axis=0)
                offset = plan_distance(centre[:2] - burner.position[:2])
            rows.append({
                "id": fl.id, "name": fl.name, "category": "reconstructed flame",
                "detail": detail,
                "standoff_m": offset,
                "height_m": round(float(corners[:, 2].max()), 3) if len(corners) else None,
                "hfov_deg": None, "intrinsics": None,
            })
        return rows

    def __repr__(self) -> str:
        return "<Plan {!r}: {} objects, {} cameras>".format(
            self.title, len(self.data.get("objects", [])), len(self.cameras)
        )
