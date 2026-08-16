/** Application entry point: wires the store, viewport and panels together. */

import examplePlan from '../../fixtures/pool-fire-camera-row.ftp.json';

import { newPlan, parsePlan } from './core/plan';
import type { LengthUnit, PlanDocument } from './core/types';
import { describeErrors, validateStructure } from './core/validate';
import {
  announceReady,
  buildShareableHtml,
  captureBootHtml,
  connectShell,
  embeddedPlan,
  isSingleFileBuild,
  openPlanText,
  savePlanText,
  saveShareableHtml,
  shell,
} from './io/files';
import { Viewport, type GizmoMode } from './scene/viewport';
import { Store } from './state/store';
import { h, qs } from './ui/dom';
import { Inspector } from './ui/inspector';
import { ChecksPanel, Outliner, Palette } from './ui/panels';
import { ReportOverlay } from './ui/report-overlay';
import './styles.css';

// Must run before anything mutates the DOM: 'export shareable viewer' hands
// someone this page with a plan baked in, and it has to be the pristine page.
captureBootHtml();

const store = new Store(embeddedPlan() ?? newPlan('Untitled fire test'));
const viewport = new Viewport(qs('#viewport'), store);
const inspector = new Inspector(qs('#inspector'), store);
const outliner = new Outliner(qs('#outliner'), store);
const checks = new ChecksPanel(qs('#checks'), store);
const palette = new Palette(qs('#palette'), store, (armed) => {
  viewport.placementMode = armed;
  document.body.classList.toggle('is-placing', armed);
  if (armed && measuring) toggleMeasure();
});

viewport.onMeasureChange = (count) => {
  measurementCount = count;
  renderToolbar();
};

const reportOverlay = new ReportOverlay((html, name) => { void saveShareableHtml(html, name); });

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

function renderToolbar(): void {
  const opts = viewport.getOptions();
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
      toggle('Front', store.viewMode === 'front', () => store.setViewMode('front'), 'Front elevation, looking +Y (2)'),
      toggle('Side', store.viewMode === 'side', () => store.setViewMode('side'), 'Side elevation, looking −X (3)'),
      toggle('3D', store.viewMode === '3d', () => store.setViewMode('3d'), 'Perspective orbit (4)'),
    ]),

    group([
      toggle('Move', gizmoMode === 'translate', () => setGizmo('translate'), 'G'),
      toggle('Rotate', gizmoMode === 'rotate', () => setGizmo('rotate'), 'R'),
      toggle('Snap', opts.snap, () => viewport.setOptions({ snap: !opts.snap })),
      toggle('Measure', measuring, toggleMeasure, 'Click two points for a distance (M)'),
      measurementCount > 0 ? btn('Clear', clearMeasurements, 'Remove all measurements') : null,
    ].filter(Boolean) as HTMLElement[]),

    group([
      toggle('Frustums', opts.showFrustums, () => viewport.setOptions({ showFrustums: !opts.showFrustums })),
      toggle('Flame', opts.showFlame, () => viewport.setOptions({ showFlame: !opts.showFlame }),
        'Heskestad flame cone and plume envelope'),
      toggle('Dims', opts.showDimensions, () => viewport.setOptions({ showDimensions: !opts.showDimensions }),
        'Standoff dimension lines from the fire'),
      toggle('Preview', opts.showPreview, () => viewport.setOptions({ showPreview: !opts.showPreview }),
        "Picture-in-picture of the selected camera's view"),
    ]),

    group([
      h('select', {
        class: 'toolbar__select',
        title: 'Display units. Stored values are always metric.',
        onchange: (e: Event) => {
          store.setDisplayUnit((e.target as HTMLSelectElement).value as LengthUnit);
          viewport.rebuild();
        },
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
  try {
    const result = await openPlanText();
    if (!result) return;

    // Validate before adopting it. A structurally broken plan would otherwise
    // reach the renderer as NaN geometry, which is far harder to diagnose than
    // being told which object is malformed.
    const doc = parsePlan(result.text);
    const errors = validateStructure(doc);
    if (errors.length > 0) {
      window.alert(
        `${result.name} is not a valid fire test plan:\n\n${describeErrors(errors)}\n\n` +
        'Nothing was loaded. Fix the file, or validate it with ' +
        '`python -c "from fireplan import Plan; Plan.load(path).validate_schema()"` ' +
        'for the full schema report.',
      );
      return;
    }

    store.replaceDocument(doc, result.name);
    viewport.frameAll();
  } catch (err) {
    window.alert(`Could not open that file.\n\n${(err as Error).message}`);
  }
}

async function savePlan(forceName = false): Promise<void> {
  const suggested = forceName || store.fileName === 'untitled.ftp.json'
    ? suggestFileName()
    : store.fileName;
  const saved = await savePlanText(store.serialize(), suggested);
  if (saved) store.markSaved(saved.split(/[\\/]/).pop() ?? suggested);
}

function suggestFileName(): string {
  const title = store.document.meta?.title ?? 'plan';
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plan';
  return `${slug}.ftp.json`;
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
  await saveShareableHtml(html, suggestFileName().replace(/\.ftp\.json$/, '') + '-viewer.html');
}

// -- keyboard -------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  // Never hijack typing in a form control.
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) {
    if (e.key === 'Escape') target.blur();
    return;
  }

  // The drawing preview owns the keyboard while it is up.
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

// A page exported by 'Share' opens straight into the plan it carries.
if (embeddedPlan()) {
  store.markSaved(`${(store.document.meta?.title ?? 'plan')}.ftp.json`);
  document.body.classList.add('is-shared-view');
}

// Adopt the desktop bridge if we are inside the pywebview shell, then report in.
// The shell's selftest waits on this call, so it doubles as the readiness signal.
connectShell(() => {
  document.body.classList.add('is-desktop');
  renderToolbar();
  void announceReady({
    title: document.title,
    toolbarButtons: document.querySelectorAll('#toolbar button').length,
    canvas: Boolean(document.querySelector('canvas.viewport-canvas')),
    objects: store.document.objects.length,
  }).then((queued) => {
    // A plan named on the shell's command line comes back from app_ready().
    if (!queued) return;
    try {
      store.replaceDocument(parsePlan(queued.text), queued.path.split(/[\\/]/).pop() ?? 'plan.ftp.json');
      viewport.frameAll();
    } catch (err) {
      window.alert(`Could not open ${queued.path}\n\n${(err as Error).message}`);
    }
  });
});
