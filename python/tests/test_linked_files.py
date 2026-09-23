"""Data links cross the schema, canonical writer, local paths and OS boundary."""
from copy import deepcopy
import json
import os
from pathlib import Path
import sys

import pytest

from fireplan import Plan, PlanError
from fireplan.linked_files import resolve_path, for_destination, parse_reconstruction_csv, MAX_CSV_BYTES, MAX_PLOT_SAMPLES
from fireplan.serialize import required_version

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'python/shell'))
import app as shell_app
import linked_files as shell_links

CSV_CASES = json.loads((ROOT / 'fixtures/linked-files/csv-cases.json').read_text(encoding='utf-8'))
PATH_CASES = json.loads((ROOT / 'fixtures/linked-files/path-cases.json').read_text(encoding='utf-8'))


@pytest.mark.parametrize('case', CSV_CASES, ids=[c['name'] for c in CSV_CASES])
def test_shared_csv_cases(case):
    if 'error' in case:
        with pytest.raises(ValueError) as exc:
            parse_reconstruction_csv(case['text'], imported_at='date')
        assert str(exc.value) == case['error']
    else:
        assert parse_reconstruction_csv(case['text'], imported_at='date') == {'importedAt': 'date', 'samples': case['samples']}


@pytest.mark.parametrize('case', PATH_CASES)
def test_shared_path_cases(case):
    assert resolve_path(case['path'], case['source']).replace('\\', '/') == case['absolute']
    data = {'objects': [{'type': 'burner', 'linkedFiles': [{'path': case['path']}]}]}
    before = deepcopy(data)
    saved = for_destination(data, case['source'], case['destination'])
    assert saved['objects'][0]['linkedFiles'][0]['path'] == case['saved']
    assert data == before


def test_complete_engineer_snapshot_and_csv_limits(linked_plan):
    text = (ROOT / 'fixtures/linked-files/volumes.csv').read_text(encoding='utf-8')
    expected = linked_plan.burners[0].linked_files[0]['plot']
    assert parse_reconstruction_csv(text, imported_at=expected['importedAt']) == expected
    header = 'timestamp_s,volume_m3,surface_area_m2\n'
    with pytest.raises(ValueError, match='5 MiB'):
        parse_reconstruction_csv(header + 'é' * (MAX_CSV_BYTES // 2))
    maximum = header + '\n'.join('{},1,2'.format(i) for i in range(MAX_PLOT_SAMPLES))
    assert len(parse_reconstruction_csv(maximum)['samples']) == MAX_PLOT_SAMPLES
    with pytest.raises(ValueError, match='20,000'):
        parse_reconstruction_csv(maximum + '\n20000,1,2')


def test_pre_ignition_schema_and_roundtrip(linked_plan):
    from jsonschema import Draft202012Validator
    schema = json.loads((ROOT / 'schema/fire-test-plan-1.3.0.schema.json').read_text(encoding='utf-8'))
    Draft202012Validator.check_schema(schema)
    linked_plan.burners[0].linked_files[0]['plot']['samples'] = [[-5, 0, 0], [0, 1, 2]]
    linked_plan.validate_schema()
    Plan.loads(linked_plan.dumps()).validate_schema()


@pytest.mark.parametrize('block', ['link', 'plot'])
def test_unknown_link_fields_are_closed(linked_plan, block):
    link = linked_plan.burners[0].linked_files[0]
    (link if block == 'link' else link['plot'])['extra'] = 1
    with pytest.raises(PlanError, match='Additional properties'):
        linked_plan.validate_schema()


def test_append_to_an_unlinked_burner_is_explicit_and_persistent(tmp_path):
    plan = Plan.load(ROOT / 'fixtures/pool-fire-camera-row.ftp.json')
    burner = plan.burners[0]
    before = plan.dumps()
    assert burner.linked_files == ()
    assert plan.dumps() == before
    with pytest.raises(AttributeError):
        burner.linked_files.append({})
    link = {'id': 'run2', 'kind': 'spreadsheet', 'path': str(tmp_path / 'run2.csv')}
    burner.add_linked_file(link)
    link['path'] = 'mutated.csv'
    assert burner.linked_files[0]['path'] != link['path']
    plan.validate_schema()
    saved = tmp_path / 'test.ftp.json'
    plan.save(saved, update_modified=False)
    assert Plan.load(saved).burners[0].linked_files[0]['id'] == 'run2'


def test_relative_shell_open_returns_an_absolute_base(shell, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'p.json').write_text('{}', encoding='utf-8')
    opened = shell.read_plan('p.json')
    assert opened['path'] == str(tmp_path / 'p.json')
    shell.adopted(opened['token'])
    assert shell.recent_files() == [str(tmp_path / 'p.json')]


def test_unreachable_network_resolution_has_relink_guidance(shell, monkeypatch):
    def unavailable(path):
        raise OSError('localized network failure')
    monkeypatch.setattr(shell_links.os.path, 'realpath', unavailable)
    result = shell.linked_file_action('//server/share/data.csv', 'spreadsheet', 'open')
    assert 'Use Relink' in result['error']
    assert 'localized network failure' not in result['error']


def test_alias_is_preserved_but_resolved_extension_is_checked(tmp_path, monkeypatch):
    target = tmp_path / 'real.csv'
    target.write_text('source', encoding='utf-8')
    alias = tmp_path / 'alias.csv'
    monkeypatch.setattr(shell_links.os.path, 'realpath', lambda path: str(target))
    assert shell_links.checked_path(str(alias), 'spreadsheet') == str(alias)
    monkeypatch.setattr(shell_links.os.path, 'realpath', lambda path: str(tmp_path / 'unsafe.exe'))
    with pytest.raises(ValueError, match='Unsupported'):
        shell_links.checked_path(str(alias), 'spreadsheet')


def test_real_directory_alias_preserves_relative_save_paths(tmp_path, linked_plan):
    import subprocess
    real, alias = tmp_path / 'data', tmp_path / 'alias'
    real.mkdir()
    (real / 'data.csv').write_text('source', encoding='utf-8')
    if os.name == 'nt':
        # Creation only: no recursive delete or shell-composed cleanup.
        result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(alias), str(real)], capture_output=True)
        assert result.returncode == 0, result.stderr.decode(errors='replace')
    else:
        alias.symlink_to(real, target_is_directory=True)
    try:
        chosen = shell_links.checked_path(str(alias / 'data.csv'), 'spreadsheet')
        assert chosen == str(alias / 'data.csv')
        linked_plan.burners[0].linked_files[0]['path'] = chosen
        destination = alias / 'plan.ftp.json'
        linked_plan.save(destination, update_modified=False)
        assert Plan.load(destination).burners[0].linked_files[0]['path'] == 'data.csv'
    finally:
        # Remove only the alias itself, leaving the target directory for pytest.
        if os.name == 'nt':
            os.rmdir(alias)
        else:
            alias.unlink()


@pytest.fixture
def linked_plan():
    return Plan.load(ROOT / 'fixtures/linked-files/linked-test.ftp.json')


@pytest.fixture
def shell(tmp_path, monkeypatch):
    monkeypatch.setenv('FIREPLAN_SHELL_HOME', str(tmp_path / 'settings'))
    return shell_app.Shell()


def test_schema_and_writer_preserve_the_example(linked_plan):
    linked_plan.validate_schema()
    text = (ROOT / 'fixtures/linked-files/linked-test.ftp.json').read_text(encoding='utf-8')
    assert linked_plan.dumps() == text
    assert linked_plan.effective_version == '1.3.0'
    assert len(linked_plan.burners[0].linked_files[0]['plot']['samples']) == 100
    with pytest.raises(PlanError):
        linked_plan.validate_schema('1.2.0')


def test_path_resolution_and_save_as_keep_targets(linked_plan, tmp_path):
    original = tmp_path / 'original'
    original.mkdir()
    (original / 'volumes.csv').write_text('source bytes', encoding='utf-8')
    (original / 'plan.ftp.json').write_text(linked_plan.dumps(), encoding='utf-8')
    linked_plan = Plan.load(original / 'plan.ftp.json')
    link = linked_plan.burners[0].linked_files[0]
    target = linked_plan.linked_file_path(link)
    dest = tmp_path / 'moved.ftp.json'
    linked_plan.save(dest, update_modified=False)
    assert linked_plan.linked_file_path(linked_plan.burners[0].linked_files[0]) == target
    reopened = Plan.load(dest)
    assert reopened.linked_file_path(reopened.burners[0].linked_files[0]) == target
    assert not os.path.isabs(reopened.burners[0].linked_files[0]['path'])
    reopened.save(tmp_path / 'again.ftp.json', update_modified=False)
    assert reopened.linked_file_path(reopened.burners[0].linked_files[0]) == target


def test_moving_the_folder_resolves_against_the_new_plan(tmp_path, linked_plan):
    directory = tmp_path / 'test'
    directory.mkdir()
    (directory / 'data.csv').write_text('example', encoding='utf-8')
    linked_plan.burners[0].linked_files[0]['path'] = 'data.csv'
    (directory / 'plan.ftp.json').write_text(linked_plan.dumps(), encoding='utf-8')
    new_directory = tmp_path / 'renamed'
    directory.rename(new_directory)
    loaded = Plan.load(new_directory / 'plan.ftp.json')
    assert loaded.linked_file_path(loaded.burners[0].linked_files[0]) == str(new_directory / 'data.csv')


def test_failed_save_does_not_rebase_in_memory(linked_plan, tmp_path, monkeypatch):
    import fireplan.plan as module
    before, source = deepcopy(linked_plan.data), linked_plan.source_path
    def refuse(*args):
        raise OSError('disk full')
    monkeypatch.setattr(module, '_write_atomic', refuse)
    with pytest.raises(OSError):
        linked_plan.save(tmp_path / 'no.ftp.json')
    assert linked_plan.data == before
    assert linked_plan.source_path == source


@pytest.mark.parametrize('bad', [
    {'path': 'https://example.com/data.csv'},
    {'kind': 'video'},
    {'plot': {'importedAt': 'date', 'samples': [[1, 0, 0], [1, 1, 1]]}},
    {'plot': {'importedAt': 'date', 'samples': [[0, -1, 0]]}},
    {'plot': {'importedAt': 'date', 'samples': [[0, float('inf'), 0]]}},
])
def test_invalid_link_data_is_rejected(linked_plan, bad):
    linked_plan.burners[0].linked_files[0].update(bad)
    with pytest.raises(PlanError):
        linked_plan.validate_schema()


def test_duplicate_link_ids_rejected_but_ids_are_local_to_objects(linked_plan):
    links = linked_plan.burners[0].linked_files
    linked_plan.burners[0].add_linked_file(links[0])
    with pytest.raises(PlanError, match='unique'):
        linked_plan.validate_schema()


def test_sensor_and_camera_link_constraints(linked_plan):
    for obj in linked_plan.data['objects']:
        if obj['type'] in ('heatFluxSensor', 'thermocouple'):
            obj['linkedFiles'] = [{'id': 'readings', 'kind': 'spreadsheet', 'path': 'readings.xlsx'}]
    linked_plan.validate_schema()
    camera = next(o for o in linked_plan.data['objects'] if o['type'] == 'camera')
    camera['linkedFiles'] = [{'id': 'video', 'kind': 'video', 'path': 'one.mp4'},
                             {'id': 'video2', 'kind': 'video', 'path': 'two.mp4'}]
    linked_plan.validate_schema()
    camera['linkedFiles'][0]['plot'] = deepcopy(linked_plan.burners[0].linked_files[0]['plot'])
    with pytest.raises(PlanError):
        linked_plan.validate_schema()


def test_measurement_precision_is_not_geometry_rounding(linked_plan):
    values = [[0, 0, 0], [1e-8, 1.23456789123, 7.89e-9]]
    linked_plan.burners[0].linked_files[0]['plot']['samples'] = values
    result = Plan.loads(linked_plan.dumps())
    result.validate_schema()
    assert result.burners[0].linked_files[0]['plot']['samples'] == values
    assert required_version({'objects': [{'type': 'obstruction'}, {'type': 'burner', 'linkedFiles': []}]}) == '1.3.0'


def test_relative_link_requires_a_base():
    with pytest.raises(ValueError, match='relative link'):
        resolve_path('data.csv')
    assert resolve_path('C:/data.csv') == 'C:\\data.csv'
    assert resolve_path('data.csv', 'fixtures/plan.json') == os.path.abspath('fixtures/data.csv')


def test_read_and_explicit_launch_actions(shell, tmp_path, monkeypatch):
    data = tmp_path / 'data.csv'
    data.write_text('\ufefftimestamp_s,volume_m3,surface_area_m2\n0,1,2\n', encoding='utf-8')
    launches = []
    monkeypatch.setattr(shell_links, 'launch', lambda path, folder=False: launches.append((path, folder)))
    assert shell.linked_file_action(str(data), 'spreadsheet', 'read')['text'].startswith('timestamp_s')
    assert launches == []
    assert shell.linked_file_action(str(data), 'spreadsheet', 'open') == {'ok': True}
    assert shell.linked_file_action(str(data), 'spreadsheet', 'folder') == {'ok': True}
    assert launches == [(str(data), False), (str(data), True)]
    video = tmp_path / 'example.mp4'
    video.write_bytes(b'video launch dispatch fixture')
    assert shell.linked_file_action(str(video), 'video', 'open') == {'ok': True}
    assert launches[-1] == (str(video), False)


@pytest.mark.parametrize('path,kind,action', [
    ('https://host/video.mp4', 'video', 'open'),
    ('relative.csv', 'spreadsheet', 'open'),
    ('C:/missing.csv', 'spreadsheet', 'open'),
    ('C:/script.exe', 'video', 'open'),
    ('C:/script.cmd', 'spreadsheet', 'folder'),
    ('C:/data.csv', 'unknown', 'open'),
    ('C:/data.csv', 'spreadsheet', 'delete'),
])
def test_invalid_or_missing_targets_never_launch(shell, monkeypatch, path, kind, action):
    def unexpected(*args, **kwargs):
        pytest.fail('invalid target was launched')
    monkeypatch.setattr(shell_links, 'launch', unexpected)
    assert 'error' in shell.linked_file_action(path, kind, action)


def test_read_limits_and_workbook_guidance(shell, tmp_path):
    book = tmp_path / 'book.xlsx'
    book.write_bytes(b'not read for plotting')
    assert 'Export' in shell.linked_file_action(str(book), 'spreadsheet', 'read')['error']
    data = tmp_path / 'large.csv'
    data.write_bytes(b'x' * (shell_links.MAX_CSV_BYTES + 1))
    assert '5 MiB' in shell.linked_file_action(str(data), 'spreadsheet', 'read')['error']


def test_save_target_does_not_write_and_isolated_token_survives_other_open(shell, tmp_path, monkeypatch):
    target = tmp_path / 'chosen.ftp.json'
    target.write_text('original', encoding='utf-8')
    monkeypatch.setattr(shell, '_ask_save', lambda name, kinds: str(target))
    chosen = shell.save_target('chosen.ftp.json')
    assert target.read_text(encoding='utf-8') == 'original'
    other = tmp_path / 'other.ftp.json'
    other.write_text('{}', encoding='utf-8')
    shell.read_plan(str(other))
    assert shell.save_plan('{"saved":true}', 'chosen.ftp.json', token=chosen['token'])['path'] == str(target)
    assert json.loads(target.read_text(encoding='utf-8')) == {'saved': True}
    assert other.read_text(encoding='utf-8') == '{}'


@pytest.mark.parametrize('kind', [{'k': 1}, ['camera'], 7, None])
def test_an_object_type_of_the_wrong_shape_does_not_crash_validation(kind):
    """An unhashable `type` used to raise TypeError out of validate_schema (FMT-5)."""
    plan = Plan.new('odd type')
    plan.data['objects'].append({'id': 'x', 'type': kind, 'linkedFiles': []})
    try:
        plan.validate_schema()
    except PlanError:
        pass
