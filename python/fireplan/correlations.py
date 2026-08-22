"""Fire plume correlations (Heskestad, as given in the SFPE Handbook).

Heat release rate in kW, all lengths in metres. See CONVENTIONS.md section 5.
"""

from __future__ import annotations

import math

DEFAULT_PLUME_HALF_ANGLE_RAD = math.radians(15.0)

#: Radiated fraction of the heat release when the burner does not state one. Fuel
#: dependent -- roughly 0.35 for heptane, 0.2 for methanol -- hence the override.
DEFAULT_RADIATIVE_FRACTION = 0.3

#: How many effective diameters away the point-source model starts to be
#: believable. Closer than this the fire is plainly not a point, and the estimate
#: is an order of magnitude rather than a number to size a gauge on.
POINT_SOURCE_MIN_DIAMETERS = 2.0


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


def point_source_flux_kw_m2(
    hrr_kw: float,
    distance_m: float,
    cos_theta: float = 1.0,
    radiative_fraction: float = DEFAULT_RADIATIVE_FRACTION,
) -> float:
    """Point-source radiation: q" = X_r * Q * cos(theta) / (4 pi r^2), in kW/m2.

    The whole fire is collapsed to one isotropic emitter at mid-flame height. That
    is the standard first-order estimate and it is what a gauge placement is sized
    with, but it only holds in the far field -- see POINT_SOURCE_MIN_DIAMETERS.

    `cos_theta` is between the gauge's outward normal and the line to the fire. A
    gauge facing away receives nothing, and is reported as nothing rather than as
    a negative flux. Mirror of `pointSourceFluxKwM2` in web/src/core/correlations.ts.
    """
    if hrr_kw <= 0.0 or distance_m <= 0.0 or cos_theta <= 0.0:
        return 0.0
    return radiative_fraction * hrr_kw * cos_theta / (4.0 * math.pi * distance_m ** 2)


def plume_centreline_rise_k(
    height_m: float,
    hrr_kw: float,
    diameter_m: float,
    radiative_fraction: float = DEFAULT_RADIATIVE_FRACTION,
):
    """Heskestad plume centreline temperature rise above ambient, in kelvin.

        dT = 25.0 * Qc^(2/3) * (z - z0)^(-5/3)

    where `Qc` is the CONVECTIVE heat release, taken as the part not radiated away.
    The 25.0 is not a fitted constant: it is 9.1 * (T_inf / (g cp^2 rho_inf^2))^(1/3)
    evaluated for air at 20 C.

    Valid in the plume only -- above the mean flame tip, on the axis. Callers check
    that themselves; this returns a number for any `height_m` above the virtual
    origin, and it would be a badly wrong number inside the flame. None when there
    is no plume to speak of.
    """
    if hrr_kw <= 0.0:
        return None
    above = height_m - virtual_origin_m(hrr_kw, diameter_m)
    if above <= 0.0:
        return None
    convective_kw = max(0.0, 1.0 - radiative_fraction) * hrr_kw
    if convective_kw <= 0.0:
        return None
    return 25.0 * convective_kw ** (2.0 / 3.0) * above ** (-5.0 / 3.0)
