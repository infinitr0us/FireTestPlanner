# Desktop shell

The same web bundle the browser runs, in a native window with native file dialogs
and a recent-files list. Packaged as one `.exe`.

```bash
cd web && npm run build             # the bundle the shell hosts

cd python/shell
py -3.14 -m venv .venv              # Python 3.11 or later; releases use 3.14
.venv\Scripts\python.exe -m pip install -r requirements.txt

.venv\Scripts\python.exe app.py                 # run it
.venv\Scripts\python.exe app.py --selftest --log selftest.log
.venv\Scripts\python.exe check_close_prompt.py  # the unsaved-changes prompt, natively
.venv\Scripts\python.exe build_exe.py           # -> dist/FireTestPlanner.exe
```

`--selftest` boots the window, waits for the web app to call `/api/ready`, checks
what it reported, prints a verdict and exits non-zero on failure. A GUI milestone
nobody can look at is not verified otherwise.

`check_close_prompt.py` drives the real window: it edits the plan through the page,
sends the window `WM_CLOSE`, expects the unsaved-changes prompt and cancels it, undoes
back to the saved state, and expects the next close to go through without asking.
WebView2 does not run the page's `beforeunload` when the host window closes, so
this prompt is the shell's (`Shell.set_dirty` arms pywebview's `confirm_close`), and
unit tests alone cannot show that the native dialog appears. A window shows for a
few seconds; the verdict goes to the ignored `review/desktop-checks/`.

## Why an HTTP bridge instead of pywebview's `js_api`

`js_api` is the obvious choice and it is not what this uses. With `js_api` bound to
this particular page the WebView2 message channel never came up: Python's worker
threads froze and the page never reached Python, over both `file://` and
`http_server=True`. The same code path against a synthetic page running an
equivalent WebGL render loop worked fine, so it is something specific to this
bundle that was not worth chasing further.

Instead the shell runs one `ThreadingHTTPServer` on loopback that serves **both**
the bundle and the API. That is same-origin, so no CORS; it uses only mechanisms
already proven to work here; and it is the right shape for Phase 2, where importing
multi-gigabyte flame sequences wants range requests rather than a JS bridge.

One trap worth recording, since it cost real time: pywebview installs an empty
`window.pywebview.api` object *before* attaching the Python methods. Code that waits
for the object rather than for a specific method latches onto the empty one and
binds a bridge whose every call is `undefined`.

## Security

The server binds `127.0.0.1` on a random free port and requires a per-run token,
generated at launch and passed to the page in its query string. Loopback alone is
not enough — without the token any other local process could POST to `/api/save`
and drive the user's file dialogs.

## API

| Route | Method | Purpose |
|---|---|---|
| `/api/ready` | POST | The app reports it has booted; returns any plan named on the command line |
| `/api/open` | POST | Native open dialog; returns `{path, text, token}` |
| `/api/open-recent` | POST | Read a path from the recent list (and only from it); same answer |
| `/api/adopted` | POST | The page kept the plan `token` names: it joins the recent list and the title |
| `/api/dirty` | POST | Unsaved changes on or off: arms the window's close prompt and the title bullet |
| `/api/recent` | GET | Recent paths that still exist |
| `/api/save-target` | POST | Chooses a plan's destination before the page rebases its links; writes nothing |
| `/api/save` | POST | Writes the plan to the file `token` names; asks for a destination otherwise |
| `/api/save-html` | POST | Native save dialog, writes an exported page |
| `/api/open-fds` | POST | Native open dialog for an FDS input; returns its text and name |
| `/api/read-fds-include` | POST | A file an `&CATF` names, confined to the input's folder and its subfolders |
| `/api/pick-linked-files` | POST | Native dialog for spreadsheets or videos to link to an object |
| `/api/linked-file` | POST | Open a linked file, show its folder, or read a spreadsheet's text |
| `/api/pick-folder` | POST | Native folder dialog for a reconstructed flame's frames |
| `/api/flame/list` | POST | The frame files a voxel folder holds; registers the folder for `/api/flame/frame` |
| `/api/flame/frame` | GET | One frame's bytes, from a registered folder only |
| `/api/presets` | GET, POST | The custom camera preset library in the settings file: read, or replace |
| `/api/results/open` | POST | Native dialog for an FDS `.smv`; opens a results session over its folder |
| `/api/results/read` | GET | A byte range of one output the session's `.smv` names (including `RESULTS_DIR` subfolders) |
| `/api/results/png` | POST | Native save dialog for a results snapshot |
| `/api/results/close` | POST | Ends a results session |

Everything else is served as static files from the bundle directory.

Both save routes answer `{"path": ...}`, `{"error": ...}` or `null` — `/api/save`
adds a `token` to the success answer. The three are distinct on purpose: `null` is a
cancelled dialog, which needs no comment, while an `error` is the user's work not
reaching the disk and has to be shown to them.

**Document identity is a token, not a filename.** Every plan the shell reads or
writes comes with an opaque token naming that file. The page keeps the token only
while the document it arrived with is the one on screen — `replaceDocument` drops it
unless a new one is supplied — and sends it back on a plain Save. The shell writes to
the file the token names and to nothing else; no token, or one it never issued, means
a Save As dialog. This is what stops three ways of losing a file that a basename
match allowed: opening a plan the page then rejects (its name matched the plan that
stayed on screen), loading the bundled Example over an open copy of the reference
fixture (same name, different plan), and importing `case.fds` over an open
`case.ftp.json`. The page also records which document and revision a save was taken
from, so a save that lands after further typing leaves the dirty marker up, and one
that lands after the document was replaced is ignored.

## Packaging

`build_exe.py` runs PyInstaller one-file with the web bundle added as data;
`resource_root()` finds it via `sys._MEIPASS` when frozen. The exe relies on the
WebView2 runtime that ships with Windows 11 rather than embedding a browser, which
is what keeps it in the tens of megabytes.

Use `--console` when building if you want to see `--selftest` output from the exe.

Note that `build_exe.py` packages whatever is already in `web/dist` — it does not
build it. Prefer `build.bat` in the repo root, which rebuilds the bundle first and
then verifies the packaged exe; running `build_exe.py` alone after editing the
frontend produces an exe carrying the previous bundle.
