import copy
import json
import math
from pathlib import Path
import runpy

import pytest

from fireplan import Plan, PlanError, GROWTH_RATES, t2_curve, curve_from_series, fds
from fireplan.hrr import curve_problem, curve_peak

ROOT = Path(__file__).resolve().parents[2]
SHARED = json.loads((ROOT / 'fixtures/hrr/parity.json').read_text(encoding='utf-8'))


def plan():
    return Plan.loads(SHARED['plan'])


def test_shared_fixture_is_reproducible():
    assert runpy.run_path(str(ROOT / 'tools/build_hrr_fixture.py'))['build']() == SHARED


def test_interpolation_and_peak_mismatch():
    p = plan()
    b = p.burner
    b.fire['hrrCurve'] = {'source': 'test', 'points': [[5, 0], [10, 100], [20, 25]]}
    b.fire['hrr_kw'] = 10
    assert [b.hrr_at(t) for t in [-10, 5, 7.5, 10, 15, 30]] == [0, 0, 50, 100, 62.5, 25]
    assert b.hrr_kw == 100
    issue = next(i for i in p.check() if i.code == 'hrr-curve-peak')
    assert issue.severity == 'warning' and '10 kW' in issue.message and '100' in issue.message
    saved = Plan.loads(p.dumps())
    assert saved.burner.fire['hrr_kw'] == 100
    assert list(saved.burner.fire['hrrCurve']) == ['points', 'source']
    assert not any(i.code == 'hrr-curve-peak' for i in saved.check())
    assert b.fire['hrr_kw'] == 10
    for source in saved.burners:
        source.fire['hrrCurve'] = None
    assert Plan.loads(saved.dumps()).format_version == '1.1.0'
    assert not any(i.code == 'version-understated' for i in saved.check())
    saved.data['version'] = '1.8.0'
    assert Plan.loads(saved.dumps()).format_version == '1.8.0'
    assert b.flame_height_m(5) == b.flame_tip_z_m(5) == 0
    del b.fire['hrr_kw']
    assert list(Plan.loads(p.dumps()).burner.fire) == ['hrr_kw', 'hrrCurve']


@pytest.mark.parametrize('curve', [
    {}, {'points': [[0, 1]]}, {'points': [[0, 1], [0, 2]]}, {'points': [[1, 1], [0, 2]]},
    {'points': [[-1, 1], [0, 2]]}, {'points': [[0, -1], [1, 2]]}, {'points': [[0, 1], [1, math.inf]]},
    {'points': [[0, 1], [math.nan, 2]]}, {'points': [[False, 1], [1, 2]]}, {'points': [[0, 1, 3], [1, 2]]},
    {'points': [[0, 1], [1, 2]], 'source': None}, {'points': [[0, 1], [1, 2]], 'extra': 1},
    {'points': [[i, 1] for i in range(10001)]},
])
def test_invalid_curves_fail_at_load_schema_and_write(curve):
    p = plan()
    p.burner.fire['hrrCurve'] = curve
    assert curve_problem(curve)
    with pytest.raises((PlanError, ValueError)):
        Plan.loads(json.dumps(p.data))
    with pytest.raises(PlanError):
        p.validate_schema()
    with pytest.raises(ValueError):
        p.dumps()


def test_zero_peak_close_times_and_schema_mirror():
    p = plan()
    p.burner.fire['hrrCurve'] = {'points': [[0, 0], [1e-9, 0], [2e-9, 0]]}
    loaded = Plan.loads(p.dumps())
    loaded.validate_schema()
    assert loaded.burner.fire['hrr_kw'] == 0
    assert loaded.burner.fire['hrrCurve']['points'][1][0] == 1e-9
    loaded.data['objects'].append({'id': 'hood', 'type': 'hood', 'opening_m': [2, 2], 'height_m': 3})
    loaded.check()
    assert (ROOT / 'schema/fire-test-plan-1.7.0.schema.json').read_bytes() == (ROOT / 'python/fireplan/schemas/fire-test-plan-1.7.0.schema.json').read_bytes()
    assert not curve_problem({'points': [[i, 1] for i in range(10000)]})


@pytest.mark.parametrize('path', ['pool-fire-camera-row.ftp.json', 'flame/flame-test.ftp.json', 'fds/room_corner.ftp.json'])
def test_reference_checks_stay_at_peak(path):
    p = Plan.load(ROOT / 'fixtures' / path)
    before = [i for i in p.check() if i.code != 'version-understated']
    for b in p.burners:
        if b.hrr_kw is not None:
            b.fire['hrrCurve'] = {'points': [[0, 0], [60, b.hrr_kw], [90, 0]]}
    assert [i for i in p.check() if i.code != 'version-understated'] == before


def test_time_predictions_match_independent_steady_snapshots():
    p = plan()
    for row in SHARED['predictions']:
        t = row['t']
        assert p.heat_flux_estimate(p.heat_flux_sensors[0], t)['incident_kw_m2'] == pytest.approx(row['flux'])
        assert p.burner.flame_height_m(t) == pytest.approx(row['height'])
        assert p.flame_tip_z_m(t) == p.burner.flame_tip_z_m(t)
        assert [b['gas_temperature_c'] for b in p.thermocouple_beads(p.thermocouples[0], t)] == pytest.approx(row['beads'])
        steady = Plan(copy.deepcopy(p.data))
        steady.data['objects'] = [o for o in steady.data['objects'] if o.get('type') != 'burner'
                                  or next(b for b in p.burners if b.id == o['id']).hrr_at(t) > 0]
        for b in steady.burners:
            b.fire['hrr_kw'] = b.hrr_at(t)
            b.fire['hrrCurve'] = None
        assert p.heat_flux_estimate(p.heat_flux_sensors[0], t)['incident_kw_m2'] == pytest.approx(steady.heat_flux_estimate(steady.heat_flux_sensors[0])['incident_kw_m2'])
    p.data['objects'] = [o for o in p.data['objects'] if o['id'] != 'b2']
    assert p.heat_flux_estimate(p.heat_flux_sensors[0], 0)['incident_kw_m2'] == 0
    assert all(b['region'] == 'outside' for b in p.thermocouple_beads(p.thermocouples[0], 0))


def test_curve_builders():
    assert list(GROWTH_RATES.values()) == [.00293, .01172, .0469, .1876]
    c = t2_curve(alpha_kW_s2=.0469, peak_kW=300, hold_s=25, decay_s=45)
    growth = math.sqrt(300 / .0469)
    assert {growth, growth + 25, growth + 70} <= {t for t, _ in c['points']}
    assert curve_peak(c) == 300 and c['points'][-1][1] == 0
    for t, q in c['points']:
        if t < growth:
            assert q == pytest.approx(.0469 * t ** 2)
    assert curve_from_series(list(range(12)), [-1, 0, 10, 2, 20, 3, 30, 4, 40, 5, 50, 0], 8) == SHARED['measured']
    with pytest.raises(ValueError):
        curve_from_series([0, 1], [0, -math.inf])
    with pytest.raises(ValueError):
        t2_curve(alpha_kW_s2=0, peak_kW=10, hold_s=0, decay_s=10)
    with pytest.raises(ValueError):
        t2_curve(alpha_kW_s2=1, peak_kW=10, hold_s=0, decay_s=10, step_s=1e-10)


@pytest.mark.parametrize('case', SHARED['imports'], ids=lambda c: c['name'])
def test_fds_curves(case):
    r = fds.to_plan(case['input'], 'case.fds', fds.ImportOptions(imported_at='2026-08-15T00:00:00Z'))
    r.plan.meta['created'] = r.plan.meta['modified'] = '2026-08-15T00:00:00Z'
    assert r.plan.dumps() == case['output']
    b = r.plan.burner
    if case['name'] in ('controlled', 'controlled-vent', 'temperature', 'duplicates'):
        assert b.fire['hrrCurve'] is None
        assert any(i.code == 'fds-hrr-curve-skipped' for i in r.issues)
    else:
        assert any(i.code == 'fds-hrr-curve' for i in r.issues)
    if case['name'] == 'tau-positive':
        assert b.hrr_at(40) == pytest.approx(200 * math.tanh(1))
    if case['name'] == 'tau-negative':
        assert b.hrr_at(40) == 200
    if case['name'] == 'react-combustion':
        assert b.fire['hrrCurve']['points'] == [[0, 0], [10, 400]]
    if case['name'] == 'mixed-side-curves':
        assert b.fire['hrrCurve']['points'] == [[0, 200], [10, 100]]
