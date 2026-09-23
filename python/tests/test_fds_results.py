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


def test_open_does_not_enumerate_nested_results(result_folder):
    nested = result_folder / 'unrelated'
    nested.mkdir()
    (nested / 'other.csv').write_text('private unrelated data')
    # A directory whose name has a result suffix must not become a file handle.
    (result_folder / 'directory.sf').mkdir()
    opened = ResultFiles().open(str(result_folder / 'case.smv'))
    assert {f['name'] for f in opened['files']} == {'case.smv', 'case.sf'}


@pytest.mark.parametrize('error', [ValueError('Choose a Smokeview metadata (.smv) file.'),
                                  ValueError('Result folder exceeds 20000 files.'),
                                  OSError('File disappeared')])
def test_open_errors_keep_their_message_over_http(result_folder, monkeypatch, tmp_path, error):
    import json
    from types import SimpleNamespace
    import urllib.request
    import app
    monkeypatch.setenv('FIREPLAN_SHELL_HOME', str(tmp_path / 'settings'))
    monkeypatch.setitem(sys.modules, 'webview', SimpleNamespace(OPEN_DIALOG=1))
    shell = app.Shell()
    shell.window = SimpleNamespace(create_file_dialog=lambda *a, **kw: [str(result_folder / 'case.smv')])
    def fail_open(_):
        raise error
    monkeypatch.setattr(shell.results, 'open', fail_open)
    server = app.start_server(shell, str(result_folder), 'test-open-token', lambda _: None)
    try:
        request = urllib.request.Request('http://127.0.0.1:{}/api/results/open'.format(server.server_port),
                                         data=b'{}', headers={'X-Shell-Token': 'test-open-token'})
        with urllib.request.urlopen(request) as response:
            assert response.status == 200
            assert json.load(response) == {'error': str(error)}
    finally:
        server.shutdown()
        server.server_close()


def test_results_dir_outputs_named_by_the_smv_are_offered(tmp_path):
    """FDS writes the .smv and CSVs beside the input, and with RESULTS_DIR every
    binary output under that folder, named in the .smv with the prefix. The desktop
    listed only the top level, so such a run opened with every field missing."""
    out = tmp_path / 'out'
    out.mkdir()
    (out / 'case_1_1.sf').write_bytes(b'slice')
    (out / 'case_1_2.bf').write_bytes(b'boundary')
    (out / 'case_1_2.bf.bnd').write_text('0 1 2\n')
    (out / 'unlisted.sf').write_bytes(b'not named by the smv')
    (tmp_path / 'case_devc.csv').write_text('s,C\nTime,T\n0,20\n')
    (tmp_path / 'case.smv').write_text(
        'SLCF     1 # STRUCTURED &     0    5     0    5     0    5\n out/case_1_1.sf\nTEMPERATURE\ntemp\nC\n'
        # RESULTS_DIR='out\' -- FDS appends '/', giving a doubled separator.
        'BNDF     1     1\n out\/case_1_2.bf\nWALL TEMPERATURE\nwtemp\nC\n'
        'SLCF     1\n ../escape.sf\nX\nx\nC\n', encoding='utf-8')
    opened = ResultFiles().open(str(tmp_path / 'case.smv'))
    names = {f['name'] for f in opened['files']}
    assert names == {'case.smv', 'case_devc.csv', 'out/case_1_1.sf', 'out/case_1_2.bf', 'out/case_1_2.bf.bnd'}
    files = ResultFiles()
    token = files.open(str(tmp_path / 'case.smv'))['token']
    assert files.read(token, 'out/case_1_2.bf', 0, 8) == b'boundary'
