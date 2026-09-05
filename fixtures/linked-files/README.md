# Linked test data example

Open **linked-test.ftp.json** in the updated editor. Select **Heptane pan, 1 ft
square** to see the reconstruction plots; select **GoPro** to see the video link.
In the desktop app, **Open** uses the default program and **Show in folder** reveals
the original file in Explorer. Move this folder as a unit to keep its links working.

`volumes.csv` and `video_example.mp4` are the original engineer-supplied examples,
preserved without alteration. The CSV has 100 measurements from 0 to 198 seconds.
The video is a 20.84-second H.264 MP4 showing a fire simulation. Its assignment to
GoPro demonstrates linking; it does not claim this camera recorded this scene or
that video time is synchronized with the CSV.

Rebuild the demonstration plan with `python tools/build_linked_fixture.py` from the
repository root. The browser and Python tests validate it and check identical
canonical serialization.

The original request is preserved in
[`docs/feature-requests/2026-09-linked-files.txt`](../../docs/feature-requests/2026-09-linked-files.txt).
See [the usage guide](../../docs/linked-files.md) for all controls and limitations.
