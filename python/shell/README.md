# Desktop shell

The same web bundle the browser runs, in a native window with native file dialogs
and a recent-files list. Packaged as one `.exe`.

```bash
cd web && npm run build             # the bundle the shell hosts

cd python/shell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt

.venv\Scripts\python.exe app.py                 # run it
.venv\Scripts\python.exe app.py --selftest --log selftest.log
.venv\Scripts\python.exe build_exe.py           # -> dist/FireTestPlanner.exe
```

`--selftest` boots the window, waits for the web app to call `/api/ready`, checks
what it reported, prints a verdict and exits non-zero on failure. A GUI milestone
nobody can look at is not verified otherwise.

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
| `/api/open` | POST | Native open dialog; returns `{path, text}` |
| `/api/open-recent` | POST | Read a known path |
| `/api/save` | POST | Native save dialog, writes the plan |
| `/api/save-html` | POST | Native save dialog, writes an exported page |
| `/api/recent` | GET | Recent paths that still exist |

Everything else is served as static files from the bundle directory.

## Packaging

`build_exe.py` runs PyInstaller one-file with the web bundle added as data;
`resource_root()` finds it via `sys._MEIPASS` when frozen. The exe relies on the
WebView2 runtime that ships with Windows 11 rather than embedding a browser, which
is what keeps it in the tens of megabytes.

Use `--console` when building if you want to see `--selftest` output from the exe.
