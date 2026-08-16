"""Typed views over the raw plan dictionaries.

Every wrapper holds a reference to the dict it came from rather than copying, so
mutations round-trip on save and unknown keys are never dropped.
"""

from __future__ import annotations

import math
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

MODALITY_COLORS = {
    "RGB": "#3b82f6",
    "LWIR": "#f97316",
    "MWIR": "#a855f7",
    "SWIR": "#14b8a6",
    "NIR": "#eab308",
    "other": "#94a3b8",
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
    def _transform(self) -> Dict[str, Any]:
        return self.raw.setdefault("transform", {"position_m": [0.0, 0.0, 0.0]})

    @property
    def position(self) -> np.ndarray:
        return np.asarray(self._transform.get("position_m", [0.0, 0.0, 0.0]), dtype=float)

    @position.setter
    def position(self, value: Iterable[float]) -> None:
        self._transform["position_m"] = [float(v) for v in value]

    @property
    def quaternion(self) -> np.ndarray:
        return np.asarray(self._transform.get("rotation_quat", IDENTITY_QUAT), dtype=float)

    @property
    def rotation_matrix(self) -> np.ndarray:
        """Object-to-world rotation, in the stored (OpenGL-style) local frame."""
        return quat_to_matrix(self.quaternion)

    @property
    def aim_target(self) -> Optional[np.ndarray]:
        t = self._transform.get("aimTarget_m")
        return None if t is None else np.asarray(t, dtype=float)

    def aim_at(self, target: Iterable[float]) -> None:
        """Re-orient to look at `target`, keeping quaternion and aimTarget in step."""
        target = [float(v) for v in target]
        q = look_at_quat(self.position, np.asarray(target))
        self._transform["rotation_quat"] = [float(v) for v in q]
        self._transform["aimTarget_m"] = target

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
        return float(self.spec["focalLength_mm"])

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
        """Reserved for the post-test record. Always None in format 1.0."""
        return self.raw.get("recording")

    # -- intrinsics ------------------------------------------------------

    @property
    def fx(self) -> float:
        return self.focal_length_mm * self.resolution[0] / self.sensor_mm[0]

    @property
    def fy(self) -> float:
        return self.focal_length_mm * self.resolution[1] / self.sensor_mm[1]

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
        return 2.0 * math.atan(self.sensor_mm[0] / (2.0 * self.focal_length_mm))

    @property
    def vfov_rad(self) -> float:
        return 2.0 * math.atan(self.sensor_mm[1] / (2.0 * self.focal_length_mm))

    @property
    def hfov_deg(self) -> float:
        return math.degrees(self.hfov_rad)

    @property
    def vfov_deg(self) -> float:
        return math.degrees(self.vfov_rad)

    # -- extrinsics ------------------------------------------------------

    @property
    def forward(self) -> np.ndarray:
        """World-space view direction. The stored frame looks down local -Z."""
        return -self.rotation_matrix[:, 2]

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
        display = self.raw.get("display") or {}
        return display.get("color") or MODALITY_COLORS.get(self.modality, MODALITY_COLORS["other"])


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
    def intake_height_m(self) -> float:
        """Lowest plane that must capture the plume: opening, less any skirt."""
        return self.height_m - self.skirt_depth_m

    @property
    def duct(self) -> Optional[Dict[str, Any]]:
        return self.raw.get("duct")


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
        """Underside above the floor -- the surface a flame impinges on."""
        return float(self.raw["height_m"])

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
        """Point-in-polygon by ray casting, in the ceiling's own local XY.

        Used so a slab off to one side does not claim a flame impinges on it.
        """
        p = self.polygon_m
        origin = self.position
        inside = False
        n = len(p)
        for i in range(n):
            x0, y0 = p[i] + origin[:2]
            x1, y1 = p[(i + 1) % n] + origin[:2]
            # Half-open edge test avoids double-counting a vertex on the ray.
            if (y0 > y) != (y1 > y):
                t = (y - y0) / (y1 - y0)
                if x < x0 + t * (x1 - x0):
                    inside = not inside
        return inside


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
}


def wrap(raw: Dict[str, Any]) -> PlanObject:
    return TYPE_MAP.get(raw.get("type"), UnknownObject)(raw)
