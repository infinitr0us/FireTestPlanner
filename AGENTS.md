# Repository development instructions

Read [CONVENTIONS.md](CONVENTIONS.md) for changes to plan data, coordinates, units,
import/export or format versions.

For any new or changed UI, scene, plot, overlay, playback control, drawing or
exported figure, read [docs/visual-language.md](docs/visual-language.md) before
implementation. Its development workflow and checklist are the default design
requirements for future features; the user does not need to repeat them.

- Reuse the shared tokens, identity maps and controls identified in that document.
- Preserve recorded quantities, units, coordinates and explicit user colors.
- Add a new shared meaning at its source and document it in the same change.
  Record intentional differences in the existing exceptions table with a reason.
- Include relevant visual and interaction checks in feature completion, and extend
  the existing regressions when adding behavior they do not cover.
- Verify changed browser paths and report desktop/WebView2 or native-dialog checks
  separately. A build or a startup self-test alone does not verify UI interaction.

See [README.md#development](README.md#development) for the development entry point
and [web/browser-tests/README.md](web/browser-tests/README.md) for browser checks.
Keep reusable test code and fixtures in the source tree; generated review
screenshots and logs belong in the ignored `review/` directory.
