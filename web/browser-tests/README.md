# Browser regression checks

From `web/`, run `npm run test:browser`. It builds the single-file app, starts a
local Vite server on an available port, and runs a temporary headless Chromium
profile with software WebGL. No additional automation package is required; the
runner uses Node's built-in WebSocket and Chromium's DevTools protocol.

Chrome and Edge are detected in their usual Windows locations; Chrome on macOS
and common Linux Chromium locations are also checked. Set `BROWSER_BIN` to an
executable path if needed. Node 22 or newer is required. The browser must be
allowed to launch renderer/GPU subprocesses.

Set `BROWSER_TEST_OUTPUT` to a JSON file path to save the report and two adjacent
screenshots. The temporary browser profile is removed after the run. Checks,
fixtures and the runner stay in this directory; generated reports and screenshots
can go in the ignored `review/` directory.

The fixture page checks native form-key guards, detached-host theme access, text
glyph presentation, temperature/probe pixels, overlap picking, cutaways, stepping,
playback cancellation, looping, single-frame inspection and scale validation.
The runner additionally sends real mouse/key input to check summary Space
activation, focused transport shortcuts and native slider Home/End. It opens the
built editor's Example plan to exercise window-level keyboard routing and compares
transport typography, dimensions and speed options between workspaces. On its
synthetic flame it checks the 55 s surface count, the linked CSV cursor, and actual
play/pause advancement, and captures a nonempty frame for visual review. On its
A8303sc camera it checks the single palette entry, the Lens options, a lens change
by a real key on the Lens select (comparison row, field of view and focal length)
and its undo.

For manual inspection, run `npm run dev -- --host 127.0.0.1` and open
`/browser-tests/visual-consistency.html` at the URL and port Vite prints.
The page also opens the public `room_corner` subset, selects a directed gauge and
its history, renders every recorded quantity, and seeks to the final 60 s frame.
Add `?interactive=1` to leave that three-frame results fixture open after the checks.

The fixture does not use a native file picker, write plan files or contact an
external service. Chromium checks are separate from native WebView2 startup and
OS file-dialog testing. Run `npm test` for Node-based identity and shortcut-policy
regressions.
