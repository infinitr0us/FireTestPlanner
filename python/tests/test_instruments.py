"""Heat flux gauges and thermocouples: geometry, prediction, and placement checks.

Format 1.1 object types. The predictions are first-order models rather than
measurements, so the tests here pin the arithmetic against hand-derived values in
the comments -- the point is that the number the tool prints is the number the
model gives, and that a plan which would waste a test day says so before anyone
travels.
"""

from __future__ import annotations

import math
import os

import numpy as np
import pytest

from fireplan import Plan
from fireplan._math import look_at_quat
from fireplan.objects import TC_MAX_TEMPERATURE_C

FIXTURES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fixtures"
)
CAMERA_ROW = os.path.join(FIXTURES, "pool-fire-camera-row.ftp.json")


def codes(issues):
    return {i.code for i in issues}


def _fire_plan(hrr_kw=130.0, radiative_fraction=None):
    """A 1 ft heptane pan at the origin -- the reference fire, without the rig."""
    plan = Plan.new("instrument test")
    fire = {"fuel": "n-heptane", "hrr_kw": hrr_kw, "hrrCurve": None}
    if radiative_fraction is not None:
        fire["radiativeFraction"] = radiative_fraction
    plan.add({
        "id": "burner-main",
        "type": "burner",
        "transform": {"position_m": [0.0, 0.0, 0.0]},
        "footprint": {"shape": "square", "size_m": [0.3048, 0.3048]},
        "rimHeight_m": 0.1,
        "fire": fire,
    })
    return plan


def _gauge(plan, position, aim=None, range_kw_m2=50.0, view_angle_deg=180.0, obj_id="hf-1"):
    aim = plan.fire_point_source() if aim is None else np.asarray(aim, dtype=float)
    q = look_at_quat(np.asarray(position, dtype=float), aim)
    plan.add({
        "id": obj_id,
        "type": "heatFluxSensor",
        "transform": {
            "position_m": [float(v) for v in position],
            "rotation_quat": [float(v) for v in q],
            "aimTarget_m": [float(v) for v in aim],
        },
        "gauge": {"range_kw_m2": range_kw_m2, "viewAngle_deg": view_angle_deg},
    })
    return plan.heat_flux_sensors[-1]


def _rake(plan, position, offsets, tc_type="K", obj_id="tc-1", max_temperature_c=None):
    spec = {"tcType": tc_type}
    if max_temperature_c is not None:
        spec["maxTemperature_C"] = max_temperature_c
    plan.add({
        "id": obj_id,
        "type": "thermocouple",
        "transform": {"position_m": [float(v) for v in position]},
        "beadOffsets_m": [float(v) for v in offsets],
        "thermocouple": spec,
    })
    return plan.thermocouples[-1]


# -- the point source ----------------------------------------------------

def test_the_point_source_sits_at_mid_flame():
    plan = _fire_plan()
    burner = plan.burner
    source = plan.fire_point_source()
    assert source[0] == pytest.approx(0.0)
    assert source[1] == pytest.approx(0.0)
    assert source[2] == pytest.approx(
        (burner.fuel_surface_z_m + burner.flame_tip_z_m()) / 2.0
    )


def test_no_hrr_means_no_point_source_rather_than_a_guess():
    plan = Plan.new("no fire")
    plan.add({
        "id": "burner-main",
        "type": "burner",
        "transform": {"position_m": [0.0, 0.0, 0.0]},
        "footprint": {"shape": "square", "size_m": [0.3048, 0.3048]},
        "fire": {"hrr_kw": None},
    })
    assert plan.fire_point_source() is None


# -- heat flux prediction ------------------------------------------------

def test_incident_flux_matches_the_point_source_formula():
    # q" = X_r Q cos(theta) / (4 pi r^2). Gauge aimed straight at the source, so
    # cos(theta) is 1 and the whole expression is fixed by the distance.
    plan = _fire_plan(hrr_kw=130.0, radiative_fraction=0.35)
    source = plan.fire_point_source()
    gauge = _gauge(plan, [2.0, 0.0, float(source[2])])

    est = plan.heat_flux_estimate(gauge)
    assert est["distance_m"] == pytest.approx(2.0)
    assert est["off_axis_deg"] == pytest.approx(0.0, abs=1e-6)
    assert est["incident_kw_m2"] == pytest.approx(
        0.35 * 130.0 / (4.0 * math.pi * 4.0)
    )


def test_flux_falls_off_as_one_over_r_squared():
    plan = _fire_plan()
    z = float(plan.fire_point_source()[2])
    near = plan.heat_flux_estimate(_gauge(plan, [1.0, 0.0, z], obj_id="hf-near"))
    far = plan.heat_flux_estimate(_gauge(plan, [2.0, 0.0, z], obj_id="hf-far"))
    assert near["incident_kw_m2"] == pytest.approx(4.0 * far["incident_kw_m2"])


def test_the_radiative_fraction_scales_the_prediction_linearly():
    z = float(_fire_plan().fire_point_source()[2])
    low = _fire_plan(radiative_fraction=0.2)
    high = _fire_plan(radiative_fraction=0.4)
    a = low.heat_flux_estimate(_gauge(low, [2.0, 0.0, z]))["incident_kw_m2"]
    b = high.heat_flux_estimate(_gauge(high, [2.0, 0.0, z]))["incident_kw_m2"]
    assert b == pytest.approx(2.0 * a)


def test_an_unstated_radiative_fraction_defaults_to_three_tenths():
    plan = _fire_plan()
    assert plan.burner.radiative_fraction == pytest.approx(0.3)


def test_a_nonsense_radiative_fraction_falls_back_rather_than_propagating():
    # A plan is someone else's file. A fraction above 1 would radiate more than the
    # fire releases, and every gauge downstream would inherit it.
    plan = _fire_plan(radiative_fraction=1.5)
    assert plan.burner.radiative_fraction == pytest.approx(0.3)


def test_a_tilted_gauge_reads_the_cosine():
    # Same distance, turned 60 degrees off the fire: cos 60 = 1/2.
    plan = _fire_plan()
    source = plan.fire_point_source()
    z = float(source[2])
    square = _gauge(plan, [2.0, 0.0, z], obj_id="hf-square")
    straight = plan.heat_flux_estimate(square)["incident_kw_m2"]

    tilted_plan = _fire_plan()
    at = np.array([2.0, 0.0, z])
    # Aim 60 degrees away from the source, in the horizontal plane.
    away = at + np.array([math.cos(math.radians(60.0)) * -1.0,
                          math.sin(math.radians(60.0)), 0.0])
    tilted = _gauge(tilted_plan, at, aim=away, obj_id="hf-tilted")
    est = tilted_plan.heat_flux_estimate(tilted)
    assert est["off_axis_deg"] == pytest.approx(60.0, abs=1e-6)
    assert est["incident_kw_m2"] == pytest.approx(0.5 * straight)


def test_a_gauge_facing_away_receives_nothing_not_a_negative_flux():
    plan = _fire_plan()
    z = float(plan.fire_point_source()[2])
    gauge = _gauge(plan, [2.0, 0.0, z], aim=[4.0, 0.0, z])
    est = plan.heat_flux_estimate(gauge)
    assert est["faces_fire"] is False
    assert est["incident_kw_m2"] == 0.0
    assert "gauge-facing-away" in codes(plan.instrument_checks())


def test_a_gauge_facing_away_suppresses_the_range_findings():
    # A gauge pointed at the wall has one problem, and it is not its range.
    plan = _fire_plan()
    z = float(plan.fire_point_source()[2])
    _gauge(plan, [2.0, 0.0, z], aim=[4.0, 0.0, z], range_kw_m2=0.001)
    assert codes(plan.instrument_checks()) == {"gauge-facing-away"}


def test_no_fire_means_no_estimate_rather_than_zero():
    plan = Plan.new("no fire")
    plan.add({
        "id": "burner-main",
        "type": "burner",
        "transform": {"position_m": [0.0, 0.0, 0.0]},
        "footprint": {"shape": "square", "size_m": [0.3048, 0.3048]},
        "fire": {"hrr_kw": None},
    })
    gauge = _gauge(plan, [2.0, 0.0, 0.5], aim=[0.0, 0.0, 0.5])
    assert plan.heat_flux_estimate(gauge) is None
    assert codes(plan.instrument_checks()) == set()


# -- heat flux placement checks ------------------------------------------

def test_an_over_range_gauge_is_an_error():
    plan = _fire_plan()
    z = float(plan.fire_point_source()[2])
    _gauge(plan, [0.8, 0.0, z], range_kw_m2=1.0)
    assert "gauge-over-range" in codes(plan.instrument_checks())


def test_a_gauge_reading_in_its_own_noise_warns():
    # The reference plan's east-wall gauge: 1.70 kW/m2 on a 50 kW/m2 scale.
    plan = Plan.load(CAMERA_ROW)
    issues = [i for i in plan.instrument_checks() if i.object_id == "hf-east"]
    assert [i.code for i in issues] == ["gauge-low-signal"]


def test_a_correctly_sized_gauge_is_silent():
    plan = Plan.load(CAMERA_ROW)
    assert [i for i in plan.instrument_checks() if i.object_id == "hf-north"] == []


def test_a_gauge_standing_in_the_fire_is_reported_as_such():
    # Everything else would divide by a zero distance and print "inf kW/m2", which
    # is not a finding anybody can act on.
    plan = _fire_plan()
    source = plan.fire_point_source()
    _gauge(plan, source, aim=[source[0] + 1.0, source[1], source[2]])
    est = plan.heat_flux_estimate(plan.heat_flux_sensors[0])
    assert not math.isfinite(est["incident_kw_m2"])
    assert codes(plan.instrument_checks()) == {"gauge-in-fire"}


def test_a_gauge_with_no_recorded_range_gets_no_range_findings():
    plan = _fire_plan()
    z = float(plan.fire_point_source()[2])
    _gauge(plan, [0.8, 0.0, z], range_kw_m2=None)
    assert plan.heat_flux_estimate(plan.heat_flux_sensors[0])["fraction_of_range"] is None
    assert "gauge-over-range" not in codes(plan.instrument_checks())
    assert "gauge-low-signal" not in codes(plan.instrument_checks())


def test_a_gauge_inside_two_diameters_is_flagged_as_near_field():
    plan = _fire_plan()
    z = float(plan.fire_point_source()[2])
    # D_eff of a 1 ft square pan is 0.344 m, so 2 D_eff is 0.69 m.
    _gauge(plan, [0.4, 0.0, z], range_kw_m2=200.0)
    assert plan.heat_flux_estimate(plan.heat_flux_sensors[0])["near_field"] is True
    assert "gauge-near-field" in codes(plan.instrument_checks())


def test_a_view_tube_that_misses_the_flame_warns():
    plan = _fire_plan()
    z = float(plan.fire_point_source()[2])
    at = np.array([2.0, 0.0, z])
    away = at + np.array([-math.cos(math.radians(30.0)), math.sin(math.radians(30.0)), 0.0])
    _gauge(plan, at, aim=away, view_angle_deg=20.0)  # accepts +/-10 deg, fire is 30 off
    assert "gauge-view-restricted" in codes(plan.instrument_checks())


def test_an_open_hemispherical_gauge_is_never_view_restricted():
    plan = _fire_plan()
    z = float(plan.fire_point_source()[2])
    at = np.array([2.0, 0.0, z])
    away = at + np.array([-math.cos(math.radians(80.0)), math.sin(math.radians(80.0)), 0.0])
    _gauge(plan, at, aim=away, view_angle_deg=180.0)
    assert "gauge-view-restricted" not in codes(plan.instrument_checks())


def test_a_gauge_aim_target_disagreeing_with_its_quaternion_warns():
    # The same check cameras get, and for the same reason: the quaternion is
    # authoritative, so a stale target is a lie about what the gauge measures.
    plan = _fire_plan()
    plan.add({
        "id": "hf-1",
        "type": "heatFluxSensor",
        "transform": {
            "position_m": [2.0, 0.0, 0.7],
            "rotation_quat": [0.0, 0.0, 0.0, 1.0],
            "aimTarget_m": [0.0, 0.0, 0.7],
        },
    })
    assert "aim-mismatch" in codes(plan.check())


# -- thermocouple geometry -----------------------------------------------

def test_a_bare_thermocouple_is_a_one_bead_rake():
    plan = _fire_plan()
    rake = _rake(plan, [1.0, 0.0, 0.5], [0.0])
    assert rake.bead_offsets_m == [0.0]
    np.testing.assert_allclose(rake.bead_positions[0], [1.0, 0.0, 0.5])


def test_missing_bead_offsets_default_to_a_single_bead_at_the_origin():
    plan = _fire_plan()
    plan.add({"id": "tc-1", "type": "thermocouple",
              "transform": {"position_m": [1.0, 0.0, 0.5]}})
    assert plan.thermocouples[0].bead_offsets_m == [0.0]


def test_bead_offsets_run_along_local_z():
    plan = _fire_plan()
    rake = _rake(plan, [1.0, 0.5, 0.0], [0.3, 0.9])
    np.testing.assert_allclose(rake.bead_positions[0], [1.0, 0.5, 0.3])
    np.testing.assert_allclose(rake.bead_positions[1], [1.0, 0.5, 0.9])


def test_a_tilted_rake_puts_its_beads_through_the_object_frame():
    # CONVENTIONS section 5a: vertex lists are local, so they all go through the
    # full transform. A rake laid on its side has horizontal beads.
    plan = _fire_plan()
    # 90 degrees about +Y takes local +Z onto world +X.
    s = math.sqrt(0.5)
    plan.add({
        "id": "tc-1",
        "type": "thermocouple",
        "transform": {"position_m": [1.0, 0.0, 0.5], "rotation_quat": [0.0, s, 0.0, s]},
        "beadOffsets_m": [1.0],
    })
    np.testing.assert_allclose(
        plan.thermocouples[0].bead_positions[0], [2.0, 0.0, 0.5], atol=1e-9
    )


# -- thermocouple prediction ---------------------------------------------

def test_a_bead_on_the_axis_above_the_tip_is_in_the_plume():
    plan = _fire_plan()
    tip = plan.burner.flame_tip_z_m()
    beads = plan.thermocouple_beads(_rake(plan, [0.0, 0.0, 0.0], [tip + 0.5]))
    assert beads[0]["region"] == "plume"
    assert beads[0]["gas_temperature_c"] is not None


def test_a_bead_in_the_flame_gets_no_plume_temperature():
    # Inside the flame the plume correlation is not imprecise, it is the wrong
    # correlation, so the honest answer is no answer.
    plan = _fire_plan()
    beads = plan.thermocouple_beads(_rake(plan, [0.0, 0.0, 0.0], [0.3]))
    assert beads[0]["region"] == "flame"
    assert beads[0]["gas_temperature_c"] is None


def test_a_bead_below_the_fuel_surface_is_not_in_the_flame():
    """The cone starts at the fuel surface, and so must the region test.

    `flame_radius_m` reports 0.0 outside the cone's own height band, so a test of
    only the upper bound reduced to `radial <= 0` below the pan -- true exactly on
    the burner axis, which is where a rake with no transform sits by default. The
    result was a severity-error over-temperature finding for a bead in the
    concrete. Mirrored in web/src/core/instruments.test.ts.
    """
    plan = _fire_plan()  # rimHeight_m 0.1, so the fuel surface is at z = 0.1
    beads = plan.thermocouple_beads(_rake(plan, [0.0, 0.0, 0.0], [0.05, -1.0], tc_type="T"))
    assert [b["region"] for b in beads] == ["outside", "outside"]
    assert "tc-over-temperature" not in codes(plan.instrument_checks())

    # The bound is inclusive: a bead resting exactly on the fuel surface is in it.
    plan = _fire_plan()
    assert plan.thermocouple_beads(_rake(plan, [0.0, 0.0, 0.0], [0.1]))[0]["region"] == "flame"


def test_a_flame_that_clamps_to_zero_height_has_no_flame_region():
    """A 1 kW fire on a 0.3 m pan: Heskestad's L_f clamps to 0, so the tip is the
    fuel surface and there is no cone.

    `flame_radius_m` returning 0.0 for that case collapsed "no flame" into "a flame
    of zero radius", and an on-axis bead came out `flame` -- an ERROR here against
    the editor's `info` on the same file, which is exactly the divergence the paired
    suites exist to catch. Mirrored in web/src/core/instruments.test.ts.
    """
    plan = _fire_plan(hrr_kw=1.0)
    assert plan.burner.flame_height_m() == 0.0
    assert plan.burner.flame_radius_m(plan.burner.fuel_surface_z_m) is None

    beads = plan.thermocouple_beads(_rake(plan, [0.0, 0.0, 0.0], [0.0, 0.05], tc_type="T"))
    assert [b["region"] for b in beads] == ["outside", "outside"]
    assert [(i.severity, i.code) for i in plan.instrument_checks()]         == [("info", "tc-outside-plume")]


def test_a_bead_well_off_to_the_side_is_outside_the_plume():
    plan = _fire_plan()
    beads = plan.thermocouple_beads(_rake(plan, [3.0, 0.0, 0.0], [1.5]))
    assert beads[0]["region"] == "outside"
    assert beads[0]["gas_temperature_c"] is None


def test_plume_temperature_falls_with_height():
    plan = _fire_plan()
    tip = plan.burner.flame_tip_z_m()
    beads = plan.thermocouple_beads(
        _rake(plan, [0.0, 0.0, 0.0], [tip + 0.3, tip + 0.8, tip + 1.3])
    )
    temps = [b["gas_temperature_c"] for b in beads]
    assert all(t is not None for t in temps)
    assert temps[0] > temps[1] > temps[2]


def test_plume_temperature_is_measured_from_ambient():
    plan = _fire_plan()
    plan.environment["ambientTemperature_C"] = 40.0
    tip = plan.burner.flame_tip_z_m()
    hot = plan.thermocouple_beads(_rake(plan, [0.0, 0.0, 0.0], [tip + 0.5]))[0]

    cold = _fire_plan()
    cold.environment["ambientTemperature_C"] = 20.0
    cool = cold.thermocouple_beads(_rake(cold, [0.0, 0.0, 0.0], [tip + 0.5]))[0]

    assert hot["gas_temperature_c"] - cool["gas_temperature_c"] == pytest.approx(20.0)


def test_the_reference_plume_rake_predictions_are_stable():
    # Hand check: Qc = (1 - 0.35) * 130 = 84.5 kW, z0 = 0.231 m above the fuel
    # surface, so dT = 25 * 84.5^(2/3) * (z - 0.1 - 0.231)^(-5/3) over ambient 20 C.
    plan = Plan.load(CAMERA_ROW)
    rake = next(t for t in plan.thermocouples if t.id == "tc-plume")
    temps = [b["gas_temperature_c"] for b in plan.thermocouple_beads(rake)]
    assert temps == pytest.approx([344.0, 247.0, 190.0], abs=1.0)


# -- thermocouple placement checks ---------------------------------------

def test_a_type_t_bead_in_the_flame_is_an_over_temperature_error():
    plan = _fire_plan()
    _rake(plan, [0.0, 0.0, 0.0], [0.3], tc_type="T")  # limited to 370 C
    assert "tc-over-temperature" in codes(plan.instrument_checks())


def test_a_type_k_bead_in_the_flame_warns_rather_than_erroring():
    plan = _fire_plan()
    _rake(plan, [0.0, 0.0, 0.0], [0.3], tc_type="K")  # good to 1260 C
    found = codes(plan.instrument_checks())
    assert "tc-in-flame" in found
    assert "tc-over-temperature" not in found


def test_a_plume_hotter_than_the_bead_limit_is_an_error():
    plan = _fire_plan(hrr_kw=2000.0)
    tip = plan.burner.flame_tip_z_m()
    _rake(plan, [0.0, 0.0, 0.0], [tip + 0.05], tc_type="T")
    assert "tc-over-temperature" in codes(plan.instrument_checks())


def test_an_explicit_limit_overrides_the_letter_type():
    plan = _fire_plan()
    rake = _rake(plan, [0.0, 0.0, 0.0], [0.3], tc_type="K", max_temperature_c=200.0)
    assert rake.max_temperature_c == pytest.approx(200.0)
    assert "tc-over-temperature" in codes(plan.instrument_checks())


def test_the_letter_type_supplies_the_limit_when_none_is_recorded():
    plan = _fire_plan()
    for letter, limit in TC_MAX_TEMPERATURE_C.items():
        rake = _rake(plan, [5.0, 0.0, 0.0], [0.5], tc_type=letter, obj_id="tc-" + letter)
        assert rake.max_temperature_c == pytest.approx(limit)


def test_a_rake_entirely_outside_the_plume_is_reported_as_info_only():
    plan = Plan.load(CAMERA_ROW)
    issues = [i for i in plan.instrument_checks() if i.object_id == "tc-east-wall"]
    assert [(i.severity, i.code) for i in issues] == [("info", "tc-outside-plume")]


def test_a_burner_with_no_usable_flame_geometry_does_not_kill_the_checks():
    """`check()` is documented for a plan mid-edit, and one malformed burner used to
    take the whole check list down with a raw ValueError out of the correlation.

    The gauge path has swallowed exactly these since 1.1 (`fire_point_source`); the
    thermocouple path tested `hrr_kw is not None`, which an hrr_kw of 0 passes.
    """
    for fire in ({"hrr_kw": 0.0}, {"hrr_kw": -5.0}, {"hrr_kw": None}):
        plan = _fire_plan()
        plan.burner.raw["fire"] = dict(fire)
        _rake(plan, [0.0, 0.0, 0.5], [0.0])
        beads = plan.thermocouple_beads(plan.thermocouples[0])
        assert beads[0]["region"] == "outside"
        plan.check()  # must not raise

    # A footprint with no area is the other way in.
    plan = _fire_plan()
    plan.burner.raw["footprint"] = {"shape": "square", "size_m": [0.0, 0.0]}
    _rake(plan, [0.0, 0.0, 0.5], [0.0])
    plan.check()


def test_a_degenerate_quaternion_does_not_take_the_checks_down_with_it():
    """Four numbers is all the schema asks for; "unit" is prose. Every frame helper
    throws on a zero-length one, so a single hand-edited object used to cost the
    caller every finding in the plan -- including the one naming the bad data."""
    plan = _fire_plan()
    _gauge(plan, [1.0, 0.0, 0.5])
    plan.heat_flux_sensors[0].raw["transform"]["rotation_quat"] = [0.0, 0.0, 0.0, 0.0]
    _rake(plan, [1.0, 0.0, 0.5], [0.0])
    plan.thermocouples[0].raw["transform"]["rotation_quat"] = [0.0, 0.0, 0.0, 0.0]

    found = codes(plan.check())
    assert "non-unit-quaternion" in found  # the data problem is still named
    assert plan.heat_flux_estimate(plan.heat_flux_sensors[0]) is not None


def test_an_aim_target_without_a_quaternion_is_not_a_mismatch():
    """`forward` falls back to the identity orientation where no quaternion is
    stored, and warning that a stored quaternion disagrees with the target is a
    claim about a quaternion that is not in the file. The web stays silent here."""
    plan = _fire_plan()
    _gauge(plan, [1.0, 0.0, 0.5])
    del plan.heat_flux_sensors[0].raw["transform"]["rotation_quat"]
    assert "aim-mismatch" not in codes(plan.check())


def test_instrument_checks_stay_silent_with_no_instruments():
    assert _fire_plan().instrument_checks() == []


# -- integration ---------------------------------------------------------

def test_the_reference_plan_still_has_no_errors():
    plan = Plan.load(CAMERA_ROW)
    assert [i for i in plan.check() if i.severity == "error"] == []


def test_instruments_appear_in_the_equipment_table():
    plan = Plan.load(CAMERA_ROW)
    rows = {r["id"]: r for r in plan.equipment_table()}

    gauge = rows["hf-east"]
    assert gauge["category"] == "heat flux"
    assert "50" in gauge["detail"]
    assert gauge["height_m"] == pytest.approx(0.9)

    rake = rows["tc-plume"]
    assert rake["category"] == "thermocouple"
    assert "3 beads" in rake["detail"]
    # The top bead, not the object origin: that is the extent a drawing dimensions.
    assert rake["height_m"] == pytest.approx(2.2)


def test_instruments_round_trip_and_validate():
    plan = Plan.load(CAMERA_ROW)
    plan.validate_schema()
    again = Plan.loads(plan.dumps())
    assert again.dumps() == plan.dumps()
    assert [s.id for s in again.heat_flux_sensors] == ["hf-east", "hf-north"]
    assert [t.id for t in again.thermocouples] == ["tc-east-wall", "tc-plume"]


def test_instrument_colours_are_stable_and_sanitised():
    plan = Plan.load(CAMERA_ROW)
    gauge = plan.heat_flux_sensors[0]
    assert gauge.color == "#ef4444"
    # Untrusted display colours reach SVG and HTML attributes, so anything but the
    # one literal the schema allows is dropped rather than handed on.
    gauge.raw["display"] = {"color": "red; onload=alert(1)"}
    assert gauge.color == "#ef4444"
    gauge.raw["display"] = {"color": "#123abc"}
    assert gauge.color == "#123abc"
