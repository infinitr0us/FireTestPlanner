/** Application entry point: wires the store, viewport and panels together. */

import examplePlan from '../../fixtures/pool-fire-camera-row.ftp.json';

import { newPlan } from './core/plan';
import { adoptShellPresets } from './core/presets';
import type { LengthUnit, PlanDocument } from './core/types';
import { parseAndValidatePlan } from './core/validate';
import {
  announceReady,
  buildShareableHtml,
  captureBootHtml,
  connectShell,
  embeddedPlanText,
  isSingleFileBuild,
  openFdsText,
  openPlanText,
  savePlanText,
  saveShareableHtml,
  shell,
} from './io/files';
import { Viewport, type GizmoMode, type ViewportOptions } from './scene/viewport';
import { Store } from './state/store';
import { h, qs } from './ui/dom';
import { FdsImportDialog } from './ui/import-fds';
import { Inspector } from './ui/inspector';
import { ChecksPanel, Outliner, Palette } from './ui/panels';
import { ReportOverlay } from './ui/report-overlay';
import './styles.css';

// Must run before anything mutates the DOM: 'export shareable viewer' hands
// someone this page with a plan baked in, and it has to be the pristine page.
captureBootHtml();

const embedded = embeddedPlanText();

/** True once an embedded plan has actually been adopted -- which is not the same as
 *  the page carrying one, because it still has to survive validation. */
let sharedPlanAdopted = false;

/** A shared page's plan, if it survives validation. A broken one opens an empty
 *  editor with a console note rather than a half-built scene. */
function initialDocument(): PlanDocument {
  if (!embedded) return newPlan('Untitled fire test');
  try {
    const doc = parseAndValidatePlan(embedded);
    sharedPlanAdopted = true;
    return doc;
  } catch (err) {
    console.warn(`Embedded plan rejected:\n${(err as Error).message}`);
    return newPlan('Untitled fire test');
  }
}

const store = new Store(initialDocument());
const viewport = new Viewport(qs('#viewport'), store);
const inspector = new Inspector(qs('#inspector'), store);
const outliner = new Outliner(qs('#outliner'), store);
const checks = new ChecksPanel(qs('#checks'), store);
const palette = new Palette(qs('#palette'), store, (armed) => {
  viewport.placementMode = armed;
  document.body.classList.toggle('is-placing', armed);
  if (armed && measuring) toggleMeasure();
});

// The camera preset library is not part of the document, so adding or removing a
// preset emits no store event. Both panels list it, so both repaint here.
inspector.onPresetLibraryChange = () => {
  palette.render();
  inspector.render();
};

viewport.onMeasureChange = (count) => {
  measurementCount = count;
  renderToolbar();
};

const reportOverlay = new ReportOverlay((html, name) => { void saveHtml(html, name); });
const fdsImport = new FdsImportDialog();

/** Write an HTML export, and say so if it fails rather than doing nothing visible. */
async function saveHtml(html: string, name: string): Promise<void> {
  try {
    await saveShareableHtml(html, name);
  } catch (err) {
    window.alert(`${name} was not saved:\n\n${(err as Error).message}`);
  }
}

let gizmoMode: GizmoMode = 'translate';
let measuring = false;
let measurementCount = 0;

/** Placement and measuring both consume viewport clicks, so only one can be armed. */
function toggleMeasure(): void {
  measuring = !measuring;
  if (measuring) palette.cancel();
  viewport.setMeasureMode(measuring);
  document.body.classList.toggle('is-measuring', measuring);
  renderToolbar();
}

function clearMeasurements(): void {
  viewport.clearMeasurements();
  renderToolbar();
}

// -- wiring ---------------------------------------------------------------

viewport.onSelect = (id, additive) => {
  if (id === null) store.select(additive ? store.selectedIds : []);
  else if (additive) store.toggleSelect(id);
  else store.select([id]);
};

viewport.onPlace = (point) => palette.place([point.x, point.y, point.z]);

store.subscribe((event) => {
  if (event === 'document') {
    viewport.rebuild();
    inspector.render();
    outliner.render();
    checks.render();
    renderToolbar();
  } else if (event === 'selection') {
    viewport.syncSelection();
    inspector.render();
    outliner.render();
  } else if (event === 'view') {
    viewport.syncViewMode();
    renderToolbar();
  } else {
    renderToolbar();
  }
});

// -- toolbar --------------------------------------------------------------

const toolbar = qs('#toolbar');

/**
 * A viewport-option toggle.
 *
 * The current value is read at CLICK time, not at render time. A render-time
 * snapshot captured in the handler goes stale the moment the option changes --
 * `setOptions` rebuilds the viewport but emits no store event, so the toolbar is
 * never rerendered and every later click writes the same value again. Re-rendering
 * after the change is what keeps the active state honest too.
 */
const option = (
  label: string,
  key: keyof ViewportOptions,
  title?: string,
): HTMLElement =>
  toggle(label, viewport.getOptions()[key], () => {
    viewport.setOptions({ [key]: !viewport.getOptions()[key] });
    renderToolbar();
  }, title);

function renderToolbar(): void {
  const dirtyMark = store.dirty ? ' •' : '';

  toolbar.replaceChildren(
    h('div', { class: 'toolbar__group toolbar__group--title' }, [
      h('span', { class: 'toolbar__title' }, [store.document.meta?.title ?? 'Untitled']),
      h('span', { class: 'toolbar__file' }, [`${store.fileName}${dirtyMark}`]),
    ]),

    group([
      btn('Open', openPlan),
      btn('Save', savePlan),
      btn('Save as…', () => savePlan(true)),
      btn('Import FDS…', importFds,
        'Build a plan from an FDS input file — geometry, the burner and the devices'),
      btn('Example', loadExample, 'Load the reference plan built from the hand sketch'),
    ]),

    group([
      btn('Drawing…', openDrawing,
        'Dimensioned plan and elevations, equipment list and coverage — print to PDF'),
      btn('Share…', exportShareable,
        'Export a single self-contained HTML file with this plan baked in'),
    ]),

    group([
      toggle('Plan', store.viewMode === 'plan', () => store.setViewMode('plan'), 'Top-down orthographic (1)'),
      toggle('Front', store.viewMode === 'front', () => store.setViewMode('front'), 'Front elevation, looking +Y north (2)'),
      toggle('Side', store.viewMode === 'side', () => store.setViewMode('side'), 'Side elevation, looking +X east (3)'),
      toggle('3D', store.viewMode === '3d', () => store.setViewMode('3d'), 'Perspective orbit (4)'),
    ]),

    group([
      toggle('Move', gizmoMode === 'translate', () => setGizmo('translate'), 'G'),
      toggle('Rotate', gizmoMode === 'rotate', () => setGizmo('rotate'), 'R'),
      option('Snap', 'snap', 'Snap gizmo drags to a quarter of the grid step'),
      toggle('Measure', measuring, toggleMeasure, 'Click two points for a distance (M)'),
      measurementCount > 0 ? btn('Clear', clearMeasurements, 'Remove all measurements') : null,
    ].filter(Boolean) as HTMLElement[]),

    group([
      option('Frustums', 'showFrustums', 'Camera field-of-view pyramids'),
      option('Flame', 'showFlame', 'Heskestad flame cone and plume envelope'),
      option('Dims', 'showDimensions', 'Standoff dimension lines from the fire'),
      option('Preview', 'showPreview', "Picture-in-picture of the selected camera's view"),
    ]),

    group([
      h('select', {
        class: 'toolbar__select',
        title: 'Display units. Stored values are always metric.',
        // setDisplayUnit emits 'document', which rebuilds the viewport already.
        onchange: (e: Event) => store.setDisplayUnit((e.target as HTMLSelectElement).value as LengthUnit),
      }, (['m', 'cm', 'mm', 'ft', 'in'] as LengthUnit[]).map((u) =>
        h('option', { value: u, selected: u === store.displayUnit }, [u]))),
      btn('Fit', () => viewport.frameAll(), 'F'),
    ]),

    group([
      btn('Undo', () => store.undo(), 'Ctrl+Z'),
      btn('Redo', () => store.redo(), 'Ctrl+Y'),
    ]),
  );
}

const group = (children: HTMLElement[]): HTMLElement => h('div', { class: 'toolbar__group' }, children);

const btn = (label: string, onClick: () => void, title?: string): HTMLElement =>
  h('button', { class: 'toolbar__btn', type: 'button', onclick: onClick, title: title ?? '' }, [label]);

const toggle = (label: string, active: boolean, onClick: () => void, title?: string): HTMLElement =>
  h('button', {
    class: `toolbar__btn${active ? ' toolbar__btn--active' : ''}`,
    type: 'button',
    onclick: onClick,
    title: title ?? '',
  }, [label]);

function setGizmo(mode: GizmoMode): void {
  gizmoMode = mode;
  viewport.setGizmoMode(mode);
  renderToolbar();
}

// -- file actions ---------------------------------------------------------

function confirmDiscard(): boolean {
  return !store.dirty || window.confirm('This plan has unsaved changes. Discard them?');
}

async function openPlan(): Promise<void> {
  if (!confirmDiscard()) return;
  let result: Awaited<ReturnType<typeof openPlanText>>;
  try {
    result = await openPlanText();
  } catch (err) {
    // The desktop bridge can fail outright -- the shell's server gone, the file
    // unreadable. Left uncaught this is an unhandled rejection and the Open button
    // simply does nothing, which reads as a broken app rather than a failed read.
    window.alert(`Could not open a plan:\n\n${(err as Error).message}`);
    return;
  }
  if (!result) return;
  adopt(result.text, result.name);
}

/**
 * Adopt a plan from any source, or explain why not.
 *
 * Shared by Open and by a plan named on the desktop shell's command line, so both
 * validate before the store is touched and both leave the current document intact
 * on failure.
 */
function adopt(text: string, name: string): void {
  try {
    store.replaceDocument(parseAndValidatePlan(text), name);
    viewport.frameAll();
  } catch (err) {
    window.alert(
      `${name} could not be opened as a fire test plan:\n\n${(err as Error).message}\n\n` +
      'Nothing was loaded. Fix the file, or validate it with ' +
      '`python -c "from fireplan import Plan; Plan.load(path).validate_schema()"` ' +
      'for the full schema report.',
    );
  }
}

async function savePlan(saveAs = false): Promise<void> {
  const suggested = saveAs || store.fileName === 'untitled.ftp.json'
    ? suggestFileName()
    : store.fileName;
  try {
    const saved = await savePlanText(store.serialize(), suggested, saveAs);
    // null means the user cancelled the dialog; a failed write throws.
    if (saved) store.markSaved(saved.split(/[\\/]/).pop() ?? suggested);
  } catch (err) {
    window.alert(
      `${suggested} was not saved:\n\n${(err as Error).message}\n\n` +
      'The plan is still open and unchanged — try Save as… to a different location.',
    );
  }
}

function suggestFileName(): string {
  const title = store.document.meta?.title ?? 'plan';
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plan';
  return `${slug}.ftp.json`;
}

/**
 * Build a plan from an FDS input.
 *
 * The conversion is previewed before anything is adopted -- an FDS model is bigger
 * than a test plan and most of it has no counterpart here, so "what did this
 * actually import?" has to be answerable before the answer matters.
 */
async function importFds(): Promise<void> {
  if (!confirmDiscard()) return;
  let picked: Awaited<ReturnType<typeof openFdsText>>;
  try {
    picked = await openFdsText();
  } catch (err) {
    window.alert(`Could not open an FDS file:\n\n${(err as Error).message}`);
    return;
  }
  if (!picked) return;

  try {
    fdsImport.open(picked.text, picked.name, store.displayUnit, (doc, name) => {
      store.replaceDocument(doc, name);
      // An import is not a saved file: the plan exists only here until it is
      // written, and Save must ask for a destination rather than aiming at the .fds.
      store.markDirty();
      viewport.frameAll();
    });
  } catch (err) {
    window.alert(
      `${picked.name} could not be read as FDS input:\n\n${(err as Error).message}`);
  }
}

function loadExample(): void {
  if (!confirmDiscard()) return;
  store.replaceDocument(
    JSON.parse(JSON.stringify(examplePlan)) as PlanDocument,
    'pool-fire-camera-row.ftp.json',
  );
  viewport.frameAll();
}

function openDrawing(): void {
  reportOverlay.open(
    store.document,
    store.displayUnit,
    suggestFileName().replace(/\.ftp\.json$/, '') + '-drawing.html',
  );
}

async function exportShareable(): Promise<void> {
  if (!isSingleFileBuild() && !shell()) {
    window.alert(
      'Shareable export only works from the built single-file app.\n\n' +
      'Run `npm run build` and open dist/index.html — the dev server serves the app ' +
      'as separate files, so an exported page would not carry its own code.',
    );
    return;
  }
  const title = store.document.meta?.title ?? 'Fire test plan';
  const html = buildShareableHtml(store.serialize(), title);
  await saveHtml(html, suggestFileName().replace(/\.ftp\.json$/, '') + '-viewer.html');
}

// -- keyboard -------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  // Never hijack typing in a form control.
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) {
    if (e.key === 'Escape') target.blur();
    return;
  }

  // A modal owns the keyboard while it is up.
  if (fdsImport.isOpen) {
    if (e.key === 'Escape') fdsImport.close();
    return;
  }
  if (reportOverlay.isOpen) {
    if (e.key === 'Escape') reportOverlay.close();
    return;
  }

  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); return; }
  if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    e.preventDefault(); store.redo(); return;
  }
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); void savePlan(e.shiftKey); return; }
  if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); void openPlan(); return; }
  if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); store.duplicateSelected(); return; }

  switch (e.key) {
    case 'Delete':
    case 'Backspace':
      store.removeSelected();
      break;
    case 'Escape':
      palette.cancel();
      if (measuring) toggleMeasure();
      store.select([]);
      break;
    case 'g': case 'G': setGizmo('translate'); break;
    case 'r': case 'R': setGizmo('rotate'); break;
    case 'm': case 'M': toggleMeasure(); break;
    case 'f': case 'F': viewport.frameAll(); break;
    case '1': store.setViewMode('plan'); break;
    case '2': store.setViewMode('front'); break;
    case '3': store.setViewMode('side'); break;
    case '4': store.setViewMode('3d'); break;
    default: break;
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!store.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

// -- boot -----------------------------------------------------------------

palette.render();
inspector.render();
outliner.render();
checks.render();
renderToolbar();
viewport.setGizmoMode(gizmoMode);
viewport.frameAll();

// A page exported by 'Share' opens straight into the plan it carries. Keyed on the
// plan having been adopted, not on the page merely carrying one: a shared page whose
// payload failed validation is showing an empty untitled plan, and presenting that as
// a saved document invites the user to Save over a filename that means nothing.
// (`is-shared-view` and `is-desktop` carry no styling of their own; they are hooks for
// a user stylesheet, and for anything that later wants to trim the chrome.)
if (sharedPlanAdopted) {
  store.markSaved(`${(store.document.meta?.title ?? 'plan')}.ftp.json`);
  document.body.classList.add('is-shared-view');
}

// Adopt the desktop bridge if we are inside the pywebview shell, then report in.
// The shell's selftest waits on this call, so it doubles as the readiness signal.
connectShell(() => {
  document.body.classList.add('is-desktop');
  renderToolbar();

  // The custom preset library comes from the shell's settings file, not from
  // browser storage: this page's origin carries a fresh loopback port on every
  // launch, and `localStorage` is scoped to the origin, so the library the user
  // built last time was in a namespace this launch cannot see. Adopted before the
  // first save can happen, and the two panels that list presets repaint once it
  // lands.
  const bridge = shell();
  if (bridge) {
    void bridge.loadPresets().then((stored) => {
      adoptShellPresets(stored, (presets) => bridge.savePresets(presets));
      palette.render();
      inspector.render();
    }, () => {
      // An unreachable shell route is not worth failing the boot over; the
      // in-memory library still works for the session and says so.
    });
  }

  void announceReady({
    title: document.title,
    toolbarButtons: document.querySelectorAll('#toolbar button').length,
    canvas: Boolean(document.querySelector('canvas.viewport-canvas')),
    objects: store.document.objects.length,
  }).then((queued) => {
    // A plan named on the shell's command line comes back from app_ready().
    if (!queued) return;
    adopt(queued.text, queued.path.split(/[\\/]/).pop() ?? 'plan.ftp.json');
  });
});
