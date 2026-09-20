"""Desktop shell: file handling, settings, and the loopback HTTP API.

No GUI and no pywebview needed -- app.py imports webview lazily so everything
except the window and the native dialogs is testable here. The window itself is
covered by `app.py --selftest`, which drives the real thing.
"""

from __future__ import annotations

import json
import os
import sys
import time
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


# -- camera preset library -----------------------------------------------

def test_the_preset_library_survives_a_restart():
    """The whole reason it is here rather than in the page's localStorage.

    Browser storage is scoped to the origin, and this shell binds a fresh loopback
    port on every launch -- so a library kept there was in a namespace the next
    launch could not see, while the UI promised it would survive.
    """
    first = shell_app.Shell()
    assert first.camera_presets() == []
    assert first.save_camera_presets([{"id": "my-rig", "focalLength_mm": 35}]) == {"saved": True}

    assert shell_app.Shell().camera_presets() == [{"id": "my-rig", "focalLength_mm": 35}]


def test_saving_presets_reports_whether_the_write_landed(monkeypatch):
    """The page words "survives a restart" from this answer, so it has to be one."""
    shell = shell_app.Shell()

    def refuse(*args, **kwargs):
        raise OSError("read-only volume")

    monkeypatch.setattr(shell_app, "open", refuse, raising=False)
    result = shell.save_camera_presets([{"id": "my-rig"}])
    assert result["saved"] is False
    assert "read-only" in result["error"]


def test_a_preset_payload_that_is_not_a_list_is_refused():
    shell = shell_app.Shell()
    assert shell.save_camera_presets({"id": "not-a-list"})["saved"] is False
    assert shell.camera_presets() == []


def test_junk_entries_are_dropped_rather_than_stored():
    shell = shell_app.Shell()
    shell.save_camera_presets([{"id": "ok"}, "a string", None, 7])
    assert shell.camera_presets() == [{"id": "ok"}]


def test_a_corrupt_preset_list_reads_back_as_empty():
    shell = shell_app.Shell()
    shell._settings["cameraPresets"] = "not a list at all"
    assert shell.camera_presets() == []


def test_corrupt_settings_do_not_stop_the_app_starting():
    with open(shell_app.settings_path(), "w", encoding="utf-8") as fh:
        fh.write("{ this is not json")
    assert shell_app.Shell().recent_files() == []


def test_writing_uses_lf_so_plans_do_not_diff_across_platforms(tmp_path):
    """The canonical writer emits LF; letting Python translate to CRLF here would
    make every plan saved from the desktop app differ from one saved elsewhere."""
    shell = shell_app.Shell()
    out = tmp_path / "written.ftp.json"
    assert shell._write(str(out), '{\n  "a": 1\n}\n') is None   # None means it worked
    assert out.read_bytes() == b'{\n  "a": 1\n}\n'


def test_writing_to_an_unwritable_path_reports_failure(tmp_path):
    shell = shell_app.Shell()
    reason = shell._write(str(tmp_path / "no such dir" / "x.json"), "{}")
    # The reason travels back to the page: a user whose disk is full needs to be told
    # so, not left looking at an unsaved dot with no explanation.
    assert reason and "x.json" in reason


def test_a_failed_write_leaves_the_previous_plan_intact(tmp_path, monkeypatch):
    """Opening the destination directly truncates it before a byte is written, so a
    disk-full or a crash mid-save destroys the plan and leaves nothing in its place."""
    shell = shell_app.Shell()
    out = tmp_path / "plan.ftp.json"
    out.write_text('{"original": true}\n', encoding="utf-8")

    real_replace = os.replace

    def explode(src, dst):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(shell_app.os, "replace", explode)
    assert shell._write(str(out), '{"new": true}\n') is not None
    assert out.read_text(encoding="utf-8") == '{"original": true}\n'

    # And no half-written temporary is left lying beside it.
    monkeypatch.setattr(shell_app.os, "replace", real_replace)
    assert [p.name for p in tmp_path.iterdir() if p.name.endswith(".tmp")] == []


def test_save_writes_back_to_the_open_file_but_save_as_asks(tmp_path, monkeypatch):
    """Prompting for a filename the user already chose is not a save."""
    shell = shell_app.Shell()
    out = tmp_path / "plan.ftp.json"
    out.write_text('{"v": 1}\n', encoding="utf-8")

    opened = shell.read_plan(str(out))
    assert opened is not None
    token = opened["token"]                            # the page's handle on the file
    asked = []
    monkeypatch.setattr(shell, "_ask_save", lambda name, kinds: asked.append(name) or None)

    saved = shell.save_plan('{"v": 2}\n', "plan.ftp.json", token=token)
    assert saved["path"] == str(out)
    assert out.read_text(encoding="utf-8") == '{"v": 2}\n'
    assert asked == []                                 # no dialog for a plain Save

    # A save hands back a fresh handle, and it writes back too.
    assert shell.save_plan('{"v": 4}\n', "plan.ftp.json", token=saved["token"])["path"] == str(out)
    assert out.read_text(encoding="utf-8") == '{"v": 4}\n'

    assert shell.save_plan('{"v": 3}\n', "elsewhere.ftp.json", save_as=True, token=token) is None
    assert asked == ["elsewhere.ftp.json"]             # Save as... does ask
    assert out.read_text(encoding="utf-8") == '{"v": 4}\n'


def test_save_asks_when_the_page_is_showing_a_different_document(tmp_path, monkeypatch):
    """Open A, then hit Example, then Save: A must not be overwritten.

    The page can replace its document without telling the shell -- the Example button
    does exactly that -- and then `current_path` still names the file that was opened
    while the editor holds something else entirely. Writing to it anyway destroys the
    user's plan through a two-click path, with no dialog to warn them.
    """
    shell = shell_app.Shell()
    original = tmp_path / "site-layout.ftp.json"
    original.write_text('{"the user": "spent all afternoon on this"}\n', encoding="utf-8")
    assert shell.read_plan(str(original)) is not None

    asked = []
    monkeypatch.setattr(shell, "_ask_save", lambda name, kinds: asked.append(name) or None)

    # The Example button leaves the page reporting the example's own filename, and
    # no token: the Example is bundled, not a file.
    assert shell.save_plan('{"example": true}\n', "pool-fire-camera-row.ftp.json") is None
    assert asked == ["pool-fire-camera-row.ftp.json"]
    assert original.read_text(encoding="utf-8") == '{"the user": "spent all afternoon on this"}\n'


def test_a_matching_basename_is_not_enough_to_write_back(tmp_path, monkeypatch):
    """Open pool-fire-camera-row.ftp.json, hit Example, Save: same name, different plan.

    The basename was once the whole test, and the Example plan happens to report the
    reference fixture's own filename -- so a user who had opened their copy of that
    fixture lost it to the bundled one. Only the token says which file is on screen.
    """
    shell = shell_app.Shell()
    original = tmp_path / "pool-fire-camera-row.ftp.json"
    original.write_text('{"mine": true}\n', encoding="utf-8")
    assert shell.read_plan(str(original)) is not None

    asked = []
    monkeypatch.setattr(shell, "_ask_save", lambda name, kinds: asked.append(name) or None)
    assert shell.save_plan('{"example": true}\n', "pool-fire-camera-row.ftp.json", token=None) is None
    assert asked == ["pool-fire-camera-row.ftp.json"]
    assert original.read_text(encoding="utf-8") == '{"mine": true}\n'


def test_a_rejected_open_does_not_redirect_the_next_save(tmp_path, monkeypatch):
    """Open A/case.ftp.json, then open a broken B/case.ftp.json, then Ctrl+S.

    The page rejects B and keeps A on screen -- and keeps A's token, because the
    document it belongs to is still the one showing. Reading B issued a token the
    page never adopted, so a plain Save goes to A, and B is left exactly as it was.
    Before the token, `current_path` was already pointing at B by the time the page
    said no, and the matching basename wrote A's plan over B with no dialog.
    """
    shell = shell_app.Shell()
    good = tmp_path / "A" / "case.ftp.json"
    bad = tmp_path / "B" / "case.ftp.json"
    good.parent.mkdir()
    bad.parent.mkdir()
    good.write_text('{"format": "fire-test-plan", "v": 1}\n', encoding="utf-8")
    bad.write_text("{ this is not json", encoding="utf-8")

    token_a = shell.read_plan(str(good))["token"]
    shell.read_plan(str(bad))                          # the page will reject this one

    asked = []
    monkeypatch.setattr(shell, "_ask_save", lambda name, kinds: asked.append(name) or None)
    saved = shell.save_plan('{"format": "fire-test-plan", "v": 2}\n', "case.ftp.json", token=token_a)
    assert saved["path"] == str(good)
    assert asked == []
    assert good.read_text(encoding="utf-8") == '{"format": "fire-test-plan", "v": 2}\n'
    assert bad.read_text(encoding="utf-8") == "{ this is not json"


def test_a_token_this_shell_never_issued_asks(tmp_path, monkeypatch):
    shell = shell_app.Shell()
    asked = []
    monkeypatch.setattr(shell, "_ask_save", lambda name, kinds: asked.append(name) or None)
    assert shell.save_plan("{}", "plan.ftp.json", token="made-up") is None
    assert asked == ["plan.ftp.json"]


def test_a_plan_with_no_file_behind_it_still_asks(monkeypatch):
    shell = shell_app.Shell()
    asked = []
    monkeypatch.setattr(shell, "_ask_save", lambda name, kinds: asked.append(name) or None)
    assert shell.save_plan("{}", "untitled.ftp.json") is None
    assert asked == ["untitled.ftp.json"]


def test_a_failed_save_is_reported_rather_than_looking_like_a_cancel(tmp_path, monkeypatch):
    """Both leave the file unwritten; only one of them is what the user asked for."""
    shell = shell_app.Shell()
    out = tmp_path / "plan.ftp.json"
    out.write_text('{"v": 1}\n', encoding="utf-8")
    token = shell.read_plan(str(out))["token"]

    def explode(src, dst):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(shell_app.os, "replace", explode)
    result = shell.save_plan('{"v": 2}\n', "plan.ftp.json", token=token)
    assert result is not None and "No space left on device" in result["error"]


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
    # The hook fires *after* the response goes out, deliberately: it ends in
    # os._exit, and the page should have its answer before the process leaves. So the
    # client can get here first -- wait for the handler thread rather than racing it.
    deadline = time.time() + 5
    while not ready_calls and time.time() < deadline:
        time.sleep(0.01)
    assert ready_calls == [shell]


def test_recent_is_served_over_the_api(server, plan_file):
    shell, _, base, _ = server
    shell.read_plan(plan_file)
    status, payload = request(base, "/api/recent", "test-token")
    assert status == 200
    assert payload == [plan_file]


def test_presets_round_trip_through_the_api(server):
    _, _, base, _ = server
    status, payload = request(base, "/api/presets", "test-token")
    assert (status, payload) == (200, [])

    _, saved = request(base, "/api/presets", "test-token", {"presets": [{"id": "my-rig"}]})
    assert saved == {"saved": True}
    _, payload = request(base, "/api/presets", "test-token")
    assert payload == [{"id": "my-rig"}]


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


def test_save_over_the_api_writes_back_only_with_the_token(server, plan_file):
    """The whole contract, end to end over HTTP: open hands out a token, save with it
    writes back with no dialog, save without it (or with a wrong one) asks."""
    _, _, base, _ = server
    _, opened = request(base, "/api/open-recent", "test-token", {"path": plan_file})
    assert isinstance(opened["token"], str) and opened["token"]

    _, saved = request(base, "/api/save", "test-token",
                       {"text": '{"v": 2}\n', "name": "demo.ftp.json", "token": opened["token"]})
    assert saved["path"] == plan_file
    assert isinstance(saved["token"], str)
    with open(plan_file, encoding="utf-8") as fh:
        assert fh.read() == '{"v": 2}\n'

    # No window, so a save that has to ask for a destination answers null.
    _, payload = request(base, "/api/save", "test-token",
                         {"text": '{"v": 3}\n', "name": "demo.ftp.json"})
    assert payload is None
    _, payload = request(base, "/api/save", "test-token",
                         {"text": '{"v": 3}\n', "name": "demo.ftp.json", "token": 42})
    assert payload is None
    with open(plan_file, encoding="utf-8") as fh:
        assert fh.read() == '{"v": 2}\n'


def test_free_port_returns_a_usable_port():
    assert 1024 < shell_app.free_port() <= 65535


# -- FDS import ------------------------------------------------------------

def test_reading_an_fds_file_returns_its_path_and_text(tmp_path):
    fds = tmp_path / "case.fds"
    fds.write_text("&HEAD CHID='case' /\n&TAIL /\n", encoding="utf-8")

    shell = shell_app.Shell()
    result = shell.read_fds(str(fds))

    assert result["path"] == str(fds)
    assert "CHID" in result["text"]


def test_reading_an_fds_file_does_not_adopt_it_as_the_document(tmp_path):
    """An FDS input is a source, not the plan.

    Remembering it as a recent file, or making it the window's current document,
    would point Save at the simulation input -- and a plan written over someone's
    FDS model is not a mistake they can undo. `read_plan` deliberately does both of
    those things; this deliberately does neither.
    """
    fds = tmp_path / "case.fds"
    fds.write_text("&HEAD CHID='case' /\n&TAIL /\n", encoding="utf-8")

    shell = shell_app.Shell()
    shell.read_fds(str(fds))

    assert shell.current_path is None
    assert str(fds) not in shell.recent_files()


def test_importing_fds_stops_save_writing_over_the_plan_that_was_open(tmp_path, monkeypatch):
    """Open `case.ftp.json`, import `case.fds`, press Save: the original must live.

    The page knows only a basename, and an import names the new document after the
    FDS job -- so `case.ftp.json` open and `case.fds` imported produce the same
    basename for two entirely unrelated documents. `_writeback_path` took the match
    as proof the page still showed the opened file and wrote the imported plan over
    it with no dialog, and the atomic rename leaves nothing to recover.
    """
    shell = shell_app.Shell()
    original = tmp_path / "case.ftp.json"
    original.write_text('{"the user": "spent all afternoon on this"}\n', encoding="utf-8")
    fds_input = tmp_path / "case.fds"
    fds_input.write_text("&HEAD CHID='case' /\n&TAIL /\n", encoding="utf-8")

    assert shell.read_plan(str(original)) is not None
    shell.read_fds(str(fds_input))

    asked = []
    monkeypatch.setattr(shell, "_ask_save", lambda name, kinds: asked.append(name) or None)

    # An import replaces the document, so the page drops the token it held for
    # the plan that was open; Save arrives with none.
    assert shell.save_plan('{"imported": true}\n', "case.ftp.json") is None
    assert asked == ["case.ftp.json"]        # Save As, not a silent write-back
    assert original.read_text(encoding="utf-8") == '{"the user": "spent all afternoon on this"}\n'


def test_an_included_file_is_read_from_beside_the_input_that_names_it(tmp_path):
    """`&CATF` splits an input across files, and the conversion lives in the shared
    core, which cannot reach a disk. This is the one thing it needs from the shell."""
    (tmp_path / "root.fds").write_text("&HEAD CHID='r' /\n", encoding="utf-8")
    (tmp_path / "geometry.fds").write_text("&OBST XB=0,1,0,1,0,1 /\n", encoding="utf-8")

    shell = shell_app.Shell()
    assert shell.read_fds_include("geometry.fds")["error"]      # nothing opened yet
    shell.read_fds(str(tmp_path / "root.fds"))
    assert "OBST" in shell.read_fds_include("geometry.fds")["text"]


@pytest.mark.parametrize("name", ["../secrets.txt", "sub/child.fds", ""])
def test_an_include_cannot_reach_outside_the_folder_the_input_came_from(tmp_path, name):
    # This route is reachable by anything holding the page's token, and "read me any
    # file you like" is not what an importer needs.
    (tmp_path / "root.fds").write_text("&HEAD CHID='r' /\n", encoding="utf-8")
    shell = shell_app.Shell()
    shell.read_fds(str(tmp_path / "root.fds"))
    assert "error" in shell.read_fds_include(name)


def test_an_unreadable_fds_file_reports_the_reason_rather_than_vanishing(tmp_path):
    shell = shell_app.Shell()
    result = shell.read_fds(str(tmp_path / "does-not-exist.fds"))
    assert result is not None and "error" in result


def test_an_fds_file_with_a_stray_byte_still_reads(tmp_path):
    # FDS inputs come off machines with every locale setting there is, and a bad
    # byte in a comment is not a reason to refuse a model whose geometry is fine.
    fds = tmp_path / "latin.fds"
    fds.write_bytes(b"A caf\xe9 note\n&HEAD CHID='case' /\n&TAIL /\n")

    result = shell_app.Shell().read_fds(str(fds))
    assert "CHID" in result["text"]


# -- reconstructed flame folders -------------------------------------------------

@pytest.fixture
def voxel_folder(tmp_path):
    """A tiny run the way the pipeline writes one, plus files that are not frames."""
    import numpy as np
    folder = tmp_path / "voxels"
    folder.mkdir()
    for t, n in ((0.0, 0), (5.0, 2)):
        np.savez_compressed(folder / "t_{:09.1f}s.npz".format(t),
                            voxels=np.zeros((n, 3)) + [[0.0, 0.0, 0.1 * i] for i in range(n)] if n else np.zeros((0, 3)),
                            voxel_size=0.1)
    (folder / "t_0000005.0s.ply").write_text("ply\n", encoding="utf-8")
    (folder / "notes.txt").write_text("not a frame", encoding="utf-8")
    return str(folder)


def test_a_voxel_folder_lists_only_its_frames(voxel_folder):
    import linked_files
    assert linked_files.list_frames(voxel_folder) == ["t_0000000.0s.npz", "t_0000005.0s.npz"]
    assert linked_files.checked_path(voxel_folder, "voxelSequence") == os.path.normpath(voxel_folder)
    with pytest.raises(FileNotFoundError, match="voxel folder is missing"):
        linked_files.checked_path(os.path.join(voxel_folder, "gone"), "voxelSequence")
    with pytest.raises(ValueError, match="relative"):
        linked_files.checked_path("voxels", "voxelSequence")


def test_a_frame_is_served_only_by_its_own_name(voxel_folder):
    import linked_files
    data = linked_files.read_frame(voxel_folder, "t_0000005.0s.npz")
    assert data[:2] == b"PK"
    for name in ("notes.txt", "../demo.ftp.json", "t_0000005.0s.ply", "t_0000009.0s.npz", "", None):
        with pytest.raises((ValueError, FileNotFoundError)):
            linked_files.read_frame(voxel_folder, name)


def test_the_frame_route_serves_a_listed_folder_and_nothing_else(server, voxel_folder):
    shell, _, base, _ = server
    # Reading before listing is refused: the page must register the folder first.
    req = urllib.request.Request(base + "/api/flame/frame?path={}&name=t_0000005.0s.npz".format(
        urllib.request.quote(voxel_folder)))
    req.add_header("X-Shell-Token", "test-token")
    with pytest.raises(urllib.error.HTTPError) as refused:
        urllib.request.urlopen(req, timeout=10)
    assert refused.value.code == 400
    assert "List the voxel folder" in json.loads(refused.value.read().decode("utf-8"))["error"]

    _, listed = request(base, "/api/flame/list", "test-token", {"path": voxel_folder})
    assert listed == {"frames": ["t_0000000.0s.npz", "t_0000005.0s.npz"]}
    with urllib.request.urlopen(req, timeout=10) as response:
        assert response.headers["Content-Type"] == "application/octet-stream"
        body = response.read()
    assert body == open(os.path.join(voxel_folder, "t_0000005.0s.npz"), "rb").read()

    # A missing frame is a 404 with a message; a name that is not a frame is a 400.
    for name, code in (("t_0000009.0s.npz", 404), ("notes.txt", 400)):
        bad = urllib.request.Request(base + "/api/flame/frame?path={}&name={}".format(urllib.request.quote(voxel_folder), name))
        bad.add_header("X-Shell-Token", "test-token")
        with pytest.raises(urllib.error.HTTPError) as err:
            urllib.request.urlopen(bad, timeout=10)
        assert err.value.code == code

    # Listing a folder that is not one says so instead of raising.
    _, payload = request(base, "/api/flame/list", "test-token", {"path": os.path.join(voxel_folder, "notes.txt")})
    assert "voxel folder is missing" in payload["error"]
    _, payload = request(base, "/api/flame/list", "test-token", {"path": None})
    assert "error" in payload


def test_the_frame_route_needs_the_token(server, voxel_folder):
    _, _, base, _ = server
    req = urllib.request.Request(base + "/api/flame/frame?path=x&name=y")
    with pytest.raises(urllib.error.HTTPError) as err:
        urllib.request.urlopen(req, timeout=10)
    assert err.value.code == 403


def test_folder_actions_show_and_open_a_checked_folder(voxel_folder, monkeypatch):
    import linked_files
    launched = []
    monkeypatch.setattr(linked_files, "launch", lambda path, folder=False: launched.append((path, folder)))
    shell = shell_app.Shell()
    assert shell.linked_file_action(voxel_folder, "voxelSequence", "folder") == {"ok": True}
    assert shell.linked_file_action(voxel_folder, "voxelSequence", "open") == {"ok": True}
    assert launched == [(os.path.normpath(voxel_folder), True), (os.path.normpath(voxel_folder), False)]
    assert "error" in shell.linked_file_action(voxel_folder, "voxelSequence", "read")
    assert "error" in shell.linked_file_action(os.path.join(voxel_folder, "gone"), "voxelSequence", "folder")


def test_pick_folder_is_inert_without_a_window(server):
    _, _, base, _ = server
    _, payload = request(base, "/api/pick-folder", "test-token", {})
    assert payload is None
