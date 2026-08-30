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
import json
import os
import secrets
import socket
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

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
MAX_BODY_BYTES = 256 * 1024 * 1024  # a plan with an embedded viewer can be large

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
        self._settings = self._load_settings()
        self._queued_plan: Optional[str] = None
        self.ready_info: Optional[Dict[str, Any]] = None
        # Absolute path of the plan currently open. The page only ever knows the
        # basename, so this is what makes Save mean "save" rather than "save as".
        self.current_path: Optional[str] = None
        # Folder of the last FDS input opened, which is where its `&CATF` includes
        # live. Not a document: an import produces an unsaved plan.
        self.fds_directory: Optional[str] = None

    # -- settings ------------------------------------------------------

    def _load_settings(self) -> Dict[str, Any]:
        try:
            with open(settings_path(), "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            # A corrupt or absent settings file must never stop the app opening.
            return {}

    def _save_settings(self) -> Optional[str]:
        """Write the settings file. None on success, or the reason it failed.

        Most callers ignore the answer -- a lost "recent files" entry is not worth
        a dialog -- but the preset library reports it, because the page words its
        own UI from whether the write actually landed rather than from the mere
        existence of somewhere to write to.
        """
        try:
            with open(settings_path(), "w", encoding="utf-8") as fh:
                json.dump(self._settings, fh, indent=2)
        except OSError as exc:
            return str(exc)
        return None

    def _remember(self, path: str) -> None:
        recent: List[str] = [p for p in self._settings.get("recent", []) if p != path]
        recent.insert(0, path)
        self._settings["recent"] = recent[:RECENT_LIMIT]
        self._save_settings()

    def recent_files(self) -> List[str]:
        """Recent paths that still exist, so the list never offers a dead file."""
        return [p for p in self._settings.get("recent", []) if os.path.isfile(p)]

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

    # -- files ---------------------------------------------------------

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
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
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
        if not name or os.path.isabs(name) or os.path.basename(name) != name:
            return {"error": "an &CATF include is read by bare filename only"}
        path = os.path.join(directory, name)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                return {"name": name, "text": fh.read()}
        except OSError as exc:
            return {"error": str(exc)}

    def read_plan(self, path: str) -> Optional[Dict[str, str]]:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                text = fh.read()
        except OSError as exc:
            report("could not read {}: {}".format(path, exc))
            return None
        self._remember(path)
        self.current_path = os.path.abspath(path)
        self._set_title(os.path.basename(path))
        return {"path": path, "text": text}

    def save_plan(self, text: str, suggested_name: str, save_as: bool = False) -> Optional[Dict[str, str]]:
        """Save to the open file, or ask for a destination.

        `Save` on a plan that came from disk writes straight back to it -- prompting
        for a filename the user already chose is not a save, and it is how a plan
        ends up saved next to itself under three near-identical names. `Save as...`,
        and any plan with no file behind it yet, still ask.

        Returns `{"path": ...}`, or `{"error": ...}` if the write failed, or None if
        the user cancelled the dialog. The page has to tell those apart: a failed
        save that looks like a cancelled one leaves the user believing their work is
        on disk when it is not.
        """
        path = None if save_as else self._writeback_path(suggested_name)
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
        return {"path": path}

    def _writeback_path(self, suggested_name: str) -> Optional[str]:
        """The open file, if the page is still showing the document that came from it.

        The editor can replace its document without the shell hearing about it -- the
        Example button does exactly that, and so does a command-line plan the page
        rejects -- after which `current_path` names a file that has nothing to do with
        what is on screen. Writing to it anyway destroys the user's plan silently,
        which is worse than the extra dialog it was meant to save.

        The page knows only a basename, and sends it back as the suggested name on a
        plain Save. Matching that against the open file is enough to tell 'this is the
        file I opened' from 'this is some other document now'.
        """
        if not self.current_path:
            return None
        return self.current_path if suggested_name == os.path.basename(self.current_path) else None

    def save_html(self, html: str, suggested_name: str) -> Optional[Dict[str, str]]:
        path = self._ask_save(suggested_name, HTML_FILTER)
        if not path:
            return None
        error = self._write(path, html)
        return {"error": error} if error else {"path": path}

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
        temp = os.path.join(directory, ".{}.tmp".format(os.path.basename(path)))
        try:
            # newline="" keeps the LF the canonical writer emitted; letting Python
            # translate to CRLF would make every plan diff wholesale against one
            # saved on another platform.
            with open(temp, "w", encoding="utf-8", newline="") as fh:
                fh.write(text)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(temp, path)
        except OSError as exc:
            message = "could not write {}: {}".format(path, exc)
            report(message)
            try:
                os.remove(temp)
            except OSError:
                pass
            return message
        self._settings["lastDirectory"] = directory
        self._save_settings()
        return None

    def _last_directory(self) -> str:
        directory = self._settings.get("lastDirectory", "")
        return directory if os.path.isdir(directory) else ""

    def _set_title(self, name: str) -> None:
        if self.window is not None:
            self.window.set_title("{} — {}".format(name, APP_NAME))


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
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    # -- routes --------------------------------------------------------

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's naming
        route = urlparse(self.path).path
        if not self._authorised():
            self._send_json({"error": "bad token"}, 403)
            return
        try:
            body = self._read_json()
        except ValueError:
            self._send_json({"error": "bad json"}, 400)
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
            elif route == "/api/open-recent":
                self._send_json(self.shell.read_plan(str(body.get("path", ""))))
            elif route == "/api/save":
                self._send_json(self.shell.save_plan(
                    body.get("text", ""),
                    body.get("name", "plan.ftp.json"),
                    save_as=bool(body.get("saveAs")),
                ))
            elif route == "/api/save-html":
                self._send_json(self.shell.save_html(body.get("html", ""), body.get("name", "page.html")))
            elif route == "/api/presets":
                self._send_json(self.shell.save_camera_presets(body.get("presets")))
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
            else:
                self._send_json({"error": "unknown route"}, 404)
            return
        super().do_GET()


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

    window = webview.create_window(
        APP_NAME, target, width=1600, height=1000, min_size=(1100, 700), text_select=True,
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
