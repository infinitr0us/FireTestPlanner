"""Desktop shell: file handling, settings, and the loopback HTTP API.

No GUI and no pywebview needed -- app.py imports webview lazily so everything
except the window and the native dialogs is testable here. The window itself is
covered by `app.py --selftest`, which drives the real thing.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

import pytest

SHELL_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "python", "shell",
)
sys.path.insert(0, SHELL_DIR)

import app as shell_app  # noqa: E402


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path, monkeypatch):
    """Never touch the user's real recent-files list."""
    monkeypatch.setenv("FIREPLAN_SHELL_HOME", str(tmp_path / "settings"))
    yield


@pytest.fixture
def plan_file(tmp_path):
    path = tmp_path / "demo.ftp.json"
    path.write_text('{"format": "fire-test-plan"}\n', encoding="utf-8")
    return str(path)


# -- file handling -------------------------------------------------------

def test_reading_a_plan_returns_its_path_and_text(plan_file):
    shell = shell_app.Shell()
    result = shell.read_plan(plan_file)
    assert result["path"] == plan_file
    assert result["text"] == '{"format": "fire-test-plan"}\n'


def test_reading_a_missing_file_returns_none_rather_than_raising():
    shell = shell_app.Shell()
    assert shell.read_plan(os.path.join("nowhere", "absent.ftp.json")) is None


def test_reading_a_plan_adds_it_to_recent_files(plan_file):
    shell = shell_app.Shell()
    shell.read_plan(plan_file)
    assert shell.recent_files() == [plan_file]


def test_recent_files_hides_paths_that_no_longer_exist(plan_file, tmp_path):
    shell = shell_app.Shell()
    shell.read_plan(plan_file)
    os.remove(plan_file)
    # A recent list that offers a dead file is worse than a short one.
    assert shell.recent_files() == []


def test_recent_files_are_most_recent_first_without_duplicates(tmp_path):
    shell = shell_app.Shell()
    paths = []
    for i in range(3):
        p = tmp_path / "plan{}.ftp.json".format(i)
        p.write_text("{}", encoding="utf-8")
        paths.append(str(p))
        shell.read_plan(str(p))
    shell.read_plan(paths[0])  # revisit the oldest
    assert shell.recent_files() == [paths[0], paths[2], paths[1]]


def test_recent_files_are_capped():
    shell = shell_app.Shell()
    shell._settings["recent"] = ["x"] * 50
    shell._remember("y")
    assert len(shell._settings["recent"]) == shell_app.RECENT_LIMIT


def test_settings_survive_a_restart(plan_file):
    shell_app.Shell().read_plan(plan_file)
    assert shell_app.Shell().recent_files() == [plan_file]


def test_corrupt_settings_do_not_stop_the_app_starting():
    with open(shell_app.settings_path(), "w", encoding="utf-8") as fh:
        fh.write("{ this is not json")
    assert shell_app.Shell().recent_files() == []


def test_writing_uses_lf_so_plans_do_not_diff_across_platforms(tmp_path):
    """The canonical writer emits LF; letting Python translate to CRLF here would
    make every plan saved from the desktop app differ from one saved elsewhere."""
    shell = shell_app.Shell()
    out = tmp_path / "written.ftp.json"
    assert shell._write(str(out), '{\n  "a": 1\n}\n') is True
    assert out.read_bytes() == b'{\n  "a": 1\n}\n'


def test_writing_to_an_unwritable_path_reports_failure(tmp_path):
    shell = shell_app.Shell()
    assert shell._write(str(tmp_path / "no such dir" / "x.json"), "{}") is False


def test_a_queued_plan_is_handed_over_exactly_once(plan_file):
    shell = shell_app.Shell()
    shell.queue_plan(plan_file)
    first = shell.take_queued_plan()
    assert first is not None and first["path"] == plan_file
    assert shell.take_queued_plan() is None


# -- HTTP API ------------------------------------------------------------

@pytest.fixture
def server(tmp_path):
    root = tmp_path / "web"
    root.mkdir()
    (root / "index.html").write_text("<!doctype html><title>Stub</title>", encoding="utf-8")

    shell = shell_app.Shell()
    ready_calls = []
    srv = shell_app.start_server(shell, str(root), "test-token", ready_calls.append)
    yield shell, srv, "http://127.0.0.1:{}".format(srv.server_address[1]), ready_calls
    srv.shutdown()


def request(base, route, token=None, body=None):
    req = urllib.request.Request(base + route, method="POST" if body is not None else "GET")
    if token:
        req.add_header("X-Shell-Token", token)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data, timeout=10) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def test_the_api_serves_the_bundle(server):
    _, _, base, _ = server
    with urllib.request.urlopen(base + "/index.html", timeout=10) as response:
        assert b"Stub" in response.read()


def test_api_calls_without_the_token_are_refused(server):
    """Loopback is not enough on its own: any local process could otherwise drive
    the user's save dialogs."""
    _, _, base, _ = server
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        request(base, "/api/recent")
    assert excinfo.value.code == 403


def test_api_calls_with_the_wrong_token_are_refused(server):
    _, _, base, _ = server
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        request(base, "/api/recent", token="guess")
    assert excinfo.value.code == 403


def test_ready_records_what_the_app_reported(server):
    shell, _, base, ready_calls = server
    status, payload = request(base, "/api/ready", "test-token", {"canvas": True, "title": "x"})
    assert status == 200
    assert payload == {"queuedPlan": None}
    assert shell.ready_info == {"canvas": True, "title": "x"}
    assert ready_calls == []  # the selftest hook only fires in selftest mode


def test_ready_hands_over_a_queued_plan(server, plan_file):
    shell, _, base, _ = server
    shell.queue_plan(plan_file)
    _, payload = request(base, "/api/ready", "test-token", {})
    assert payload["queuedPlan"]["path"] == plan_file


def test_ready_triggers_the_selftest_hook_in_selftest_mode(server):
    shell, _, base, ready_calls = server
    shell.selftest = True
    request(base, "/api/ready", "test-token", {"canvas": True})
    assert ready_calls == [shell]


def test_recent_is_served_over_the_api(server, plan_file):
    shell, _, base, _ = server
    shell.read_plan(plan_file)
    status, payload = request(base, "/api/recent", "test-token")
    assert status == 200
    assert payload == [plan_file]


def test_open_recent_reads_through_the_api(server, plan_file):
    _, _, base, _ = server
    _, payload = request(base, "/api/open-recent", "test-token", {"path": plan_file})
    assert payload["text"].startswith('{"format"')


def test_an_unknown_route_is_a_404_not_a_crash(server):
    _, _, base, _ = server
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        request(base, "/api/nope", "test-token", {})
    assert excinfo.value.code == 404


def test_malformed_json_is_rejected_cleanly(server):
    _, _, base, _ = server
    req = urllib.request.Request(base + "/api/ready", method="POST")
    req.add_header("X-Shell-Token", "test-token")
    req.add_header("Content-Type", "application/json")
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        urllib.request.urlopen(req, b"{not json", timeout=10)
    assert excinfo.value.code == 400


def test_dialog_routes_are_inert_without_a_window(server):
    """No window means no dialog; the API must answer rather than raise."""
    _, _, base, _ = server
    _, payload = request(base, "/api/open", "test-token", {})
    assert payload is None
    _, payload = request(base, "/api/save", "test-token", {"text": "{}", "name": "x.json"})
    assert payload is None


def test_free_port_returns_a_usable_port():
    assert 1024 < shell_app.free_port() <= 65535
