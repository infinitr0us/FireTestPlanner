r"""Native check of the close prompt, in a real WebView2 window.

    .venv\Scripts\python.exe check_close_prompt.py       (from python/shell/)

WebView2 does not run the page's `beforeunload` when the host window closes, so
the unsaved-changes prompt is the shell's: `Shell.set_dirty` arms pywebview's
`confirm_close`. `test_shell.py` covers that contract; this drives the real window
(review 2026-09-22, L1/UI-3 and UI-11). It runs `app.main()` with an isolated
settings folder and a copy of the reference plan, and from a side thread:

  1. waits for the page to boot and adopt the queued plan (clean, no title bullet);
  2. deletes an object through the page's own keyboard handler -> dirty;
  3. posts WM_CLOSE -> expects the OK/Cancel prompt with CLOSE_PROMPT, presses
     Cancel -> the window must stay open;
  4. undoes through the page (Ctrl+Z) -> back at the saved state, dirty clears;
  5. posts WM_CLOSE again -> the window must close with no prompt.

A window appears for a few seconds. The verdict and a log go to the ignored
`review/desktop-checks/`, or to the folder given as the first argument. Windows
only; build the web bundle first (`cd web && npm run build`).
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
import shutil
import sys
import tempfile
import threading
import time

# The console may not be UTF-8 (GBK here); the window title carries "•" and "—".
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE =os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, "review", "desktop-checks")
os.makedirs(OUT, exist_ok=True)
home = tempfile.mkdtemp(prefix="fireplan-close-check-")
os.environ["FIREPLAN_SHELL_HOME"] = home
plan_path = os.path.join(home, "close-check.ftp.json")
shutil.copyfile(os.path.join(REPO, "fixtures", "pool-fire-camera-row.ftp.json"), plan_path)

sys.path.insert(0, HERE)
import app  # noqa: E402

user32 = ctypes.WinDLL("user32", use_last_error=True)
WM_CLOSE, WM_COMMAND, IDCANCEL, IDOK = 0x0010, 0x0111, 2, 1
EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
user32.EnumWindows.argtypes = [EnumProc, wt.LPARAM]
user32.EnumChildWindows.argtypes = [wt.HWND, EnumProc, wt.LPARAM]
user32.PostMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
user32.IsWindow.argtypes = [wt.HWND]
user32.IsWindowVisible.argtypes = [wt.HWND]
user32.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]

log = []
result = {"checks": [], "passed": False}


def note(msg):
    line = "{:7.2f}  {}".format(time.time() - t0, msg)
    log.append(line)
    print(line, flush=True)


def check(name, ok, detail=""):
    result["checks"].append({"name": name, "passed": bool(ok), "detail": detail})
    note(("PASS " if ok else "FAIL ") + name + (" -- " + detail if detail else ""))
    return ok


def text_of(hwnd):
    buf = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, buf, 512)
    return buf.value


def class_of(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def own_windows():
    found = []

    def cb(hwnd, _):
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == os.getpid() and user32.IsWindowVisible(hwnd):
            found.append(hwnd)
        return True

    user32.EnumWindows(EnumProc(cb), 0)
    return found


def main_window():
    for hwnd in own_windows():
        # The shell titles the window "<file>[ •] — Fire Test Plan Editor".
        if text_of(hwnd).endswith(app.APP_NAME) and class_of(hwnd) != "#32770":
            return hwnd
    return None


def dialog():
    for hwnd in own_windows():
        if class_of(hwnd) == "#32770":
            return hwnd
    return None


def dialog_text(hwnd):
    texts = []

    def cb(child, _):
        texts.append(text_of(child))
        return True

    user32.EnumChildWindows(hwnd, EnumProc(cb), 0)
    return " | ".join(t for t in texts if t)


def wait_for(fn, timeout, step=0.1):
    end = time.time() + timeout
    while time.time() < end:
        value = fn()
        if value:
            return value
        time.sleep(step)
    return None


shell_ref = {}
done = threading.Event()


class RecordingShell(app.Shell):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        shell_ref["shell"] = self


app.Shell = RecordingShell


def driver():
    try:
        shell = wait_for(lambda: shell_ref.get("shell"), 20)
        booted = wait_for(lambda: shell.window is not None and shell.ready_info, 60)
        check("page booted and reached Python", booted)
        adopted = wait_for(lambda: shell.current_path == os.path.abspath(plan_path), 20)
        check("queued plan adopted by the page", adopted, str(shell.current_path))
        hwnd = wait_for(main_window, 20)
        if not check("main window found", hwnd, "; ".join(
                "{}:{}".format(class_of(h), text_of(h)) for h in own_windows())):
            return
        time.sleep(1.0)
        check("clean plan: no title bullet", "•" not in text_of(hwnd), text_of(hwnd))

        rows = shell.window.evaluate_js(
            "(() => { const r = document.querySelector('.outliner__row'); r.click();"
            " window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Delete', bubbles: true}));"
            " return document.querySelectorAll('.outliner__row').length; })()")
        note("rows after Delete: {}".format(rows))
        check("edit reported dirty to the shell", wait_for(lambda: shell.dirty, 10))
        check("window.confirm_close armed", shell.window.confirm_close is True)
        check("dirty plan: title bullet", wait_for(lambda: "•" in text_of(hwnd), 5), text_of(hwnd))

        user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        dlg = wait_for(dialog, 10)
        check("WM_CLOSE on a dirty plan shows a prompt", dlg)
        if dlg:
            text = dialog_text(dlg)
            check("prompt carries the shell's wording", app.CLOSE_PROMPT in text, text)
            user32.PostMessageW(dlg, WM_COMMAND, IDCANCEL, 0)
            gone = wait_for(lambda: not user32.IsWindow(dlg), 5)
            check("Cancel dismisses the prompt", gone)
            time.sleep(1.0)
            check("Cancel keeps the window open", user32.IsWindow(hwnd) and main_window() == hwnd)

        shell.window.evaluate_js(
            "window.dispatchEvent(new KeyboardEvent('keydown', {key: 'z', ctrlKey: true, bubbles: true}))")
        check("undo back to the saved state clears dirty", wait_for(lambda: not shell.dirty, 10))
        check("confirm_close disarmed", shell.window.confirm_close is False)
        check("clean again: no title bullet", wait_for(lambda: "•" not in text_of(hwnd), 5), text_of(hwnd))

        user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        closed_or_prompt = wait_for(lambda: dialog() or (not user32.IsWindow(hwnd) and "closed"), 10)
        if closed_or_prompt and closed_or_prompt != "closed":
            check("WM_CLOSE on a clean plan closes without a prompt", False, dialog_text(closed_or_prompt))
            user32.PostMessageW(closed_or_prompt, WM_COMMAND, IDOK, 0)
        else:
            check("WM_CLOSE on a clean plan closes without a prompt", closed_or_prompt == "closed")
    except Exception as exc:  # noqa: BLE001
        check("driver ran without an exception", False, repr(exc))
    finally:
        result["passed"] = bool(result["checks"]) and all(c["passed"] for c in result["checks"])
        with open(os.path.join(OUT, "close-prompt.json"), "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        with open(os.path.join(OUT, "close-prompt.log"), "w", encoding="utf-8") as f:
            f.write("\n".join(log) + "\n")
        done.set()
        if main_window():
            # Never leave a window behind: close it outright.
            note("window still open at the end; exiting the process")
            os._exit(0 if result["passed"] else 1)


t0 = time.time()
threading.Thread(target=driver, daemon=True).start()
timer = threading.Timer(120, lambda: (note("timeout"), os._exit(3)))
timer.daemon = True
timer.start()
sys.argv = ["app.py", plan_path]
code = app.main()
note("app.main() returned {}".format(code))
done.wait(15)
shutil.rmtree(home, ignore_errors=True)
print("RESULT", "PASSED" if result["passed"] else "FAILED", flush=True)
os._exit(0 if result["passed"] else 1)
