"""The editor language uses per-user shell settings, never a plan file."""
import json

from test_shell import shell_app


def test_interface_language_survives_restart_and_preserves_presets(tmp_path, monkeypatch):
    monkeypatch.setenv("FIREPLAN_SHELL_HOME", str(tmp_path / "settings"))
    shell = shell_app.Shell()
    assert shell.interface_language() == {"language": "en"}
    assert shell.save_camera_presets([{"id": "my-camera"}])["saved"]
    assert shell.save_interface_language("fr")["saved"]
    reopened = shell_app.Shell()
    assert reopened.interface_language() == {"language": "fr"}
    assert reopened.camera_presets() == [{"id": "my-camera"}]
    assert not reopened.save_interface_language("invalid")["saved"]
    with open(shell_app.settings_path(), encoding="utf8") as source:
        assert json.load(source)["language"] == "fr"
