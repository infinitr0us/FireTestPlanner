"""The Plan container: load, validate, query, export."""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterator, List, Optional

import numpy as np

from . import serialize
from ._math import normalize
from .objects import Burner, Camera, Ceiling, Hood, PlanObject, Wall, wrap

FORMAT = "fire-test-plan"
VERSION = "1.0.0"

_SCHEMA_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "schema",
    "fire-test-plan-1.0.0.schema.json",
)


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

    def validate_schema(self) -> None:
        """Raise if the document violates the JSON Schema."""
        import jsonschema

        with open(_SCHEMA_PATH, "r", encoding="utf-8") as fh:
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
            target = obj.aim_target
            if target is not None and isinstance(obj, Camera):
                delta = target - obj.position
                if float(np.linalg.norm(delta)) < 1e-9:
                    issues.append(Issue("warning", "degenerate-aim",
                                        "aimTarget_m coincides with the camera position", obj.id))
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

        for hood in hoods:
            intake = hood.intake_height_m

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

            plume_d = 2.0 * burner.plume_radius_m(intake)
            opening = min(hood.opening_m)
            if plume_d > opening:
                issues.append(
                    Issue("error", "plume-spillage",
                          "plume is {:.2f} m across at the hood intake but the opening is only {:.2f} m -- "
                          "the hood will spill and HRR by oxygen consumption will read low"
                          .format(plume_d, opening), hood.id)
                )
            elif plume_d > 0.8 * opening:
                issues.append(
                    Issue("warning", "plume-margin",
                          "plume is {:.2f} m across at a {:.2f} m opening, leaving little margin for "
                          "draught or an off-centre fire".format(plume_d, opening), hood.id)
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
        format 1.0 reserves `recording` without defining it, so a plan does not yet
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
        return rows

    def __repr__(self) -> str:
        return "<Plan {!r}: {} objects, {} cameras>".format(
            self.title, len(self.data.get("objects", [])), len(self.cameras)
        )
