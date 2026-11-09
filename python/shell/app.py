"""Desktop shell for the fire test plan editor.

The same web bundle the browser runs, hosted in a pywebview window. pywebview uses
the WebView2 runtime that ships with Windows 11, so the packaged exe stays around
40-60 MB instead of the ~150 MB an Electron or QtWebEngine bundle would cost.

Python supplies only what a browser genuinely cannot: native file dialogs, a
recent-files list, and (later) streaming multi-GB flame sequences off disk.

The bridge is a loopback HTTP API rather than pywebview's `js_api`. That is a
deliberate choice, not a preference: with `js_api` bound to this particular page the
WebView2 message channel never came up -- Python's worker threads froze and the page
never reached Python -- while a synthetic WebGL page over the same code path worked
fine. Rather than keep chasing it, the shell serves the bundle and the API from one
loopback origin, which uses only mechanisms already known to work here. It also
gives Phase 2 a natural way to stream large flame sequences, which is something a
browser does well and a JS bridge does badly.

    python app.py                 run against ../../web/dist
    python app.py --selftest      boot, verify the app reached Python, exit
    python app.py --dev URL       point the window at a dev server instead
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import secrets
import socket
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
import stat
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse
import linked_files
from fds_results import ResultFiles
from flame_analysis import AnalysisFolders

# webview is imported lazily, inside the functions that open windows and dialogs.
# That keeps the file logic, settings and HTTP API importable -- and therefore
# testable -- without pywebview or a display present.

APP_NAME = "Fire Test Plan Editor"
RECENT_LIMIT = 10
PLAN_FILTER = ("Fire test plan (*.ftp.json;*.json)", "All files (*.*)")
#: An FDS input is read, never written: the import converts it into a plan, and the
#: plan is what gets saved. So there is no matching save filter.
FDS_FILTER = ("FDS input (*.fds)", "All files (*.*)")
HTML_FILTER = ("Web page (*.html)", "All files (*.*)")
#: pywebview refuses a filter that is not a wildcard pattern (a plain name such as
#: "analysis.json" raises before the dialog opens), so the name is checked after.
ANALYSIS_FILTER = ("Flame analysis (*.json)", "All files (*.*)")
MAX_BODY_BYTES = 256 * 1024 * 1024  # a plan with an embedded viewer can be large
MAX_MEDIA_BYTES = 1024 * 1024 * 1024  # an exported flame analysis video
MAX_TEST_DATA_BYTES = 64 * 1024 * 1024
#: What the native close prompt says. pywebview shows it only while the page has
#: reported unsaved changes (`Shell.set_dirty` flips `confirm_close`).
CLOSE_PROMPT = "This plan has unsaved changes. Close the window and discard them?"
#: Names Windows resolves to a device wherever they appear, extension or not. An
#: `&CATF` include named `CON` would otherwise read the console and hang the import.
_DEVICE_NAME = re.compile(r"^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9]|CONIN\$|CONOUT\$)(\..*)?$", re.I)

_LOG_FILE: Optional[Any] = None


def report(message: str = "") -> None:
    """Write a selftest line to the log file, then to stdout.

    File first, and stdout guarded: a detached GUI process can inherit a stdout
    nobody drains, and a blocked `print` would then take the log down with it --
    the diagnostic channel must not depend on the channel that is failing.
    """
    if _LOG_FILE is not None:
        try:
            _LOG_FILE.write(message + "\n")
            _LOG_FILE.flush()
            os.fsync(_LOG_FILE.fileno())
        except (OSError, ValueError):
            pass
    try:
        print(message, flush=True)
    except (OSError, ValueError):
        pass


def resource_root() -> str:
    """Where the web bundle lives, frozen or not.

    PyInstaller one-file extracts data to a temp dir it advertises as _MEIPASS.
    """
    bundled = getattr(sys, "_MEIPASS", None)
    if bundled:
        return os.path.join(bundled, "web")
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "web", "dist"))


def settings_path() -> str:
    """Where recent files and the last directory are kept.

    FIREPLAN_SHELL_HOME overrides the location, which lets tests run without
    touching the user's real settings and allows a portable install later.
    """
    override = os.environ.get("FIREPLAN_SHELL_HOME")
    base = override or os.environ.get("APPDATA") or os.path.expanduser("~")
    directory = base if override else os.path.join(base, "FireTestPlanEditor")
    os.makedirs(directory, exist_ok=True)
    return os.path.join(directory, "settings.json")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class Shell:
    """Everything the page can ask the desktop to do."""

    def __init__(self) -> None:
        self.window: Any = None  # a webview.Window once the GUI is up
        self.selftest = False
        # The HTTP server answers on several threads, and recent files, the last
        # directory and the preset library all read-modify-write one dict.
        self._settings_lock = threading.RLock()
        self._settings = self._load_settings()
        #: True while the page reports unsaved changes. Drives the close prompt and
        #: the title bullet; see `set_dirty`.
        self.dirty = False
        self._title_name: Optional[str] = None
        self._queued_plan: Optional[str] = None
        self.ready_info: Optional[Dict[str, Any]] = None
        # Absolute path of the plan most recently read or written, for the window
        # title. It is NOT what decides where a plain Save goes -- see `_documents`.
        self.current_path: Optional[str] = None
        # The files the page may write back to, keyed by an opaque token issued when
        # each was read or written. The page keeps a token only while the document it
        # came with is the one on screen, and hands it back on a plain Save; a Save
        # with no token, or with one this shell never issued, asks for a destination.
        # This is what makes Save mean "save" rather than "save as" -- the basename
        # the page reports is not enough, because a file the page rejected, or the
        # bundled Example, can carry the same name as the file that was open before.
        self._documents: Dict[str, str] = {}
        # Folder of the last FDS input opened, which is where its `&CATF` includes
        # live. Not a document: an import produces an unsaved plan.
        self.fds_directory: Optional[str] = None
        #: Voxel folders the page has listed this run; the frame route serves only these.
        self._flame_folders: set = set()
        self.results = ResultFiles()
        self.analyses = AnalysisFolders()

    # -- settings ------------------------------------------------------

    def _load_settings(self) -> Dict[str, Any]:
        """The settings file, or an empty dict.

        A corrupt or absent file must never stop the app opening -- but a corrupt
        one is set aside rather than left where the next write would overwrite it.
        It holds the user's camera preset library, and the first recent-file entry
        written over it used to make a disk-full mishap permanent.
        """
        path = settings_path()
        try:
            with open(path, "r", encoding="utf-8-sig") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            return {}
        except (OSError, ValueError):
            self._quarantine_settings(path)
            return {}
        if not isinstance(data, dict):
            self._quarantine_settings(path)
            return {}
        return data

    @staticmethod
    def _quarantine_settings(path: str) -> None:
        try:
            os.replace(path, "{}.corrupt-{}".format(path, time.strftime("%Y%m%d-%H%M%S")))
        except OSError:
            pass

    def _save_settings(self) -> Optional[str]:
        """Write the settings file. None on success, or the reason it failed.

        Most callers ignore the answer -- a lost "recent files" entry is not worth
        a dialog -- but the preset library reports it, because the page words its
        own UI from whether the write actually landed rather than from the mere
        existence of somewhere to write to.

        Written beside the destination and renamed over it, as a plan is: opening
        the file for writing truncates it first, and a failure part-way through left
        invalid JSON where the preset library had been.
        """
        path = settings_path()
        with self._settings_lock:
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(
                        "w", encoding="utf-8", dir=os.path.dirname(path), prefix=".settings.",
                        suffix=".tmp", delete=False) as fh:
                    temporary = fh.name
                    json.dump(self._settings, fh, indent=2)
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(temporary, path)
                temporary = None
            except OSError as exc:
                return str(exc)
            finally:
                if temporary is not None:
                    try:
                        os.remove(temporary)
                    except OSError:
                        pass
        return None

    def _remember(self, path: str) -> None:
        with self._settings_lock:
            stored = self._settings.get("recent")
            recent: List[str] = [p for p in stored if isinstance(p, str) and p != path] \
                if isinstance(stored, list) else []
            recent.insert(0, path)
            self._settings["recent"] = recent[:RECENT_LIMIT]
            self._save_settings()

    def recent_files(self) -> List[str]:
        """Recent paths that still exist, so the list never offers a dead file."""
        stored = self._settings.get("recent")
        if not isinstance(stored, list):
            return []
        return [p for p in stored if isinstance(p, str) and os.path.isfile(p)]

    def open_recent(self, path: Any) -> Dict[str, Any]:
        """A plan from the recent list -- and from nowhere else.

        This route used to read whatever path it was handed and issue a write token
        for it, which made the page's token a way to read and overwrite any file the
        user can. A recent entry is a file the user opened or saved as a plan.
        """
        wanted = os.path.normcase(os.path.abspath(str(path or "")))
        if not any(os.path.normcase(os.path.abspath(p)) == wanted for p in self.recent_files()):
            return {"error": "That file is not in the recent list."}
        result = self.read_plan(str(path))
        return result if result is not None else {"error": "Could not read {}.".format(path)}

    def adopted(self, token: Any) -> Dict[str, Any]:
        """The page put the document `token` came with on screen.

        Only now does the file join the recent list and the window title: a file the
        page rejected as not a plan must not be offered again as one, nor sit in the
        title bar over the document that is really open.
        """
        path = self._documents.get(str(token or ""))
        if path is None:
            return {"adopted": False}
        self._remember(path)
        self.current_path = path
        self._set_title(os.path.basename(path))
        return {"adopted": True}

    def set_dirty(self, dirty: Any) -> Dict[str, Any]:
        """Record whether the page holds unsaved changes.

        pywebview prompts on close only while `confirm_close` is set, and WebView2
        does not run the page's `beforeunload` when the host window closes -- so
        without this, closing the window discarded unsaved work in silence.
        """
        self.dirty = bool(dirty)
        if self.window is not None:
            self.window.confirm_close = self.dirty
        if self._title_name is not None:
            self._set_title(self._title_name)
        return {"dirty": self.dirty}

    # -- camera preset library -----------------------------------------

    def camera_presets(self) -> List[Dict[str, Any]]:
        """The user's own camera presets, as the page last wrote them.

        The library lives here rather than in the page's `localStorage` because
        browser storage is scoped to the ORIGIN, and this shell asks the OS for a
        free loopback port on every launch -- so every launch was a different
        origin and therefore a different, empty storage namespace. The user built a
        library that vanished on the next start while the UI promised it would not.
        `settings.json` is already per-profile and already survives a restart.

        The page validates every entry on the way in (`coerce` in
        web/src/core/presets.ts), so nothing here needs to understand a preset --
        only that it is a list of objects.
        """
        stored = self._settings.get("cameraPresets")
        return [p for p in stored if isinstance(p, dict)] if isinstance(stored, list) else []

    def save_camera_presets(self, presets: Any) -> Dict[str, Any]:
        """Replace the library. Reports whether the write reached the disk.

        The page words its own UI from this answer instead of from "storage exists",
        which is the difference between telling the user their preset will survive a
        restart and knowing that it will.
        """
        if not isinstance(presets, list):
            return {"saved": False, "error": "presets must be a list"}
        self._settings["cameraPresets"] = [p for p in presets if isinstance(p, dict)]
        failure = self._save_settings()
        return {"saved": False, "error": failure} if failure else {"saved": True}

    def queue_plan(self, path: str) -> None:
        self._queued_plan = path

    def interface_language(self) -> Dict[str, str]:
        """Editor preference stored beside camera presets, independent of plans."""
        return {"language": "fr" if self._settings.get("language") == "fr" else "en"}

    def save_interface_language(self, language: Any) -> Dict[str, Any]:
        if language not in ("en", "fr"):
            return {"saved": False, "error": "language must be en or fr"}
        self._settings["language"] = language
        failure = self._save_settings()
        return {"saved": False, "error": failure} if failure else {"saved": True}

    # -- files ---------------------------------------------------------

    def pick_linked_files(self, kind: str) -> Dict[str, Any]:
        if kind not in ('spreadsheet', 'video'):
            return {"error": "Unknown linked file kind."}
        if self.window is None:
            return {"files": []}
        import webview
        extensions = linked_files.VIDEOS if kind == 'video' else linked_files.SPREADSHEETS
        pattern = ';'.join('*' + ext for ext in sorted(extensions))
        result = self.window.create_file_dialog(
            webview.OPEN_DIALOG, allow_multiple=True,
            file_types=("{} ({})".format(kind.title(), pattern),),
            directory=self._last_directory(),
        )
        files = []
        for path in result or []:
            try:
                resolved = linked_files.checked_path(path, kind)
                item = {"path": resolved}
                if os.path.splitext(resolved)[1].lower() in {'.csv', '.tsv'}:
                    try:
                        item['text'] = linked_files.read_csv(resolved)
                    except (OSError, ValueError) as exc:
                        item['warning'] = str(exc)
                files.append(item)
            except (OSError, ValueError) as exc:
                return {"error": str(exc)}
        return {"files": files}

    def open_results(self) -> Optional[Dict[str, Any]]:
        if self.window is None:
            return None
        import webview
        selected = self.window.create_file_dialog(
            webview.OPEN_DIALOG, allow_multiple=False,
            file_types=("FDS results (*.smv)",), directory=self._last_directory())
        if not selected:
            return None
        path = selected[0] if isinstance(selected, (list, tuple)) else selected
        try:
            return self.results.open(str(path))
        except (OSError, ValueError) as exc:
            return {"error": str(exc)}

    def open_analysis(self) -> Optional[Dict[str, Any]]:
        """Native dialog for a flame analysis folder's analysis.json; the folder it is
        in becomes a read-only session the page reads whole files from."""
        if self.window is None:
            return None
        import webview
        selected = self.window.create_file_dialog(
            webview.OPEN_DIALOG, allow_multiple=False,
            file_types=ANALYSIS_FILTER, directory=self._last_directory())
        if not selected:
            return None
        path = selected[0] if isinstance(selected, (list, tuple)) else selected
        try:
            return self.analyses.open(str(path))
        except (OSError, ValueError) as exc:
            return {"error": str(exc)}

    def pick_folder(self) -> Optional[Dict[str, str]]:
        """Native folder dialog, for a reconstructed flame's voxels/ folder."""
        if self.window is None:
            return None
        import webview
        result = self.window.create_file_dialog(
            webview.FileDialog.FOLDER, directory=self._last_directory())
        if not result:
            return None
        path = result[0] if isinstance(result, (list, tuple)) else result
        try:
            return {"path": linked_files.checked_path(str(path), 'voxelSequence')}
        except (OSError, ValueError) as exc:
            return {"error": str(exc)}

    def list_flame_frames(self, path: Any) -> Dict[str, Any]:
        """The frames a linked voxel folder holds. Registers the folder, so the
        frame route can serve from it and from nowhere else."""
        try:
            folder = linked_files.checked_path(path, 'voxelSequence')
            frames = linked_files.list_frames(folder)
            self._flame_folders.add(os.path.normcase(folder))
            return {"frames": frames}
        except (OSError, ValueError, TypeError) as exc:
            return {"error": str(exc)}

    def read_flame_frame(self, path: Any, name: Any) -> bytes:
        """One frame's bytes from a folder the page has listed. Raises on anything
        else: the route turns that into an error response."""
        folder = linked_files.checked_path(path, 'voxelSequence')
        if os.path.normcase(folder) not in self._flame_folders:
            raise PermissionError('List the voxel folder before reading its frames.')
        return linked_files.read_frame(folder, name)

    def linked_file_action(self, path: str, kind: str, action: str) -> Dict[str, Any]:
        try:
            if action not in ('open', 'folder', 'read'):
                raise ValueError('Unknown linked file action.')
            resolved = linked_files.checked_path(path, kind)
            if action == 'read':
                if kind != 'spreadsheet':
                    raise ValueError('Only CSV spreadsheets can be read for plotting.')
                return {"text": linked_files.read_csv(resolved)}
            linked_files.launch(resolved, folder=action == 'folder')
            return {"ok": True}
        except (OSError, ValueError) as exc:
            return {"error": str(exc)}

    def save_target(self, suggested_name: str, save_as: bool = False,
                    token: Optional[str] = None) -> Optional[Dict[str, str]]:
        """Choose the destination before the page rebases external links.

        This performs no write. The returned token authorises the subsequent
        atomic save to precisely that destination, even if another plan is opened.
        """
        path = None if save_as else self._writeback_path(token)
        if path is None:
            path = self._ask_save(suggested_name, PLAN_FILTER)
        return {"path": os.path.abspath(path), "token": self._issue_token(path)} if path else None

    def open_plan(self) -> Optional[Dict[str, str]]:
        if self.window is None:
            return None
        import webview

        result = self.window.create_file_dialog(
            webview.OPEN_DIALOG, allow_multiple=False, file_types=PLAN_FILTER,
            directory=self._last_directory(),
        )
        return self.read_plan(result[0]) if result else None

    def open_fds(self) -> Optional[Dict[str, str]]:
        """Pick an FDS input file and hand back its text.

        Deliberately just a read. The conversion lives in the shared core so the
        browser build imports the same way and the two cannot drift, and the shell's
        job is the one thing a browser tab genuinely cannot do: a native file dialog
        with the right filter.

        The path is NOT remembered as a recent file and does not become the window's
        current document -- an import produces an unsaved plan, and pointing Save at
        the .fds it came from would overwrite the simulation input.
        """
        if self.window is None:
            return None
        import webview

        result = self.window.create_file_dialog(
            webview.OPEN_DIALOG, allow_multiple=False, file_types=FDS_FILTER,
            directory=self._last_directory(),
        )
        return self.read_fds(result[0]) if result else None

    def read_fds(self, path: str) -> Optional[Dict[str, str]]:
        """An FDS input file's text, or the reason it could not be read.

        `errors="replace"` rather than a strict decode: FDS inputs come off machines
        with every locale setting there is, and a stray byte in a comment is not a
        reason to refuse a model whose geometry is perfectly readable.

        Reading one **forgets the open plan**. An import replaces the page's
        document, and the only thing tying a Save to a file is the basename the page
        sends back -- so with `case.ftp.json` open and `case.fds` imported, the two
        agree and a plain Save writes the imported plan over the original. Same
        name, different document, and an atomic rename leaves nothing to recover.
        Nothing about an import belongs to the file that was open before it, so this
        drops the claim and the first Save lands in Save As, where it belongs.
        """
        try:
            # utf-8-sig: a byte-order mark from a Windows editor is not part of the
            # first record, and left in place it hid that record from one engine.
            with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
                text = fh.read()
        except OSError as exc:
            report("could not read {}: {}".format(path, exc))
            return {"error": str(exc)}
        self.current_path = None
        self.fds_directory = os.path.dirname(os.path.abspath(path))
        self._set_title(os.path.basename(path) + " (imported)")
        return {"path": path, "text": text}

    def read_fds_include(self, name: str) -> Dict[str, Any]:
        """A file `&CATF` names, read from beside the input that names it.

        Split inputs are the normal shape for anything past a demonstration case: a
        geometry file plus a devices file, pulled in by `&CATF`. The conversion
        lives in the shared core and the core cannot reach a disk, so this is the
        one thing it needs from the shell -- the bytes of a sibling file, by name.

        Confined to the folder the input came from, and to a bare filename: this
        route is reachable by anything that has the page's token, and "read me any
        file you like" is not what an importer needs.
        """
        directory = self.fds_directory
        if not directory:
            return {"error": "no FDS input has been opened"}
        # A path relative to the input's folder -- FDS reads `&CATF` names relative
        # to where it runs, and `geometry/walls.fds` is as common as a bare name --
        # but never out of it: no absolute path, drive, stream or `..`.
        parts = re.split(r"[\\/]+", name or "")
        if (not name or os.path.isabs(name) or ":" in name
                or any(part in ("", ".", "..") for part in parts)):
            return {"error": "an &CATF include is read from the input's own folder only"}
        if any(_DEVICE_NAME.match(part.rstrip(" .")) or part != part.rstrip(" .") for part in parts):
            # CON, NUL, COM1... are devices in every folder; reading CON waits on
            # the console. A received model must not be able to name one.
            return {"error": "{} is not a file name an &CATF include can use".format(name)}
        root = os.path.realpath(directory)
        path = os.path.realpath(os.path.join(directory, *parts))
        try:
            inside = os.path.commonpath([os.path.normcase(path), os.path.normcase(root)]) == os.path.normcase(root)
        except ValueError:
            # Different drives -- a junction in the input's folder pointing at D: --
            # have no common path. That is outside the folder, not a server error.
            inside = False
        if not inside:
            return {"error": "an &CATF include is read from the input's own folder only"}
        if not os.path.isfile(path):
            return {"error": "{} is not beside the FDS input".format(name)}
        try:
            with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
                return {"name": name, "text": fh.read()}
        except OSError as exc:
            return {"error": str(exc)}

    def _issue_token(self, path: str) -> str:
        """A fresh handle on `path`, for the page to hand back on a plain Save."""
        token = secrets.token_urlsafe(12)
        self._documents[token] = os.path.abspath(path)
        return token

    def read_plan(self, path: str) -> Optional[Dict[str, str]]:
        """A plan's text, its path, and a token the page can save back with.

        Reading a file does not make it the Save destination. Only the page knows
        whether it adopted the document -- it may reject the file as not a plan -- so
        the token travels with the text and comes back only if the document did go
        on screen. A rejected `case.ftp.json` therefore cannot become the target of
        the next Ctrl+S on the `case.ftp.json` that was open before it. For the same
        reason the recent list and the window title wait for `adopted`.
        """
        path = os.path.abspath(path)
        try:
            # utf-8-sig: Notepad's byte-order mark is not part of the JSON, and a
            # browser tab already drops it when it reads a picked file.
            with open(path, "r", encoding="utf-8-sig") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError) as exc:
            report("could not read {}: {}".format(path, exc))
            return None
        return {"path": path, "text": text, "token": self._issue_token(path)}

    def save_plan(self, text: str, suggested_name: str, save_as: bool = False,
                  token: Optional[str] = None) -> Optional[Dict[str, str]]:
        """Save to the file `token` names, or ask for a destination.

        `Save` on a plan that came from disk writes straight back to it -- prompting
        for a filename the user already chose is not a save, and it is how a plan
        ends up saved next to itself under three near-identical names. `Save as...`,
        and any plan with no file behind it yet, still ask.

        Which file "it" is comes from the token the page was given when the file was
        read or last written, never from the name the page suggests: the Example plan
        and a rejected open can both report the basename of the file that was open
        before them, and a basename match wrote over that file with no dialog.

        Returns `{"path": ..., "token": ...}`, or `{"error": ...}` if the write
        failed, or None if the user cancelled the dialog. The page has to tell those
        apart: a failed save that looks like a cancelled one leaves the user believing
        their work is on disk when it is not.
        """
        path = None if save_as else self._writeback_path(token)
        if path is None:
            path = self._ask_save(suggested_name, PLAN_FILTER)
        if not path:
            return None
        error = self._write(path, text)
        if error:
            return {"error": error}
        self._remember(path)
        self.current_path = os.path.abspath(path)
        self._set_title(os.path.basename(path))
        return {"path": path, "token": self._issue_token(path)}

    def _writeback_path(self, token: Optional[str]) -> Optional[str]:
        """The file a token names, if this shell issued it.

        The editor can replace its document without the shell hearing about it -- the
        Example button does exactly that, and so does an Open the page rejects -- so
        the shell cannot know which file is on screen. The page can: it keeps the
        token it was handed with the document it adopted, drops it when the document
        is replaced, and sends it back on a plain Save. No token, or one this shell
        never issued, means there is no file to write back to.
        """
        if not token:
            return None
        return self._documents.get(str(token))

    def save_html(self, html: str, suggested_name: str) -> Optional[Dict[str, str]]:
        path = self._ask_save(suggested_name, HTML_FILTER)
        if not path:
            return None
        error = self._write(path, html)
        return {"error": error} if error else {"path": path}

    def save_fds(self, text: str, suggested_name: str) -> Optional[Dict[str, str]]:
        path = self._ask_save(suggested_name, FDS_FILTER)
        if not path:
            return None
        if not path.lower().endswith('.fds'):
            path += '.fds'
            if os.path.lexists(path):
                return {"error": "The name with its extension already exists. Choose the name with its extension."}
        error = self._write(path, text)
        return {"error": error} if error else {"path": path}

    def save_csv(self, text: str, suggested_name: str) -> Optional[Dict[str, str]]:
        path = self._ask_save(suggested_name, ("CSV table (*.csv)", "All files (*.*)"))
        if not path:
            return None
        if not path.lower().endswith(".csv"):
            path += ".csv"
            if os.path.lexists(path):
                return {"error": "The name with its extension already exists. Choose the name with its extension."}
        error = self._write(path, text)
        return {"error": error} if error else {"path": path}

    def save_results_png(self, data_url: Any) -> Optional[Dict[str, str]]:
        if not isinstance(data_url, str) or not data_url.startswith('data:image/png;base64,') or len(data_url) > 48 * 1024 * 1024:
            return {"error": "Invalid or oversized PNG snapshot."}
        try:
            data = base64.b64decode(data_url.split(',', 1)[1], validate=True)
        except ValueError:
            return {"error": "Invalid PNG encoding."}
        if not data.startswith(bytes([137, 80, 78, 71, 13, 10, 26, 10])):
            return {"error": "Invalid PNG signature."}
        path = self._ask_save('fds-results.png', ('PNG image (*.png)',))
        if not path:
            return None
        if not path.lower().endswith('.png'):
            path += '.png'
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=os.path.dirname(os.path.abspath(path)), prefix='.fds-snapshot-', delete=False) as stream:
                temporary = stream.name
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            temporary = None
            return {"path": path}
        except OSError as exc:
            return {"error": str(exc)}
        finally:
            if temporary is not None:
                try:
                    os.remove(temporary)
                except OSError:
                    pass

    def save_media(self, data: bytes, name: Any, kind: Any) -> Optional[Dict[str, str]]:
        """A video or picture the page made (the flame analysis board's export):
        checked for what it claims to be, written atomically where the user says."""
        formats = {"video": (".mp4", "MP4 video (*.mp4)"), "png": (".png", "PNG image (*.png)")}
        if kind not in formats:
            return {"error": "Unknown media kind."}
        extension, file_type = formats[kind]
        if kind == "video" and data[4:8] != b"ftyp":
            return {"error": "Not an MP4 file."}
        if kind == "png" and not data.startswith(bytes([137, 80, 78, 71, 13, 10, 26, 10])):
            return {"error": "Invalid PNG signature."}
        suggested = os.path.basename(str(name or "")) or "flame-analysis" + extension
        path = self._ask_save(suggested, (file_type,))
        if not path:
            return None
        if not path.lower().endswith(extension):
            path += extension
            if os.path.lexists(path):
                return {"error": "The name with its extension already exists. Choose the name with its extension."}
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=os.path.dirname(os.path.abspath(path)), prefix=".flame-analysis-",
                                             delete=False) as stream:
                temporary = stream.name
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            temporary = None
            return {"path": path}
        except OSError as exc:
            return {"error": str(exc)}
        finally:
            if temporary is not None:
                try:
                    os.remove(temporary)
                except OSError:
                    pass

    def take_queued_plan(self) -> Optional[Dict[str, str]]:
        queued, self._queued_plan = self._queued_plan, None
        return self.read_plan(queued) if queued else None

    # -- helpers -------------------------------------------------------

    def _ask_save(self, suggested_name: str, file_types) -> Optional[str]:
        if self.window is None:
            return None
        import webview

        result = self.window.create_file_dialog(
            webview.SAVE_DIALOG, save_filename=suggested_name, file_types=file_types,
            directory=self._last_directory(),
        )
        if not result:
            return None
        # Older pywebview returns a string here and newer versions a sequence.
        return result if isinstance(result, str) else result[0]

    def _write(self, path: str, text: str) -> Optional[str]:
        """Write via a temporary file in the same directory, then rename over.

        Opening the destination directly truncates it before a single byte is
        written, so a disk-full, a crash or a pulled USB stick mid-save destroys the
        previous plan and leaves nothing in its place. os.replace is atomic on the
        same filesystem, so the destination is either the old file or the new one.

        Returns None on success, or the reason it failed -- which the caller shows the
        user, because 'the disk is full' is not something to leave in a log file.
        """
        directory = os.path.dirname(os.path.abspath(path))
        temp: Optional[str] = None
        try:
            # A unique temporary name: a fixed `.name.tmp` let two saves of one file
            # (two windows, or two machines on a shared drive) write into the same
            # temporary and rename a mixture of both over the plan.
            # newline="" keeps the LF the canonical writer emitted; letting Python
            # translate to CRLF would make every plan diff wholesale against one
            # saved on another platform.
            with tempfile.NamedTemporaryFile(
                    "w", encoding="utf-8", newline="", dir=directory,
                    prefix=".{}.".format(os.path.basename(path)), suffix=".tmp",
                    delete=False) as fh:
                temp = fh.name
                fh.write(text)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(temp, path)
            temp = None
        except OSError as exc:
            message = "could not write {}: {}".format(path, exc)
            report(message)
            if temp is not None:
                try:
                    os.remove(temp)
                except OSError:
                    pass
            return message
        with self._settings_lock:
            self._settings["lastDirectory"] = directory
            self._save_settings()
        return None

    def _last_directory(self) -> str:
        directory = self._settings.get("lastDirectory", "")
        return directory if isinstance(directory, str) and os.path.isdir(directory) else ""

    def _set_title(self, name: str) -> None:
        self._title_name = name
        if self.window is not None:
            self.window.set_title("{}{} — {}".format(name, " •" if self.dirty else "", APP_NAME))


class Handler(SimpleHTTPRequestHandler):
    """Serves the bundle, and the shell API under /api/.

    Same origin as the page, so there is no CORS to arrange. Bound to loopback and
    gated on a per-run token, because anything else on the machine could otherwise
    drive the user's file dialogs.
    """

    shell: Shell
    token: str
    on_ready: Any

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        pass  # the default logs every request to stderr

    # -- plumbing ------------------------------------------------------

    def _send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorised(self) -> bool:
        return self.headers.get("X-Shell-Token") == self.token

    def _read_json(self) -> Dict[str, Any]:
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not re.fullmatch(r"[0-9]+", lengths[0]):
            raise ValueError("invalid Content-Length")
        # Compare before int conversion, including arbitrarily long declarations.
        digits = lengths[0].lstrip("0") or "0"
        cap = str(MAX_BODY_BYTES)
        if len(digits) > len(cap) or (len(digits) == len(cap) and digits > cap):
            raise OverflowError("JSON body exceeds the size limit")
        length = int(digits)
        if length <= 0:
            raise ValueError("empty JSON body")
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ValueError("incomplete JSON body")
        body = json.loads(raw.decode("utf-8"))
        if not isinstance(body, dict):
            raise ValueError("JSON body must be an object")
        return body

    # -- routes --------------------------------------------------------

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's naming
        route = urlparse(self.path).path
        if not self._authorised():
            self._send_json({"error": "bad token"}, 403)
            return
        if route == "/api/save-media":
            self._save_media()
            return
        try:
            body = self._read_json()
        except OverflowError:
            self._send_json({"error": "JSON request body exceeds the size limit."}, 413)
            return
        except ValueError:
            self._send_json({"error": "Invalid JSON request body."}, 400)
            return

        try:
            if route == "/api/ready":
                self.shell.ready_info = body
                # A plan named on the command line is collected here rather than
                # pushed at the page.
                self._send_json({"queuedPlan": self.shell.take_queued_plan()})
                if self.shell.selftest:
                    self.on_ready(self.shell)
            elif route == "/api/open":
                self._send_json(self.shell.open_plan())
            elif route == "/api/read-fds-include":
                self._send_json(self.shell.read_fds_include(body.get("name", "")))
            elif route == "/api/open-fds":
                self._send_json(self.shell.open_fds())
            elif route == "/api/results/open":
                self._send_json(self.shell.open_results())
            elif route == "/api/results/png":
                self._send_json(self.shell.save_results_png(body.get("data")))
            elif route == "/api/results/close":
                self.shell.results.close(str(body.get("token", "")))
                self._send_json({"closed": True})
            elif route == "/api/flame-analysis/open":
                self._send_json(self.shell.open_analysis())
            elif route == "/api/flame-analysis/close":
                self.shell.analyses.close(str(body.get("token", "")))
                self._send_json({"closed": True})
            elif route == "/api/open-recent":
                self._send_json(self.shell.open_recent(body.get("path")))
            elif route == "/api/adopted":
                self._send_json(self.shell.adopted(body.get("token")))
            elif route == "/api/dirty":
                self._send_json(self.shell.set_dirty(body.get("dirty")))
            elif route == "/api/save":
                token = body.get("token")
                self._send_json(self.shell.save_plan(
                    body.get("text", ""),
                    body.get("name", "plan.ftp.json"),
                    save_as=bool(body.get("saveAs")),
                    token=token if isinstance(token, str) else None,
                ))
            elif route == "/api/save-target":
                self._send_json(self.shell.save_target(
                    str(body.get("name", "plan.ftp.json")), bool(body.get("saveAs")),
                    body.get("token") if isinstance(body.get("token"), str) else None,
                ))
            elif route == "/api/pick-linked-files":
                self._send_json(self.shell.pick_linked_files(body.get("kind")))
            elif route == "/api/pick-folder":
                self._send_json(self.shell.pick_folder())
            elif route == "/api/flame/list":
                self._send_json(self.shell.list_flame_frames(body.get("path")))
            elif route == "/api/linked-file":
                self._send_json(self.shell.linked_file_action(body.get("path"), body.get("kind"), body.get("action")))
            elif route == "/api/save-html":
                self._send_json(self.shell.save_html(body.get("html", ""), body.get("name", "page.html")))
            elif route == "/api/save-fds":
                self._send_json(self.shell.save_fds(body.get("text", ""), body.get("name", "devices.fds")))
            elif route == "/api/save-csv":
                self._send_json(self.shell.save_csv(body.get("text", ""), body.get("name", "schedule.csv")))
            elif route == "/api/presets":
                self._send_json(self.shell.save_camera_presets(body.get("presets")))
            elif route == "/api/language":
                self._send_json(self.shell.save_interface_language(body.get("language")))
            else:
                self._send_json({"error": "unknown route"}, 404)
        except Exception as exc:  # noqa: BLE001 - never take the server down
            report("api error on {}: {!r}".format(route, exc))
            self._send_json({"error": str(exc)}, 500)

    def do_GET(self) -> None:  # noqa: N802
        route = urlparse(self.path).path
        if route.startswith("/api/"):
            if not self._authorised():
                self._send_json({"error": "bad token"}, 403)
            elif route == "/api/recent":
                self._send_json(self.shell.recent_files())
            elif route == "/api/presets":
                self._send_json(self.shell.camera_presets())
            elif route == "/api/language":
                self._send_json(self.shell.interface_language())
            elif route == "/api/flame/frame":
                self._send_flame_frame()
            elif route == "/api/test-data/file":
                self._send_test_data_file()
            elif route == "/api/results/read":
                self._send_result_range()
            elif route == "/api/flame-analysis/file":
                self._send_analysis_file()
            else:
                self._send_json({"error": "unknown route"}, 404)
            return
        super().do_GET()

    def _send_test_data_file(self) -> None:
        """Authenticated, bounded file read. The editor defers network paths until
        Load data, using the same isNetworkPath predicate as flame sequences."""
        path = (parse_qs(urlparse(self.path).query).get("path") or [""])[0]
        try:
            path = linked_files.checked_path(path, "spreadsheet")
            if os.path.splitext(path)[1].lower() not in (".xlsx", ".xlsm", ".csv", ".tsv", ".txt"):
                raise ValueError("Choose an .xlsx, .xlsm, .csv, .tsv or .txt file.")
            # Check before allocating and bound the read too, in case the file grows.
            info = os.stat(path)
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("Test data must be a regular file.")
            if info.st_size > MAX_TEST_DATA_BYTES:
                raise ValueError("Test data file exceeds the 64 MiB limit.")
            with open(path, "rb") as stream:
                info = os.fstat(stream.fileno())
                data = stream.read(MAX_TEST_DATA_BYTES + 1)
            if len(data) > MAX_TEST_DATA_BYTES:
                raise ValueError("Test data file exceeds the 64 MiB limit.")
            modified = datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        except (OSError, ValueError, TypeError) as exc:
            self._send_json({"error": str(exc)}, 404 if isinstance(exc, FileNotFoundError) else 400)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-File-Modified", modified)
        self.end_headers()
        self.wfile.write(data)

    def _send_result_range(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        def value(key: str) -> str:
            return (query.get(key) or [""])[0]
        try:
            data = self.shell.results.read(value("token"), value("name"),
                                           int(value("offset")), int(value("length")))
        except (OSError, ValueError, TypeError) as exc:
            self._send_json({"error": str(exc)}, 400)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _save_media(self) -> None:
        """The raw body is the file (an exported video can be tens of megabytes, so
        not base64 in JSON); name and kind come in the query."""
        query = parse_qs(urlparse(self.path).query)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_MEDIA_BYTES:
            self._send_json({"error": "Empty or oversized media (1 GiB at most)."}, 400)
            return
        data = bytearray()
        while len(data) < length:
            chunk = self.rfile.read(min(1 << 20, length - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) != length:
            self._send_json({"error": "Truncated media upload."}, 400)
            return
        try:
            result = self.shell.save_media(bytes(data), (query.get("name") or [""])[0], (query.get("kind") or [""])[0])
        except Exception as exc:  # noqa: BLE001 - report, never take the server down
            report("api error on /api/save-media: {!r}".format(exc))
            self._send_json({"error": str(exc)}, 500)
            return
        self._send_json(result)

    def _send_analysis_file(self) -> None:
        """A whole file of an opened flame analysis folder. Errors are JSON; success
        is the raw bytes (a picture, a manifest, a CSV or a hull frame)."""
        query = parse_qs(urlparse(self.path).query)
        token = (query.get("token") or [""])[0]
        name = (query.get("path") or [""])[0]
        try:
            data = self.shell.analyses.read(token, name)
        except (OSError, ValueError, TypeError) as exc:
            self._send_json({"error": str(exc)}, 404 if isinstance(exc, FileNotFoundError) else 400)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_flame_frame(self) -> None:
        """One frame's bytes, for a folder the page has listed. Errors are JSON so
        the page can show them; success is the raw file, which the page parses."""
        query = parse_qs(urlparse(self.path).query)
        path = (query.get("path") or [""])[0]
        name = (query.get("name") or [""])[0]
        try:
            data = self.shell.read_flame_frame(path, name)
        except (OSError, ValueError, TypeError, PermissionError) as exc:
            self._send_json({"error": str(exc)}, 404 if isinstance(exc, FileNotFoundError) else 400)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def start_server(shell: Shell, root: str, token: str, on_ready: Any) -> ThreadingHTTPServer:
    handler = partial(SimpleHTTPRequestHandler, directory=root)  # type: ignore[arg-type]
    del handler  # only to document the directory-serving mechanism below

    class Bound(Handler):
        pass

    Bound.shell = shell
    Bound.token = token
    Bound.on_ready = staticmethod(on_ready)

    def factory(*args: Any, **kwargs: Any) -> Bound:
        return Bound(*args, directory=root, **kwargs)

    server = ThreadingHTTPServer(("127.0.0.1", free_port()), factory)  # type: ignore[arg-type]
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def report_selftest(shell: Shell) -> None:
    """Check what the app reported, print a verdict, and exit the process.

    A GUI milestone nobody can see is not verified. This asserts the two things
    that actually break -- the bundle booting, and the bridge reaching Python --
    using the app's own /api/ready call as both trigger and evidence.
    """
    failures: List[str] = []
    info = shell.ready_info or {}
    try:
        report("the web app reached Python. /api/ready payload:")
        for key in sorted(info):
            report("  {:<16} {!r}".format(key, info[key]))

        if not info.get("canvas"):
            failures.append("the WebGL canvas was never created")
        if not info.get("toolbarButtons"):
            failures.append("the toolbar rendered no buttons")
        if not info.get("title"):
            failures.append("the page reported no title")

        recent = shell.recent_files()
        report("  {:<16} {!r}".format("recent_files()", recent))
        if not isinstance(recent, list):
            failures.append("recent_files() did not return a list")

    except Exception as exc:  # noqa: BLE001 - the selftest reports, never raises
        failures.append("exception during selftest: {!r}".format(exc))
    finally:
        if failures:
            report("\nSELFTEST FAILED:")
            for f in failures:
                report("  - {}".format(f))
        else:
            report("\nSELFTEST PASSED")
        # os._exit rather than a clean shutdown: this runs on a request thread, and
        # unwinding the GUI loop from here is neither necessary nor reliable. The
        # verdict is already written and flushed.
        os._exit(1 if failures else 0)


def main() -> int:
    parser = argparse.ArgumentParser(description=APP_NAME)
    parser.add_argument("--selftest", action="store_true",
                        help="boot, verify the app reached Python, print a report and exit")
    parser.add_argument("--dev", metavar="URL", default=None,
                        help="load a dev server URL instead of the built bundle")
    parser.add_argument("--log", metavar="FILE", default=None,
                        help="also write selftest output here, flushed as it happens")
    parser.add_argument("plan", nargs="?", help="a .ftp.json to open on launch")
    args = parser.parse_args()

    if args.log:
        globals()["_LOG_FILE"] = open(args.log, "w", encoding="utf-8")
        report("app.py starting (pid {})".format(os.getpid()))

    root = resource_root()
    if not args.dev and not os.path.isfile(os.path.join(root, "index.html")):
        print("Web bundle not found in {}\n"
              "Build it first:  cd web && npm run build".format(root), file=sys.stderr)
        return 2

    import webview

    shell = Shell()
    shell.selftest = args.selftest
    if args.plan and os.path.isfile(args.plan):
        shell.queue_plan(os.path.abspath(args.plan))

    # The token travels in the URL fragment-free query string, which the page reads
    # and echoes in a header. Loopback alone is not enough: any local process could
    # otherwise POST to /api/save and drive a file dialog.
    token = secrets.token_urlsafe(24)
    server = start_server(shell, root, token, report_selftest)
    port = server.server_address[1]
    target = args.dev or "http://127.0.0.1:{}/index.html".format(port)
    target = "{}{}shell={}&port={}".format(target, "&" if "?" in target else "?", token, port)

    if args.selftest:
        report("serving {} on port {}".format(root, port))
        report("window opening at {}".format(target.split("shell=")[0] + "shell=..."))

    # confirm_close starts off and follows the page's unsaved-changes state
    # (`Shell.set_dirty`), so closing a saved plan asks nothing and closing an
    # edited one asks this.
    window = webview.create_window(
        APP_NAME, target, width=1600, height=1000, min_size=(1100, 700), text_select=True,
        localization={"global.quitConfirmation": CLOSE_PROMPT},
    )
    shell.window = window

    try:
        webview.start()
    except Exception as exc:  # noqa: BLE001
        # A detached GUI process's stderr goes nowhere, so surface this in the log.
        import traceback
        report("webview.start raised: {!r}\n{}".format(exc, traceback.format_exc()))
        return 1

    if args.selftest:
        report("\nSELFTEST FAILED:\n  - the window closed before the web app called "
               "/api/ready; it either failed to boot or could not reach the server")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
