"""Fire plume correlations (Heskestad, as given in the SFPE Handbook).

Heat release rate in kW, all lengths in metres. See CONVENTIONS.md section 5.
"""

from __future__ import annotations

import math

DEFAULT_PLUME_HALF_ANGLE_RAD = math.radians(15.0)


def effective_diameter_m(area_m2: float) -> float:
    """Diameter of the circle with the same burning area.

    Heskestad is formulated for circular pools, so a square or rectangular pan is
    converted by equal area before the correlations are applied.
    """
    if area_m2 <= 0.0:
        raise ValueError("burning area must be positive")
    return math.sqrt(4.0 * area_m2 / math.pi)


def flame_height_m(hrr_kw: float, diameter_m: float) -> float:
    """Heskestad mean flame height: L_f = 0.235 Q^(2/5) - 1.02 D.

    'Mean' means the height exceeded by the intermittent flame tip 50% of the time,
    not a maximum. The result can be negative for a very large, very low-intensity
    pool; that is clamped to zero, since a negative flame height is not meaningful.
    """
    if hrr_kw <= 0.0:
        raise ValueError("heat release rate must be positive")
    if diameter_m <= 0.0:
        raise ValueError("diameter must be positive")
    return max(0.0, 0.235 * hrr_kw ** 0.4 - 1.02 * diameter_m)


def virtual_origin_m(hrr_kw: float, diameter_m: float) -> float:
    """Heskestad virtual origin: z0 = 0.083 Q^(2/5) - 1.02 D.

    Height above the fuel surface of the apparent point source. Routinely negative
    (i.e. below the fuel surface) for larger pools, which is physical and is NOT
    clamped -- clamping it would distort the plume cone.
    """
    if hrr_kw <= 0.0:
        raise ValueError("heat release rate must be positive")
    if diameter_m <= 0.0:
        raise ValueError("diameter must be positive")
    return 0.083 * hrr_kw ** 0.4 - 1.02 * diameter_m


def plume_radius_m(
    height_m: float,
    hrr_kw: float,
    diameter_m: float,
    half_angle_rad: float = DEFAULT_PLUME_HALF_ANGLE_RAD,
) -> float:
    """Visible plume radius at `height_m` above the fuel surface.

    A straight-sided cone opening from the virtual origin. The 15 degree default
    half-angle is an engineering rule of thumb for visualisation, not a rigorous
    Gaussian plume half-width -- hence the parameter.
    """
    z0 = virtual_origin_m(hrr_kw, diameter_m)
    return max(0.0, math.tan(half_angle_rad) * (height_m - z0))
