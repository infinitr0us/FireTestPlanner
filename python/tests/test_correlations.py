"""Heskestad correlations.

Expected values are computed by hand from the published forms (CONVENTIONS.md
section 5) rather than by re-running the implementation.
"""

from __future__ import annotations

import math

import pytest

from fireplan import correlations as c


def test_flame_height_one_megawatt_one_metre_pool():
    """L_f = 0.235 * 1000^0.4 - 1.02 * 1.0
           = 0.235 * 15.848932 - 1.02
           = 3.724499 - 1.02 = 2.704499 m

    Sanity: a 1 MW fire on a 1 m pool has roughly 2.7 m flames, which is the
    figure any fire engineer would expect.
    """
    assert c.flame_height_m(1000.0, 1.0) == pytest.approx(2.704499, abs=1e-6)


def test_virtual_origin_one_megawatt_one_metre_pool():
    """z0 = 0.083 * 15.848932 - 1.02 = 1.315461 - 1.02 = 0.295461 m"""
    assert c.virtual_origin_m(1000.0, 1.0) == pytest.approx(0.295461, abs=1e-6)


def test_virtual_origin_goes_below_the_fuel_surface_for_large_pools():
    """Physical and deliberately not clamped: a big, low-intensity pool has its
    apparent point source beneath the fuel surface."""
    assert c.virtual_origin_m(500.0, 3.0) < 0.0


def test_flame_height_clamps_at_zero_rather_than_going_negative():
    z = c.flame_height_m(1.0, 5.0)  # tiny fire, huge pan -> formula returns negative
    assert z == 0.0


def test_hrr_for_flame_height_inverts_the_flame_height():
    """Q = ((L_f + 1.02 D) / 0.235)^2.5; ((2.704499 + 1.02) / 0.235)^2.5 =
    15.848932^2.5 = 1000 kW, the 1 MW case back. Mirror of the web test."""
    assert c.hrr_for_flame_height_kw(2.704499, 1.0) == pytest.approx(1000.0, abs=1e-3)
    for height, d in ((0.5, 0.3), (9.6, 2.53), (10.0, 5.35)):
        assert c.flame_height_m(c.hrr_for_flame_height_kw(height, d), d) == pytest.approx(height, abs=1e-9)
    for height, d in ((0.0, 1.0), (-1.0, 1.0), (2.0, 0.0)):
        with pytest.raises(ValueError):
            c.hrr_for_flame_height_kw(height, d)


def test_effective_diameter_is_equal_area():
    """D = sqrt(4A/pi); for A = 1 m^2 that is 1.128379 m."""
    assert c.effective_diameter_m(1.0) == pytest.approx(1.1283792, abs=1e-6)
    # Round-trips against the area of the circle it describes.
    d = c.effective_diameter_m(2.5)
    assert math.pi * (d / 2) ** 2 == pytest.approx(2.5)


def test_square_and_circle_of_equal_area_burn_the_same_height():
    """The whole point of the equal-area conversion."""
    side = 0.5
    area = side * side
    d_eff = c.effective_diameter_m(area)
    circle_area = math.pi * (d_eff / 2) ** 2
    assert circle_area == pytest.approx(area)
    assert c.flame_height_m(200.0, d_eff) == pytest.approx(
        c.flame_height_m(200.0, c.effective_diameter_m(circle_area))
    )


def test_plume_radius_opens_from_the_virtual_origin():
    """r(z) = tan(15 deg) * (z - z0), so the cone apex sits at z0, not at zero."""
    q, d = 1000.0, 1.0
    z0 = c.virtual_origin_m(q, d)
    assert c.plume_radius_m(z0, q, d) == pytest.approx(0.0, abs=1e-12)
    r = c.plume_radius_m(z0 + 2.0, q, d)
    assert r == pytest.approx(2.0 * math.tan(math.radians(15.0)), abs=1e-9)


def test_plume_radius_never_negative_below_the_virtual_origin():
    assert c.plume_radius_m(0.0, 1000.0, 1.0) == 0.0


def test_half_angle_is_a_parameter():
    q, d = 1000.0, 1.0
    z0 = c.virtual_origin_m(q, d)
    wide = c.plume_radius_m(z0 + 1.0, q, d, half_angle_rad=math.radians(30.0))
    assert wide == pytest.approx(math.tan(math.radians(30.0)), abs=1e-9)


@pytest.mark.parametrize("hrr,diameter", [(0.0, 1.0), (-5.0, 1.0), (1000.0, 0.0), (1000.0, -1.0)])
def test_nonphysical_inputs_raise(hrr, diameter):
    with pytest.raises(ValueError):
        c.flame_height_m(hrr, diameter)
