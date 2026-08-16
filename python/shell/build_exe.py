"""Package the desktop shell into a single Windows executable.

    cd web && npm run build          # the bundle the exe will carry
    cd python/shell
    .venv\\Scripts\\python.exe build_exe.py

Produces dist/FireTestPlanner.exe. The exe carries the web bundle as bundled data
and relies on the WebView2 runtime that ships with Windows 11, which is what keeps
it in the tens of megabytes rather than the ~150 MB an embedded Chromium costs.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
WEB_DIST = os.path.join(REPO, "web", "dist")
APP_NAME = "FireTestPlanner"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--console", action="store_true",
                        help="keep a console window, so --selftest output is visible")
    parser.add_argument("--clean", action="store_true", help="discard previous build artefacts")
    args = parser.parse_args()

    index = os.path.join(WEB_DIST, "index.html")
    if not os.path.isfile(index):
        print("Web bundle missing: {}\nRun `npm run build` in web/ first.".format(index),
              file=sys.stderr)
        return 2

    size_mb = os.path.getsize(index) / (1024 * 1024)
    print("Bundling web/dist/index.html ({:.1f} MB)".format(size_mb))

    if args.clean:
        for path in (os.path.join(HERE, "build"), os.path.join(HERE, "dist")):
            shutil.rmtree(path, ignore_errors=True)

    command = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--onefile",
        "--name", APP_NAME,
        "--distpath", os.path.join(HERE, "dist"),
        "--workpath", os.path.join(HERE, "build"),
        "--specpath", HERE,
        # ';' is the Windows separator; the bundle lands in a 'web' folder that
        # resource_root() finds via sys._MEIPASS.
        "--add-data", "{};web".format(WEB_DIST),
        # pywebview loads its own JS at runtime and resolves the platform backend
        # dynamically, so neither the data files nor the submodules are visible to
        # PyInstaller's static analysis.
        "--collect-all", "webview",
        "--collect-all", "clr_loader",
        "--hidden-import", "webview.platforms.edgechromium",
        "--hidden-import", "webview.platforms.winforms",
    ]
    command.append("--console" if args.console else "--windowed")
    command.append(os.path.join(HERE, "app.py"))

    print("$ " + " ".join(command))
    result = subprocess.run(command, cwd=HERE, check=False)
    if result.returncode != 0:
        return result.returncode

    exe = os.path.join(HERE, "dist", APP_NAME + ".exe")
    if os.path.isfile(exe):
        print("\nBuilt {} ({:.1f} MB)".format(exe, os.path.getsize(exe) / (1024 * 1024)))
        print("Verify with:  {} --selftest --log selftest-exe.log".format(exe))
    return 0


if __name__ == "__main__":
    sys.exit(main())
