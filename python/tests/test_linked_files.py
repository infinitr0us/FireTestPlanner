"""Data links cross the schema, canonical writer, local paths and OS boundary."""
from copy import deepcopy
import json
import os
from pathlib import Path
import sys

import pytest

from fireplan import Plan, PlanError
from fireplan.linked_files import resolve_path
from fireplan.serialize import required_version

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'python/shell'))
import app as shell_app
import linked_files as shell_links


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
    links.append(deepcopy(links[0]))
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
    video = ROOT / 'fixtures/linked-files/video_example.mp4'
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
