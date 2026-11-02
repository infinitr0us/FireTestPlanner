"""Shared geometry and instrument cases, mirrored in web/src/core/occlusion.test.ts."""
import hashlib
import json
from copy import deepcopy
from pathlib import Path

import pytest

from fireplan import Plan
from fireplan._math import look_at_quat
from fireplan.occlusion import FLAME_SAMPLE_COUNT, OCCLUSION_ENDPOINT_TOLERANCE_M, first_occluder

FIXTURES = Path(__file__).resolve().parents[2] / 'fixtures'
SHARED = json.loads((FIXTURES / 'occlusion/check-cases.json').read_text(encoding='utf-8'))


def test_constants():
    assert FLAME_SAMPLE_COUNT == 9
    assert OCCLUSION_ENDPOINT_TOLERANCE_M == 0.05


@pytest.mark.parametrize('case', SHARED['cases'], ids=lambda c: c['name'])
def test_shared_cases(case):
    plan = Plan.new(case['name'])
    at = case.get('at', [-4, 0, 1])
    plan.add(deepcopy(SHARED['burner']))
    gauge = plan.add({'id': 'gauge', 'type': 'heatFluxSensor', 'name': 'Test gauge',
                      'transform': {'position_m': at, 'rotation_quat': look_at_quat(at, [0, 0, 1]).tolist()},
                      'gauge': {'range_kw_m2': 50}})
    camera = plan.add({'id': 'camera', 'type': 'camera', 'name': 'Test camera',
                       'transform': {'position_m': at, 'rotation_quat': look_at_quat(at, case.get('cameraAim', [0, 0, 1])).tolist()},
                       'camera': {'modality': 'RGB', 'resolution_px': [1000, 1000], 'sensor_mm': [36, 24], 'focalLength_mm': case.get('cameraFocal', 10)}})
    for obj in case['objects']:
        plan.add(deepcopy(obj))
    before = deepcopy(plan.data)
    clear = Plan(deepcopy(plan.data))
    clear.data['objects'] = [o for o in clear.data['objects'] if o['type'] in ('burner', 'camera', 'heatFluxSensor')]
    estimate = plan.heat_flux_estimate(gauge)
    assert estimate['visible_fraction'] == case['visible'] / 9
    assert estimate['incident_kw_m2'] == clear.heat_flux_estimate(gauge)['incident_kw_m2'] * (case['visible'] / 9)
    framing = plan.framing(camera)
    camera_share = None if case.get('inFrame') == 0 else case.get('visibleInFrame', case['visible']) / case.get('inFrame', 9)
    assert framing['unobstructed'] == camera_share
    clear_framing = clear.framing(camera)
    for key in ('flame_base_visible', 'flame_tip_visible', 'plume_fraction_visible'):
        assert framing[key] == clear_framing[key]
    issues = plan.check()
    los = [i for i in issues if i.code in ('gauge-no-line-of-sight', 'gauge-partly-shadowed')]
    assert [i.code for i in los] == ([] if case['visible'] == 9 else [
        'gauge-no-line-of-sight' if case['visible'] == 0 else 'gauge-partly-shadowed'])
    if los:
        assert los[0].object_id == 'gauge'
        assert 'Test gauge' in los[0].message
        assert los[0].severity == ('error' if case['visible'] == 0 else 'warning')
    # A gauge that cannot see the fire gets one finding, not also "fit a more
    # sensitive gauge": every other gauge check judges radiation it cannot receive.
    if case['visible'] == 0:
        assert [i.code for i in issues if i.object_id == 'gauge'] == ['gauge-no-line-of-sight']
    blocked = [i for i in issues if i.code == 'camera-view-blocked']
    assert len(blocked) == int(camera_share is not None and camera_share < 1)
    if blocked:
        assert blocked[0].object_id == 'camera'
        assert blocked[0].severity == 'warning'
        assert case['blocker'] in blocked[0].message
        for name in case.get('blockers', []):
            assert name in blocked[0].message
        assert '{:.0f}%'.format((1 - camera_share) * 100) in blocked[0].message
    assert plan.data == before


@pytest.mark.parametrize('case', SHARED['segments'], ids=lambda c: c['name'])
def test_shared_segments(case):
    plan = Plan.new(case['name'])
    for obj in case['objects']:
        plan.add(deepcopy(obj))
    for a, b in [(case['a'], case['b']), (case['b'], case['a'])]:
        hit = first_occluder(plan.objects, a, b)
        assert (hit.id if hit else None) == case['blocker']


def test_reference_bytes_and_example_numbers():
    for path, digest in [
        ('pool-fire-camera-row.ftp.json', 'a1451e00a36c10e893237c54cc30cb402c9345aacf010b4d2135f76dc32aff19'),
        ('flame/flame-test.ftp.json', '7206263f12fa9da063f3ced9b91129314b9b1c8db9cf5f8f9ea423e477605dae'),
        ('fds/room_corner.ftp.json', '01686fb2bbf7dd882ccc18b83ab2661693bc80950d8473772233c7d0457bb15b'),
    ]:
        assert hashlib.sha256((FIXTURES / path).read_bytes()).hexdigest() == digest
    plan = Plan.load(FIXTURES / 'flame/flame-test.ftp.json')
    for name, flux, rng in [('East wall', 1.0, 50), ('North wall', 0.6, 10)]:
        gauge = next(g for g in plan.heat_flux_sensors if name in g.name)
        estimate = plan.heat_flux_estimate(gauge)
        assert estimate['visible_fraction'] == 1
        assert estimate['incident_kw_m2'] == pytest.approx(flux, abs=0.05)
        assert estimate['fraction_of_range'] == pytest.approx(flux / rng, abs=0.005)


def test_scales_each_admitted_fire_before_summing():
    plan = Plan.new('two fires')
    plan.add(deepcopy(SHARED['burner']))
    second = plan.add(dict(deepcopy(SHARED['burner']), id='second', transform={'position_m': [0, 4, 0]}))
    gauge = plan.add({'id': 'gauge', 'type': 'heatFluxSensor',
                      'transform': {'position_m': [-4, 0, 1], 'rotation_quat': look_at_quat([-4, 0, 1], [0, 0, 1]).tolist()},
                      'gauge': {'range_kw_m2': 50}})
    clear = plan.heat_flux_estimate(gauge)
    only = Plan.new('second only')
    only.add(deepcopy(second.raw))
    second_only = only.heat_flux_estimate(gauge)
    plan.add({'id': 'wall', 'type': 'wall', 'polyline_m': [[-2, -1], [-2, 1]], 'thickness_m': 0.2, 'height_m': 3})
    shadowed = plan.heat_flux_estimate(gauge)
    assert shadowed['incident_kw_m2'] == second_only['incident_kw_m2']
    assert shadowed['visible_fraction'] == second_only['incident_kw_m2'] / clear['incident_kw_m2']
    assert shadowed['source_id'] == 'second'
    assert any(i.code == 'gauge-partly-shadowed' for i in plan.check())
    gauge.raw['transform']['rotation_quat'] = look_at_quat([-4, 0, 1], [0, 4, 1]).tolist()
    gauge.raw['gauge']['viewAngle_deg'] = 20
    assert plan.heat_flux_estimate(gauge)['visible_fraction'] == 1
    assert not any(i.code == 'gauge-partly-shadowed' for i in plan.check())


def test_scaled_flux_drives_range_checks():
    plan = Plan.new('range checks')
    plan.add(deepcopy(SHARED['burner']))
    gauge = plan.add({'id': 'gauge', 'type': 'heatFluxSensor',
                      'transform': {'position_m': [-4, 0, 1], 'rotation_quat': look_at_quat([-4, 0, 1], [0, 0, 1]).tolist()},
                      'gauge': {}})
    flux = plan.heat_flux_estimate(gauge)['incident_kw_m2']
    gauge.raw['gauge']['range_kw_m2'] = flux * 0.8
    assert any(i.code == 'gauge-over-range' for i in plan.check())
    wall = next(c for c in SHARED['cases'] if c['name'] == 'lower four samples hidden')['objects'][0]
    plan.add(deepcopy(wall))
    assert not any(i.code == 'gauge-over-range' for i in plan.check())
    gauge.raw['gauge']['range_kw_m2'] = flux * 15
    assert any(i.code == 'gauge-low-signal' for i in plan.check())
    plan.data['objects'].pop()
    assert not any(i.code == 'gauge-low-signal' for i in plan.check())


def test_singular_point_source_keeps_sampled_share():
    plan = Plan.new('in fire')
    plan.add(deepcopy(SHARED['burner']))
    gauge = plan.add({'id': 'gauge', 'type': 'heatFluxSensor', 'transform': {'position_m': [0, 0, 1]}})
    plan.add({'id': 'box', 'type': 'obstruction', 'size_m': [2, 2, 4]})
    estimate = plan.heat_flux_estimate(gauge)
    assert estimate['visible_fraction'] == 1 / 9
    assert estimate['incident_kw_m2'] == float('inf')
    assert any(i.code == 'gauge-in-fire' for i in plan.check())
