"""Mirrored survey, pose and next-test regressions."""
from copy import deepcopy
from pathlib import Path
import numpy as np
import pytest
from fireplan import Plan, PlanError
from fireplan._math import look_at_quat

FIXTURE = Path(__file__).resolve().parents[2] / 'fixtures/asbuilt-series.ftp.json'


def fresh():
    return Plan.load(FIXTURE)


def test_roundtrip_parity_and_version():
    p = fresh()
    p.validate_schema()
    assert p.dumps().encode() == FIXTURE.read_bytes()
    assert p.effective_version == '1.7.0'
    for o in p.data['objects']:
        del o['asBuilt']
    assert p.effective_version == '1.1.0'
    p.data['objects'] = []
    assert p.effective_version == '1.0.0'  # series is open metadata


def test_survey_canonical_order_rounding_and_unknown_precision():
    p = fresh()
    p.data['meta'] = dict(reversed(list(p.meta.items())))
    for o in p.data['objects']:
        a = o.pop('asBuilt')
        a['transform'] = dict(reversed(list(a['transform'].items())))
        o['asBuilt'] = dict(reversed(list(a.items())))
    p.data['objects'][0]['asBuilt']['transform']['position_m'][0] = 1.30000000001
    unknown = p.data['objects'][2]
    unknown['asBuilt']['transform']['position_m'][0] = 0.123456789
    p.data['objects'][2] = dict(asBuilt=unknown.pop('asBuilt'), **unknown)
    assert p.dumps().encode() == FIXTURE.read_bytes()


@pytest.mark.parametrize('bad', [None, {}, {'transform': {'position_m': [1, 2]}, 'measured': None, 'note': None},
    {'transform': {'position_m': [1, 2, 3]}, 'measured': '2026-02-30', 'note': None},
    {'transform': {'position_m': [1, 2, 3]}, 'measured': None, 'note': 3},
    {'transform': {'position_m': [float('nan'), 2, 3]}, 'measured': None, 'note': None},
    {'transform': {'position_m': [1, 2, 3], 'rotation_quat': [0, 0, float('inf'), 1]}, 'measured': None, 'note': None}])
def test_invalid_asbuilt(bad):
    p = fresh()
    p.data['objects'][0]['asBuilt'] = bad
    with pytest.raises(PlanError):
        p.validate_schema()


def test_asbuilt_requires_planned_transform_even_for_unknown():
    p = fresh()
    p.data['objects'][0]['type'] = 'future'
    del p.data['objects'][0]['transform']
    with pytest.raises(PlanError):
        p.validate_schema()


def test_schema_extension_keeps_unrelated_unknown_objects_compatible():
    p = Plan.new()
    p.add({'id': 'future', 'type': 'future', 'transform': {'futureTransform': 42}})
    # Earlier 1.7 accepts arbitrary unknown-object content. The extension must
    # only require a valid planned transform when a survey actually uses it.
    p.validate_schema('1.7.0')


@pytest.mark.parametrize('convention', ['opencv', 'colmap', 'opengl', 'three', 'gl', 'cv', 'nerfstudio'])
def test_pose_conversion_and_planning_unchanged(convention):
    p = fresh()
    c = p.cameras['cam']
    c.raw['asBuilt']['transform']['rotation_quat'] = look_at_quat(np.array([1.3, 2.4, 2.96]), np.array([-1, 0.4, 1.2])).tolist()
    measured = deepcopy(c.raw['asBuilt']['transform'])
    reference = fresh().cameras['cam']
    reference.raw['transform'] = measured
    del reference.raw['asBuilt']
    for inverse in (False, True):
        np.testing.assert_allclose(c.extrinsics(convention, inverse, pose='best'), reference.extrinsics(convention, inverse))
        np.testing.assert_allclose(c.extrinsics(convention, inverse, pose='as-built'), reference.extrinsics(convention, inverse))
        planned = fresh().cameras['cam']
        del planned.raw['asBuilt']
        np.testing.assert_allclose(c.extrinsics(convention, inverse, pose='planned'), planned.extrinsics(convention, inverse))
    assert c.pose_used() == 'as-built'
    assert c.pose_used('planned') == 'planned'
    np.testing.assert_allclose(c.extrinsics(pose='planned')[:3, 3], [1, 2, 3])
    np.testing.assert_allclose(c.position, [1, 2, 3])
    assert reference.pose_used() == 'planned'
    with pytest.raises(ValueError):
        reference.extrinsics(pose='as-built')
    with pytest.raises(ValueError):
        c.pose_used('typo')


def test_nerfstudio_provenance_and_setout_numbers():
    p = fresh()
    planned = deepcopy(p.cameras['cam'].raw)
    planned['id'] = 'planned-only'
    del planned['asBuilt']
    p.add(planned)
    out = p.to_nerfstudio()
    np.testing.assert_allclose(out['frames'][0]['transform_matrix'], p.cameras['cam'].extrinsics('opengl', pose='best'))
    assert out['metadata']['poses']['cam'] == {'pose': 'as-built', 'measured': '2026-11-02'}
    assert out['metadata']['poses']['planned-only'] == {'pose': 'planned', 'measured': None}
    row = p.set_out_check()[0]
    assert row['plan_distance_m'] == pytest.approx(0.5)
    assert row['height_difference_m'] == pytest.approx(-0.04)
    assert row['aim_difference_deg'] == pytest.approx(180)
    assert p.set_out_check()[1]['aim_difference_deg'] is None


@pytest.mark.parametrize('old,new', [('T-007', 'T-008'), ('EX-001', 'EX-002'), ('T-099', 'T-100'),
    ('T-999', 'T-1000'), ('Test', 'Test-2'), ('', '-2'), (None, '-2'), ('X-9007199254740999', 'X-9007199254741000')])
def test_next_test(old, new):
    p = fresh()
    p.meta['testId'] = old
    p.data['testData'] = [{'id': 'old-data'}]
    p.add({'id': 'flame', 'type': 'reconstructedFlame'})
    p.add({'id': 'future', 'type': 'future', 'linkedFiles': [{'id': 'file'}]})
    for o in p.data['objects'][:2]:
        o['linkedFiles'] = [{'id': 'file'}]
    before = deepcopy(p.data)
    next_plan = p.next_test()
    assert next_plan.source_path is None
    assert p.data == before
    assert next_plan.meta['testId'] == new
    assert next_plan.meta['series'] == p.meta['series']
    assert next_plan.meta['revision'] is None
    assert next_plan.meta['created'] == next_plan.meta['modified'] != p.meta['created']
    assert 'testData' not in next_plan.data
    assert [o.type for o in next_plan] == ['camera', 'thermocouple', 'future', 'future']
    assert all('linkedFiles' not in o.raw and 'asBuilt' not in o.raw for o in next_plan)
    next_plan.cameras['cam'].position = [9, 9, 9]
    assert p.data == before


def test_every_placed_type_accepts_survey_and_preserves_planning():
    p = Plan.load(FIXTURE.parent / 'flame/flame-test.ftp.json')
    p.data['objects'].extend(Plan.load(FIXTURE.parent / 'instruments17.ftp.json').data['objects'])
    planned = p.equipment_table()
    for o in p.data['objects']:
        o.setdefault('transform', {'position_m': [0, 0, 0]})
        o['asBuilt'] = {'transform': deepcopy(o['transform']), 'measured': None, 'note': None}
        o['asBuilt']['transform']['position_m'] = [91, 92, 93]
    p.validate_schema()
    assert p.equipment_table() == planned
    assert Plan.loads(p.dumps()).dumps() == p.dumps()
