import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Two build targets from one source tree:
//
//   npm run build                 -> dist/index.html, a single self-contained file
//   SPLIT=1 npm run build         -> conventional split bundle
//
// The single file is the lightweight variant from PLAN.md: no server, no install,
// works offline, and can be emailed to a collaborator who then double-clicks it.
// It is also what the pywebview shell loads, so the desktop exe and the shareable
// page run byte-identical code.
const singleFile = !process.env.SPLIT;

export default defineConfig({
  base: './',
  plugins: singleFile ? [viteSingleFile()] : [],
  server: {
    // src/core/presets.ts imports the repo-root presets/cameras.json directly rather
    // than keeping a copy, so the editor and tools/build_fixtures.py cannot drift.
    fs: { allow: ['..'] },
  },
  build: {
    target: 'es2022',
    // Inlining is what makes the output self-contained; without a generous limit
    // Vite emits sibling asset files the single-file page cannot reach.
    assetsInlineLimit: 100 * 1024 * 1024,
    chunkSizeWarningLimit: 2000,
    // viteSingleFile already sets codeSplitting: false, which subsumes
    // inlineDynamicImports -- setting both makes Rollup warn.
  },
});
