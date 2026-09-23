/** Application entry point: wires the store, viewport and panels together. */

// The Example is the reference layout with a flame reconstructed from a test on
// its site: the plan, and the packed frames the page carries so nothing has to be
// on disk. Both come from fixtures/flame/ via tools/build_flame_fixture.py.
import examplePlan from '../../fixtures/flame/flame-test.ftp.json';
import exampleFlameUrl from '../../fixtures/flame/flame-test.fvs?url';

import { handleTransportKey } from './ui/transport';
import type { FlameSequence } from './core/flame';
import { flameSequenceLink, newPlan, reconstructedFlames } from './core/plan';
import { adoptShellPresets, keepPresetsForSession } from './core/presets';
import { isReconstructedFlame, type LengthUnit, type PlanDocument } from './core/types';
import { describeErrors, parseAndValidatePlan, validateStructure } from './core/validate';
import {
  announceReady,
  buildShareableHtml,
  captureBootHtml,
  connectShell,
  embeddedFlameKey,
  embeddedPlanText,
  isSingleFileBuild,
  openFdsText,
  resolveFdsIncludes,
  openPlanText,
  savePlanText,
  saveShareableHtml,
  shell,
  splitEmbeddedFlames,
  type EmbeddedFlames,
  type ShellBridge,
} from './io/files';
import { isNetworkPath } from './core/linked-files';
import { decodeEmbedded, encodeEmbedded } from './io/flame-sources';
import { Viewport, type GizmoMode, type ViewportOptions } from './scene/viewport';
import { flameActions, type FlameActionsHost } from './state/flame-actions';
import { FlameStore } from './state/flame-store';
import { Playhead } from './state/playhead';
import { Store } from './state/store';
import { h, qs } from './ui/dom';
import { FdsImportDialog } from './ui/import-fds';
import { FdsResultsDialog } from './ui/fds-results';
import { Inspector } from './ui/inspector';
import { ChecksPanel, Outliner, Palette } from './ui/panels';
import { PlaybackBar } from './ui/playback-bar';
import { ReportOverlay } from './ui/report-overlay';
import { ReconstructionPlotPanel } from './ui/reconstruction-plot';
import './styles.css';

// Must run before anything mutates the DOM: 'export shareable viewer' hands
// someone this page with a plan baked in, and it has to be the pristine page.
captureBootHtml();

/** True once an embedded plan has actually been adopted -- which is not the same as
 *  the page carrying one, because it still has to survive validation. */
let sharedPlanAdopted = false;
/** The packed frames a shared page carried for its plan, attached once the app is up. */
let embeddedFlames: EmbeddedFlames = new Map();

/**
 * A shared page's plan, if it survives validation. A broken one opens an empty
 * editor with a console note rather than a half-built scene -- and that includes
 * lifting the embedded frames out of it, which reads the plan's shape before the
 * validator has said anything about it.
 */
function initialDocument(): PlanDocument {
  const text = embeddedPlanText() ?? '';
  if (!text) return newPlan('Untitled fire test');
  try {
    const embedded = splitEmbeddedFlames(text);
    const doc = parseAndValidatePlan(embedded.text);
    sharedPlanAdopted = true;
    embeddedFlames = embedded.flames;
    return doc;
  } catch (err) {
    console.warn(`Embedded plan rejected:\n${(err as Error).message}`);
    return newPlan('Untitled fire test');
  }
}

const store = new Store(initialDocument());
const flameStore = new FlameStore();
const playhead = new Playhead();
const viewport = new Viewport(qs('#viewport'), store, flameStore, playhead);
const inspector = new Inspector(qs('#inspector'), store);
new ReconstructionPlotPanel(qs('#viewport'), store, playhead, flameStore);
// Linking, relinking, refreshing and reading a flame's frames, shared by the
// palette, the burner's Linked files section, the flame's inspector and the bar.
const flameHost: FlameActionsHost = {};
const flameOps = flameActions(store, flameStore, flameHost);
const flamePanel = inspector.attachFlames(flameStore, flameOps);
flameHost.onProgress = (text) => flamePanel.setProgress(text);
const playbackBar = new PlaybackBar(qs('#viewport'), store, flameStore, playhead, {
  cubeCount: () => viewport.flameCubeCount,
  snapshot: () => downloadDataUrl(viewport.snapshotPng(3), suggestFileName().replace(/\.ftp\.json$/, '') + '-flame.png'),
  loadFrames: (flame) => { void flameOps.load(flame); },
});

// The camera preview sits in the corner the bar docks along; lift it by the bar's height.
new ResizeObserver(() => {
  viewport.setPreviewInset(playbackBar.visible ? playbackBar.element.offsetHeight + 8 : 0);
}).observe(playbackBar.element);

// -- flames: loading and the clock ---------------------------------------------

/**
 * The instants the clock can stand at: every loaded sequence's timestamps, for the
 * flames the document holds. Recomputed whenever either side changes; `setMarks`
 * is a no-op when nothing did.
 */
function syncPlayback(): void {
  const marks: number[] = [];
  for (const flame of reconstructedFlames(store.document)) {
    const link = flameSequenceLink(flame);
    const sequence = link ? flameStore.sequenceOf(link) : undefined;
    if (sequence) marks.push(...sequence.timestamps);
  }
  playhead.setMarks(marks);
  viewport.syncFlames();
}

/** Adopt the packed sequences a page carried, matched to the plan's links. */
async function attachEmbedded(flames: EmbeddedFlames): Promise<void> {
  const documentId = store.documentId;
  for (const flame of reconstructedFlames(store.document)) {
    const link = flameSequenceLink(flame);
    const payload = link && flames.get(embeddedFlameKey(flame.id, link.id));
    if (!link || !payload) continue;
    try {
      const sequence = await decodeEmbedded(payload);
      if (store.documentId !== documentId) return;
      flameStore.attach(link, sequence);
    } catch (err) {
      console.warn(`Embedded flame for ${flame.id} rejected: ${(err as Error).message}`);
    }
  }
}

/**
 * On the desktop, frames the plan links are read as the plan opens -- from a local
 * folder. A plan is someone else's file, and a link to `\\host\share` would have
 * Windows contact that host, offering the user's credentials, before anyone clicked
 * anything; such a folder waits for Load frames like a browser tab's does.
 */
function autoLoadFlames(): void {
  if (!shell()) return;
  for (const flame of reconstructedFlames(store.document)) {
    const link = flameSequenceLink(flame);
    if (link && !isNetworkPath(link.path) && !flameStore.get(link)) void flameOps.load(flame);
  }
}

/**
 * Tell the desktop shell whether there are unsaved changes, so its close prompt is
 * armed exactly while they exist. WebView2 does not run `beforeunload` when the
 * window is closed, so this is the only thing that stops a close discarding work.
 * Chained, so two quick updates cannot reach the threaded server out of order.
 */
let reportedDirty = false;
let dirtyReports: Promise<void> = Promise.resolve();
function reportDirty(): void {
  const bridge = shell();
  if (!bridge || store.dirty === reportedDirty) return;
  reportedDirty = store.dirty;
  const dirty = store.dirty;
  dirtyReports = dirtyReports.then(() => bridge.setDirty(dirty)).catch(() => {
    // The prompt is a safeguard, not a reason to interrupt editing.
  });
}

/** The desktop's recent plans, newest first. Empty in a browser tab. */
let recentPlans: string[] = [];
function refreshRecent(): void {
  const bridge = shell();
  if (!bridge) return;
  void bridge.recentFiles().then((list) => {
    recentPlans = list;
    renderToolbar();
  }, () => {});
}

async function openRecentPlan(path: string): Promise<void> {
  const bridge = shell();
  if (!bridge || !confirmDiscard()) return;
  let result: Awaited<ReturnType<ShellBridge['openRecent']>>;
  try {
    result = await bridge.openRecent(path);
  } catch (err) {
    window.alert(`Could not open ${path}:\n\n${(err as Error).message}`);
    refreshRecent();
    return;
  }
  if (result) adopt(result.text, result.path.split(/[\\/]/).pop() ?? 'plan.ftp.json', result.token);
}

function downloadDataUrl(url: string, name: string): void {
  if (!url) return;
  const anchor = h('a', { href: url, download: name });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/** The selected flame's cache state the inspector last painted, so a progress
 *  tick can be told from a change of state. */
let flameInspectorState = '';
flameStore.subscribe(() => {
  syncPlayback();
  // The flame's inspector says whether its frames are loaded; frames arriving
  // through the bar, an auto-load or an embedded payload have to reach it too. A
  // change of state always repaints; a per-frame progress tick repaints only when
  // no field in the inspector has the keyboard, so a name being typed during a
  // long read is not rebuilt from under the cursor eighty times.
  const sole = store.soleSelected;
  if (!sole || !isReconstructedFlame(sole)) return;
  const link = flameSequenceLink(sole);
  const entry = link ? flameStore.get(link) : undefined;
  const state = `${store.documentId}/${sole.id}/${entry?.status ?? 'absent'}/${entry?.changed ?? ''}/${entry?.error ?? ''}`;
  const active = document.activeElement;
  const typing = active instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName) && qs('#inspector').contains(active);
  if (state !== flameInspectorState || !typing) {
    flameInspectorState = state;
    inspector.render();
  }
});
let flameDocumentId = store.documentId;
const outliner = new Outliner(qs('#outliner'), store);
const checks = new ChecksPanel(qs('#checks'), store);
const palette = new Palette(qs('#palette'), store, (armed) => {
  viewport.placementMode = armed;
  document.body.classList.toggle('is-placing', armed);
  if (armed && measuring) toggleMeasure();
});
// The palette has no panel to show a failure under, so a folder that cannot be
// read is reported the way a plan that cannot be opened is.
palette.linkFlame = () => {
  flameOps.link(null).catch((err) => {
    window.alert(`The voxel folder was not linked:\n\n${(err as Error).message}`);
  });
};

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
const fdsResults = new FdsResultsDialog(open => viewport.setSuspended(open));

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
  reportDirty();
  if (event === 'document') {
    if (store.documentId !== flameDocumentId) {
      // A new document: the loaded sequences belonged to the old one.
      flameDocumentId = store.documentId;
      flameStore.clear();
      autoLoadFlames();
    }
    viewport.rebuild();
    syncPlayback();
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
      btn('Open', () => { void openPlan(); }),
      recentPlans.length > 0 ? recentSelect() : null,
      btn('Save', () => { void savePlan(false); }),
      btn('Save as…', () => { void savePlan(true); }),
      btn('Import FDS…', () => { void importFds(); },
        'Build a plan from an FDS input file — geometry, the burner and the devices'),
      btn('FDS results…', () => { playhead.pause(); fdsResults.open(); }, 'Visualize and play recorded FDS simulation output'),
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
      option('Predicted', 'showFlame', 'Heskestad flame cone and plume envelope — the prediction, drawn beside any reconstructed flame'),
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

const group = (children: Array<HTMLElement | null>): HTMLElement =>
  h('div', { class: 'toolbar__group' }, children);

/** The desktop's recent plans: a select whose first option is its own label, so
 *  choosing a file opens it and the control shows "Recent…" again afterwards. */
function recentSelect(): HTMLElement {
  return h('select', {
    class: 'toolbar__select',
    title: 'Open a recent plan',
    onchange: (e: Event) => {
      const select = e.target as HTMLSelectElement;
      const path = select.value;
      select.value = '';
      if (path) void openRecentPlan(path);
    },
  }, [
    h('option', { value: '', selected: true }, ['Recent…']),
    ...recentPlans.map((path) => h('option', { value: path, title: path }, [path.split(/[\\/]/).pop() ?? path])),
  ]);
}

// The click event is swallowed here rather than forwarded: a handler such as
// `savePlan(saveAs = false)` registered directly would receive the MouseEvent as its
// first argument, and a truthy object where a boolean was expected turned every
// click on Save into Save As. Typing the callback as `() => void` does not stop the
// DOM supplying an argument at runtime; not passing it on does.
const btn = (label: string, onClick: () => void, title?: string): HTMLElement =>
  h('button', {
    class: 'toolbar__btn', type: 'button', onclick: () => onClick(), title: title ?? '',
  }, [label]);

const toggle = (label: string, active: boolean, onClick: () => void, title?: string): HTMLElement =>
  h('button', {
    class: `toolbar__btn${active ? ' toolbar__btn--active' : ''}`,
    type: 'button',
    onclick: () => onClick(),
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
  adopt(result.text, result.name, result.token);
}

/**
 * Adopt a plan from any source, or explain why not.
 *
 * Shared by Open and by a plan named on the desktop shell's command line, so both
 * validate before the store is touched and both leave the current document intact
 * on failure. `token` is the shell's handle on the file the text came from; it is
 * adopted only if the document is, so a file the page rejects never becomes the
 * destination of the next Save -- the document still on screen keeps its own.
 */
function adopt(text: string, name: string, token: string | null = null): void {
  try {
    // A plan lifted out of a shared page may still carry its packed flames.
    const split = splitEmbeddedFlames(text);
    store.replaceDocument(parseAndValidatePlan(split.text), name, token);
    if (split.flames.size) void attachEmbedded(split.flames);
    viewport.frameAll();
    // Only an adopted file becomes a recent plan and the window's title.
    const bridge = shell();
    if (bridge && token) void bridge.adopted(token).then(refreshRecent, () => {});
  } catch (err) {
    window.alert(
      `${name} could not be opened as a fire test plan:\n\n${(err as Error).message}\n\n` +
      'Nothing was loaded. Fix the file, or validate it with ' +
      '`python -c "from fireplan import Plan; Plan.load(path).validate_schema()"` ' +
      'for the full schema report.',
    );
  }
}

/** True while a save is waiting on the shell, so a second Ctrl+S does not race it. */
let saveInFlight = false;

async function savePlan(saveAs = false): Promise<void> {
  // Two saves in flight would write two snapshots to one file in whichever order the
  // dialogs close. The dirty bullet stays up until the first one lands, so a second
  // press is not lost -- it is simply asked for again once the file is on disk.
  if (saveInFlight) return;
  const suggested = saveAs || store.fileName === 'untitled.ftp.json'
    ? suggestFileName()
    : store.fileName;
  // Taken BEFORE serialising: this is the document and revision the bytes describe,
  // and it is what decides whether the dirty bullet may clear when the write lands.
  const identity = store.identity();
  saveInFlight = true;
  try {
    const saved = await savePlanText(store.serialize(), suggested, saveAs, identity.token);
    // null means the user cancelled the dialog; a failed write throws.
    if (saved) {
      store.markSaved(saved.path.split(/[\\/]/).pop() ?? suggested, identity, saved.token);
      refreshRecent();
    }
  } catch (err) {
    window.alert(
      `${suggested} was not saved:\n\n${(err as Error).message}\n\n` +
      'The plan is still open and unchanged — try Save as… to a different location.',
    );
  } finally {
    saveInFlight = false;
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

  // A split input -- geometry in one file, devices in another, pulled together by
  // &CATF -- is the normal shape for anything past a demo, and importing only the
  // file that was named would hand over a model with most of itself missing.
  const source = await resolveFdsIncludes(picked.text, picked.name);

  try {
    fdsImport.open(source.text, picked.name, store.displayUnit, (doc, name) => {
      // The same boundary every other document crosses. `replaceDocument` installs
      // the document before anything reads it, so a plan that would fail to load is
      // refused here rather than adopted, saved and then refused on reopen.
      const errors = validateStructure(doc);
      if (errors.length > 0) {
        window.alert(
          `${picked!.name} converted into a plan this editor cannot open:\n\n`
          + `${describeErrors(errors)}\n\nNothing was imported.`);
        return;
      }
      // No token: an import is not a saved file. The plan exists only here until
      // it is written, and Save must ask for a destination rather than aiming at
      // the .fds or at whatever plan was open before.
      store.replaceDocument(doc, name);
      store.markDirty();
      viewport.frameAll();
    }, { includesResolved: source.resolved, includeIssues: source.issues });
  } catch (err) {
    window.alert(
      `${picked.name} could not be read as FDS input:\n\n${(err as Error).message}`);
  }
}

function loadExample(): void {
  if (!confirmDiscard()) return;
  // No token: the Example is bundled, not a file on this machine, so the first Save
  // asks where to put it -- even when the file that was open before happened to be
  // called flame-test.ftp.json too.
  store.replaceDocument(
    JSON.parse(JSON.stringify(examplePlan)) as PlanDocument,
    'flame-test.ftp.json',
  );
  viewport.frameAll();
  // The frames travel with the page, so the Example plays with nothing on disk.
  const documentId = store.documentId;
  void fetch(exampleFlameUrl).then((r) => r.arrayBuffer()).then(async (buffer) => {
    if (store.documentId !== documentId) return;
    const { gunzip, FlameSequence } = await import('./core/flame');
    const sequence = FlameSequence.unpack(await gunzip(new Uint8Array(buffer)));
    for (const flame of reconstructedFlames(store.document)) {
      const link = flameSequenceLink(flame);
      if (link && store.documentId === documentId) flameStore.attach(link, sequence);
    }
  }).catch((err) => console.warn(`Example flame not loaded: ${(err as Error).message}`));
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
  // One snapshot, taken before the first await: the plan text, its title, the
  // file name and which loaded sequences go with it. Compressing the frames
  // yields to the page, and a plan opened or edited meanwhile would otherwise be
  // serialised under the old title with the old plan's frames.
  const identity = store.identity();
  const title = store.document.meta?.title ?? 'Fire test plan';
  const name = suggestFileName().replace(/\.ftp\.json$/, '') + '-viewer.html';
  const planJson = store.serialize();
  const flames = await embeddableFlames(store.document);
  if (flames === null) return;
  if (store.documentId !== identity.documentId || store.revision !== identity.revision) {
    window.alert('The plan changed while the page was being built. Nothing was exported; please Share again.');
    return;
  }
  const html = buildShareableHtml(planJson, title, flames);
  await saveHtml(html, name);
}

/** A shared page carries at most this much packed flame data, gzipped. */
const EMBED_CAP_BYTES = 25 * 1024 * 1024;

/**
 * The loaded sequences a shared page can carry for `doc`, or null if the user
 * backed out.
 *
 * Under the cap, every loaded flame goes in and the viewer plays with nothing on
 * disk. Over it, the page is exported without them and says so up front rather
 * than producing a file nobody can open. The sequences are looked up before the
 * first await, so they are the ones loaded for the document handed in.
 */
async function embeddableFlames(doc: PlanDocument): Promise<EmbeddedFlames | null> {
  const payloads: EmbeddedFlames = new Map();
  const unloaded: string[] = [];
  const loaded: Array<{ key: string; sequence: FlameSequence }> = [];
  for (const flame of reconstructedFlames(doc)) {
    const link = flameSequenceLink(flame);
    if (!link) continue;
    const sequence = flameStore.sequenceOf(link);
    if (!sequence) { unloaded.push(flame.name || flame.id); continue; }
    loaded.push({ key: embeddedFlameKey(flame.id, link.id), sequence });
  }
  let bytes = 0;
  for (const { key, sequence } of loaded) {
    const encoded = await encodeEmbedded(sequence);
    bytes += encoded.length * 0.75;
    payloads.set(key, encoded);
  }
  if (bytes > EMBED_CAP_BYTES) {
    const proceed = window.confirm(
      `The reconstructed flame frames come to ${(bytes / 1048576).toFixed(0)} MB packed, over the ` +
      `${EMBED_CAP_BYTES / 1048576} MB a shared page carries. Export the page without them? ` +
      'The viewer will show the timeline and say the frames are not included.',
    );
    return proceed ? new Map() : null;
  }
  if (unloaded.length) {
    const proceed = window.confirm(
      `The frames for ${unloaded.join(', ')} are not loaded, so the page will not carry them. Export anyway?`,
    );
    if (!proceed) return null;
  }
  return payloads;
}

// -- keyboard -------------------------------------------------------------

/**
 * Whether a focused form control is one the user types into, as opposed to one
 * they operate -- a slider, a checkbox, a select. A text field has an edit history
 * and a pending value of its own; the others have neither.
 */
function isTextControl(el: HTMLElement): boolean {
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  return !/^(range|checkbox|radio|color|file|button|submit|reset|image)$/.test((el as HTMLInputElement).type);
}

/**
 * The value the focused text control held when it took focus or last committed,
 * so Escape can put it back. Escape used to blur the field with the typed text
 * still in it -- and a blur commits, so Escape saved the edit it should cancel.
 */
let committedText: { el: HTMLInputElement | HTMLTextAreaElement; value: string } | null = null;
const noteCommitted = (e: Event): void => {
  const el = e.target;
  committedText = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && isTextControl(el)
    ? { el, value: el.value }
    : null;
};
window.addEventListener('focusin', noteCommitted);
window.addEventListener('change', (e) => { if (e.target === committedText?.el) noteCommitted(e); }, true);

window.addEventListener('keydown', (e) => {
  if (fdsResults.isOpen) return;
  const target = e.target as HTMLElement | null;
  const control = target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) ? target : null;
  // Escape cancels what was typed, then hands the keyboard back to the editor.
  if (control && e.key === 'Escape') {
    if (committedText?.el === control) committedText.el.value = committedText.value;
    control.blur();
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
  const key = e.key.toLowerCase();
  const textField = control && isTextControl(control) ? control : null;

  // Document shortcuts. Save and Open are the document's from any control: none
  // uses them, and the browser's own Ctrl+S and Ctrl+O -- Save Page As, Open
  // File -- are the wrong dialogs, which is where they went after a click on the
  // playback scrubber, speed or Loop. Undo, redo and duplicate are the document's
  // too, unless a text field has focus: its Ctrl+Z is its own edit history. A text
  // field commits what is typed in it before a save or an open (`change` fires on
  // blur), so the file holds the value on screen and a discard is asked about.
  if (ctrl && key === 's') { e.preventDefault(); textField?.blur(); void savePlan(e.shiftKey); return; }
  if (ctrl && key === 'o') { e.preventDefault(); textField?.blur(); void openPlan(); return; }
  if (ctrl && !textField) {
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); return; }
    if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); store.redo(); return; }
    if (key === 'd') { e.preventDefault(); store.duplicateSelected(); return; }
  }
  // Every other key in a form control is the control's: typing, arrows on a
  // slider, type-ahead on a select, Space on a checkbox.
  if (control) return;

  // Transport keys, only while there is something to play. Space on a focused
  // button is the button's: the browser activates it on keyup, and toggling the
  // clock as well would press two things at once.
  if (playbackBar.visible && handleTransportKey(e, {
    play: () => playhead.toggle(),
    previous: () => playhead.step(-1),
    next: () => playhead.step(1),
    first: () => playhead.seek(playhead.start),
    last: () => playhead.seek(playhead.end),
  })) return;

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
  store.markSaved(`${(store.document.meta?.title ?? 'plan')}.ftp.json`, store.identity());
  document.body.classList.add('is-shared-view');
  if (embeddedFlames.size) void attachEmbedded(embeddedFlames);
}

// Adopt the desktop bridge if we are inside the pywebview shell, then report in.
// The shell's selftest waits on this call, so it doubles as the readiness signal.
connectShell(() => {
  document.body.classList.add('is-desktop');
  renderToolbar();
  refreshRecent();
  reportDirty();

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
      // in-memory library still works for the session, and now says so -- it used
      // to fall back to browser storage under this launch's one-off origin and
      // promise the library would outlive the window.
      keepPresetsForSession();
      palette.render();
      inspector.render();
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
    adopt(queued.text, queued.path.split(/[\\/]/).pop() ?? 'plan.ftp.json', queued.token);
  });
  // The shell may have connected after the first document was installed.
  autoLoadFlames();
});
