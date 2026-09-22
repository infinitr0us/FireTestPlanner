"""Output bridge boundaries; fixtures are temporary and do not need a GUI."""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'shell'))
from fds_results import ResultFiles, MAX_READ


@pytest.fixture
def result_folder(tmp_path):
    (tmp_path / 'case.smv').write_text('CHID\ncase\n')
    (tmp_path / 'case.sf').write_bytes(bytes(range(100)))
    (tmp_path / 'private.txt').write_text('not result data')
    return tmp_path


def test_ranges_and_closed_session(result_folder):
    files = ResultFiles()
    opened = files.open(str(result_folder / 'case.smv'))
    assert {f['name'] for f in opened['files']} == {'case.smv', 'case.sf'}
    token = opened['token']
    assert files.read(token, 'case.sf', 10, 3) == bytes([10, 11, 12])
    assert files.read(token, 'case.sf', 100, 0) == b''
    files.close(token)
    with pytest.raises(ValueError, match='closed'):
        files.read(token, 'case.sf', 0, 1)


@pytest.mark.parametrize('name,offset,length', [
    ('../case.sf', 0, 1), ('private.txt', 0, 1), ('case.sf', -1, 1),
    ('case.sf', 0, MAX_READ + 1), ('case.sf', 99, 2), ('case.sf', True, 1),
])
def test_invalid_or_unregistered_reads(result_folder, name, offset, length):
    files = ResultFiles(); token = files.open(str(result_folder / 'case.smv'))['token']
    with pytest.raises(ValueError):
        files.read(token, name, offset, length)


def test_changed_file_requires_reopen(result_folder):
    files = ResultFiles(); token = files.open(str(result_folder / 'case.smv'))['token']
    path = result_folder / 'case.sf'
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000000))
    with pytest.raises(ValueError, match='changed'):
        files.read(token, 'case.sf', 0, 1)


def test_result_http_authentication_and_range(result_folder, monkeypatch, tmp_path):
    import json
    import urllib.request
    import urllib.error
    import app
    monkeypatch.setenv('FIREPLAN_SHELL_HOME', str(tmp_path / 'settings'))
    shell = app.Shell()
    opened = shell.results.open(str(result_folder / 'case.smv'))
    server = app.start_server(shell, str(result_folder), 'secret-test-token', lambda _: None)
    base = 'http://127.0.0.1:{}'.format(server.server_port)
    url = base + '/api/results/read?token={}&name=case.sf&offset=10&length=3'.format(opened['token'])
    try:
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(url)
        assert error.value.code == 403
        request = urllib.request.Request(url, headers={'X-Shell-Token': 'secret-test-token'})
        with urllib.request.urlopen(request) as response:
            assert response.read() == bytes([10, 11, 12])
        request = urllib.request.Request(base + '/api/results/close',
            data=json.dumps({'token': opened['token']}).encode(), headers={'X-Shell-Token': 'secret-test-token'})
        with urllib.request.urlopen(request) as response:
            assert json.load(response) == {'closed': True}
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(urllib.request.Request(url, headers={'X-Shell-Token': 'secret-test-token'}))
        assert error.value.code == 400
    finally:
        server.shutdown(); server.server_close()


def test_png_save_cancel_invalid_and_atomic_failure(tmp_path, monkeypatch):
    import base64
    import app
    monkeypatch.setenv('FIREPLAN_SHELL_HOME', str(tmp_path / 'settings'))
    shell = app.Shell()
    image = bytes([137, 80, 78, 71, 13, 10, 26, 10]) + b'test'
    data_url = 'data:image/png;base64,' + base64.b64encode(image).decode()
    assert 'error' in shell.save_results_png('bad')
    monkeypatch.setattr(shell, '_ask_save', lambda *_: None)
    assert shell.save_results_png(data_url) is None
    target = tmp_path / 'snapshot.png'
    monkeypatch.setattr(shell, '_ask_save', lambda *_: str(target))
    assert shell.save_results_png(data_url) == {'path': str(target)}
    assert target.read_bytes() == image
    original = b'keep this previous snapshot'
    target.write_bytes(original)
    monkeypatch.setattr(os, 'replace', lambda *_: (_ for _ in ()).throw(OSError('disk full')))
    assert 'error' in shell.save_results_png(data_url)
    assert target.read_bytes() == original
    assert not list(tmp_path.glob('.fds-snapshot-*'))
