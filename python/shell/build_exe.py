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
from typing import Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
WEB_DIST = os.path.join(REPO, "web", "dist")
APP_NAME = "FireTestPlanner"
# The exe's icon, which pywebview's window and the taskbar take from the exe. Built from
# web/src/assets/app-icon*.svg by tools/build_app_icon.py and committed.
ICON = os.path.join(HERE, APP_NAME + ".ico")

# The Visual C++ runtime is not part of Windows. Finding it in System32 on the build
# machine says nothing about the machine the exe will run on, so it must be bundled.
VC_RUNTIME = ("vcruntime140", "msvcp140", "concrt140", "vcomp140")


def conda_library_bin() -> Optional[str]:
    """`Library\\bin` of the conda Python this venv was made from, if it is one.

    Conda keeps the DLLs that `_ctypes`, `_ssl`, `_hashlib`, `pyexpat` and `_decimal`
    load (ffi.dll, libcrypto, libssl, libexpat, libmpdec) in `Library\\bin`, not next
    to the extension modules. PyInstaller searches there only when the running prefix
    has `conda-meta`, which a venv made from a conda Python does not. It then takes
    same-named DLLs from anywhere on PATH, or leaves them out with a warning, and the
    exe starts only on machines that happen to have them on PATH.
    """
    base = sys.base_prefix
    library_bin = os.path.join(base, "Library", "bin")
    if os.path.isdir(os.path.join(base, "conda-meta")) and os.path.isdir(library_bin):
        return library_bin
    return None


def unresolved_dlls(exe: str) -> Dict[str, List[str]]:
    """DLLs that a binary inside the exe imports but that neither the exe nor Windows has.

    Windows is judged by this machine's System32, except for the Visual C++ runtime.
    """
    import pefile
    from PyInstaller.archive.readers import CArchiveReader

    reader = CArchiveReader(exe)
    bundled = {os.path.basename(name).lower() for name in reader.toc}
    system32 = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32")
    missing: Dict[str, List[str]] = {}
    for name in sorted(reader.toc):
        if not name.lower().endswith((".dll", ".pyd")):
            continue
        pe = pefile.PE(data=reader.extract(name), fast_load=True)
        pe.parse_data_directories(
            directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"]])
        for entry in getattr(pe, "DIRECTORY_ENTRY_IMPORT", []):
            dll = entry.dll.decode("ascii", "replace").lower()
            if dll in bundled or dll.startswith(("api-ms-win-", "ext-ms-")):
                continue
            if not dll.startswith(VC_RUNTIME) and os.path.isfile(os.path.join(system32, dll)):
                continue
            missing.setdefault(dll, []).append(name)
    return missing


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
        "--icon", ICON,
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
        # Build-time code that the lines above would otherwise put in the exe.
        # `--collect-all webview` also collects pywebview's PyInstaller hook, which
        # imports PyInstaller itself (and with it pefile, altgraph and setuptools);
        # PyInstaller finds that hook through its entry point, not this module graph.
        # cffi reaches distutils (setuptools' copy since Python 3.12) only to compile
        # C code, and clr_loader uses cffi in ABI mode (cdef and dlopen).
        "--exclude-module", "webview.__pyinstaller",
        "--exclude-module", "cffi._shimmed_dist_utils",
    ]
    command.append("--console" if args.console else "--windowed")
    command.append(os.path.join(HERE, "app.py"))

    env = dict(os.environ)
    library_bin = conda_library_bin()
    if library_bin:
        print("Conda Python: DLLs resolve from {} first".format(library_bin))
        env["PATH"] = library_bin + os.pathsep + env.get("PATH", "")

    print("$ " + " ".join(command))
    result = subprocess.run(command, cwd=HERE, env=env, check=False)
    if result.returncode != 0:
        return result.returncode

    exe = os.path.join(HERE, "dist", APP_NAME + ".exe")
    if not os.path.isfile(exe):
        return 0
    missing = unresolved_dlls(exe)
    if missing:
        print("\nThe exe lacks DLLs that its own binaries import, so it would start only "
              "where they happen to be on PATH:", file=sys.stderr)
        for dll, users in sorted(missing.items()):
            print("  {}  (needed by {})".format(dll, ", ".join(users)), file=sys.stderr)
        return 3
    print("\nEvery DLL the bundled binaries import is in the exe or part of Windows.")
    print("Built {} ({:.1f} MB)".format(exe, os.path.getsize(exe) / (1024 * 1024)))
    print("Verify with:  {} --selftest --log selftest-exe.log".format(exe))
    return 0


if __name__ == "__main__":
    sys.exit(main())
