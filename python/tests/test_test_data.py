"""Format 1.6 model, readers and Save As parity with the TypeScript suite."""
from copy import deepcopy
import json
from pathlib import Path

import numpy as np
import pytest

from fireplan import Plan, PlanError, VERSION_LATEST
from fireplan.linked_files import for_destination, resolve_path
from fireplan.serialize import required_version
from fireplan.test_data import manifest_for, manifest_mismatch, read_source, source_series

ROOT = Path(__file__).resolve().parents[2]
FOLDER = ROOT / 'fixtures/test-data'
TEXT = (FOLDER / 'test-data.ftp.json').read_text(encoding='utf-8')
EXPECTED = json.loads((FOLDER / 'series-expected.json').read_text(encoding='utf-8'))


def load():
    return Plan.load(FOLDER / 'test-data.ftp.json')


def test_fixture_version_and_schema():
    p = load()
    assert p.dumps() == TEXT
    assert required_version(p.data) == '1.6.0'
    assert VERSION_LATEST == '1.7.0'
    p.validate_schema()
    with pytest.raises(PlanError, match='testData'):
        p.validate_schema('1.5.0')
    assert not [i for i in p.check() if i.code.startswith('test-data-')]
    p.data['version'] = '1.0.0'
    assert 'version-understated' in [i.code for i in p.check()]
    assert p.dumps() == TEXT
    p.data['version'] = '2.0.0'
    assert json.loads(p.dumps())['version'] == '2.0.0'
    empty = Plan.new()
    empty.data['testData'] = []
    assert required_version(empty.data) == '1.0.0'
    assert 'testData' not in json.loads(empty.dumps())
    empty.data['version'] = '1.6.0'
    assert json.loads(empty.dumps())['version'] == '1.6.0'
    assert (ROOT / 'schema/fire-test-plan-1.6.0.schema.json').read_bytes() == (ROOT / 'python/fireplan/schemas/fire-test-plan-1.6.0.schema.json').read_bytes()


def test_precision_order_and_forward_keys():
    p = load()
    source = p.test_data[0].raw
    tiny = 1.23456789012345e-8
    source['channels'][0]['scale'] = tiny
    source['timeOffset_s'] = tiny
    source['manifest']['channels'][0]['t0'] = -tiny
    source['extra'] = dict(coefficient=tiny)
    before = deepcopy(p.data)
    result = json.loads(p.dumps())
    assert result['testData'][0] == source
    assert list(result)[-1] == 'testData'
    assert list(result['testData'][0]) == ['id', 'name', 'role', 'file', 'table', 'timeOffset_s', 'channels', 'manifest', 'extra']
    assert p.data == before
    with pytest.raises(PlanError, match='extra'):
        p.validate_schema()


def test_all_series_and_manifests():
    p = load()
    assert [s.name for s in p.test_data] == ['Synthetic logger', 'Synthetic FDS']
    assert p.series(p.burner) == []
    for e in EXPECTED:
        by_id = p.series(e['object'], e['bead'])
        obj = next(o for o in p.objects if o.id == e['object'])
        s = next(s for s in p.series(obj, e['bead']) if s.source_id == e['sourceId'])
        assert len(by_id) == len(p.series(obj, e['bead']))
        assert (s.source, s.role, s.unit, len(s.t), s.missing) == (e['source'], e['role'], e['unit'], e['samples'], e['missing'])
        assert s.t.dtype == s.values.dtype == np.dtype('float64')
        assert [s.t[0], s.values[0], s.t[-1], s.values[-1]] == pytest.approx(e['first'] + e['last'], rel=1e-12, abs=0)
    for source in p.test_data:
        path = Path(p.linked_file_path(source.file))
        grid, units = read_source(source, path)
        info = dict(size=path.stat().st_size, modified=None, units=units, table=source.table)
        assert manifest_for(source, grid, info) == source.manifest
        assert manifest_mismatch(source.manifest, info, grid) == []
    # An explicit single metadata sheet reproduces the same calibrated series.
    p.test_data[0].table['unitsSheet'] = 'Metadata'
    assert p.series('hf-east')[0].unit == 'kW/m2'
    with pytest.raises(PlanError, match='bead'):
        p.series('tc-tree')
    with pytest.raises(PlanError, match='bead'):
        p.series('tc-tree', 5)
    with pytest.raises(PlanError, match='bead'):
        p.series('hf-east', 0)
    with pytest.raises(PlanError, match='unsupported'):
        p.series('absent')


@pytest.mark.parametrize('path,value', [
    (('id',), ''), (('role',), ['measured']), (('file', 'kind'), 'video'),
    (('file', 'path'), 'https://example.test/a.xlsx'), (('file', 'extra'), 1), (('file', 'plot'), {}),
    (('table', 'shape'), 'other'), (('table', 'headerRow'), 0), (('table', 'unitsRow'), 0.5),
    (('table', 'dataRow'), None), (('table', 'shape'), 'plain'), (('table', 'unitsSheet'), 4),
    (('table', 'sheet'), None), (('channels', 0, 'scale'), 0), (('channels', 0, 'offset'), None),
    (('channels', 0, 'bead'), -1), (('timeOffset_s',), float('inf')),
    (('manifest', 'size'), -1), (('manifest', 'modified'), 3), (('manifest', 'rows'), 1.5),
    (('manifest', 'channels', 0, 't1'), -1), (('manifest', 'channels', 0, 'samples'), 0),
    (('manifest', 'extra'), 1),
])
def test_invalid_source(path, value):
    p = load()
    obj = p.test_data[0].raw
    for key in path[:-1]:
        obj = obj[key]
    obj[path[-1]] = value
    with pytest.raises(PlanError):
        p.validate_schema()


def test_invalid_sources_and_manifest_membership():
    p = load()
    p.data['testData'].append(deepcopy(p.data['testData'][0]))
    with pytest.raises(PlanError, match='unique'):
        p.validate_schema()
    p = load()
    p.test_data[0].manifest['channels'].pop()
    with pytest.raises(PlanError, match='exactly'):
        p.validate_schema()
    for value in [None, {}, 4]:
        p.data['testData'] = value
        with pytest.raises(PlanError):
            p.validate_schema()


def test_semantic_checks():
    p = load()
    c = p.test_data[0].channels
    c[0]['object'] = 'absent'
    c[1]['object'] = 'tc-tree'
    c[2]['bead'] = 5
    c.append(dict(c[3]))
    issues = [i for i in p.check() if i.code.startswith('test-data-')]
    assert [i.code for i in issues] == ['test-data-dangling'] * 3 + ['test-data-duplicate']
    assert all(i.severity == 'warning' for i in issues)
    c[0].update(object='burner', bead=0)
    next(o for o in p.objects if o.id == 'hf-west').raw['type'] = 'futureInstrument'
    c[1]['object'] = 'hf-west'
    assert len([i for i in p.check() if i.code == 'test-data-dangling']) == 3
    p.validate_schema()  # References are warnings, not structural refusals.


def test_layout_calibration_mismatch_and_duplicate_policy():
    source = load().test_data[1]
    source.raw['channels'] = [dict(channel='Power', object='burner', scale=-2, offset=7)]
    source.raw['table'] = dict(sheet=None, shape='plain', headerRow=2, unitsRow=3, dataRow=4, timeColumn=1)
    source.raw['timeOffset_s'] = 10
    grid = [['note'], ['Power', 'Time'], ['V', 's'], [3, 10], [None, 11], [4, 12], [8, 12]]
    before = deepcopy(grid)
    s = source_series(source, grid, {'burner': 'kW'})[('burner', None)]
    assert s.t.tolist() == [0, 2] and s.values.tolist() == [1, -1] and s.missing == 1 and s.unit == 'kW'
    assert grid == before
    info = dict(size=50, modified=None, table=source.table)
    manifest = manifest_for(source, grid, info)
    assert manifest_mismatch(manifest, info, grid) == []
    grid[2][0] = 'W'
    assert manifest_mismatch(manifest, dict(info, size=51, modified='changed'), grid) == [
        'File size changed.', 'File modification time changed.', 'Unit of mapped channel "Power" changed.']
    source.channels.append(dict(source.channels[0]))
    with pytest.raises(ValueError, match='more than once'):
        source_series(source, grid, {'burner': 'kW'})
    source.channels.pop()
    grid[1][0] = 'renamed'
    assert manifest_mismatch(manifest, info, grid) == ['Mapped channel "Power" is missing.']
    with pytest.raises(ValueError, match='missing'):
        source_series(source, grid, {'burner': 'kW'})
    with pytest.raises(ValueError, match='missing'):
        manifest_for(source, grid, info)


@pytest.mark.parametrize('case', json.loads((ROOT / 'fixtures/linked-files/path-cases.json').read_text(encoding='utf-8')))
def test_portable_source_paths(case):
    data = dict(objects=[], testData=[dict(file=dict(path=case['path']))])
    saved = for_destination(data, case['source'], case['destination'])
    assert saved['testData'][0]['file']['path'] == case['saved']
    assert resolve_path(case['path'], case['source']).replace('\\', '/') == case['absolute']
    assert data['testData'][0]['file']['path'] == case['path']


def test_save_as_series_and_missing_path(tmp_path, monkeypatch):
    original, revised = tmp_path / 'original', tmp_path / 'revised'
    original.mkdir(); revised.mkdir()
    (original / 'test.ftp.json').write_bytes(TEXT.encode('utf-8'))
    for name in ['logger-export.xlsx', 'room-test_devc.csv']:
        (original / name).write_bytes((FOLDER / name).read_bytes())
    p = Plan.load(original / 'test.ftp.json')
    source = p.test_data[0]
    initial = p.series('hf-east')[0].values.copy()
    target = revised / 'test.ftp.json'
    p.save(target, update_modified=False)
    assert source.file['path'] == '../original/logger-export.xlsx'
    assert Path(p.linked_file_path(source.file)) == original / 'logger-export.xlsx'
    assert np.array_equal(p.series('hf-east')[0].values, initial)
    assert np.array_equal(Plan.load(target).series('hf-east')[0].values, initial)
    p.save(target, update_modified=False)
    before = deepcopy(p.data)
    monkeypatch.setattr('fireplan.plan._write_atomic', lambda *args: (_ for _ in ()).throw(OSError('disk full')))
    with pytest.raises(OSError, match='disk full'):
        p.save(original / 'failed.ftp.json')
    assert p.data == before and p.source_path == str(target)
    source.file['path'] = '../original/missing.xlsx'
    with pytest.raises(FileNotFoundError) as exc:
        p.series('hf-east')
    assert str(original / 'missing.xlsx') in str(exc.value)


@pytest.mark.parametrize('suffix', ['.csv', '.tsv', '.txt'])
def test_delimited_plan_series(tmp_path, suffix):
    path = tmp_path / ('data' + suffix)
    path.write_bytes(b'Time,Power\n0,3\n1,4\n')
    p = load()
    s = p.test_data[0]
    s.file['path'] = str(path)
    s.raw['table'] = dict(sheet=None, shape='plain', headerRow=1, unitsRow=None, dataRow=2, timeColumn=0)
    s.raw['channels'] = [dict(channel='Power', object='burner', scale=2, offset=1)]
    s.raw['timeOffset_s'] = 1
    result = p.series('burner')[0]
    assert result.unit == 'kW' and result.t.tolist() == [-1, 0] and result.values.tolist() == [7, 9]
