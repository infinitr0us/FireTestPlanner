"""Build FireTestPlanner's Windows icon from its SVG masters.

    python tools/build_app_icon.py

Renders web/src/assets/app-icon.svg (32 px and up) and web/src/assets/app-icon-small.svg
(16 to 24 px, the fire alone) in headless Chrome or Edge, the one SVG renderer this
project can count on, and writes python/shell/FireTestPlanner.ico with one PNG image
per size (Windows reads PNG entries at every size since Vista). The .ico is committed,
so only a change of artwork needs this script; the exe build only points PyInstaller
at the file. Needs Pillow, to cut the sizes out of one screenshot.

A browser other than the usual install paths: set FIREPLAN_CHROME to its executable.
"""

import base64
import io
import os
import struct
import subprocess
import sys
import tempfile
import time

from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FULL = os.path.join(REPO, "web", "src", "assets", "app-icon.svg")
SMALL = os.path.join(REPO, "web", "src", "assets", "app-icon-small.svg")
OUT = os.path.join(REPO, "python", "shell", "FireTestPlanner.ico")
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
SMALL_UP_TO = 24
GAP = 8

BROWSERS = [
    os.environ.get("FIREPLAN_CHROME", ""),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def browser():
    for path in BROWSERS:
        if path and os.path.isfile(path):
            return path
    sys.exit("No Chrome or Edge found; set FIREPLAN_CHROME to one.")


def data_url(path):
    with open(path, "rb") as f:
        return "data:image/svg+xml;base64," + base64.b64encode(f.read()).decode("ascii")


def render():
    """Every size side by side in one page, one screenshot with a clear background."""
    full, small = data_url(FULL), data_url(SMALL)
    places, x = {}, 0
    for size in SIZES:
        places[size] = x
        x += size + GAP
    width, height = x, max(SIZES) + GAP
    images = "".join(
        '<img src="{}" style="position:absolute;left:{}px;top:0;width:{}px;height:{}px">'.format(
            small if size <= SMALL_UP_TO else full, places[size], size, size)
        for size in SIZES)
    page = '<!doctype html><html><body style="margin:0;background:transparent">{}</body></html>'.format(images)
    with tempfile.TemporaryDirectory() as folder:
        html = os.path.join(folder, "icon.html")
        shot = os.path.join(folder, "icon.png")
        with open(html, "w", encoding="utf-8") as f:
            f.write(page)
        subprocess.run([
            browser(), "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
            "--user-data-dir=" + os.path.join(folder, "profile"),
            "--force-device-scale-factor=1", "--default-background-color=00000000",
            "--window-size={},{}".format(width, height), "--screenshot=" + shot,
            "file:///" + html.replace(os.sep, "/"),
        ], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        # On Windows chrome.exe hands the work to a browser process and returns at once:
        # wait for the screenshot to be written in full.
        size, deadline = -1, time.monotonic() + 60
        while time.monotonic() < deadline:
            now = os.path.getsize(shot) if os.path.isfile(shot) else -1
            if now > 0 and now == size:
                break
            size = now
            time.sleep(0.5)
        else:
            sys.exit("The browser wrote no screenshot within a minute.")
        time.sleep(1)  # let the browser exit before the folder is removed
        sheet = Image.open(shot).convert("RGBA")
        sheet.load()
    if sheet.size != (width, height):
        sys.exit("The screenshot is {} rather than {}; is the display scaled?".format(sheet.size, (width, height)))
    pngs = []
    for size in SIZES:
        image = sheet.crop((places[size], 0, places[size] + size, size))
        if not any(a > 0 for a in image.getchannel("A").getdata()):
            sys.exit("The {} px icon rendered empty.".format(size))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=True)
        pngs.append((size, buffer.getvalue()))
    return pngs


def write_ico(path, pngs):
    """ICONDIR, one ICONDIRENTRY per size (0 stands for 256), then the PNG images."""
    offset = 6 + 16 * len(pngs)
    entries, data = b"", b""
    for size, png in pngs:
        side = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", side, side, 0, 0, 1, 32, len(png), offset + len(data))
        data += png
    with open(path, "wb") as f:
        f.write(struct.pack("<HHH", 0, 1, len(pngs)) + entries + data)


def main():
    pngs = render()
    write_ico(OUT, pngs)
    print("Wrote {} ({} sizes, {} bytes)".format(os.path.relpath(OUT, REPO), len(pngs), os.path.getsize(OUT)))


if __name__ == "__main__":
    main()
