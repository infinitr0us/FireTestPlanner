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
from ._math import normalize
from .objects import (
    Burner,
    Camera,
    Ceiling,
    HeatFluxSensor,
    Hood,
    Obstruction,
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
VERSION_LATEST = "1.2.0"

_SCHEMA_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "schema",
)

#: One schema per format version, so a 1.0 file is judged by the 1.0 rules. A 1.0
#: plan holding a camera with a zoomFactor really is invalid, and validating it
#: against the 1.1 schema would hide exactly the mislabelling worth catching.
_SCHEMA_FILES = {
    "1.0.0": "fire-test-plan-1.0.0.schema.json",
    "1.1.0": "fire-test-plan-1.1.0.schema.json",
    "1.2.0": "fire-test-plan-1.2.0.schema.json",
}

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


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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
        try:
            return cls(json.loads(text))
        except json.JSONDecodeError as exc:
            raise PlanError("invalid JSON: {}".format(exc)) from exc

    @classmethod
    def from_fds(cls, path, options=None) -> "Plan":
        """Build a plan from an FDS input file.

        The plan only. `fireplan.fds.load` returns the same plan wrapped in a full
        account of the conversion -- what was skipped, which heat-release surface was
        taken to be the burner, where the origin went -- and the editor's import
        preview is built on that. This is the one-liner for a notebook.

            >>> Plan.from_fds("fixtures/fds/IR401_0.fds")

        The import re-origins onto the burner centre at floor level, as this format
        requires, and records the shift in `meta.source.originOffset_m` so the source
        file's own coordinates stay recoverable.
        """
        from . import fds  # deferred: fds imports Plan

        return fds.load(path, options).plan

    @classmethod
    def load(cls, path) -> "Plan":
        with open(path, "r", encoding="utf-8") as fh:
            plan = cls.loads(fh.read())
        plan.source_path = str(path)
        return plan

    def dumps(self) -> str:
        return serialize.dumps(self.data)

    def save(self, path, update_modified: bool = True) -> None:
        if update_modified:
            self.data.setdefault("meta", {})["modified"] = _utc_now_iso()
        # The writer derives the declared version; adopt it in memory too, so a plan
        # that has just been written does not go on reporting `version-understated`
        # about a file where it is no longer true.
        self.data["version"] = self.effective_version
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(self.dumps())

    # -- access ----------------------------------------------------------

    @property
    def meta(self) -> Dict[str, Any]:
        return self.data.setdefault("meta", {})

    @property
    def title(self) -> str:
        return self.meta.get("title") or "Untitled fire test"

    @property
    def environment(self) -> Dict[str, Any]:
        return self.data.setdefault("environment", {})

    @property
    def ambient_temperature_c(self) -> float:
        t = self.environment.get("ambientTemperature_C")
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
        with open(os.path.join(_SCHEMA_DIR, filename), "r", encoding="utf-8") as fh:
            schema = json.load(fh)
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

        issues.extend(self.hood_checks())
        issues.extend(self.ceiling_checks())
        issues.extend(self.instrument_checks())
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
        try:
            burner = self.burner
            if burner.hrr_kw is None:
                return issues
        except PlanError:
            return issues

        flame_tip = burner.flame_tip_z_m()
        bp = burner.position

        for hood in hoods:
            intake = hood.intake_height_m
            off_u, off_v, overhang = hood.opening_offset(bp[0], bp[1])

            # Nothing else is meaningful about a hood that is not over the fire: the
            # flame cannot reach a canopy beside it, and the plume it fails to
            # capture is not a margin problem but a placement one.
            if overhang > 0.0:
                issues.append(
                    Issue("error", "hood-offset",
                          "the hood opening does not cover the burner -- the burner centre is "
                          "{:.2f} m outside the opening, so this hood captures none of the plume"
                          .format(overhang), hood.id)
                )
                continue

            if flame_tip >= intake:
                issues.append(
                    Issue("error", "flame-impingement",
                          "mean flame tip reaches {:.2f} m, at or above the hood intake at {:.2f} m -- "
                          "flame in the canopy, not a free plume".format(flame_tip, intake), hood.id)
                )
            elif flame_tip > 0.8 * intake:
                issues.append(
                    Issue("warning", "flame-clearance",
                          "mean flame tip at {:.2f} m leaves only {:.2f} m below the hood intake; "
                          "an intermittent tip will reach higher".format(flame_tip, intake - flame_tip), hood.id)
                )

            radius = burner.plume_radius_m(intake)
            plume_d = 2.0 * radius
            # Span the plume demands along each opening axis, and the axis with the
            # least slack -- which is the one that spills first.
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
                          "plume is {:.2f} m across at the hood intake{}, needing {:.2f} m of a "
                          "{:.2f} m opening -- the hood will spill and HRR by oxygen consumption "
                          "will read low".format(plume_d, eccentric, need, avail), hood.id)
                )
            elif need > 0.8 * avail:
                issues.append(
                    Issue("warning", "plume-margin",
                          "plume is {:.2f} m across at the hood intake{}, needing {:.2f} m of a "
                          "{:.2f} m opening -- little margin for draught or an off-centre fire"
                          .format(plume_d, eccentric, need, avail), hood.id)
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
        try:
            burner = self.burner
            if burner.hrr_kw is None:
                return issues
        except PlanError:
            return issues

        tip = burner.flame_tip_z_m()
        bx, by = float(burner.position[0]), float(burner.position[1])

        for ceiling in ceilings:
            if ceiling.height_m <= burner.fuel_surface_z_m:
                continue  # below the fire; not a ceiling for this burner
            if not ceiling.contains_xy(bx, by):
                continue  # off to one side

            if tip >= ceiling.height_m:
                issues.append(
                    Issue("error", "ceiling-impingement",
                          "mean flame tip reaches {:.2f} m, at or above the ceiling soffit at "
                          "{:.2f} m -- the fire will spread as a ceiling jet and the free-plume "
                          "correlations no longer apply".format(tip, ceiling.height_m), ceiling.id)
                )
            elif tip > 0.8 * ceiling.height_m:
                issues.append(
                    Issue("warning", "ceiling-clearance",
                          "mean flame tip at {:.2f} m leaves only {:.2f} m below the ceiling; "
                          "an intermittent tip will reach higher"
                          .format(tip, ceiling.height_m - tip), ceiling.id)
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
        source = self.fire_point_source()
        if source is None:
            return None
        burner = self.burner
        hrr = burner.hrr_kw

        at = sensor.position
        delta = source - at
        distance = float(np.linalg.norm(delta))
        rng = sensor.range_kw_m2

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
            }

        normal = sensor.normal
        cos_theta = float(np.dot(normal, delta / distance))
        off_axis = math.degrees(math.acos(float(np.clip(cos_theta, -1.0, 1.0))))
        incident = correlations.point_source_flux_kw_m2(
            hrr, distance, cos_theta, burner.radiative_fraction
        )

        return {
            "sensor_id": sensor.id,
            "distance_m": distance,
            "off_axis_deg": off_axis,
            "incident_kw_m2": incident,
            "faces_fire": cos_theta > 0.0,
            "within_view_angle": off_axis <= sensor.view_angle_deg / 2.0,
            "near_field": distance < correlations.POINT_SOURCE_MIN_DIAMETERS * burner.diameter_m,
            "fraction_of_range": None if rng is None else incident / rng,
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
        try:
            burner = self.burner
            tip = burner.flame_tip_z_m()
        except (PlanError, ValueError):
            # No burner, no HRR, a non-positive HRR, or a zero-area footprint. Every
            # one of them means "no flame geometry to place a bead against", and none
            # of them should cost the caller the whole check list: `check()` is
            # documented for a plan mid-edit, and `fire_point_source` has swallowed
            # exactly these for the gauge path since 1.1. Testing `hrr_kw is not
            # None` was not the same test -- an hrr_kw of 0 passed it and then raised
            # out of the correlation.
            burner = None
            tip = None
        has_fire = burner is not None and tip is not None

        out: List[Dict[str, Any]] = []
        for index, (offset, world) in enumerate(
            zip(rake.bead_offsets_m, rake.bead_positions)
        ):
            region = "outside"
            gas_c = None
            radial = float("nan")

            if has_fire:
                bp = burner.position
                radial = float(math.hypot(world[0] - bp[0], world[1] - bp[1]))
                surface = burner.fuel_surface_z_m
                flame_r = burner.flame_radius_m(float(world[2]))
                # Both bounds are load-bearing. `flame_radius_m` reports 0.0 outside
                # the cone's own height band, so without the lower bound a bead
                # exactly on the burner axis -- the default placement of a rake with
                # no transform -- satisfies `radial <= 0` at any depth below the pan
                # and is called "flame".
                if (flame_r is not None
                        and surface <= world[2] <= tip
                        and radial <= flame_r):
                    region = "flame"
                elif world[2] > surface and radial <= burner.plume_radius_m(float(world[2])):
                    region = "plume"
                    if world[2] > tip:
                        rise = correlations.plume_centreline_rise_k(
                            float(world[2]) - surface,
                            burner.hrr_kw,
                            burner.diameter_m,
                            burner.radiative_fraction,
                        )
                        if rise is not None:
                            gas_c = ambient + rise

            out.append({
                "index": index,
                "offset_m": float(offset),
                "world": np.asarray(world, dtype=float),
                "height_m": float(world[2]),
                "radial_m": radial,
                "region": region,
                "gas_temperature_c": gas_c,
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
                issues.append(Issue(
                    "warning", "gauge-near-field",
                    "the gauge is {:.2f} m from a fire of effective diameter {:.2f} m; closer "
                    "than {:.0f} diameters the fire is plainly not a point source, so the "
                    "predicted flux is an order of magnitude, not a value to size a gauge on"
                    .format(est["distance_m"], self.burner.diameter_m,
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

            in_flame = [b for b in beads if b["region"] == "flame"]
            if in_flame:
                which = ("every bead" if len(in_flame) == len(beads)
                         else "{} of {} beads".format(len(in_flame), len(beads)))
                if limit < FLAME_TEMPERATURE_C:
                    issues.append(Issue(
                        "error", "tc-over-temperature",
                        "{} sits inside the mean flame envelope, where gas is roughly {:.0f} C "
                        "-- past the {:.0f} C limit of a type {} thermocouple"
                        .format(which, FLAME_TEMPERATURE_C, limit, tc_type), rake.id))
                else:
                    issues.append(Issue(
                        "warning", "tc-in-flame",
                        "{} sits inside the mean flame envelope; expect intermittent flame "
                        "temperatures rather than a plume reading, and significant radiation "
                        "error on a bare bead".format(which), rake.id))

            temps = [b["gas_temperature_c"] for b in beads if b["gas_temperature_c"] is not None]
            if temps and max(temps) > limit:
                issues.append(Issue(
                    "error", "tc-over-temperature",
                    "predicted plume centreline reaches {:.0f} C at the hottest bead, past the "
                    "{:.0f} C limit of a type {} thermocouple"
                    .format(max(temps), limit, tc_type), rake.id))

            if (all(b["region"] == "outside" for b in beads)
                    and self.fire_point_source() is not None):
                issues.append(Issue(
                    "info", "tc-outside-plume",
                    "no bead falls inside the flame or the plume envelope, so this rake will "
                    "read close to ambient", rake.id))

        return issues

    # -- camera framing --------------------------------------------------

    def framing(self, camera: Camera, samples: int = 24) -> Dict[str, Any]:
        """Does this camera actually frame the fire?

        Samples the plume envelope from the fuel surface to the mean flame tip and
        reports what falls inside the image. This is the question a test plan exists
        to answer: whether the gear, at that standoff, will see what it must.
        """
        burner = self.burner
        base_z = burner.fuel_surface_z_m
        result: Dict[str, Any] = {
            "camera_id": camera.id,
            "standoff_m": camera.standoff_m,
            "standoff_horizontal_m": camera.standoff_horizontal_m,
            "ground_sample_distance_mm": camera.ground_sample_distance_m() * 1000.0,
            "hfov_deg": camera.hfov_deg,
            "vfov_deg": camera.vfov_deg,
        }

        _, base_visible = camera.project(np.array([burner.position[0], burner.position[1], base_z]))
        result["flame_base_visible"] = bool(base_visible)

        if burner.hrr_kw is None:
            result["flame_tip_visible"] = None
            result["plume_fraction_visible"] = None
            return result

        tip_z = burner.flame_tip_z_m()
        _, tip_visible = camera.project(np.array([burner.position[0], burner.position[1], tip_z]))
        result["flame_tip_visible"] = bool(tip_visible)
        result["flame_height_m"] = tip_z - base_z

        # Ring of points around the plume at each sampled height, so a plume that
        # overflows the frame sideways is caught as well as one that overflows the top.
        pts = []
        for i in range(samples):
            z = base_z + (tip_z - base_z) * i / max(1, samples - 1)
            r = burner.plume_radius_m(z)
            for ang in (0.0, math.pi / 2, math.pi, 3 * math.pi / 2):
                pts.append([burner.position[0] + r * math.cos(ang),
                            burner.position[1] + r * math.sin(ang), z])
        _, vis = camera.project(np.asarray(pts))
        result["plume_fraction_visible"] = float(np.mean(vis))
        return result

    # -- export ----------------------------------------------------------

    def camera_poses(self, convention: str = "opencv", world_to_camera: bool = False) -> Dict[str, np.ndarray]:
        """All camera poses as 4x4 matrices, keyed by id."""
        return {
            cid: cam.extrinsics(convention, world_to_camera=world_to_camera)
            for cid, cam in self.cameras.items()
        }

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
                "cx": cx,
                "cy": cy,
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
        """Flat rows for the equipment list in the exported drawing."""
        rows: List[Dict[str, Any]] = []
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
            rows.append({
                "id": b.id, "name": b.name, "category": "burner",
                "detail": "{} D_eff {:.3f} m".format(b.shape, b.diameter_m),
                "standoff_m": round(float(np.linalg.norm(b.position)), 3),
                "height_m": round(float(b.position[2]), 3),
                "hfov_deg": None, "intrinsics": None,
            })
        for hd in self.hoods:
            rows.append({
                "id": hd.id, "name": hd.name, "category": "hood",
                "detail": "{:.2f} x {:.2f} m at {:.2f} m".format(*hd.opening_m, hd.height_m),
                "standoff_m": round(float(np.linalg.norm(hd.position)), 3),
                "height_m": round(hd.height_m, 3),
                "hfov_deg": None, "intrinsics": None,
            })
        for wl in self.walls:
            rows.append({
                "id": wl.id, "name": wl.name, "category": "wall",
                "detail": "{:.2f} m long, {:.2f} m high".format(wl.length_m, wl.height_m),
                "standoff_m": None, "height_m": round(wl.height_m, 3),
                "hfov_deg": None, "intrinsics": None,
            })
        for cl in self.ceilings:
            rows.append({
                "id": cl.id, "name": cl.name, "category": "ceiling",
                "detail": "{:.1f} m2 slab, soffit at {:.2f} m".format(cl.area_m2, cl.height_m),
                "standoff_m": None, "height_m": round(cl.height_m, 3),
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
        return rows

    def __repr__(self) -> str:
        return "<Plan {!r}: {} objects, {} cameras>".format(
            self.title, len(self.data.get("objects", [])), len(self.cameras)
        )
