"""Mirrored format 1.7 instrument and device mapping regressions."""
from pathlib import Path
from copy import deepcopy
import json
import math

import numpy as np
import pytest

from fireplan import Plan, PlanError, fds, namelist
from fireplan._math import look_at_quat
from fireplan.instrument_placement import nearest_opening, load_cell_under_fuel
from fireplan.test_data import TARGET_UNITS, source_series

FIXTURES = Path(__file__).resolve().parents[2] / 'fixtures'


def fresh():
    return Plan.load(FIXTURES / 'instruments17.ftp.json')


def test_roundtrip_api_and_byte_parity():
    plan = fresh()
    assert plan.dumps().encode() == (FIXTURES / 'instruments17.ftp.json').read_bytes()
    assert len(plan.velocity_probes) == len(plan.gas_sampling) == len(plan.load_cells) == 1
    assert plan.velocity_probes[0].range_m_s == 20
    assert plan.gas_sampling[0].species == ['O2', 'CO2']
    assert plan.gas_sampling[0].in_duct is False
    assert plan.load_cells[0].capacity_kg == 100
    assert plan.load_cells[0].platform_m == (1, 0.5)
    for obj in plan.objects:
        single = Plan(deepcopy(plan.data))
        single.data['objects'] = [deepcopy(obj.raw)]
        assert single.effective_version == '1.7.0'
        assert not single.validate_schema()


def test_opening_checks_and_alignment():
    plan = Plan.new()
    p = plan.add({'id': 'vp', 'type': 'velocityProbe', 'range_m_s': None, 'transform': {'position_m': [1, 0.1, 1]}})
    wall = plan.add({'id': 'wall', 'type': 'wall', 'polyline_m': [[0, 0], [3, 0]], 'height_m': 3,
                    'openings': [{'offset_m': 0.5, 'width_m': 1, 'height_m': 2}]})
    codes = lambda: {i.code for i in plan.check()}
    assert 'probe-not-in-opening' not in codes()
    p.position = [1, 0.1001, 1]
    assert 'probe-not-in-opening' in codes()
    assert nearest_opening(plan, p.position, 1)['normal'] == [0, -1, 0]
    p.position = [20, 0, 1]
    assert nearest_opening(plan, p.position, 1) is None
    assert 'probe-not-in-opening' in codes()
    wall.raw['transform'] = {'position_m': [4, 5, 2], 'rotation_quat': [0, 0, math.sqrt(0.5), math.sqrt(0.5)]}
    p.position = [4.1, 6, 3]
    assert 'probe-not-in-opening' not in codes()
    assert nearest_opening(plan, p.position, 1)['normal'][0] == pytest.approx(1)


def test_load_cell_overlap_and_height():
    plan = Plan.new()
    c = plan.add({'id': 'lc', 'type': 'loadCell', 'capacity_kg': None, 'platform_m': [2, 1]})
    b = plan.add({'id': 'fuel', 'type': 'burner', 'transform': {'position_m': [1.1, 0, 0.2]},
                  'footprint': {'shape': 'circle', 'diameter_m': 0.4}})
    assert load_cell_under_fuel(plan, c)
    c.raw['platform_m'] = None
    assert next(i for i in plan.check() if i.code == 'load-cell-not-under-fuel').severity == 'info'
    b.position = [0, 0, -1]
    assert not load_cell_under_fuel(plan, c)
    b.position = [0, 0, 1]
    assert load_cell_under_fuel(plan, c)


def test_yawed_and_tilted_platform():
    plan = Plan.new()
    c = plan.add({'id': 'lc', 'type': 'loadCell', 'platform_m': [2, 0.2],
                  'transform': {'position_m': [0, 0, 0], 'rotation_quat': [0, 0, math.sqrt(0.5), math.sqrt(0.5)]}})
    b = plan.add({'id': 'fuel', 'type': 'burner', 'transform': {'position_m': [0, 0.8, 0.2]},
                  'footprint': {'shape': 'rectangle', 'size_m': [0.1, 0.1]}})
    assert load_cell_under_fuel(plan, c)
    b.position = [0.8, 0, 0.2]
    assert not load_cell_under_fuel(plan, c)
    c.raw['transform']['rotation_quat'] = [0, math.sin(math.pi / 8), 0, math.cos(math.pi / 8)]
    b.position = [0.5, 0, 0]
    assert load_cell_under_fuel(plan, c)
    b.position = [-0.5, 0, 0]
    assert not load_cell_under_fuel(plan, c)


def test_import_components_magnitude_and_gas_merge():
    result = fds.to_plan((FIXTURES / 'fds/instruments17.fds').read_text(), options=fds.ImportOptions(origin_m=[0, 0, 0]))
    plan = result.plan
    assert len(plan.velocity_probes) == 4
    for p, axis in zip(plan.velocity_probes, np.eye(3)):
        assert p.axis == pytest.approx(axis)
    assert plan.velocity_probes[3].axis is None
    assert 'magnitude' in plan.velocity_probes[3].notes
    assert len(plan.gas_sampling) == 1
    assert plan.gas_sampling[0].species == ['O2', 'CO2']
    assert sum(g.objects for g in result.devices if g.mapped_to == 'gasSampling') == 1


def test_export_and_axis_boundary():
    plan = fresh()
    assert plan.to_fds_devices().encode() == (FIXTURES / 'fds/instruments17-devices.fds').read_bytes()
    p = plan.velocity_probes[0]
    plan.data['objects'] = [p.raw]
    for angle, quantity in [(5, 'U-VELOCITY'), (5.01, 'VELOCITY')]:
        a = math.radians(angle)
        p.raw['transform']['rotation_quat'] = look_at_quat(p.position, p.position + [math.cos(a), math.sin(a), 0]).tolist()
        record, = namelist.read(plan.to_fds_devices())
        assert record.string('QUANTITY') == quantity
    p.raw['transform']['rotation_quat'] = look_at_quat(p.position, p.position + [-1, 0, 0]).tolist()
    assert 'negative X' in plan.to_fds_devices()


def test_targets_and_gas_column_unit():
    plan = fresh()
    assert TARGET_UNITS['velocityProbe'] == 'm/s'
    assert TARGET_UNITS['loadCell'] == 'kg'
    assert TARGET_UNITS['gasSampling'] is None
    for obj in plan.objects:
        assert plan.series(obj) == []
    source = {'id': 'data', 'name': 'Data', 'role': 'measured',
              'table': {'sheet': None, 'shape': 'plain', 'headerRow': 1, 'unitsRow': 2, 'dataRow': 3, 'timeColumn': 0},
              'channels': [{'channel': 'oxygen', 'object': 'gas'}]}
    result = source_series(source, [['Time', 'oxygen'], ['s', '%'], [0, 20.9], [1, 19]], {'gas': None})
    assert result[('gas', None)].unit == '%'


@pytest.mark.parametrize('kind', ['plate-thermometer', 'thin-skin'])
def test_documentary_gauge_kinds(kind):
    plan = Plan.new()
    plan.add({'id': 'g', 'type': 'heatFluxSensor', 'gauge': {'kind': kind}})
    assert plan.effective_version == '1.7.0'
    assert not plan.validate_schema()


def test_additional_import_bytes():
    plan = fds.load(FIXTURES / 'fds/instruments17.fds', fds.ImportOptions(
        origin_m=[0, 0, 0], imported_at='2026-11-02T00:00:00Z')).plan
    plan.meta['created'] = plan.meta['modified'] = '2026-11-02T00:00:00Z'
    assert plan.dumps().encode() == (FIXTURES / 'fds/instruments17.ftp.json').read_bytes()


CASES = json.loads((FIXTURES / 'fds/device-export-cases.json').read_text())['instruments17']


@pytest.mark.parametrize('case', CASES, ids=lambda c: c['name'])
def test_shared_device_cases(case):
    plan = Plan.new(case['name'])
    obj = {'id': 'extra', 'name': case['name'], 'type': case['type'], 'transform': {'position_m': [1, 2, 3]}}
    if 'normal' in case:
        obj['transform']['rotation_quat'] = look_at_quat(np.array([1, 2, 3]), np.array([1, 2, 3]) + case['normal']).tolist()
    if 'species' in case:
        obj.update(species=case['species'], inDuct=False)
    plan.add(obj)
    text = plan.to_fds_devices()
    records = namelist.read(text)
    if case['type'] == 'loadCell':
        assert not records and 'load cell omitted' in text
    elif 'species' in case:
        assert [r.string('SPEC_ID') for r in records] == case['specIds']
        assert [r.string('ID') for r in records] == [case['name'] + '_' + s for s in case['species']]
        assert all(r.string('QUANTITY') == 'VOLUME FRACTION' for r in records)
    else:
        assert records[0].string('QUANTITY') == case['quantity']


def test_close_gas_sites_and_invalid_targets():
    text = ("&DEVC ID='a', XYZ=0,0,1, QUANTITY='VOLUME FRACTION', SPEC_ID='O2' /\n"
            "&DEVC ID='b', XYZ=0,0,1.00001, QUANTITY='MASS FRACTION', SPEC_ID='CO' /\n"
            "&DEVC ID='skip', XYZ=0,0,1, QUANTITY='VOLUME FRACTION', SPEC_ID='UNKNOWN' /\n")
    result = fds.to_plan(text, options=fds.ImportOptions(origin_m=[0, 0, 0]))
    assert len(result.plan.gas_sampling) == 2
    assert '1 with unsupported' in result.devices[0].note
    plan = fresh()
    source = json.loads((FIXTURES / 'test-data/test-data.ftp.json').read_text())['testData'][0]
    source['channels'] = [{'channel': 'x', 'object': o.id, 'bead': 0} for o in plan.objects]
    plan.data['testData'] = [source]
    assert sum(i.code == 'test-data-dangling' for i in plan.check()) == 3
    for c in source['channels']:
        del c['bead']
    plan.data['objects'].pop()
    assert sum(i.code == 'test-data-dangling' for i in plan.check()) == 1


@pytest.mark.parametrize('obj', [
    {'id': 'p', 'type': 'velocityProbe', 'range_m_s': -1},
    {'id': 'g', 'type': 'gasSampling', 'species': ['NOPE'], 'inDuct': False},
    {'id': 'l', 'type': 'loadCell', 'platform_m': [1, 0], 'capacity_kg': None},
])
def test_malformed_fields(obj):
    plan = Plan.new()
    plan.add(obj)
    with pytest.raises(PlanError):
        plan.validate_schema()


def test_series_api_uses_actual_units(tmp_path):
    plan = fresh()
    path = tmp_path / 'channels.csv'
    path.write_text('Time,speed,oxygen,mass\ns,m/s,%,kg\n0,1,20.9,10\n1,2,19,9\n')
    plan.data['testData'] = [{'id': 'data', 'name': 'Data', 'role': 'measured',
        'file': {'id': 'file', 'path': str(path), 'kind': 'spreadsheet'},
        'table': {'sheet': None, 'shape': 'plain', 'headerRow': 1, 'unitsRow': 2, 'dataRow': 3, 'timeColumn': 0},
        'channels': [{'channel': c, 'object': o} for c, o in [('speed', 'vp'), ('oxygen', 'gas'), ('mass', 'lc')]]}]
    assert [plan.series(o)[0].unit for o in plan.objects] == ['m/s', '%', 'kg']
    assert plan.series('gas')[0].values.tolist() == [20.9, 19]
    assert {r['id'] for r in plan.equipment_table()} == {'vp', 'gas', 'lc'}
