"""Typed views over the raw plan dictionaries.

Every wrapper holds a reference to the dict it came from rather than copying, so
mutations round-trip on save and unknown keys are never dropped.
"""

from __future__ import annotations

import math
from copy import deepcopy
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np

from . import correlations
from ._math import look_at_quat, quat_to_matrix

IDENTITY_QUAT = [0.0, 0.0, 0.0, 1.0]

# Axis flips from the stored OpenGL-style frame into each consumer's frame.
# CONVENTIONS.md section 3.
_FRAME_FLIPS = {
    "opengl": np.diag([1.0, 1.0, 1.0]),
    "gl": np.diag([1.0, 1.0, 1.0]),
    "three": np.diag([1.0, 1.0, 1.0]),
    "nerfstudio": np.diag([1.0, 1.0, 1.0]),
    "opencv": np.diag([1.0, -1.0, -1.0]),
    "cv": np.diag([1.0, -1.0, -1.0]),
    "colmap": np.diag([1.0, -1.0, -1.0]),
}

# The one colour literal the schema allows. Mirror of HEX_COLOR in web/src/core/plan.ts.
_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")

MODALITY_COLORS = {
    "RGB": "#3b82f6",
    "LWIR": "#f97316",
    "MWIR": "#a855f7",
    "SWIR": "#14b8a6",
    "NIR": "#eab308",
    "other": "#94a3b8",
}

# Fallback colours for object types with no modality to key off. Mirror of
# TYPE_COLORS in web/src/core/plan.ts.
TYPE_COLORS = {
    "heatFluxSensor": "#ef4444",
    "thermocouple": "#10b981",
}

# Standard continuous-use upper limits, ASTM/ANSI, largest wire gauge. These are
# what makes an over-temperature placement checkable from the letter type alone.
TC_MAX_TEMPERATURE_C = {
    "K": 1260.0, "J": 760.0, "T": 370.0, "E": 870.0,
    "N": 1260.0, "R": 1480.0, "S": 1480.0, "B": 1700.0,
}


class PlanObject:
    """Base view. Subclasses add domain accessors; all share id/name/transform."""

    def __init__(self, raw: Dict[str, Any]):
        self.raw = raw

    @property
    def id(self) -> str:
        return self.raw["id"]

    @property
    def type(self) -> str:
        return self.raw["type"]

    @property
    def name(self) -> str:
        return self.raw.get("name") or self.raw["id"]

    @property
    def notes(self) -> Optional[str]:
        return self.raw.get("notes")

    @property
    def linked_files(self) -> Tuple[Dict[str, Any], ...]:
        """Read-only collection of live link records; use add_linked_file to append.

        Reading an unlinked object does not change its format version.
        """
        return tuple(self.raw.get("linkedFiles", []))

    def add_linked_file(self, link: Dict[str, Any]) -> Dict[str, Any]:
        """Append a copied recording reference; validate the plan before saving."""
        from .linked_files import LINK_TYPES
        if self.type not in LINK_TYPES:
            raise ValueError('This object type does not support linked files.')
        record = deepcopy(link)
        self.raw.setdefault("linkedFiles", []).append(record)
        return record

    @property
    def _transform(self) -> Dict[str, Any]:
        """The transform block to WRITE into, created when absent. Setters only."""
        return self.raw.setdefault("transform", {"position_m": [0.0, 0.0, 0.0]})

    @property
    def _transform_view(self) -> Dict[str, Any]:
        """The transform block to READ, or an empty one -- never inserted.

        `transform` is optional in every schema, and reading a position is not an
        edit: creating the block on read made `check()` rewrite objects it merely
        inspected, unknown types included, so a plan that had only been checked
        saved with bytes the web writer would not have written.
        """
        t = self.raw.get("transform")
        return t if isinstance(t, dict) else {}

    @property
    def position(self) -> np.ndarray:
        return np.asarray(self._transform_view.get("position_m", [0.0, 0.0, 0.0]), dtype=float)

    @position.setter
    def position(self, value: Iterable[float]) -> None:
        self._transform["position_m"] = [float(v) for v in value]

    @property
    def quaternion(self) -> np.ndarray:
        return np.asarray(self._transform_view.get("rotation_quat", IDENTITY_QUAT), dtype=float)

    @property
    def rotation_matrix(self) -> np.ndarray:
        """Object-to-world rotation, in the stored (OpenGL-style) local frame.

        A zero-length quaternion is schema-legal -- the schema says "unit" in prose,
        and prose is not a constraint -- but `quat_to_matrix` throws on one, which
        would cost the caller every check in the plan over a single degenerate
        object. `quaternion` still returns the raw value, so `Plan.check()` reports
        it as `non-unit-quaternion`; here it falls back to the identity. Mirror of
        `quatOf` in web/src/core/plan.ts.
        """
        q = self.quaternion
        if not np.all(np.isfinite(q)) or float(np.linalg.norm(q)) == 0.0:
            return np.eye(3)
        return quat_to_matrix(q)

    @property
    def aim_target(self) -> Optional[np.ndarray]:
        t = self._transform_view.get("aimTarget_m")
        return None if t is None else np.asarray(t, dtype=float)

    def aim_at(self, target: Iterable[float]) -> None:
        """Re-orient to look at `target`, keeping quaternion and aimTarget in step."""
        target = [float(v) for v in target]
        q = look_at_quat(self.position, np.asarray(target))
        self._transform["rotation_quat"] = [float(v) for v in q]
        self._transform["aimTarget_m"] = target

    def to_world(self, local) -> np.ndarray:
        """A point in this object's local frame, in world coordinates.

        `rotation_quat` is part of every object's transform and the 3D editor draws
        it, so checks and drawings have to apply it too -- otherwise a rotated wall
        is in one place on screen and another in the printed plan. Vertex lists
        (`polyline_m`, `polygon_m`, hood openings) are all local, so they all come
        through here. Mirror of `toWorld` in web/src/core/plan.ts.
        """
        return self.position + self.rotation_matrix @ np.asarray(local, dtype=float)

    def to_local(self, world) -> np.ndarray:
        """A world point in this object's local frame -- the inverse of `to_world`."""
        return self.rotation_matrix.T @ (np.asarray(world, dtype=float) - self.position)

    def footprint_xy(self, xy) -> np.ndarray:
        """A local footprint vertex `[x, y]` as a world `[x, y]`, dropping height."""
        return self.to_world([float(xy[0]), float(xy[1]), 0.0])[:2]

    @property
    def forward(self) -> np.ndarray:
        """World-space direction this object faces: down its local -Z.

        On the base class because since format 1.1 it is not only cameras that
        point at things -- a heat flux gauge's normal is read exactly this way,
        and it is the term that makes its reading mean something.
        """
        return -self.rotation_matrix[:, 2]

    @property
    def color(self) -> str:
        """This object's display colour, normalised to `#rrggbb`.

        A plan is someone else's file, and this value is exactly the kind of thing
        that ends up interpolated into markup -- `equipment_table()` output pasted
        into a report, a notebook rendering a swatch. Anything that is not the one
        literal the schema allows falls back to a type colour rather than being
        handed on. Mirror of `objectColor` in web/src/core/plan.ts, which guards
        the editor's own SVG and HTML sinks.
        """
        raw = (self.raw.get("display") or {}).get("color")
        if isinstance(raw, str) and _HEX_COLOR.match(raw):
            return raw
        return TYPE_COLORS.get(self.type, MODALITY_COLORS["other"])

    def __repr__(self) -> str:
        return "<{} {!r}>".format(type(self).__name__, self.id)


class Camera(PlanObject):
    @property
    def spec(self) -> Dict[str, Any]:
        return self.raw["camera"]

    @property
    def modality(self) -> str:
        return self.spec["modality"]

    @property
    def preset_id(self) -> Optional[str]:
        return self.spec.get("presetId")

    @property
    def resolution(self) -> Tuple[int, int]:
        w, h = self.spec["resolution_px"]
        return int(w), int(h)

    @property
    def sensor_mm(self) -> Tuple[float, float]:
        w, h = self.spec["sensor_mm"]
        return float(w), float(h)

    @property
    def focal_length_mm(self) -> float:
        """The lens. Never scaled by the zoom setting -- a 25 mm lens stays 25 mm."""
        return float(self.spec["focalLength_mm"])

    @property
    def zoom_factor(self) -> float:
        """Zoom setting, as a multiplier on the effective focal length.

        Absent, null or non-positive all mean 1. A plan is someone else's file, and
        a zero here would take every derived quantity to infinity. Format 1.1.
        """
        z = self.spec.get("zoomFactor")
        try:
            z = float(z)
        except (TypeError, ValueError):
            return 1.0
        return z if z > 0.0 and z == z and z != float("inf") else 1.0

    @property
    def effective_focal_length_mm(self) -> float:
        """Lens times zoom -- the focal length the image is actually formed at.

        Every derived quantity goes through here, so a zoomed camera is zoomed
        everywhere or nowhere.
        """
        return self.focal_length_mm * self.zoom_factor

    @property
    def intrinsics_source(self) -> str:
        return self.spec.get("intrinsicsSource", "nominal")

    @property
    def is_reconstruction_ready(self) -> bool:
        """True only for genuinely calibrated intrinsics.

        Nominal and datasheet values are fine for checking framing but will bias a
        reconstruction, so this is deliberately strict.
        """
        return self.intrinsics_source == "calibrated"

    @property
    def spectral_band_um(self) -> Optional[Tuple[float, float]]:
        b = self.spec.get("spectralBand_um")
        return None if b is None else (float(b[0]), float(b[1]))

    @property
    def framerate_hz(self) -> Optional[float]:
        f = self.spec.get("framerate_hz")
        return None if f is None else float(f)

    @property
    def recording(self) -> None:
        """Reserved for the post-test record. Always None throughout format 1.x."""
        return self.raw.get("recording")

    # -- intrinsics ------------------------------------------------------

    @property
    def fx(self) -> float:
        return self.effective_focal_length_mm * self.resolution[0] / self.sensor_mm[0]

    @property
    def fy(self) -> float:
        return self.effective_focal_length_mm * self.resolution[1] / self.sensor_mm[1]

    @property
    def principal_point(self) -> Tuple[float, float]:
        """OpenCV convention: pixel centres at integer coordinates."""
        pp = self.spec.get("principalPoint_px")
        if pp is not None:
            return float(pp[0]), float(pp[1])
        w, h = self.resolution
        return (w - 1) / 2.0, (h - 1) / 2.0

    @property
    def K(self) -> np.ndarray:
        cx, cy = self.principal_point
        return np.array(
            [[self.fx, 0.0, cx], [0.0, self.fy, cy], [0.0, 0.0, 1.0]], dtype=float
        )

    @property
    def distortion(self) -> Optional[np.ndarray]:
        d = self.spec.get("distortion")
        if d is None:
            return None
        return np.asarray(d["coefficients"], dtype=float)

    @property
    def hfov_rad(self) -> float:
        return 2.0 * math.atan(self.sensor_mm[0] / (2.0 * self.effective_focal_length_mm))

    @property
    def vfov_rad(self) -> float:
        return 2.0 * math.atan(self.sensor_mm[1] / (2.0 * self.effective_focal_length_mm))

    @property
    def hfov_deg(self) -> float:
        return math.degrees(self.hfov_rad)

    @property
    def vfov_deg(self) -> float:
        return math.degrees(self.vfov_rad)

    # -- extrinsics ------------------------------------------------------

    @property
    def up(self) -> np.ndarray:
        return self.rotation_matrix[:, 1]

    @property
    def right(self) -> np.ndarray:
        return self.rotation_matrix[:, 0]

    @property
    def standoff_m(self) -> float:
        """Slant distance to the burner centre. Trivial only because the origin
        IS the burner. This is the distance that governs resolution at the fire."""
        return float(np.linalg.norm(self.position))

    @property
    def standoff_horizontal_m(self) -> float:
        """Plan-view distance to the burner -- the number that gets dimensioned on
        a drawing, and the one a sketch's '9 ft' almost always means."""
        return float(np.linalg.norm(self.position[:2]))

    def rotation(self, convention: str = "opencv") -> np.ndarray:
        try:
            flip = _FRAME_FLIPS[convention.lower()]
        except KeyError:
            raise ValueError(
                "unknown convention {!r}; expected one of {}".format(
                    convention, sorted(set(_FRAME_FLIPS))
                )
            )
        return self.rotation_matrix @ flip

    def extrinsics(
        self, convention: str = "opencv", world_to_camera: bool = False
    ) -> np.ndarray:
        """4x4 pose. Camera-to-world by default; OpenCV frame by default."""
        r = self.rotation(convention)
        t = self.position
        m = np.eye(4)
        if world_to_camera:
            m[:3, :3] = r.T
            m[:3, 3] = -r.T @ t
        else:
            m[:3, :3] = r
            m[:3, 3] = t
        return m

    # -- projection ------------------------------------------------------

    def project(self, points_world) -> Tuple[np.ndarray, np.ndarray]:
        """Project world points to pixels.

        Returns (uv, visible). Ideal pinhole -- distortion coefficients are carried
        in the file but not applied here, since a plan's job is framing, not
        undistortion. Points behind the camera get NaN rather than a mirrored
        false positive.
        """
        pts = np.atleast_2d(np.asarray(points_world, dtype=float))
        r = self.rotation("opencv")
        cam = (pts - self.position) @ r  # equivalent to (R^T @ (X - t)) per row
        z = cam[:, 2]
        cx, cy = self.principal_point
        w, h = self.resolution

        with np.errstate(divide="ignore", invalid="ignore"):
            u = self.fx * cam[:, 0] / z + cx
            v = self.fy * cam[:, 1] / z + cy

        in_front = z > 0.0
        visible = in_front & (u >= 0) & (u <= w - 1) & (v >= 0) & (v <= h - 1)
        uv = np.stack([u, v], axis=-1)
        uv[~in_front] = np.nan

        if np.ndim(points_world) == 1:
            return uv[0], bool(visible[0])
        return uv, visible

    def ground_sample_distance_m(self, distance_m: Optional[float] = None) -> float:
        """Metres per pixel on a surface square to the axis at `distance_m`.

        Defaults to the burner standoff, which is the distance that matters when
        asking how well a camera resolves the fire.
        """
        d = self.standoff_m if distance_m is None else distance_m
        return d / self.fx

    @property
    def color(self) -> str:
        """This camera's display colour, keyed on modality. See PlanObject.color."""
        raw = (self.raw.get("display") or {}).get("color")
        if isinstance(raw, str) and _HEX_COLOR.match(raw):
            return raw
        return MODALITY_COLORS.get(self.modality, MODALITY_COLORS["other"])


class Burner(PlanObject):
    @property
    def footprint(self) -> Dict[str, Any]:
        return self.raw["footprint"]

    @property
    def shape(self) -> str:
        return self.footprint["shape"]

    @property
    def area_m2(self) -> float:
        fp = self.footprint
        if fp["shape"] == "circle":
            return math.pi * (float(fp["diameter_m"]) / 2.0) ** 2
        w, d = fp["size_m"]
        return float(w) * float(d)

    @property
    def diameter_m(self) -> float:
        """Effective (equal-area) diameter, which is what the correlations want."""
        fp = self.footprint
        if fp["shape"] == "circle":
            return float(fp["diameter_m"])
        return correlations.effective_diameter_m(self.area_m2)

    @property
    def rim_height_m(self) -> float:
        return float(self.raw.get("rimHeight_m") or 0.0)

    @property
    def fuel_surface_z_m(self) -> float:
        """Absolute height of the fuel surface. Correlations measure from here."""
        return float(self.position[2]) + self.rim_height_m

    @property
    def fire(self) -> Dict[str, Any]:
        return self.raw.get("fire") or {}

    @property
    def fuel(self) -> Optional[str]:
        return self.fire.get("fuel")

    @property
    def hrr_kw(self) -> Optional[float]:
        q = self.fire.get("hrr_kw")
        return None if q is None else float(q)

    def _require_hrr(self) -> float:
        q = self.hrr_kw
        if q is None:
            raise ValueError(
                "burner {!r} has no hrr_kw; flame and plume geometry are undefined".format(self.id)
            )
        return q

    def flame_height_m(self) -> float:
        """Mean flame height above the fuel surface."""
        return correlations.flame_height_m(self._require_hrr(), self.diameter_m)

    def flame_tip_z_m(self) -> float:
        """Absolute height of the mean flame tip above the floor."""
        return self.fuel_surface_z_m + self.flame_height_m()

    def virtual_origin_m(self) -> float:
        return correlations.virtual_origin_m(self._require_hrr(), self.diameter_m)

    def plume_radius_m(self, z_above_floor_m: float, half_angle_rad: Optional[float] = None) -> float:
        """Plume radius at an absolute height above the floor."""
        kwargs = {} if half_angle_rad is None else {"half_angle_rad": half_angle_rad}
        return correlations.plume_radius_m(
            z_above_floor_m - self.fuel_surface_z_m,
            self._require_hrr(),
            self.diameter_m,
            **kwargs
        )

    @property
    def radiative_fraction(self) -> float:
        """Fraction of the heat release emitted as radiation. Format 1.1.

        Fuel-dependent and consequential: it is a linear term in what every heat
        flux gauge in the plan is predicted to read. 0.3 when unstated.
        """
        raw = self.fire.get("radiativeFraction")
        try:
            f = float(raw)
        except (TypeError, ValueError):
            return correlations.DEFAULT_RADIATIVE_FRACTION
        if not 0.0 < f <= 1.0:
            return correlations.DEFAULT_RADIATIVE_FRACTION
        return f

    def flame_radius_m(self, z_above_floor_m: float) -> Optional[float]:
        """Radius of the mean flame cone at an absolute height above the floor.

        Tapers from the effective diameter at the fuel surface to a point at the
        mean tip -- the same cone the 3D editor draws, so "this bead is in the
        flame" means the same thing in a notebook as it looks like on screen.

        None when there is no cone at all (a flame height that clamps to zero),
        which is a different answer from a cone of zero radius: collapsing the two
        made an on-axis bead "in the flame" of a fire that has no flame, and put
        this engine's verdict at odds with the editor's on the same file. Mirror of
        `flameRadiusAtZ` in web/src/core/plan.ts.
        """
        base = self.fuel_surface_z_m
        tip = self.flame_tip_z_m()
        if tip <= base:
            return None
        if z_above_floor_m < base or z_above_floor_m > tip:
            return 0.0
        return (self.diameter_m / 2.0) * (1.0 - (z_above_floor_m - base) / (tip - base))

    def point_source_z_m(self) -> float:
        """Mid-flame height: where the point-source radiation model puts the fire,
        and what a camera or a gauge means by "aim at the fire"."""
        return (self.fuel_surface_z_m + self.flame_tip_z_m()) / 2.0


class Hood(PlanObject):
    @property
    def opening_m(self) -> Tuple[float, float]:
        w, d = self.raw["opening_m"]
        return float(w), float(d)

    @property
    def height_m(self) -> float:
        return float(self.raw["height_m"])

    @property
    def skirt_depth_m(self) -> float:
        return float(self.raw.get("skirtDepth_m") or 0.0)

    @property
    def opening_z_m(self) -> float:
        """Height of the opening plane above the floor, in world space.

        `height_m` is measured from the hood's own origin, and the origin can move:
        the editor's gizmo translates a hood in Z like any other object, and the 3D
        view draws the canopy where the transform puts it. Every check and table
        goes through here rather than reading `height_m` directly, so a hood moved
        three metres down is judged where it is drawn -- a check that read
        `height_m` alone cleared a flame that was visibly inside the canopy. Mirror
        of `hoodOpeningZM` in web/src/core/plan.ts.
        """
        return float(self.position[2]) + self.height_m

    @property
    def intake_height_m(self) -> float:
        """Lowest plane that must capture the plume: opening, less any skirt.

        World space -- above the floor, wherever the hood's transform puts it.
        """
        return self.opening_z_m - self.skirt_depth_m

    @property
    def duct(self) -> Optional[Dict[str, Any]]:
        return self.raw.get("duct")

    @property
    def opening_corners_xy(self) -> np.ndarray:
        """The four corners of the opening in world XY, honouring the hood's rotation."""
        w, d = self.opening_m
        local = [(-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)]
        return np.array([self.footprint_xy(c) for c in local])

    def opening_offset(self, x: float, y: float) -> Tuple[float, float, float]:
        """Where a world XY point sits relative to the opening, in the hood's own axes.

        Returns `(u, v, overhang)`: the in-plane offset from the opening centre, and
        how far the point lies beyond the rim -- zero when it is inside. Mirror of
        `hoodOpeningOffset` in web/src/core/plan.ts.
        """
        local = self.to_local([float(x), float(y), 0.0])
        w, d = self.opening_m
        over_u = max(0.0, abs(local[0]) - w / 2)
        over_v = max(0.0, abs(local[1]) - d / 2)
        return float(local[0]), float(local[1]), float(math.hypot(over_u, over_v))


class Wall(PlanObject):
    @property
    def polyline_m(self) -> np.ndarray:
        return np.asarray(self.raw["polyline_m"], dtype=float)

    @property
    def height_m(self) -> float:
        return float(self.raw["height_m"])

    @property
    def thickness_m(self) -> float:
        return float(self.raw.get("thickness_m") or 0.1)

    @property
    def base_height_m(self) -> float:
        return float(self.raw.get("baseHeight_m") or 0.0)

    @property
    def openings(self) -> List[Dict[str, Any]]:
        return self.raw.get("openings") or []

    @property
    def length_m(self) -> float:
        p = self.polyline_m
        return float(np.sum(np.linalg.norm(np.diff(p, axis=0), axis=1)))


class Ceiling(PlanObject):
    @property
    def polygon_m(self) -> np.ndarray:
        return np.asarray(self.raw["polygon_m"], dtype=float)

    @property
    def height_m(self) -> float:
        """Underside above the slab's own origin -- the floor, unless the slab has
        been moved in Z. `soffit_z_m` is the same plane above the floor."""
        return float(self.raw["height_m"])

    @property
    def soffit_z_m(self) -> float:
        """The surface a flame impinges on, in world space: the slab's own height
        plus wherever its transform puts it. Same reasoning as `Hood.opening_z_m`.
        Mirror of `ceilingSoffitZM` in web/src/core/plan.ts."""
        return float(self.position[2]) + self.height_m

    @property
    def thickness_m(self) -> float:
        return float(self.raw.get("thickness_m") or 0.1)

    @property
    def area_m2(self) -> float:
        """Shoelace formula over the closed polygon."""
        p = self.polygon_m
        x, y = p[:, 0], p[:, 1]
        return float(abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2.0)

    def contains_xy(self, x: float, y: float) -> bool:
        """Point-in-polygon by ray casting, over the slab's world footprint.

        Used so a slab off to one side does not claim a flame impinges on it. The
        footprint goes through the object frame rather than a bare translation: a
        rotated slab covers a different area, and the 3D editor already draws it
        rotated.
        """
        p = self.polygon_m
        inside = False
        n = len(p)
        for i in range(n):
            x0, y0 = self.footprint_xy(p[i])
            x1, y1 = self.footprint_xy(p[(i + 1) % n])
            # Half-open edge test avoids double-counting a vertex on the ray.
            if (y0 > y) != (y1 > y):
                t = (y - y0) / (y1 - y0)
                if x < x0 + t * (x1 - x0):
                    inside = not inside
        return inside


class HeatFluxSensor(PlanObject):
    """A heat flux gauge. Format 1.1.

    Directional, on the camera convention: the sensing face looks down local -Z,
    so `forward` (inherited) is its outward normal and `aim_target` records what
    it was pointed at. `Plan.heat_flux_estimate` turns that into a number.
    """

    @property
    def gauge(self) -> Dict[str, Any]:
        return self.raw.get("gauge") or {}

    @property
    def kind(self) -> str:
        return self.gauge.get("kind") or "schmidt-boelter"

    @property
    def range_kw_m2(self) -> Optional[float]:
        """Full scale, or None when unrecorded -- which silences the range checks
        rather than inventing a limit to test against."""
        r = self.gauge.get("range_kw_m2")
        if r is None:
            return None
        r = float(r)
        return r if r > 0.0 else None

    @property
    def view_angle_deg(self) -> float:
        """Full acceptance angle of the sensing face. 180 is an open hemisphere."""
        raw = self.gauge.get("viewAngle_deg")
        try:
            v = float(raw)
        except (TypeError, ValueError):
            return 180.0
        return v if 0.0 < v <= 180.0 else 180.0

    @property
    def water_cooled(self) -> Optional[bool]:
        return self.gauge.get("waterCooled")

    @property
    def serial(self) -> Optional[str]:
        return self.gauge.get("serial")

    @property
    def normal(self) -> np.ndarray:
        """Outward normal of the sensing face. An alias for `forward`, spelled the
        way a radiation calculation spells it."""
        return self.forward


class Thermocouple(PlanObject):
    """One thermocouple, or a rake of them on a common support. Format 1.1.

    A single bead is the one-element case of a tree, so both are this one class
    and there is no second thing to keep in step.
    """

    @property
    def spec(self) -> Dict[str, Any]:
        return self.raw.get("thermocouple") or {}

    @property
    def tc_type(self) -> str:
        return self.spec.get("tcType") or "K"

    @property
    def bead_diameter_mm(self) -> Optional[float]:
        d = self.spec.get("beadDiameter_mm")
        return None if d is None else float(d)

    @property
    def sheathed(self) -> Optional[bool]:
        return self.spec.get("sheathed")

    @property
    def max_temperature_c(self) -> float:
        """Upper limit: the recorded one, or the letter type's standard limit."""
        explicit = self.spec.get("maxTemperature_C")
        if explicit is not None:
            return float(explicit)
        return TC_MAX_TEMPERATURE_C.get(self.tc_type, TC_MAX_TEMPERATURE_C["K"])

    @property
    def bead_offsets_m(self) -> List[float]:
        """Offsets along the rake, from the object origin. Always at least one."""
        raw = self.raw.get("beadOffsets_m")
        if not isinstance(raw, list):
            return [0.0]
        clean = [
            float(v) for v in raw
            if isinstance(v, (int, float)) and not isinstance(v, bool)
        ]
        return clean if clean else [0.0]

    @property
    def bead_positions(self) -> np.ndarray:
        """Every bead in world coordinates, shape `(n, 3)`.

        Offsets run along LOCAL +Z, so they go through the object transform like
        every other vertex list in this format (CONVENTIONS section 5a) -- a rake
        leaned against a wall leans here too.
        """
        return np.array([self.to_world([0.0, 0.0, z]) for z in self.bead_offsets_m])


class Obstruction(PlanObject):
    """A rectangular solid -- furniture, equipment, blockwork. Format 1.2.

    The object origin is the CENTRE OF THE BASE, so the box spans +/- half its x
    and y extents and rises from 0 to its z extent. That is unlike a wall, whose
    height above the floor lives in `baseHeight_m`, and the reason is that a wall's
    geometry is a polyline with no z of its own while a box has an origin to put the
    height in. It also makes the rotate gizmo do the obvious thing: yaw about the
    box's own vertical axis.
    """

    @property
    def size_m(self) -> np.ndarray:
        return np.asarray(self.raw["size_m"], dtype=float)

    @property
    def height_m(self) -> float:
        return float(self.size_m[2])

    @property
    def base_z_m(self) -> float:
        """Underside above the floor. Just the transform's z."""
        return float(self.position[2])

    @property
    def top_z_m(self) -> float:
        return self.base_z_m + self.height_m

    @property
    def footprint_local(self) -> np.ndarray:
        """The four base corners in the object's LOCAL frame, counter-clockwise."""
        hx, hy = self.size_m[0] / 2.0, self.size_m[1] / 2.0
        return np.array([[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]], dtype=float)

    @property
    def footprint_world(self) -> np.ndarray:
        """The same four corners in world XY, through the full object transform."""
        return np.array([self.footprint_xy(c) for c in self.footprint_local], dtype=float)

    @property
    def volume_m3(self) -> float:
        return float(np.prod(self.size_m))

    def bounds_xb(self) -> List[float]:
        """`[x0, x1, y0, y1, z0, z1]` in world coordinates -- the FDS `XB` ordering.

        Exact for an unrotated box, which is every box an FDS import produces, since
        an `&OBST` is axis-aligned by definition. A yawed box reports the axis-aligned
        bounds of its footprint, which is a bounding box rather than the box itself;
        the editor only offers XB entry while the object is axis-aligned, for exactly
        that reason.
        """
        f = self.footprint_world
        return [
            float(f[:, 0].min()), float(f[:, 0].max()),
            float(f[:, 1].min()), float(f[:, 1].max()),
            self.base_z_m, self.top_z_m,
        ]


class ReconstructedFlame(PlanObject):
    """A measured flame: the visual hull reconstructed from the test's cameras, one
    voxel frame per timestep. Format 1.4.

    World-anchored, not a burner attachment: the voxels are in the reconstruction
    rig's frame, and this object's transform maps that frame onto the plan's. It is
    the identity when the rig was set up from this plan. The data itself stays in its
    folder; the one `linkedFiles` entry carries the manifest. Recorded data: it
    changes no prediction, check or verdict. Mirror of the `reconstructedFlame`
    helpers in web/src/core/plan.ts.
    """

    @property
    def burner_id(self) -> Optional[str]:
        """The burner this flame was reconstructed from; None means the primary."""
        return self.raw.get("burnerId") or None

    @property
    def representation(self) -> str:
        return self.raw.get("representation") or "voxels"

    @property
    def sequence_link(self) -> Optional[Dict[str, Any]]:
        """The one link a flame carries: the folder of voxel frames, with its manifest."""
        for link in self.raw.get("linkedFiles") or []:
            if isinstance(link, dict) and link.get("kind") == "voxelSequence":
                return link
        return None

    @property
    def manifest(self) -> Optional[Dict[str, Any]]:
        link = self.sequence_link
        return link.get("sequence") if link else None

    @property
    def opacity(self) -> float:
        value = (self.raw.get("display") or {}).get("opacity")
        return 1.0 if value is None else float(value)

    @property
    def color_mode(self) -> str:
        return (self.raw.get("display") or {}).get("colorMode") or "height"

    def bounds_corners(self) -> np.ndarray:
        """The eight corners of the manifest's box in world space, `(8, 3)`, or
        `(0, 3)` without a manifest.

        Corners rather than the two extremes because the transform may rotate the
        rig frame onto the plan's, and a rotated box is bounded by its corners.
        """
        manifest = self.manifest
        if not manifest:
            return np.zeros((0, 3), dtype=float)
        lo, hi = manifest["bounds_m"]
        corners = [self.to_world([x, y, z]) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
        return np.array(corners, dtype=float)


class UnknownObject(PlanObject):
    """An object type this version does not recognise.

    Held so it survives a load/save cycle byte-identical rather than being dropped.
    """


TYPE_MAP = {
    "camera": Camera,
    "burner": Burner,
    "hood": Hood,
    "wall": Wall,
    "ceiling": Ceiling,
    "heatFluxSensor": HeatFluxSensor,
    "thermocouple": Thermocouple,
    "obstruction": Obstruction,
    "reconstructedFlame": ReconstructedFlame,
}


def wrap(raw: Dict[str, Any]) -> PlanObject:
    return TYPE_MAP.get(raw.get("type"), UnknownObject)(raw)
