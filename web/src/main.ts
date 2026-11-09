import * as i18n from './ui/i18n';
import { adoptShellLanguage, chooseLanguage, restoreBrowserLanguage } from './ui/language-preference';
/** Application entry point: wires the store, viewport and panels together. */

// The Example is the reference layout with a synthetic 80 kW design fire from
// tools/build_synthetic_flame.py. The plan and packed frames are built by
// tools/build_flame_fixture.py, so playback needs no external files.
import examplePlan from '../../fixtures/flame/flame-test.ftp.json';
import exampleFlameUrl from '../../fixtures/flame/flame-test.fvs?url';

import { handleTransportKey } from './ui/transport';
import { nextTest } from './core/asbuilt';
import { serializePlan } from './core/serialize';
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
  saveNextTestText,
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
import { TestDataStore } from './state/test-data-store';
import { embedTestData, splitEmbeddedTestData, type TestDataShareSummary } from './io/test-data-embed';
import type { Series } from './core/test-data';
import { fireClockMarks } from './state/fire-clock';
import { Playhead } from './state/playhead';
import { Store } from './state/store';
import { h, qs } from './ui/dom';
import { menuButton } from './ui/menu-button';
import { FdsImportDialog } from './ui/import-fds';
import { FdsExportDialog } from './ui/export-fds';
import { FdsResultsDialog } from './ui/fds-results';
import { FlameAnalysisWorkspace } from './ui/flame-analysis';
import { Inspector } from './ui/inspector';
import { ChecksPanel, Outliner, Palette } from './ui/panels';
import { PlaybackBar } from './ui/playback-bar';
import { ReportOverlay } from './ui/report-overlay';
import { PlotPanel } from './ui/plot-panel';
import { ReconstructionView } from './ui/reconstruction-plot';
import { TestDataView } from './ui/instrument-plot';
import { TestDataDialog } from './ui/test-data';
import './styles.css';

// Must run before anything mutates the DOM: 'export shareable viewer' hands
// someone this page with a plan baked in, and it has to be the pristine page.
captureBootHtml();
restoreBrowserLanguage();
document.documentElement.lang = i18n.language();

/** True once an embedded plan has actually been adopted -- which is not the same as
 *  the page carrying one, because it still has to survive validation. */
let sharedPlanAdopted = false;
/** The packed frames a shared page carried for its plan, attached once the app is up. */
let embeddedFlames: EmbeddedFlames = new Map();
let embeddedTestData = new Map<string, Series[]>();

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
    const data = splitEmbeddedTestData(text);
    const embedded = splitEmbeddedFlames(data.text);
    const doc = parseAndValidatePlan(embedded.text);
    sharedPlanAdopted = true;
    embeddedFlames = embedded.flames;
    embeddedTestData = data.series;
    data.warnings.forEach(warning => console.warn(warning));
    return doc;
  } catch (err) {
    console.warn(`Embedded plan rejected:\n${(err as Error).message}`);
    return newPlan('Untitled fire test');
  }
}

const store = new Store(initialDocument());
const flameStore = new FlameStore();
const testDataStore = new TestDataStore(store);
function attachTestData(series: Map<string, Series[]>): void {
  for (const [id, samples] of series) testDataStore.attachEmbedded(id, samples);
}
attachTestData(embeddedTestData);
const playhead = new Playhead();
const viewport = new Viewport(qs('#viewport'), store, flameStore, playhead);
const inspector = new Inspector(qs('#inspector'), store);
// One plot panel in the viewport's upper right: a burner's reconstruction CSV and
// an instrument's test data share its frame, with a selector when both apply.
new PlotPanel(qs('#viewport'), store,
  [new ReconstructionView(store, playhead, flameStore), new TestDataView(store, testDataStore, playhead)],
  [(fn) => flameStore.subscribe(fn), (fn) => testDataStore.subscribe(fn)], playhead);
// Linking, relinking, refreshing and reading a flame's frames, shared by the
// palette, the burner's Linked files section, the flame's inspector and the bar.
const flameHost: FlameActionsHost = {};
const flameOps = flameActions(store, flameStore, flameHost);
const flamePanel = inspector.attachFlames(flameStore, flameOps);
inspector.attachTestData(testDataStore);
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
 * flames the document holds, or with none loaded the fire clock over the burners'
 * heat release rate curves. One clock either way: the cone follows the flame's
 * frames when there are some. Recomputed whenever either side changes; `setMarks`
 * is a no-op when nothing did.
 */
function syncPlayback(): void {
  const marks: number[] = [];
  for (const flame of reconstructedFlames(store.document)) {
    const link = flameSequenceLink(flame);
    const sequence = link ? flameStore.sequenceOf(link) : undefined;
    if (sequence) marks.push(...sequence.timestamps);
  }
  if (marks.length) playhead.setMarks(marks, 'flame');
  else playhead.setMarks(fireClockMarks(store.document), 'fire');
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
    window.alert(i18n.t("Could not open {p1}:\n\n{p2}", { p1: path, p2: (err as Error).message }));
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
checks.openTestData = (sourceId) => openTestData(sourceId);
const palette = new Palette(qs('#palette'), store, (armed) => {
  viewport.placementMode = armed;
  document.body.classList.toggle('is-placing', armed);
  if (armed && measuring) toggleMeasure();
});
// The palette has no panel to show a failure under, so a folder that cannot be
// read is reported the way a plan that cannot be opened is.
palette.linkFlame = () => {
  flameOps.link(null).catch((err) => {
    window.alert(i18n.t("The voxel folder was not linked:\n\n{p1}", { p1: (err as Error).message }));
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
const fdsExport = new FdsExportDialog(open => viewport.setSuspended(open));
let fdsResults = new FdsResultsDialog(open => viewport.setSuspended(open));
const newFlameAnalysis = (): FlameAnalysisWorkspace =>
  new FlameAnalysisWorkspace(open => viewport.setSuspended(open), { lengthUnit: () => store.displayUnit });
let flameAnalysis = newFlameAnalysis();
const testDataDialog = new TestDataDialog(store, testDataStore, open => viewport.setSuspended(open), () => {
  // The toolbar is rebuilt by every edit made in the dialog, so the button that
  // opened it is gone; give the keyboard back to its replacement.
  if (document.activeElement === document.body) {
    [...toolbar.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === i18n.t('Test data…'))?.focus();
  }
});
// From Checks, the dialog opens at the source and scrolls to the flagged mapping.
const openTestData = (sourceId?: string): void => { playhead.pause(); testDataDialog.open(sourceId, sourceId !== undefined); };

/** Write an HTML export, and say so if it fails rather than doing nothing visible. */
async function saveHtml(html: string, name: string): Promise<void> {
  try {
    await saveShareableHtml(html, name);
  } catch (err) {
    window.alert(i18n.t("{p1} was not saved:\n\n{p2}", { p1: name, p2: (err as Error).message }));
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
const fileStatus = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', id: 'file-status' });
toolbar.after(fileStatus);
const announceFile = (text: string): void => { fileStatus.textContent = text; };

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
  const focused = toolbar.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const focusText = focused?.textContent;
  const dirtyMark = store.dirty ? ' •' : '';

  toolbar.replaceChildren(
    h('div', { class: 'toolbar__group toolbar__group--title' }, [
      h('span', { class: 'toolbar__title', title: store.document.meta?.title ?? i18n.t("Untitled") }, [store.document.meta?.title ?? i18n.t("Untitled")]),
      h('span', { class: 'toolbar__file', title: store.fileName }, [`${store.fileName}${dirtyMark}`]),
    ]),

    group([
      btn(i18n.t("Open"), () => { void openPlan(); }),
      recentPlans.length > 0 ? recentSelect() : null,
      btn(i18n.t("Save"), () => { void savePlan(false); }),
      btn(i18n.t("Save as…"), () => { void savePlan(true); }),
      btn(i18n.t("Next test…"), () => { void saveNextTest(); }, i18n.t("Copy the rig for the next test of this series")),
      menuButton(i18n.t("FDS"), 'fds-menu', [
        btn(i18n.t("Import FDS…"), () => { void importFds(); },
          i18n.t("Build a plan from an FDS input file — geometry, the burner and the devices")),
        btn(i18n.t("Export to FDS…"), () => { playhead.pause(); fdsExport.open(store.document, store.fileName); },
          i18n.t("Write gauges and thermocouple beads as FDS devices")),
        btn(i18n.t("FDS results…"), () => { playhead.pause(); fdsResults.open(); }, i18n.t("Visualize and play recorded FDS simulation output")),
      ]),
      btn(i18n.t("Test data…"), () => openTestData(),
        i18n.t("Measured and simulated channels on the instruments: add a logger workbook or FDS output and map its channels")),
      btn(i18n.t("Flame analysis…"), () => { playhead.pause(); flameAnalysis.open(); },
        i18n.t("Review a fire filmed by several cameras: pictures, flame outlines, the 3-D flame and heat release rate")),
      btn(i18n.t("Example"), loadExample, i18n.t("Load the reference plan built from the hand sketch")),
    ]),

    group([
      btn(i18n.t("Drawing…"), openDrawing,
        i18n.t("Dimensioned plan and elevations, equipment list and coverage — print to PDF")),
      btn(i18n.t("Share…"), exportShareable,
        i18n.t("Export a single self-contained HTML file with this plan baked in")),
    ]),

    group([
      toggle(i18n.t("Plan"), store.viewMode === 'plan', () => store.setViewMode('plan'), i18n.t("Top-down orthographic (1)")),
      toggle(i18n.t("Front"), store.viewMode === 'front', () => store.setViewMode('front'), i18n.t("Front elevation, looking +Y north (2)")),
      toggle(i18n.t("Side"), store.viewMode === 'side', () => store.setViewMode('side'), i18n.t("Side elevation, looking +X east (3)")),
      toggle('3D', store.viewMode === '3d', () => store.setViewMode('3d'), i18n.t("Perspective orbit (4)")),
    ]),

    group([
      toggle(i18n.t("Move"), gizmoMode === 'translate', () => setGizmo('translate'), 'G'),
      toggle(i18n.t("Rotate"), gizmoMode === 'rotate', () => setGizmo('rotate'), 'R'),
      option(i18n.t("Snap"), 'snap', i18n.t("Snap gizmo drags to a quarter of the grid step")),
      toggle(i18n.t("Measure"), measuring, toggleMeasure, i18n.t("Click two points for a distance (M)")),
      measurementCount > 0 ? btn(i18n.t("Clear"), clearMeasurements, i18n.t("Remove all measurements")) : null,
    ].filter(Boolean) as HTMLElement[]),

    group([
      option(i18n.t("Frustums"), 'showFrustums', i18n.t("Camera field-of-view pyramids")),
      option(i18n.t("As built"), 'showAsBuilt', i18n.t("Measured poses and connections to the planned positions")),
      option(i18n.t("Predicted"), 'showFlame', i18n.t("Heskestad flame cone and plume envelope — the prediction, drawn beside any reconstructed flame")),
      option(i18n.t("Dims"), 'showDimensions', i18n.t("Standoff dimension lines from the fire")),
      option(i18n.t("Preview"), 'showPreview', i18n.t("Picture-in-picture of the selected camera's view")),
    ]),

    group([
      h('select', {
        class: 'toolbar__select',
        title: i18n.t("Display units. Stored values are always metric."),
        // setDisplayUnit emits 'document', which rebuilds the viewport already.
        onchange: (e: Event) => store.setDisplayUnit((e.target as HTMLSelectElement).value as LengthUnit),
      }, (['m', 'cm', 'mm', 'ft', 'ft-in', 'in'] as LengthUnit[]).map((u) =>
        h('option', { value: u, selected: u === store.displayUnit }, [u]))),
      btn(i18n.t("Fit"), () => viewport.frameAll(), 'F'),
    ]),

    group([
      btn(i18n.t("Undo"), () => store.undo(), 'Ctrl+Z'),
      btn(i18n.t("Redo"), () => store.redo(), 'Ctrl+Y'),
      h('span', { class: 'language-switch', role: 'group', 'aria-label': i18n.t('Interface language') },
        (['en', 'fr'] as const).flatMap((value, index) => [
          ...(index ? [h('span', { 'aria-hidden': 'true' }, ['|'])] : []),
          h('button', { type: 'button', class: 'toolbar__btn', lang: i18n.language(),
            'aria-label': value === 'en' ? i18n.t('EN: English') : i18n.t('FR: French'),
            'aria-pressed': String(i18n.language() === value),
            dataset: { language: value }, onclick: () => chooseLanguage(value),
          }, [value.toUpperCase()]),
        ])),
    ]),
  );
  if (focused && document.activeElement === document.body) {
    [...toolbar.querySelectorAll<HTMLElement>('button, select')].find(e => e.textContent === focusText)?.focus();
  }
}

const group = (children: Array<HTMLElement | null>): HTMLElement =>
  h('div', { class: 'toolbar__group' }, children);

/** The desktop's recent plans: a select whose first option is its own label, so
 *  choosing a file opens it and the control shows "Recent…" again afterwards. */
function recentSelect(): HTMLElement {
  return h('select', {
    class: 'toolbar__select',
    title: i18n.t("Open a recent plan"),
    onchange: (e: Event) => {
      const select = e.target as HTMLSelectElement;
      const path = select.value;
      select.value = '';
      if (path) void openRecentPlan(path);
    },
  }, [
    h('option', { value: '', selected: true }, [i18n.t("Recent…")]),
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
    'aria-pressed': String(active),
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
  return !store.dirty || window.confirm(i18n.t("This plan has unsaved changes. Discard them?"));
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
    window.alert(i18n.t("Could not open a plan:\n\n{p1}", { p1: (err as Error).message }));
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
    const data = splitEmbeddedTestData(text);
    const split = splitEmbeddedFlames(data.text);
    store.replaceDocument(parseAndValidatePlan(split.text), name, token);
    if (split.flames.size) void attachEmbedded(split.flames);
    attachTestData(data.series);
    data.warnings.forEach(warning => console.warn(warning));
    viewport.frameAll();
    announceFile(i18n.t('Opened {name}.', { name }));
    // Only an adopted file becomes a recent plan and the window's title.
    const bridge = shell();
    if (bridge && token) void bridge.adopted(token).then(refreshRecent, () => {});
  } catch (err) {
    window.alert(
      i18n.t("{p1} could not be opened as a fire test plan:\n\n{p2}\n\nNothing was loaded. Fix the file, or validate it with `python -c \"from fireplan import Plan; Plan.load(path).validate_schema()\"` for the full schema report.", { p1: name, p2: (err as Error).message }),
    );
  }
}

/** True while a save is waiting on the shell, so a second Ctrl+S does not race it. */
let saveInFlight = false;

async function saveNextTest(): Promise<void> {
  if (saveInFlight || !confirmDiscard()) return;
  saveInFlight = true;
  const identity = store.identity();
  try {
    const next = nextTest(store.document);
    const text = serializePlan(next);
    const name = `${(next.meta?.testId || 'next-test').replace(/[^a-zA-Z0-9_-]+/g, '-')}.ftp.json`;
    const saved = await saveNextTestText(text, name);
    if (!saved) return;
    if (identity.documentId !== store.documentId || identity.revision !== store.revision) {
      window.alert(i18n.t("The next test copy was saved; the editor kept the plan changed while saving."));
      return;
    }
    adopt(text, saved.path.split(/[\\/]/).pop() ?? name, saved.token);
    window.alert(i18n.t("Left behind: test data, reconstructed flames, linked files and as-built poses."));
  } catch (error) {
    window.alert(i18n.t("Next test was not saved: {p1}", { p1: (error as Error).message }));
  } finally { saveInFlight = false; }
}

async function savePlan(saveAs = false): Promise<void> {
  // Two saves in flight would write two snapshots to one file in whichever order the
  // dialogs close. The dirty bullet stays up until the first one lands, so a second
  // press is not lost -- it is simply asked for again once the file is on disk.
  if (saveInFlight) return;
  const suggested = saveAs || store.fileName === 'untitled.ftp.json'
    ? suggestFileName()
    : store.fileName;
  saveInFlight = true;
  try {
    // The document and revision the bytes describe, and the document as written:
    // what decides whether the dirty bullet may clear when the write lands, and what
    // undo compares against afterwards.
    const { text, identity } = store.serializeForSave();
    const saved = await savePlanText(text, suggested, saveAs, identity.token);
    // null means the user cancelled the dialog; a failed write throws.
    if (saved) {
      announceFile(i18n.t('Saved {name}.', { name: saved.path.split(/[\\/]/).pop() ?? suggested }));
      store.markSaved(saved.path.split(/[\\/]/).pop() ?? suggested, identity, saved.token);
      refreshRecent();
    } else announceFile(i18n.t('Save cancelled.'));
  } catch (err) {
    window.alert(
      i18n.t("{p1} was not saved:\n\n{p2}\n\nThe plan is still open and unchanged — try Save as… to a different location.", { p1: suggested, p2: (err as Error).message }),
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
    window.alert(i18n.t("Could not open an FDS file:\n\n{p1}", { p1: (err as Error).message }));
    return;
  }
  if (!picked) return;

  try {
    // A split input -- geometry in one file, devices in another, pulled together by
    // &CATF -- is the normal shape for anything past a demo, and importing only the
    // file that was named would hand over a model with most of itself missing.
    // Inside the try: a failure here used to escape this function unreported.
    const source = await resolveFdsIncludes(picked.text, picked.name);
    fdsImport.open(source.text, picked.name, store.displayUnit, (doc, name) => {
      // The same boundary every other document crosses. `replaceDocument` installs
      // the document before anything reads it, so a plan that would fail to load is
      // refused here rather than adopted, saved and then refused on reopen.
      const errors = validateStructure(doc);
      if (errors.length > 0) {
        window.alert(
          i18n.t("{p1} converted into a plan this editor cannot open:\n\n{p2}\n\nNothing was imported.", { p1: picked!.name, p2: describeErrors(errors) }));
        return;
      }
      // No token: an import is not a saved file. The plan exists only here until
      // it is written, and Save must ask for a destination rather than aiming at
      // the .fds or at whatever plan was open before.
      store.replaceDocument(doc, name);
      announceFile(i18n.t('Imported {name}.', { name: picked!.name }));
      store.markDirty();
      viewport.frameAll();
    }, { includesResolved: source.resolved, includeIssues: source.issues });
  } catch (err) {
    window.alert(
      i18n.t("{p1} could not be read as FDS input:\n\n{p2}", { p1: picked.name, p2: (err as Error).message }));
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
  }).catch((err) => console.warn(i18n.t("Example flame not loaded: {p1}", { p1: (err as Error).message })));
}

function openDrawing(): void {
  reportOverlay.open(
    store.document,
    store.displayUnit,
    suggestFileName().replace(/\.ftp\.json$/, '') + '-drawing.html',
  );
}

async function exportShareable(): Promise<TestDataShareSummary | undefined> {
  if (!isSingleFileBuild() && !shell()) {
    window.alert(
      i18n.t("Shareable export only works from the built single-file app.\n\nRun `npm run build` and open dist/index.html — the dev server serves the app as separate files, so an exported page would not carry its own code."),
    );
    return;
  }
  // One snapshot, taken before the first await: the plan text, its title, the
  // file name and which loaded sequences go with it. Compressing the frames
  // yields to the page, and a plan opened or edited meanwhile would otherwise be
  // serialised under the old title with the old plan's frames.
  const identity = store.identity();
  const title = store.document.meta?.title ?? i18n.t("Fire test plan");
  const name = suggestFileName().replace(/\.ftp\.json$/, '') + '-viewer.html';
  const planJson = store.serialize();
  const testData = embedTestData(store.document, id => testDataStore.get(id));
  const flames = await embeddableFlames(store.document);
  if (flames === null) return;
  if (store.documentId !== identity.documentId || store.revision !== identity.revision) {
    window.alert(i18n.t("The plan changed while the page was being built. Nothing was exported; please Share again."));
    return;
  }
  const html = buildShareableHtml(planJson, title, flames, testData.payload);
  for (const warning of testData.warnings) console.warn(warning);
  await saveHtml(html, name);
  return testData;
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
      i18n.t("The reconstructed flame frames come to {p1} MB packed, over the {p2} MB a shared page carries. Export the page without them? The viewer will show the timeline and say the frames are not included.", { p1: i18n.numberText((bytes / 1048576).toFixed(0)), p2: EMBED_CAP_BYTES / 1048576 }),
    );
    return proceed ? new Map() : null;
  }
  if (unloaded.length) {
    const proceed = window.confirm(
      i18n.t("The frames for {p1} are not loaded, so the page will not carry them. Export anyway?", { p1: unloaded.join(', ') }),
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
  if (fdsResults.isOpen || fdsExport.isOpen || testDataDialog.isOpen || flameAnalysis.isOpen) return;
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

i18n.subscribeLanguage(() => {
  document.documentElement.lang = i18n.language();
  document.title = i18n.t('Fire Test Plan Editor');
  fdsResults.close();
  fdsResults = new FdsResultsDialog(open => viewport.setSuspended(open));
  flameAnalysis.dispose();
  flameAnalysis = newFlameAnalysis();
  palette.render();
  inspector.render();
  outliner.render();
  checks.render();
  renderToolbar();
  viewport.rebuild();
  toolbar.querySelector<HTMLButtonElement>(`[data-language="${i18n.language()}"]`)?.focus();
});
document.title = i18n.t('Fire Test Plan Editor');

palette.render();
inspector.render();
outliner.render();
checks.render();
renderToolbar();
syncPlayback(); // a shared plan's curve gets its fire clock before any edit
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
    void adoptShellLanguage(() => bridge.loadLanguage(), value => bridge.saveLanguage(value));
    testDataStore.setReader(path => bridge.readTestDataFile(path));
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
