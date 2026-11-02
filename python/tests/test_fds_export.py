"""Instrument export parity, frames and round trips through the existing reader."""
import json
import math
import re
from copy import deepcopy
from pathlib import Path

import numpy as np
import pytest

from fireplan import Plan, fds, namelist
from fireplan._math import look_at_quat
from fireplan.occlusion import mounting_ior
from fireplan.objects import HeatFluxSensor, Thermocouple

FIXTURES = Path(__file__).resolve().parents[2] / 'fixtures'
SOURCES = ['flame/flame-test', 'pool-fire-camera-row', 'fds/room_corner']
SHARED = json.loads((FIXTURES / 'fds/device-export-cases.json').read_text(encoding='utf-8'))
SURFACE_NOTE = "FDS &DEVC QUANTITY='WALL TEMPERATURE' -- a surface temperature, not a gas temperature"


def devices(text):
    return [r for r in namelist.read(text) if r.group == 'DEVC']


@pytest.mark.parametrize('source', SOURCES)
def test_shared_bytes_and_round_trip(source):
    plan = Plan.load(FIXTURES / (source + '.ftp.json'))
    before = deepcopy(plan.data)
    text = plan.to_fds_devices()
    expected = FIXTURES / ('fds/' + source.split('/')[-1] + '-devices.fds')
    assert text.encode('utf-8') == expected.read_bytes()
    assert plan.to_fds_devices() == text
    assert plan.data == before
    assert '\r' not in text
    assert text.splitlines()[4] == '! Written by FireTestPlanner'
    assert 'BEAD_DIAMETER=' not in text
    assert all(r.group in ('PROP', 'DEVC') for r in namelist.read(text))
    exported = devices(text)
    origin = (plan.meta.get('source') or {}).get('originOffset_m', [0, 0, 0])
    options = dict(origin_m=origin, imported_at='2026-11-02T00:00:00Z')
    single = fds.to_plan(text, options=fds.ImportOptions(**options, group_rakes=False))
    assert len(single.plan.objects) == len(exported)
    assert all(g.mapped_to is not None and g.objects == g.count for g in single.devices)
    copies = {o.name: o for o in single.plan.objects}
    for obj in plan.objects:
        if isinstance(obj, HeatFluxSensor):
            copy = copies[obj.name]
            assert isinstance(copy, HeatFluxSensor)
            assert np.linalg.norm(obj.position - copy.position) < 0.001
            angle = math.degrees(math.acos(float(np.clip(np.dot(obj.normal, copy.normal), -1, 1))))
            assert angle < 0.5
        elif isinstance(obj, Thermocouple):
            for i, bead in enumerate(obj.bead_positions):
                name = obj.name if len(obj.bead_positions) == 1 else '{}_{}'.format(obj.name, i + 1)
                if source == 'fds/room_corner':
                    name = re.sub(r'[0-9]+$', '', obj.name.split('-')[0]) + str(i + 1)
                copy = copies[name]
                assert isinstance(copy, Thermocouple)
                assert np.linalg.norm(bead - copy.position) < 0.001
                surface = (obj.raw.get('mount') or {}).get('type') in ('wall', 'ceiling')
                assert copy.bead_diameter_mm == (None if surface else obj.bead_diameter_mm)
                if surface:
                    assert copy.raw['mount']['type'] == 'wall'
                    assert copy.raw['notes'] == SURFACE_NOTE
                    if source == 'fds/room_corner':
                        assert copy.raw['notes'] == obj.raw['notes']
    # Quantity and IOR keep coincident gas and surface runs separate.
    grouped = fds.to_plan(text, options=fds.ImportOptions(**options))
    assert all(g.mapped_to is not None and g.note == '' for g in grouped.devices)
    runs = {}
    for r in exported:
        if r.string('QUANTITY') in ('THERMOCOUPLE', 'WALL TEMPERATURE'):
            key = (r.string('QUANTITY'), r.number('IOR'), *[fds._round4(v) for v in r.numbers('XYZ')[:2]])
            runs.setdefault(key, []).append(r)
    rakes = [o for o in grouped.plan.objects if isinstance(o, Thermocouple)]
    assert len(rakes) == len(runs)
    for rake, run in zip(rakes, runs.values()):
        run.sort(key=lambda r: r.numbers('XYZ')[2])
        name = run[0].string('ID') if len(run) == 1 else '{}-{}'.format(run[0].string('ID'), run[-1].string('ID'))
        assert rake.name == name
        if run[0].string('QUANTITY') == 'WALL TEMPERATURE':
            assert rake.raw['mount']['type'] == 'wall'
            assert rake.raw['notes'] == SURFACE_NOTE
        assert len(rake.bead_positions) == len(run)
        for bead, r in zip(rake.bead_positions, run):
            assert np.linalg.norm(bead - (np.array(r.numbers('XYZ')) - origin)) < 0.001
    gauges = [r for r in exported if 'HEAT FLUX' in r.string('QUANTITY')]
    if source == 'fds/room_corner':
        assert [r.string('ID') for r in gauges if r.number('IOR') == 2] == ['BACK_HF_{}'.format(i) for i in range(1, 7)]
        assert [r.string('ID') for r in gauges if r.number('IOR') == 1] == ['SIDE_HF_{}'.format(i) for i in range(1, 7)]
        assert [r.string('ID') for r in gauges if r.number('IOR') == 3] == ['FLOOR_HF']
        assert all(r.string('QUANTITY') == 'GAUGE HEAT FLUX' for r in gauges)
        original = {r.string('ID'): r for r in devices((FIXTURES / 'fds/room_corner.fds').read_text(encoding='utf-8'))}
        assert sorted(r.string('ID') for r in exported) == sorted(original)
        for r in exported:
            name = r.string('ID')
            assert np.linalg.norm(np.array(r.numbers('XYZ')) - original[name].numbers('XYZ')) < 0.001
            if '_WT_' in name:
                assert r.string('QUANTITY') == original[name].string('QUANTITY')
                assert r.number('IOR') == original[name].number('IOR')
                assert r.string('PROP_ID') is None
        assert sum(r.string('QUANTITY') == 'WALL TEMPERATURE' for r in exported) == 12
        assert len(rakes) == 4
    else:
        assert [(r.string('ID'), r.number('IOR')) for r in gauges] == [('East wall gauge', -1), ('North wall gauge', -2)]
        assert len(gauges[1].numbers('ORIENTATION')) == 3


@pytest.mark.parametrize('case', SHARED['cases'], ids=lambda c: c['name'])
def test_mounting_classification(case):
    plan = Plan.new(case['name'])
    if case.get('solid'):
        plan.add(deepcopy(SHARED['solids'][case['solid']]))
    at = np.array(case['at'])
    plan.add({'id': 'g', 'type': 'heatFluxSensor', 'transform': {
        'position_m': at.tolist(), 'rotation_quat': look_at_quat(at, at + case['normal']).tolist()}})
    text = plan.to_fds_devices()
    assert text == case['exportText']
    record, = devices(text)
    expected = case.get('exportIor', case['ior'])
    assert record.number('IOR') == expected
    assert record.string('QUANTITY') == ('RADIATIVE HEAT FLUX GAS' if expected is None else 'GAUGE HEAT FLUX')
    assert mounting_ior(plan.objects, at, case['normal']) == case['ior']
    comment = expected is not None and abs(case['normal'][abs(expected)-1]) < math.cos(math.radians(5))-1e-10
    assert ('factor cos(tilt)' in text) == comment


@pytest.mark.parametrize('case', SHARED['surfaceCases'], ids=lambda c: c['name'])
def test_surface_classification(case):
    plan = Plan.new(case['name'])
    for key in case.get('solids', []):
        plan.add(deepcopy(SHARED['solids'][key]))
    plan.add({'id': 'bead', 'type': 'thermocouple', 'name': 'Bead', 'transform': {'position_m': case['at']},
              'mount': {'type': case.get('mount', 'wall')}, 'thermocouple': {'beadDiameter_mm': 2}})
    before = deepcopy(plan.data)
    text = plan.to_fds_devices()
    assert plan.data == before
    record, = devices(text)
    surface = case['ior'] is not None
    assert record.number('IOR') == case['ior']
    assert record.string('QUANTITY') == ('WALL TEMPERATURE' if surface else 'THERMOCOUPLE')
    assert record.string('PROP_ID') == (None if surface else 'TC 2 mm')
    assert sum(r.group == 'PROP' for r in namelist.read(text)) == (0 if surface else 1)
    if not surface:
        assert "! Bead: surface thermocouple with no surface in the plan at that point.\n&DEVC ID='Bead'" in text
    copy, = fds.to_plan(text, options=fds.ImportOptions(origin_m=[0, 0, 0])).plan.thermocouples
    assert copy.raw['mount']['type'] == ('wall' if surface else 'pole')
    if surface:
        assert copy.raw['notes'] == SURFACE_NOTE
    plan.data['objects'].reverse()
    assert plan.to_fds_devices() == text


def test_rotated_surface_rake_and_gas_mounts():
    plan = Plan.new()
    plan.add(deepcopy(SHARED['solids']['wall']))
    plan.add({'id': 'rake', 'type': 'thermocouple', 'name': 'Rake', 'mount': {'type': 'wall'},
              'transform': {'position_m': [0.5, -0.12, 1], 'rotation_quat': [0, math.sqrt(0.5), 0, math.sqrt(0.5)]},
              'beadOffsets_m': [0, 1, 2], 'thermocouple': {'beadDiameter_mm': 2}})
    text = plan.to_fds_devices()
    records = devices(text)
    assert [(r.string('QUANTITY'), r.number('IOR'), r.string('PROP_ID')) for r in records] == [
        ('WALL TEMPERATURE', -2, None), ('THERMOCOUPLE', None, 'TC 2 mm'), ('WALL TEMPERATURE', -2, None)]
    assert [r.numbers('XYZ') for r in records] == [[0.5, -0.12, 1], [1.5, -0.12, 1], [2.5, -0.12, 1]]
    assert "! Rake_2: surface thermocouple with no surface in the plan at that point.\n&DEVC ID='Rake_2'" in text
    for mount_type in ['pole', 'floor', None]:
        gas = Plan(deepcopy(plan.data))
        gas.data['objects'][1]['mount'] = {'type': mount_type} if mount_type else None
        output = gas.to_fds_devices()
        assert all(r.string('QUANTITY') == 'THERMOCOUPLE' and r.string('PROP_ID') == 'TC 2 mm' for r in devices(output))
        assert 'no surface in the plan' not in output


@pytest.mark.parametrize('case', SHARED['beadNames'], ids=lambda c: c['name'])
def test_imported_bead_names(case):
    plan = Plan.new()
    plan.add({'id': 'tc', 'type': 'thermocouple', 'name': case['name'],
              'beadOffsets_m': [i * 0.5 for i in range(case['count'])]})
    assert [r.string('ID') for r in devices(plan.to_fds_devices())] == case['ids']


def test_recovered_ids_remain_unique():
    plan = Plan.new()
    rake = {'id': 'a', 'type': 'thermocouple', 'name': 'TC_3-TC_5', 'beadOffsets_m': [0, 0.5, 1]}
    plan.data['objects'] = [rake, dict(rake, id='b'), {'id': 'g', 'type': 'heatFluxSensor', 'name': 'TC_3'}]
    assert [r.string('ID') for r in devices(plan.to_fds_devices())] == [
        'TC_3', 'TC_4', 'TC_5', 'TC_3-TC_5_2_1', 'TC_3-TC_5_2_2', 'TC_3-TC_5_2_3', 'TC_3_2']


@pytest.mark.parametrize('field', ['DIAMETER', 'BEAD_DIAMETER'])
def test_imports_both_diameter_spellings(field):
    result = fds.to_plan("&PROP ID='bead', {}=0.002 /\n"
                         "&DEVC ID='tc', XYZ=0,0,1, QUANTITY='THERMOCOUPLE', PROP_ID='bead' /".format(field))
    tc, = result.plan.thermocouples
    assert tc.bead_diameter_mm == 2


def test_rotated_beads_names_properties_and_rounding():
    plan = Plan.new("Title\n&OBST ID='injected' /")

    def tc(id, name, x, diameter):
        return {'id': id, 'name': name, 'type': 'thermocouple', 'transform': {
            'position_m': [x, 0, 1], 'rotation_quat': [0, math.sqrt(0.5), 0, math.sqrt(0.5)]},
            'beadOffsets_m': [0, 0.5], 'thermocouple': {'beadDiameter_mm': diameter}}

    plan.data['objects'] = [tc('a', 'A', 0, 1.5), tc('b', 'A', 2, 1.5), tc('c', "O'Brien", 4, 2),
        {'id': 'd', 'name': 'A_1', 'type': 'heatFluxSensor'}, {'id': 'e', 'name': 'O_Brien', 'type': 'thermocouple'},
        {'id': 'fallback', 'type': 'thermocouple', 'transform': {'position_m': [0.0015875, -0.0000004, 1.23456789]}},
        {'id': 'camera', 'type': 'camera'}, {'id': 'future', 'type': 'futureProbe'}]
    text = plan.to_fds_devices()
    records = devices(text)
    assert [r.string('ID') for r in records] == ['A_1', 'A_2', 'A_2_1', 'A_2_2', 'O_Brien_1', 'O_Brien_2', 'A_1_2', 'O_Brien_3', 'fallback']
    assert records[1].numbers('XYZ') == [0.5, 0, 1]
    assert records[-1].numbers('XYZ') == [0.001587, 0, 1.234568]
    assert records[7].string('PROP_ID') is None
    assert [r.number('DIAMETER') for r in namelist.read(text) if r.group == 'PROP'] == [0.0015, 0.002]
    assert len(namelist.read(text)) == 11
    imported = fds.to_plan(text, options=fds.ImportOptions(group_rakes=False, origin_m=[0, 0, 0]))
    assert sorted(o.name for o in imported.plan.objects) == sorted(r.string('ID') for r in records)


def test_empty_header_does_not_require_or_insert_metadata():
    plan = Plan.new()
    del plan.data['meta']
    before = deepcopy(plan.data)
    text = plan.to_fds_devices()
    assert text.endswith('! No instruments: nothing to export.\n')
    assert not namelist.read(text)
    assert plan.data == before
