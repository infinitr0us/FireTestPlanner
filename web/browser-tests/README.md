# Browser regression checks

Run `npm run dev -- --host 127.0.0.1` from `web`, then open
`http://127.0.0.1:5173/browser-tests/visual-consistency.html` in a WebGL-capable browser.

The page uses the real DOM controls, canvas probe layer and results dialog with
small in-memory FDS files. It reports 18 checks covering native form-key guards,
frame stepping, playback cancellation, looping, single-frame inspection, scale
validation, hollow probe shapes, overlap picking and cutaway filtering.

The page does not use a native file picker, write plan files or contact an external
service. Native control defaults (such as actual slider Home/End behavior) and
layout still need a browser interaction check; synthetic key events alone do not
prove those defaults. This is separate from the Node-based `npm test` suite.
