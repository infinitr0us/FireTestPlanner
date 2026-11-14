/**
 * The flame analysis board: a read-only workspace that walks an engineer through
 * one processed fire event filmed by several calibrated cameras (design:
 * docs/flame-analysis-board-design.md; format: CONVENTIONS.md section 13).
 *
 * Like the FDS results workspace it owns its scene, clock and file session and
 * never touches the plan open in the editor. What it says about how the data were
 * made comes from the analysis folder, never from this code.
 */

import { FlameSequence, parseFrameData, surfaceCells, type RawFrame } from '../core/flame';
import { flameHeightM } from '../core/correlations';
import {
  asHoodSees, centredMean, cumulative, fillTemplate, folderOf, heskestadSeries, hoodOf, instantAt, joinPath,
  keyNumbers, localText, parseMesh, projectHull, type HullProjection,
  parseAnalysisManifest, parseEventManifest, parseOutlines, parseSeriesCsv, seriesObjectProblems, STEP_IDS,
  type AnalysisManifest, type EventManifest, type EventSeries, type KeyNumbers, type Series, type StepId,
} from '../core/flame-analysis';
import { burnerDiameterM, cameras as planCameras, displayName, primaryBurner, radiativeFractionOf } from '../core/plan';
import type { CameraObject, LengthUnit, PlanDocument } from '../core/types';
import { parseAndValidatePlan } from '../core/validate';
import { closeShellAnalysis, openShellAnalysis, saveMedia, shell } from '../io/files';
import {
  checkedEventSource, pickedAnalysisSource, readText, shellAnalysisSource, type AnalysisSource,
} from '../io/flame-analysis-source';
import { AnalysisScene, type FlameLook, type SceneView } from '../scene/flame-analysis';
import { ANALYSIS_DEFAULT_SPEED, ANALYSIS_SPEEDS, Playhead } from '../state/playhead';
import { h } from './dom';
import { CameraTiles, drawHull, drawOutline, placement, type PictureMode } from './flame-analysis-cameras';
import { AnalysisPlots, readoutText, type Band, type Moment, type PlotLine, type PlotSpec } from './flame-analysis-plots';
import {
  checkExportSignal, Composer, encodePng, encodeVideo, VIDEO_FPS, videoFrames, type VideoLayout, type VideoOptions,
} from './flame-analysis-video';
import * as i18n from './i18n';
import { fmt, valueAt } from './plot-svg';
import { handleTransportKey, setTransportPlaying, transportButton } from './transport';

const IMPERIAL = new Set<LengthUnit>(['ft', 'ft-in', 'in']);
const PREFETCH = 8;
const READ_CONCURRENCY = 8;

/** The board's view choices, kept for this computer like the interface language:
 *  whether the plots are shown and whether they draw as the event plays. */
const VIEW_KEY = 'fire-test-plan.flame-analysis.view';
interface BoardView { plots: boolean; reveal: boolean }
function readView(): BoardView {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Partial<BoardView>;
    return { plots: saved.plots !== false, reveal: saved.reveal !== false };
  } catch { return { plots: true, reveal: true }; }
}
function writeView(view: BoardView): void {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* Session-only preference. */ }
}

/** Generic step titles, used when a folder has no text of its own. */
const STEP_TITLES = (): Record<StepId, string> => ({
  cameras: i18n.t("Cameras"),
  frames: i18n.t("Synchronised frames"),
  segmentation: i18n.t("Flame in each view"),
  reconstruction: i18n.t("3-D flame"),
  size: i18n.t("Flame volume and surface area"),
  hrr: i18n.t("Heat release rate"),
  limitations: i18n.t("What this can and cannot tell you"),
});
/** The panel a step's explanation points at. */
const STEP_TARGET: Record<StepId, string> = {
  cameras: 'scene', frames: 'cameras', segmentation: 'cameras', reconstruction: 'scene',
  size: 'size', hrr: 'hrr', limitations: '',
};

/** An event's heat flux records by the gauge that made them (the site plan object they
 *  name), or one alone where a series names no gauge. Shown and hidden together. */
interface FluxGauge { key: string; object?: string; name: string; series: EventSeries[] }

interface LoadedEvent {
  event: EventManifest;
  gauges: FluxGauge[];
  folder: string;
  series: Map<string, Series>;
  outlines: Map<string, Float32Array[][]>;
  sequence: FlameSequence | null;
  numbers: KeyNumbers;
  tiles: CameraTiles;
  plots: AnalysisPlots;
  /** What the plots draw, for the video and PNG composition. */
  plotData: { specs: PlotSpec[]; bands: Band[]; moments: Moment[]; window: [number, number]; reveal: boolean };
}

export interface FlameAnalysisOptions {
  /** The editor's length unit, for heights; volume and area follow its system. */
  lengthUnit?: () => LengthUnit;
}

export class FlameAnalysisWorkspace {
  private dialog = h('dialog', { class: 'flame-analysis', get 'aria-label'() { return i18n.t("Flame analysis"); } });
  private title = h('h1', { class: 'flame-analysis__title' }, [i18n.t("Flame analysis")]);
  private eventSelect = h('select', { class: 'field__input', get 'aria-label'() { return i18n.t("Event"); } });
  private readout = h('output', { class: 'flame-analysis__readout', 'aria-live': 'off' });
  private body = h('div', { class: 'flame-analysis__body' });
  private status = h('p', { class: 'flame-analysis__status', role: 'status' });
  /** Shown once a folder is open; the welcome screen has its own button. */
  private another = h('button', { type: 'button', class: 'btn flame-analysis__another', hidden: true, onclick: () => { void this.choose(); } },
    [i18n.t("Open another analysis…")]);
  /** Shown with an event: the plots, or the pictures and the 3-D view on the whole board. */
  private plotsToggle = h('button', {
    type: 'button', class: 'btn flame-analysis__toggle flame-analysis__plots-toggle', hidden: true,
    title: i18n.t("Show or hide the plots; without them the pictures and the 3-D view share the board"),
    onclick: () => this.setPlotsShown(!this.plotsShown),
  }, [i18n.t("Plots")]);
  private plotsShown: boolean;
  private main?: HTMLElement;
  private layoutObserver?: ResizeObserver;
  private chooseRequest = 0;
  private source?: AnalysisSource;
  private analysis?: AnalysisManifest;
  private plan?: PlanDocument;
  private loaded?: LoadedEvent;
  private scene?: AnalysisScene;
  /** The site plan the scene shows: another folder brings another site. */
  private sitePlan?: PlanDocument;
  /** Whether the plots and cards were built in imperial units. */
  private builtImperial?: boolean;
  private sceneView: SceneView = 'flame';
  private playhead = new Playhead();
  private index = -1;
  private epoch = 0;
  private raf = 0;
  private lastTick = 0;
  private drawerStep: StepId | null = null;
  private drawer = h('aside', { class: 'flame-analysis__drawer', id: 'flame-analysis-drawer', hidden: true, tabIndex: -1 });
  private steps = h('nav', { class: 'flame-analysis__steps', get 'aria-label'() { return i18n.t("Steps of the analysis"); } });
  private slider = h('input', { type: 'range', min: 0, max: 0, step: 1, value: 0, class: 'playback-bar__slider', get 'aria-label'() { return i18n.t("Instant"); } });
  private play = transportButton('play', () => this.playhead.toggle());
  private first = transportButton('first', () => this.seekIndex(0));
  private previous = transportButton('previous', () => this.seekIndex(this.index - 1));
  private next = transportButton('next', () => this.seekIndex(this.index + 1));
  private last = transportButton('last', () => this.seekIndex(this.instantCount - 1));
  private stamp = h('output', { class: 'playback-bar__readout', 'aria-live': 'off' });
  private speed = h('select', { class: 'playback-bar__select', get 'aria-label'() { return i18n.t("Playback speed"); } },
    ANALYSIS_SPEEDS.map((s) => h('option', { value: String(s), selected: s === ANALYSIS_DEFAULT_SPEED }, [`×${i18n.numberText(s)}`])));
  private loop = h('input', { type: 'checkbox' });
  private zoom?: HTMLElement;
  private zoomFocus?: HTMLElement;
  private zoomRestore?: () => void;
  /** The panels that hold the board (export, full-size picture), in opening order. */
  private holders: HTMLElement[] = [];
  private exportPanel?: HTMLElement;
  private exportAbort?: () => void;
  private exportTask?: Promise<Blob>;
  private exportController?: AbortController;
  private exportId = 0;
  private exportRestore?: () => void;
  private disposal?: Promise<void>;
  /** The last video the export panel made (for hosts and tests). */
  lastVideo?: Blob;
  private focusBefore?: HTMLElement;
  private outlinesShown = false;
  private hullCheck = false;
  private hullCache = new Map<string, HullProjection | null>();
  private flameLook: FlameLook = 'cubes';
  /** The plots' choices: heat released instead of its rate, the estimates as the
   *  hood would record them, the Heskestad height beside the flame's, and each line
   *  drawn only up to the playback time. */
  private plotOptions = { heat: false, hoodResponse: false, heskestad: false, reveal: true };
  /** The gauges whose heat flux is plotted: none at first; kept across events. */
  private fluxShown = new Set<string>();

  constructor(private onOpenChange: (open: boolean) => void = () => {}, private options: FlameAnalysisOptions = {}) {
    const view = readView();
    this.plotsShown = view.plots;
    this.plotOptions.reveal = view.reveal;
    this.plotsToggle.setAttribute('aria-pressed', String(this.plotsShown));
    this.dialog.append(
      h('header', { class: 'flame-analysis__header' }, [
        this.title,
        h('label', { class: 'flame-analysis__event' }, [i18n.t("Event"), this.eventSelect]),
        this.readout,
        this.plotsToggle,
        this.another,
        h('button', { type: 'button', class: 'btn', onclick: () => this.close() }, [i18n.t("Back to plan")]),
      ]),
      this.body,
    );
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (this.exportPanel) this.escapeExport();
      else if (this.zoom) this.closeZoom();
      else if (this.drawerStep) this.closeDrawer();
      else this.close();
    });
    this.dialog.addEventListener('keydown', (e) => {
      e.stopPropagation();
      // Escape closes the innermost layer here, on the key itself: once a dialog's
      // cancel has been prevented, Chromium may close the whole dialog on the next
      // Escape without asking, taking the board down with the full-size picture.
      if (e.key === 'Escape' && (this.exportPanel || this.zoom || this.drawerStep)) {
        e.preventDefault();
        if (this.exportPanel) this.escapeExport();
        else if (this.zoom) this.closeZoom();
        else this.closeDrawer();
        return;
      }
      if (!this.loaded || this.zoom || this.exportPanel) return;
      handleTransportKey(e, {
        play: () => this.playhead.toggle(),
        previous: () => this.seekIndex(this.index - 1),
        next: () => this.seekIndex(this.index + 1),
        first: () => this.seekIndex(0),
        last: () => this.seekIndex(this.instantCount - 1),
      }, this.slider);
    });
    this.eventSelect.onchange = () => { void this.selectEvent(this.eventSelect.value); };
    this.slider.oninput = () => this.seekIndex(Number(this.slider.value));
    this.speed.onchange = () => this.playhead.setSpeed(Number(this.speed.value));
    this.loop.onchange = () => this.playhead.setLoop(this.loop.checked);
    this.playhead.setSpeed(ANALYSIS_DEFAULT_SPEED);
    this.playhead.setLoop(false);
    this.playhead.subscribe((kind) => {
      if (kind === 'state') setTransportPlaying(this.play, this.playhead.playing);
      if (kind !== 'state') this.showTime(this.playhead.time_s);
    });
  }

  get isOpen(): boolean { return this.dialog.open; }
  private get instantCount(): number { return this.loaded?.event.instants.t_s.length ?? 0; }

  open(): void {
    if (this.isOpen) return;
    this.focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    document.body.append(this.dialog);
    this.dialog.showModal();
    this.onOpenChange(true);
    if (!this.analysis) this.welcome();
    this.scene?.setActive(true);
    // The editor's length unit may have changed while the board was closed.
    if (this.loaded && this.builtImperial !== this.imperial()) this.refreshUnits();
    this.tick(performance.now());
  }

  async close(): Promise<void> {
    if (!this.isOpen) return;
    await this.closeExport();
    if (!this.isOpen) return;
    this.closeZoom();
    this.playhead.pause();
    cancelAnimationFrame(this.raf);
    this.scene?.setActive(false);
    this.dialog.close();
    this.dialog.remove();
    this.onOpenChange(false);
    this.focusBefore?.focus();
  }

  /** Release everything: the session, the scene and its pictures. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    ++this.epoch;
    this.disposal = (async () => {
      await this.closeExport();
      await this.close();
      this.unloadEvent();
      this.scene?.dispose();
      this.scene = undefined;
      this.sitePlan = undefined;
      this.source?.close();
      this.source = undefined;
    })();
    return this.disposal;
  }

  private welcome(message = ''): void {
    this.title.textContent = i18n.t("Flame analysis");
    this.eventSelect.parentElement!.hidden = true;
    this.another.hidden = true;
    this.plotsToggle.hidden = true;
    this.readout.textContent = '';
    this.body.replaceChildren(h('div', { class: 'flame-analysis__welcome' }, [
      h('h2', {}, [i18n.t("Review a fire filmed by several cameras")]),
      h('p', {}, [i18n.t("Open a flame analysis folder: the synchronised pictures of each camera, the flame found in each picture, the flame rebuilt in 3-D inside the test site, its volume and surface area, and heat release rate estimates beside the hood measurement.")]),
      h('button', { type: 'button', class: 'btn btn--primary', onclick: () => { void this.choose(); } },
        [shell() ? i18n.t("Open analysis.json…") : i18n.t("Choose analysis folder…")]),
      h('p', { class: 'flame-analysis__note' }, [i18n.t("Your test plan stays open. The analysis is a separate session and is not saved in the plan.")]),
      this.status,
    ]));
    this.setStatus(message, message ? 'error' : 'info');
  }

  private setStatus(message: string, tone: 'info' | 'error' = 'info'): void {
    this.status.textContent = message;
    this.status.classList.toggle('flame-analysis__status--error', tone === 'error');
  }

  /** An event of an open folder that could not be read: the folder stays open, with
   *  its other events in the selector and the way to another folder beside it. */
  private eventFailed(message: string): void {
    this.readout.textContent = '';
    this.plotsToggle.hidden = true;
    this.body.replaceChildren(h('div', { class: 'flame-analysis__welcome' }, [
      h('h2', {}, [i18n.t("This event could not be opened")]),
      this.status,
    ]));
    this.setStatus(message, 'error');
  }

  /** Ask for a folder and open it. What is on screen stays until a folder is chosen:
   *  cancelling the dialog changes nothing, not even a load that is still running. */
  private async choose(): Promise<void> {
    const request = ++this.chooseRequest;
    const stale = (): boolean => request !== this.chooseRequest || !!this.disposal;
    try {
      if (shell()) {
        const opened = await openShellAnalysis();
        if (!opened) return;
        if (stale()) { closeShellAnalysis(opened.token); return; }
        await this.load(shellAnalysisSource(opened));
        return;
      }
      const input = h('input', { type: 'file', multiple: true, hidden: true });
      input.setAttribute('webkitdirectory', '');
      this.dialog.append(input);
      const files = await new Promise<File[]>((resolve) => {
        input.onchange = () => { resolve(Array.from(input.files ?? [])); input.remove(); };
        input.addEventListener('cancel', () => { resolve([]); input.remove(); }, { once: true });
        input.click();
      });
      if (!files.length || stale()) return;
      await this.load(pickedAnalysisSource(files));
    } catch (error) {
      if (!stale()) this.setStatus((error as Error).message, 'error');
    }
  }

  /** Open a folder. Public so tests and hosts can hand over a source directly. */
  async load(source: AnalysisSource): Promise<void> {
    await this.closeExport();
    this.playhead.pause();
    const epoch = ++this.epoch;
    this.source?.close();
    this.source = source;
    this.unloadEvent();
    this.analysis = undefined;
    this.plan = undefined;
    this.body.replaceChildren(h('div', { class: 'flame-analysis__welcome' }, [this.status]));
    this.setStatus(i18n.t("Reading analysis.json…"));
    try {
      const analysis = parseAnalysisManifest(await readText(source, 'analysis.json'));
      const plan = parseAndValidatePlan(await readText(source, joinPath('', analysis.sitePlan)));
      const known = new Set(planCameras(plan).map((c) => c.id));
      const missing = analysis.cameras.filter((c) => !known.has(c.planCameraId));
      if (missing.length) throw new Error(i18n.t("The site plan has no camera {p1}.", { p1: missing.map((c) => c.planCameraId).join(', ') }));
      if (epoch !== this.epoch) return;
      this.analysis = analysis;
      this.plan = plan;
      this.title.textContent = localText(analysis.title);
      this.eventSelect.replaceChildren(...analysis.events.map((e) => h('option', { value: e.id }, [localText(e.label)])));
      this.eventSelect.parentElement!.hidden = analysis.events.length < 2;
      this.another.hidden = false;
      await this.selectEvent(analysis.events[0].id);
    } catch (error) {
      if (epoch === this.epoch) this.welcome((error as Error).message);
    }
  }

  private unloadEvent(): void {
    this.layoutObserver?.disconnect();
    this.layoutObserver = undefined;
    this.main = undefined;
    this.plotsToggle.hidden = true;
    this.loaded?.tiles.dispose();
    this.loaded?.plots.dispose();
    this.loaded = undefined;
    this.index = -1;
    this.closeZoom();
  }

  async selectEvent(id: string): Promise<void> {
    await this.closeExport();
    const analysis = this.analysis, plan = this.plan;
    if (!analysis || !this.source || !plan) return;
    let source = this.source;
    this.playhead.pause();
    const epoch = ++this.epoch;
    const entry = analysis.events.find((e) => e.id === id);
    if (!entry) return;
    this.eventSelect.value = id;
    this.unloadEvent();
    this.body.replaceChildren(h('div', { class: 'flame-analysis__welcome' }, [this.status]));
    try {
      const path = joinPath('', entry.path);
      const folder = folderOf(path);
      this.setStatus(i18n.t("Reading {p1}…", { p1: path }));
      const event = parseEventManifest(await readText(source, path), path);
      const listed = new Set(analysis.cameras.map((c) => c.id));
      const unknown = event.cameras.filter((c) => !listed.has(c) || !event.images[c]);
      if (unknown.length) throw new Error(i18n.t("{p1}: cameras {p2} are not in analysis.json or have no picture sizes.", { p1: path, p2: unknown.join(', ') }));
      // A record's gauge must be a heat flux gauge of the site plan (format 1.2).
      const objects = seriesObjectProblems(event, plan.objects);
      if (objects.length) throw new Error(objects.join(' '));
      const texts = new Map<string, Promise<string>>();
      const textOf = (file: string): Promise<string> => {
        if (!texts.has(file)) texts.set(file, readText(source, file));
        return texts.get(file)!;
      };
      const series = new Map<string, Series>();
      for (const s of event.series) {
        const file = joinPath(folder, s.file);
        series.set(s.id, parseSeriesCsv(await textOf(file), s.time, s.value, file));
      }
      const outlines = new Map<string, Float32Array[][]>();
      source = checkedEventSource(source, event, entry, series, folder);
      for (const cam of event.cameras) {
        const file = joinPath(folder, fillTemplate(event.files.outlines, cam));
        outlines.set(cam, parseOutlines(await textOf(file), cam, event.instants.t_s.length, file));
      }
      const sequence = await this.readHull(source, event, folder, epoch);
      if (epoch !== this.epoch) return;
      this.setStatus('');
      this.build(analysis, plan, event, folder, series, outlines, sequence, source);
    } catch (error) {
      if (epoch === this.epoch) this.eventFailed((error as Error).message);
    }
  }

  private async readHull(source: AnalysisSource, event: EventManifest, folder: string, epoch: number): Promise<FlameSequence | null> {
    const { t_s, stem } = event.instants;
    const raw: RawFrame[] = new Array(t_s.length);
    let next = 0, done = 0, failed = false;
    // One file that cannot be read ends the reading: the others stop asking for more,
    // and none reports progress over the message that names the file.
    const live = (): boolean => !failed && epoch === this.epoch;
    const worker = async (): Promise<void> => {
      while (next < t_s.length && live()) {
        const i = next++;
        const file = joinPath(folder, fillTemplate(event.files.hull, undefined, stem[i]));
        try { raw[i] = await parseFrameData(file, await source.read(file), t_s[i]); }
        catch (error) { failed = true; throw error; }
        done += 1;
        if (live() && (done % 20 === 0 || done === t_s.length)) this.setStatus(i18n.t("Reading the 3-D flame… {p1} of {p2} instants", { p1: done, p2: t_s.length }));
      }
    };
    await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
    if (epoch !== this.epoch) return null;
    if (raw.every((f) => !f.voxels.length)) return null;
    return FlameSequence.fromFrames(raw);
  }

  // -- the board ---------------------------------------------------------------

  private cameraLabel(id: string): string {
    const camera = this.analysis?.cameras.find((c) => c.id === id);
    const planCamera = this.planCamera(id);
    return camera?.label ? localText(camera.label) : planCamera ? displayName(planCamera) : id;
  }
  private planCamera(id: string): CameraObject | undefined {
    const planId = this.analysis?.cameras.find((c) => c.id === id)?.planCameraId;
    return this.plan ? planCameras(this.plan).find((c) => c.id === planId) : undefined;
  }

  private build(
    analysis: AnalysisManifest, plan: PlanDocument, event: EventManifest, folder: string,
    series: Map<string, Series>, outlines: Map<string, Float32Array[][]>, sequence: FlameSequence | null,
    source: AnalysisSource,
  ): void {
    const numbers = keyNumbers(event, series);
    const tiles = new CameraTiles(source, event, folder,
      event.cameras.map((id) => ({ id, label: this.cameraLabel(id) })), outlines, (cam) => { void this.openZoom(cam); });
    const gauges = this.fluxGauges(event, plan);
    // Plotted gauges carry over to an event that has them; none are plotted at first.
    this.fluxShown = new Set([...this.fluxShown].filter((key) => gauges.some((g) => g.key === key)));
    const { plots, plotData, note } = this.makePlots(event, series, gauges);
    this.loaded = { event, gauges, folder, series, outlines, sequence, numbers, tiles, plots, plotData };
    this.builtImperial = this.imperial();

    const sceneHost = h('div', { class: 'flame-analysis__scene-host' });
    const viewButtons = (['site', 'flame'] as SceneView[]).map((view) => h('button', {
      type: 'button', class: 'btn flame-analysis__toggle', 'aria-pressed': String(view === this.sceneView),
      dataset: { view }, onclick: () => this.setSceneView(view),
    }, [view === 'site' ? i18n.t("Whole site") : i18n.t("Flame close-up")]));
    const pictureButtons = (['closeup', 'whole'] as PictureMode[]).map((mode) => h('button', {
      type: 'button', class: 'btn flame-analysis__toggle', 'aria-pressed': String(mode === tiles.pictureMode),
      disabled: mode === 'closeup' && !tiles.hasCloseups,
      onclick: () => {
        tiles.setMode(mode);
        pictureButtons.forEach((b, k) => b.setAttribute('aria-pressed', String((['closeup', 'whole'] as PictureMode[])[k] === tiles.pictureMode)));
        this.packPictures(); // a close-up and a whole picture have different shapes
      },
    }, [mode === 'closeup' ? i18n.t("Close-up") : i18n.t("Whole picture")]));
    const outlineToggle = h('button', {
      type: 'button', class: 'btn flame-analysis__toggle flame-analysis__outline-toggle', 'aria-pressed': String(this.outlinesShown),
      onclick: () => this.setOutlines(!this.outlinesShown),
    }, [i18n.t("Flame outline")]);
    tiles.setOutlines(this.outlinesShown);
    const hullToggle = h('button', {
      type: 'button', class: 'btn flame-analysis__toggle flame-analysis__hull-toggle', 'aria-pressed': String(this.hullCheck && !!sequence),
      disabled: !sequence, title: i18n.t("Draw the 3-D flame through each camera's calibrated view, over its picture"),
      onclick: () => this.setHullCheck(!this.hullCheck),
    }, [i18n.t("Hull check")]);
    this.hullCache.clear();
    tiles.setHullCheck(this.hullCheck && sequence ? this.hullProjection : null);

    const cameraPanel = h('section', { class: 'flame-analysis__panel flame-analysis__cameras', dataset: { target: 'cameras' }, 'aria-label': i18n.t("Camera pictures") }, [
      h('div', { class: 'flame-analysis__panel-bar' }, [
        h('h2', {}, [i18n.t("Cameras")]),
        h('div', { class: 'flame-analysis__group', role: 'group', 'aria-label': i18n.t("Picture") }, pictureButtons),
        outlineToggle,
        hullToggle,
      ]),
      tiles.element,
    ]);
    const scenePanel = h('section', { class: 'flame-analysis__panel flame-analysis__scene', dataset: { target: 'scene' }, 'aria-label': i18n.t("3-D view") }, [
      h('div', { class: 'flame-analysis__panel-bar' }, [
        h('h2', {}, [i18n.t("3-D flame in the site")]),
        event.files.mesh ? h('div', { class: 'flame-analysis__group', role: 'group', 'aria-label': i18n.t("Flame drawn as") },
          (['cubes', 'surface'] as FlameLook[]).map((look) => h('button', {
            type: 'button', class: 'btn flame-analysis__toggle flame-analysis__look', dataset: { look },
            'aria-pressed': String(look === this.flameLook), onclick: () => this.setLook(look),
          }, [look === 'cubes' ? i18n.t("Cubes") : i18n.t("Surface")]))) : null,
        h('div', { class: 'flame-analysis__group', role: 'group', 'aria-label': i18n.t("3-D view") }, viewButtons),
      ]),
      sceneHost,
      sequence ? null : h('p', { class: 'flame-analysis__note' }, [i18n.t("This event has no 3-D flame at any instant.")]),
    ]);
    const plotPanel = h('section', { class: 'flame-analysis__panel flame-analysis__charts', 'aria-label': i18n.t("Plots") },
      [this.plotBar(event, series), plots.element, note ? h('p', { class: 'flame-analysis__note flame-analysis__plot-note' }, [note]) : null,
        this.fluxRow(gauges)]);
    const main = h('div', { class: 'flame-analysis__main' }, [
      h('div', { class: 'flame-analysis__left' }, [cameraPanel, scenePanel]),
      plotPanel,
      this.drawer,
    ]);
    this.main = main;
    this.renderSteps(analysis);
    this.body.replaceChildren(
      this.steps,
      this.numbersRow(numbers, event),
      main,
      this.transport(event),
      this.status,
    );
    this.plotsToggle.hidden = false;
    this.applyLayout();

    if (!this.scene) {
      this.scene = new AnalysisScene(sceneHost);
      if (!this.isOpen) this.scene.setActive(false);
    } else {
      this.scene.attach(sceneHost);
    }
    // The site belongs to the folder, not to the scene: another folder brings its own.
    if (this.sitePlan !== plan) {
      this.scene.setSite(plan, new Map(analysis.cameras.map((c) => [c.planCameraId, this.cameraLabel(c.id)])));
      this.sitePlan = plan;
    }
    this.scene.setFlame(sequence, this.planCamera(event.cameras[0]));
    const meshTemplate = event.files.mesh;
    this.scene.setSurfaces(meshTemplate && sequence ? (index) => {
      const file = joinPath(folder, fillTemplate(meshTemplate, undefined, event.instants.stem[index]));
      return source.read(file).then((bytes) => parseMesh(bytes, file)).catch((error: Error) => {
        throw new Error(i18n.t("Surface at {p1} s, {p2}: {p3}", { p1: event.instants.t_s[index], p2: file, p3: error.message }));
      });
    } : null, sequence ? [sequence.bounds[0][2], sequence.bounds[1][2]] : undefined,
    (error) => this.setStatus(error.message, 'error'));
    this.scene.setLook(this.flameLook);
    this.setSceneView(this.sceneView, viewButtons);
    this.scene.setGauges(gauges.flatMap((g) => (g.object ? [g.object] : [])), (id) => this.toggleGauge(id));

    const times = event.instants.t_s;
    this.slider.max = String(times.length - 1);
    this.playhead.setMarks(times);
    const peak = numbers.volume?.peakMean.t;
    const start = peak !== undefined ? times[Math.max(instantAt(times, peak), 0)] : times[0];
    this.index = -1;
    this.playhead.seek(start);
    this.showTime(this.playhead.time_s);
    this.closeDrawer();
  }

  private setHullCheck(on: boolean): void {
    this.hullCheck = on;
    const loaded = this.loaded;
    loaded?.tiles.setHullCheck(on && loaded.sequence ? this.hullProjection : null);
    this.body.querySelector('.flame-analysis__hull-toggle')?.setAttribute('aria-pressed', String(on && !!loaded?.sequence));
    this.packPictures(); // the coverage line under each picture
  }

  // -- layout ----------------------------------------------------------------------

  private setPlotsShown(shown: boolean): void {
    this.plotsShown = shown;
    writeView({ plots: shown, reveal: this.plotOptions.reveal });
    this.applyLayout();
  }

  /** The board with its plots, or without them: the pictures in rows as large as the
   *  height allows, in a column only as wide as they need, and the 3-D view beside
   *  them taking the rest of the width. */
  private applyLayout(): void {
    this.plotsToggle.setAttribute('aria-pressed', String(this.plotsShown));
    const main = this.main;
    if (!main) return;
    const left = main.querySelector<HTMLElement>('.flame-analysis__left')!;
    const charts = main.querySelector<HTMLElement>('.flame-analysis__charts');
    main.classList.toggle('flame-analysis__main--pictures', !this.plotsShown);
    if (charts) charts.hidden = !this.plotsShown;
    this.layoutObserver?.disconnect();
    this.layoutObserver = undefined;
    if (this.plotsShown) {
      left.style.removeProperty('--pictures-w');
      this.loaded?.tiles.pack(null);
      return;
    }
    this.layoutObserver = new ResizeObserver(() => this.packPictures());
    this.layoutObserver.observe(left);
    this.packPictures();
  }

  private packPictures(): void {
    const loaded = this.loaded, left = this.main?.querySelector<HTMLElement>('.flame-analysis__left');
    if (!loaded || !left || this.plotsShown) return;
    // A narrow window keeps the stacked panels of the board's small-screen layout.
    if (!matchMedia('(min-width: 1101px)').matches || !left.clientWidth) {
      left.style.removeProperty('--pictures-w');
      loaded.tiles.pack(null);
      return;
    }
    const bar = left.querySelector<HTMLElement>('.flame-analysis__cameras .flame-analysis__panel-bar')!;
    // The column is at least as wide as the panel's buttons on one line (measured at
    // their natural widths: under `nowrap` a button may squeeze and wrap its own text).
    bar.style.width = 'max-content';
    const barWidth = bar.offsetWidth + 2, barHeight = bar.offsetHeight;
    bar.style.width = '';
    // Panel border 1 + 1 and the tiles' padding: 8 at each side, 8 below.
    const width = loaded.tiles.pack({ width: Math.floor((left.clientWidth - 10) * 0.55) - 18, height: left.clientHeight - barHeight - 10 });
    left.style.setProperty('--pictures-w', `${Math.max(width + 18, barWidth)}px`);
  }

  /** The 3-D flame at an instant through a camera's calibrated model: its surface
   *  cells projected into the full-resolution picture. Null when the pictures are
   *  not the size of the site plan's camera, so they cannot be compared. */
  private hullProjection = (camera: string, index: number): HullProjection | null => {
    const loaded = this.loaded, sequence = loaded?.sequence;
    const planCamera = this.planCamera(camera);
    if (!loaded || !sequence || !planCamera) return null;
    const [w, h] = loaded.event.images[camera].size_px;
    if (w !== planCamera.camera.resolution_px[0] || h !== planCamera.camera.resolution_px[1]) return null;
    const key = `${camera}/${index}`;
    const cached = this.hullCache.get(key);
    if (cached !== undefined) return cached;
    const frame = sequence.frames[index];
    let projection: HullProjection = { uv: new Float32Array(0), size: 0 };
    if (frame?.count) {
      const cells = surfaceCells(frame);
      const origin = sequence.frameOrigin(frame), pitch = sequence.grid.pitch_m;
      const points = new Float64Array(cells.length);
      for (let i = 0; i < cells.length; i++) points[i] = origin[i % 3] + cells[i] * pitch;
      projection = projectHull(planCamera, points, pitch);
    }
    this.hullCache.set(key, projection);
    if (this.hullCache.size > 400) this.hullCache.delete(this.hullCache.keys().next().value as string);
    return projection;
  };

  private setLook(look: FlameLook): void {
    this.flameLook = look;
    this.scene?.setLook(look);
    this.body.querySelectorAll<HTMLButtonElement>('[data-look]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.look === look)));
  }

  /** The measured heat release rate's response time (format 1.1), if the folder gives one. */
  private responseTime(event: EventManifest): number | undefined {
    return hoodOf(event)?.responseTime_s;
  }

  /** Heskestad's mean height from the measured heat release rate and the site plan's
   *  fire, with what it assumed; null without a hood record or a burner. */
  private heskestad(event: EventManifest, series: Map<string, Series>): (Series & { note: string }) | null {
    const hood = hoodOf(event);
    const burner = this.plan ? primaryBurner(this.plan) : undefined;
    if (!hood || !burner) return null;
    const d = burnerDiameterM(burner), chi = radiativeFractionOf(burner);
    const convective = hood.basis === 'convective';
    const data = heskestadSeries(series.get(hood.id)!, d, convective, chi, flameHeightM);
    const note = convective
      ? i18n.t("Heskestad: L = 0.235 Q^0.4 - 1.02 D, with Q the total heat release rate (the hood's convective rate divided by 1 - {p1}, the radiative fraction of the site plan's fire) and D = {p2} m. A pool-fire correlation of the mean flame height, shown for comparison: the flame top is the 3-D flame's highest point.", { p1: i18n.formatNumber(chi), p2: i18n.formatNumber(Number(d.toFixed(2))) })
      : i18n.t("Heskestad: L = 0.235 Q^0.4 - 1.02 D, with Q the hood's heat release rate and D = {p1} m. A pool-fire correlation of the mean flame height, shown for comparison: the flame top is the 3-D flame's highest point.", { p1: i18n.formatNumber(Number(d.toFixed(2))) });
    return { ...data, note };
  }

  private plotBar(event: EventManifest, series: Map<string, Series>): HTMLElement {
    const hasHrr = event.series.some((s) => s.quantity === 'hrr');
    const tau = this.responseTime(event);
    const canHeskestad = event.series.some((s) => s.quantity === 'height') && this.heskestad(event, series) !== null;
    const toggle = (label: string, key: 'hoodResponse' | 'heskestad' | 'reveal', title: string, disabled = false): HTMLButtonElement =>
      h('button', {
        type: 'button', class: `btn flame-analysis__toggle flame-analysis__${key}`, 'aria-pressed': String(this.plotOptions[key]), title, disabled,
        onclick: (e: Event) => {
          this.plotOptions[key] = !this.plotOptions[key];
          (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(this.plotOptions[key]));
          if (key === 'reveal') writeView({ plots: this.plotsShown, reveal: this.plotOptions.reveal });
          this.rebuildPlots();
        },
      }, [label]);
    const mode = (['rate', 'heat'] as const).map((m) => h('button', {
      type: 'button', class: 'btn flame-analysis__toggle flame-analysis__heat', dataset: { mode: m },
      'aria-pressed': String((m === 'heat') === this.plotOptions.heat),
      onclick: () => {
        this.plotOptions.heat = m === 'heat';
        this.body.querySelectorAll<HTMLElement>('.flame-analysis__heat').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.mode === 'heat') === this.plotOptions.heat)));
        this.rebuildPlots();
      },
    }, [m === 'rate' ? i18n.t("Rate") : i18n.t("Heat released")]));
    return h('div', { class: 'flame-analysis__panel-bar' }, [
      h('h2', {}, [i18n.t("Plots")]),
      hasHrr ? h('div', { class: 'flame-analysis__group', role: 'group', 'aria-label': i18n.t("Heat release") }, mode) : null,
      tau ? toggle(i18n.t("As the hood sees it"), 'hoodResponse',
        i18n.t("The estimates passed through the hood's own response time ({p1} s), so their timing compares with the hood's", { p1: i18n.formatNumber(tau) })) : null,
      canHeskestad ? toggle(i18n.t("Heskestad height"), 'heskestad', i18n.t("Heskestad's mean flame height from the hood record, beside the 3-D flame's top")) : null,
      toggle(i18n.t("Draw as it plays"), 'reveal', i18n.t("Each line ends at the playback time, so the plots draw as the event plays; the axes keep the whole event. The exported video draws them the same way")),
    ]);
  }

  private rebuildPlots(): void {
    const loaded = this.loaded;
    if (!loaded) return;
    const { plots, plotData, note } = this.makePlots(loaded.event, loaded.series, loaded.gauges);
    const old = loaded.plots.element;
    loaded.plots.dispose();
    old.replaceWith(plots.element);
    loaded.plots = plots;
    loaded.plotData = plotData;
    this.builtImperial = this.imperial();
    const charts = plots.element.parentElement;
    charts?.querySelector('.flame-analysis__plot-note')?.remove();
    if (note) plots.element.after(h('p', { class: 'flame-analysis__note flame-analysis__plot-note' }, [note]));
    plots.setTime(loaded.event.instants.t_s[Math.max(this.index, 0)]);
  }

  /** Heat flux records by gauge, in the order the event lists them. */
  private fluxGauges(event: EventManifest, plan: PlanDocument): FluxGauge[] {
    const gauges: FluxGauge[] = [];
    for (const s of event.series) {
      if (s.quantity !== 'heatFlux') continue;
      const key = s.object ?? `series:${s.id}`;
      const known = gauges.find((g) => g.key === key);
      if (known) { known.series.push(s); continue; }
      const object = s.object ? plan.objects.find((o) => o.id === s.object) : undefined;
      gauges.push({ key, object: s.object, name: object ? displayName(object) : localText(s.label), series: [s] });
    }
    return gauges;
  }

  /** One toggle per gauge under the plots: the keyboard's way to what a click on a
   *  gauge in the 3-D view does, and the way to one outside the view. */
  private fluxRow(gauges: FluxGauge[]): HTMLElement | null {
    if (!gauges.length) return null;
    return h('div', { class: 'flame-analysis__flux', role: 'group', 'aria-label': i18n.t("Heat flux gauges") }, [
      h('span', { class: 'flame-analysis__flux-title' }, [i18n.t("Heat flux")]),
      ...gauges.map((g) => h('button', {
        type: 'button', class: 'btn btn--small flame-analysis__toggle flame-analysis__flux-toggle', dataset: { gauge: g.key },
        'aria-pressed': String(this.fluxShown.has(g.key)),
        title: i18n.t("Plot the heat flux of {p1}; a click on the gauge in the 3-D view does the same", { p1: g.name }),
        onclick: () => this.toggleGauge(g.key),
      }, [g.name])),
    ]);
  }

  /** Plot a gauge's heat flux, or stop; plotting one shows the plots if they are hidden. */
  private toggleGauge(key: string): void {
    const loaded = this.loaded;
    if (!loaded?.gauges.some((g) => g.key === key)) return;
    if (this.fluxShown.has(key)) this.fluxShown.delete(key);
    else {
      this.fluxShown.add(key);
      if (!this.plotsShown) this.setPlotsShown(true);
    }
    this.body.querySelectorAll<HTMLElement>('.flame-analysis__flux-toggle')
      .forEach((b) => b.setAttribute('aria-pressed', String(this.fluxShown.has(b.dataset.gauge!))));
    this.rebuildPlots();
    this.showGauges();
  }

  /** A gauge's name and its reading at an instant (its first record's last sample). */
  private gaugeText(gauge: FluxGauge, index: number): string {
    const loaded = this.loaded;
    const data = loaded?.series.get(gauge.series[0].id);
    const value = data && index >= 0 ? valueAt(data.t, data.v, loaded!.event.instants.t_s[index]) : null;
    return value === null || !Number.isFinite(value) ? gauge.name
      : i18n.t("{p1}: {p2} kW/m²", { p1: gauge.name, p2: readoutText(value, 1) });
  }

  /** The gauges' labels in the 3-D view: reading at the playback time, and plotted or not. */
  private showGauges(): void {
    const loaded = this.loaded;
    if (!loaded || !this.scene) return;
    for (const g of loaded.gauges) {
      if (g.object) this.scene.setGaugeState(g.object, this.gaugeText(g, this.index), this.fluxShown.has(g.key));
    }
  }

  private setOutlines(shown: boolean): void {
    this.outlinesShown = shown;
    this.loaded?.tiles.setOutlines(shown);
    this.body.querySelector('.flame-analysis__outline-toggle')?.setAttribute('aria-pressed', String(shown));
  }

  private setSceneView(view: SceneView, buttons?: HTMLButtonElement[]): void {
    this.sceneView = view;
    this.scene?.setView(view);
    const list = buttons ?? [...this.body.querySelectorAll<HTMLButtonElement>('[data-view]')];
    list.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  }

  private imperial(): boolean { return IMPERIAL.has(this.options.lengthUnit?.() ?? 'm'); }

  /** Redraw what carries a unit, for a unit changed in the editor since the event was built. */
  private refreshUnits(): void {
    const loaded = this.loaded;
    if (!loaded) return;
    this.body.querySelector('.flame-analysis__numbers')?.replaceWith(this.numbersRow(loaded.numbers, loaded.event));
    this.rebuildPlots();
  }

  private units(): { volume: [number, string]; area: [number, string]; height: [number, string] } {
    return this.imperial()
      ? { volume: [35.3146667, 'ft³'], area: [10.7639104, 'ft²'], height: [1 / 0.3048, 'ft'] }
      : { volume: [1, 'm³'], area: [1, 'm²'], height: [1, 'm'] };
  }

  private makePlots(event: EventManifest, series: Map<string, Series>, gauges: FluxGauge[] = []): { plots: AnalysisPlots; plotData: LoadedEvent['plotData']; note?: string } {
    const units = this.units();
    let note: string | undefined;
    const line = (id: string, role: PlotLine['role'], nth: number, extra: Partial<PlotLine> = {}): PlotLine => {
      const s = event.series.find((x) => x.id === id)!;
      const data = series.get(id)!;
      return { label: localText(s.label), note: localText(s.note), t: data.t, v: data.v, role, nth, ...extra };
    };
    const plots: PlotSpec[] = [];
    const hrr = event.series.filter((s) => s.quantity === 'hrr');
    if (hrr.length) {
      const bases = new Set(hrr.map((s) => s.basis));
      const basis = bases.size === 1 && hrr[0].basis ? hrr[0].basis : null;
      const lines: PlotLine[] = [];
      let nEstimated = 0, nMeasured = 0;
      const tau = this.responseTime(event);
      for (const s of [...hrr.filter((x) => x.role === 'measured'), ...hrr.filter((x) => x.role !== 'measured')]) {
        const estimated = s.role === 'estimated';
        const base = line(s.id, estimated ? 'estimated' : 'measured', estimated ? nEstimated++ : nMeasured++);
        if (!basis) base.label = i18n.t("{p1} ({p2})", { p1: base.label,
          p2: s.basis === 'convective' ? i18n.t("convective") : s.basis === 'total' ? i18n.t("total") : i18n.t("basis not stated") });
        let data = series.get(s.id)!;
        if (estimated && this.plotOptions.hoodResponse && tau) {
          data = asHoodSees(data, tau, event.instants.t_s[0]);
          base.label = i18n.t("{p1}, as the hood sees it", { p1: base.label });
        }
        if (this.plotOptions.heat) data = cumulative(data, event.instants.t_s[0], event.instants.t_s.at(-1)!);
        lines.push({ ...base, ...data });
      }
      plots.push(this.plotOptions.heat ? {
        id: 'hrr', unit: 'MJ', scale: 0.001, lines,
        title: basis === 'convective' ? i18n.t("Heat released, convective") : basis === 'total' ? i18n.t("Heat released, total") : i18n.t("Heat released"),
      } : {
        id: 'hrr', unit: 'kW', lines,
        title: basis === 'convective' ? i18n.t("Heat release rate, convective") : basis === 'total' ? i18n.t("Heat release rate, total") : i18n.t("Heat release rate"),
      });
    }
    const sized = (quantity: 'volume' | 'area', title: string, [scale, unit]: [number, string]): void => {
      const s = event.series.find((x) => x.quantity === quantity);
      if (!s) return;
      const data = series.get(s.id)!;
      plots.push({
        id: quantity, title, unit, scale,
        lines: [
          { ...line(s.id, 'reconstructed', 0, { thin: true }), label: i18n.t("every instant") },
          { ...line(s.id, 'reconstructed', 0), v: centredMean(data), label: i18n.t("one-second mean") },
        ],
      });
    };
    sized('volume', i18n.t("Flame volume"), units.volume);
    sized('area', i18n.t("Flame surface area"), units.area);
    const height = event.series.find((x) => x.quantity === 'height');
    if (height) {
      const lines = [line(height.id, 'reconstructed', 0)];
      const predicted = this.plotOptions.heskestad ? this.heskestad(event, series) : null;
      if (predicted) {
        lines.push({ label: i18n.t("Heskestad mean height (pool fire), from the hood"), t: predicted.t, v: predicted.v, role: 'predicted', nth: 0 });
        note = predicted.note; // the note goes with the line it explains
      }
      plots.push({ id: 'height', title: localText(height.label), unit: units.height[1], scale: units.height[0], lines });
    }
    // Heat flux, of the gauges switched on: one plot on one scale, so gauges compare;
    // records of one gauge (two sensors on one mount) take successive dashes.
    const flux = gauges.filter((g) => this.fluxShown.has(g.key)).flatMap((g) => g.series);
    if (flux.length) {
      let nMeasured = 0, nEstimated = 0;
      plots.push({
        id: 'heatFlux', title: i18n.t("Heat flux"), unit: 'kW/m²',
        lines: flux.map((s) => (s.role === 'estimated' ? line(s.id, 'estimated', nEstimated++) : line(s.id, 'measured', nMeasured++))),
      });
    }

    const times = event.instants.t_s;
    const step = times.length > 1 ? times[1] - times[0] : 0.1;
    const bands: Band[] = [];
    const toBands = (indices: number[] | undefined, kind: Band['kind']): void => {
      const sorted = [...new Set(indices ?? [])].sort((a, b) => a - b);
      for (let k = 0; k < sorted.length; k++) {
        let end = k;
        while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++;
        const to = sorted[end] + 1 < times.length ? times[sorted[end] + 1] : times[sorted[end]] + step;
        bands.push({ from: times[sorted[k]], to, kind });
        k = end;
      }
    };
    toBands(event.quality?.noHull, 'noHull');
    toBands(Object.values(event.quality?.outsideFrame ?? {}).flat(), 'outsideFrame');
    const moments = (event.keyMoments ?? []).map((m) => ({ t: m.t_s, label: localText(m.label) }));
    const window: [number, number] = [times[0], times[times.length - 1]];
    const reveal = this.plotOptions.reveal;
    return {
      plots: new AnalysisPlots(plots, window, event.onset_s, bands, moments, (t) => this.seekTime(t), { reveal }),
      plotData: { specs: plots, bands, moments, window, reveal },
      note,
    };
  }

  private numbersRow(numbers: KeyNumbers, event: EventManifest): HTMLElement {
    const units = this.units();
    const window = i18n.t("Between the first and last instant, {p1} s to {p2} s from the onset", {
      p1: fmt(numbers.window[0] - event.onset_s), p2: fmt(numbers.window[1] - event.onset_s),
    });
    const at = (t: number): string => Number.isFinite(t) ? i18n.t("at {p1} s", { p1: `${t - event.onset_s > 0 ? '+' : ''}${fmt(t - event.onset_s)}` }) : '';
    const signed = (ratio: number | null): string => {
      if (ratio === null) return '–';
      const p = Math.round((ratio - 1) * 100);
      return `${p > 0 ? '+' : p < 0 ? '−' : ''}${i18n.formatQuantity(Math.abs(p), '%')}`;
    };
    const percent = (ratio: number | null): string => (ratio === null ? '' : ` (${signed(ratio)})`);
    const quantity = (value: number, unit: string): string => Number.isFinite(value) ? i18n.formatQuantity(Number(value.toPrecision(3)), unit) : '–';
    const heatText = (heat: { heat_kJ: number; coverage: number }): string => {
      if (!heat.coverage) return '–';
      const value = quantity(heat.heat_kJ / 1000, 'MJ');
      return heat.coverage >= 0.995 ? value : i18n.t("{p1} (partial, {p2} covered)", {
        p1: value, p2: i18n.formatQuantity(100 * heat.coverage, '%', 1),
      });
    };
    // `aside` sits beside the value, for a second number that needs no line of its own.
    const tile = (label: string, value: string, detail: string, tip: string, aside = ''): HTMLElement =>
      h('div', { class: 'flame-analysis__number', title: tip }, [
        h('span', { class: 'flame-analysis__number-label' }, [label]),
        h('span', { class: 'flame-analysis__number-value' }, [
          h('strong', {}, [value]),
          aside ? h('span', { class: 'flame-analysis__number-detail' }, [aside]) : null,
        ]),
        h('span', { class: 'flame-analysis__number-detail' }, [detail]),
      ]);
    const tiles: HTMLElement[] = [];
    const hood = numbers.hood;
    if (hood) {
      const note = localText(event.series.find((s) => s.id === hood.id)?.note);
      tiles.push(tile(i18n.t("Hood peak"), quantity(hood.peak.value, 'kW'), at(hood.peak.t),
        [note, i18n.t("The largest measured heat release rate. {p1}.", { p1: window })].filter(Boolean).join('\n')));
      tiles.push(tile(i18n.t("Heat released, hood"), heatText(hood), '',
        [note, i18n.t("The measured heat release rate integrated over time. {p1}.", { p1: window })].filter(Boolean).join('\n')));
    }
    for (const estimate of numbers.estimates) {
      const s = event.series.find((x) => x.id === estimate.id)!;
      const comparison = estimate.comparison === 'different' ? i18n.t("Bases differ; not compared.")
        : estimate.comparison === 'unstated' ? i18n.t("A basis is not stated; not compared.")
        : estimate.coverage < 0.995 || (hood?.coverage ?? 0) < 0.995 ? i18n.t("Incomplete coverage; not compared.") : '';
      // Like for like where the folder gives the hood's response time: a hood averages
      // over seconds, so the raw peak of a 10 Hz estimate against it says little.
      const seen = estimate.asHood && (estimate.asHood.peakRatio !== null || estimate.asHood.heatRatio !== null) ? estimate.asHood : null;
      const compared = estimate.peakRatio !== null || estimate.heatRatio !== null;
      const how = seen
        ? i18n.t("The percentages compare the estimate as the hood would record it (response time {p1} s: peak {p2}, heat {p3}) with the hood. A hood averages over its response time, so at a peak it reads lower than the flame.", {
          p1: i18n.formatNumber(hood?.responseTime_s ?? 0), p2: quantity(seen.peak.value, 'kW'), p3: quantity(seen.heat_kJ / 1000, 'MJ'),
        })
        : compared ? i18n.t("A hood averages over its response time, so at a peak it reads lower than the flame: a higher estimate there is expected.") : '';
      tiles.push(tile(localText(s.label),
        seen ? quantity(estimate.peak.value, 'kW') : `${quantity(estimate.peak.value, 'kW')}${percent(estimate.peakRatio)}`,
        seen
          ? i18n.t("as the hood sees it: peak {p1}, heat {p2}", { p1: signed(seen.peakRatio), p2: signed(seen.heatRatio) })
          : [i18n.t("heat {p1}{p2}", { p1: heatText(estimate), p2: percent(estimate.heatRatio) }), comparison].filter(Boolean).join(' · '),
        [localText(s.note), i18n.t("Peak and heat released of this estimate. Comparisons require the same stated basis and at least 99.5 % coverage on both series. {p1}.", { p1: window }), how].filter(Boolean).join('\n'),
        // The raw heat beside the raw peak; the line below is the comparison.
        seen ? i18n.t("heat {p1}{p2}", { p1: heatText(estimate), p2: '' }) : ''));
    }
    if (numbers.volume) {
      const [scale, unit] = units.volume;
      tiles.push(tile(i18n.t("Largest flame"), quantity(numbers.volume.peakMean.value * scale, unit),
        `${i18n.t("one-second mean")} ${at(numbers.volume.peakMean.t)}`,
        i18n.t("The largest one-second mean of the 3-D flame's volume. {p1}.", { p1: window })));
    }
    if (numbers.height) {
      const [scale, unit] = units.height;
      tiles.push(tile(i18n.t("Tallest flame"), quantity(numbers.height.peak.value * scale, unit),
        at(numbers.height.peak.t), i18n.t("The highest point of the 3-D flame at any instant. {p1}.", { p1: window })));
    }
    return h('div', { class: 'flame-analysis__numbers' }, tiles);
  }

  private transport(event: EventManifest): HTMLElement {
    setTransportPlaying(this.play, false);
    this.loop.checked = this.playhead.loop;
    const moments = (event.keyMoments ?? []).filter((m) => m.t_s >= event.instants.t_s[0] && m.t_s <= event.instants.t_s.at(-1)!);
    return h('div', { class: 'flame-analysis__transport', role: 'group', 'aria-label': i18n.t("Playback") }, [
      this.first, this.previous, this.play, this.next, this.last, this.slider, this.stamp, this.speed,
      h('label', { class: 'playback-bar__loop' }, [this.loop, i18n.t("Loop")]),
      moments.length ? h('div', { class: 'flame-analysis__moments', role: 'group', 'aria-label': i18n.t("Key moments") },
        moments.map((m) => h('button', { type: 'button', class: 'btn btn--small', onclick: () => this.seekTime(m.t_s) }, [localText(m.label)]))) : null,
      h('div', { class: 'flame-analysis__export', role: 'group', 'aria-label': i18n.t("Export") }, [
        h('button', { type: 'button', class: 'btn btn--small', onclick: () => this.openExport(),
          title: i18n.t("Make an MP4 video of the board for slides") }, [i18n.t("Export video…")]),
        h('button', { type: 'button', class: 'btn btn--small', onclick: () => { void this.savePng(); },
          title: i18n.t("Save the board at this instant as a PNG picture") }, [i18n.t("PNG")]),
      ]),
    ]);
  }

  // -- export ------------------------------------------------------------------------

  /** The composition a video frame or PNG is drawn from, as the board shows it now. */
  composer(layout: VideoLayout, width: 1920 | 1280): Composer | null {
    const loaded = this.loaded, analysis = this.analysis;
    if (!loaded || !analysis) return null;
    const { event, tiles } = loaded;
    const pictureMode = tiles.pictureMode;
    return new Composer({
      title: localText(analysis.title),
      eventLabel: localText(event.label),
      onset: event.onset_s,
      timeBase: analysis.timeBase.label,
      times: event.instants.t_s,
      cameras: event.cameras.map((id) => ({ id, label: this.cameraLabel(id), image: event.images[id] })),
      pictureMode: tiles.pictureMode,
      outlines: tiles.outlinesOn ? loaded.outlines : null,
      coverageOutlines: loaded.outlines,
      outsideFrame: event.quality?.outsideFrame ?? {},
      picture: (camera, index) => tiles.picture(camera, index, pictureMode),
      hull: tiles.hullCheckOn ? this.hullProjection : null,
      coverage: tiles.hullCheckOn ? (camera, index) => tiles.coverageAt(camera, index) : undefined,
      scene: this.scene ?? null,
      labelText: (id, index) => {
        const gauge = loaded.gauges.find((g) => g.object === id);
        return gauge ? this.gaugeText(gauge, index) : undefined;
      },
      plots: loaded.plotData,
    }, layout, width);
  }

  /** Encode a video of the board; public so tests and hosts can call it directly. */
  async exportVideo(options: VideoOptions, progress: (done: number, total: number) => void = () => {},
    signal?: AbortSignal): Promise<Blob> {
    const composer = this.composer(options.layout, options.width);
    if (!composer || !this.loaded) throw new Error(i18n.t("No event is open."));
    this.playhead.pause();
    const times = this.loaded.event.instants.t_s;
    return this.runExport(async (ownedSignal) => {
      const bytes = await encodeVideo(composer, times, options, progress, ownedSignal);
      return new Blob([bytes as BlobPart], { type: 'video/mp4' });
    }, signal);
  }

  /** The board at the playback instant as a PNG, by default in the layout on screen
   *  (the full board, or the cameras and the 3-D view when the plots are hidden). */
  async exportPng(width: 1920 | 1280 = 1920, layout: VideoLayout = this.plotsShown ? 'board' : 'cameras'): Promise<Blob> {
    const composer = this.composer(layout, width);
    if (!composer || this.index < 0) throw new Error(i18n.t("No event is open."));
    const index = this.index;
    return this.runExport((signal) => encodePng(composer, index, signal));
  }

  /** One owner for every asynchronous composition, including direct host calls. */
  private runExport(work: (signal: AbortSignal) => Promise<Blob>, signal?: AbortSignal): Promise<Blob> {
    if (this.exportTask) return Promise.reject(new Error(i18n.t("An export is already running.")));
    const controller = new AbortController();
    this.exportController = controller;
    ++this.exportId;
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const task = Promise.resolve().then(async () => {
      try {
        checkExportSignal(controller.signal);
        const blob = await work(controller.signal);
        checkExportSignal(controller.signal);
        return blob;
      } finally {
        signal?.removeEventListener('abort', abort);
        const current = this.loaded?.sequence ? this.index : -1;
        if (this.scene && this.scene.currentFrame !== current) this.scene.setFrame(current);
        if (this.exportTask === task) { this.exportTask = undefined; this.exportController = undefined; }
      }
    });
    this.exportTask = task;
    return task;
  }

  /** Stop before replacing the event, scene, or language-owned interface. */
  async stopExport(): Promise<void> {
    ++this.exportId;
    this.exportAbort?.();
    this.exportController?.abort();
    try { await this.exportTask; } catch { /* The owning export reports its result. */ }
  }

  private async savePng(): Promise<void> {
    const event = this.loaded?.event;
    if (!event) return;
    const relative = event.instants.t_s[Math.max(this.index, 0)] - event.onset_s;
    const name = `${event.id}_${relative >= 0 ? '+' : '-'}${Math.abs(relative).toFixed(1)}s.png`;
    try {
      const pending = this.exportPng(), id = this.exportId;
      const blob = await pending;
      if (id !== this.exportId || !this.isOpen || this.loaded?.event !== event) return;
      const saved = await saveMedia(blob, name, 'png');
      this.setStatus(saved ? i18n.t("Saved {p1}.", { p1: saved }) : '');
    } catch (error) {
      this.setStatus((error as Error).message, 'error');
    }
  }

  private openExport(): void {
    const loaded = this.loaded;
    if (!loaded || this.exportPanel || this.exportTask) return;
    this.closeZoom(); // one panel over the board at a time
    this.playhead.pause();
    const { event } = loaded;
    const times = event.instants.t_s;
    const select = (label: string, options: [string, string][], value: string): HTMLSelectElement => {
      const el = h('select', { class: 'field__input', 'aria-label': label },
        options.map(([v, text]) => h('option', { value: v, selected: v === value }, [text])));
      return el;
    };
    const hasPlots = loaded.plotData.specs.length > 0;
    // The board as it is on screen, with or without its plots.
    const layout = select(i18n.t("Layout"), [
      ['board', i18n.t("Full board")], ['cameras', i18n.t("Cameras and 3-D")], ...(hasPlots ? [['plots', i18n.t("3-D and plots")] as [string, string]] : []),
    ], this.plotsShown && hasPlots ? 'board' : 'cameras');
    const size = select(i18n.t("Size"), [['1920', '1920 × 1080'], ['1280', '1280 × 720']], '1920');
    const moments = (event.keyMoments ?? []).filter((m) => m.t_s > times[0] && m.t_s < times[times.length - 1]);
    const at = (t: number): string => `${t - event.onset_s > 0 ? '+' : ''}${i18n.formatNumber(t - event.onset_s, 1)} s`;
    const startPoints: [string, string][] = [
      [String(times[0]), i18n.t("Start of the event ({p1})", { p1: at(times[0]) })],
      ...(event.onset_s > times[0] && event.onset_s < times[times.length - 1] ? [[String(event.onset_s), i18n.t("Onset ({p1})", { p1: at(event.onset_s) })] as [string, string]] : []),
      ...moments.map((m) => [String(m.t_s), `${localText(m.label)} (${at(m.t_s)})`] as [string, string]),
      [String(times[Math.max(this.index, 0)]), i18n.t("Playback time ({p1})", { p1: at(times[Math.max(this.index, 0)]) })],
    ];
    const from = select(i18n.t("From"), startPoints, String(times[0]));
    const to = select(i18n.t("To"), [
      ...moments.map((m) => [String(m.t_s), `${localText(m.label)} (${at(m.t_s)})`] as [string, string]),
      [String(times[times.length - 1]), i18n.t("End of the event ({p1})", { p1: at(times[times.length - 1]) })],
    ], String(times[times.length - 1]));
    const speed = select(i18n.t("Speed"), [['1', i18n.t("Real time (×1)")], ['0.5', i18n.t("Slow (×0.5)")], ['0.25', i18n.t("Slower (×0.25)")]], '1');
    const summary = h('p', { class: 'flame-analysis__note' });
    const status = h('p', { class: 'flame-analysis__status', role: 'status' });
    const bar = h('progress', { class: 'flame-analysis__progress', max: 1, value: 0, hidden: true, 'aria-label': i18n.t("Export progress") });
    const options = (): VideoOptions => ({
      layout: layout.value as VideoLayout, width: Number(size.value) as 1920 | 1280,
      from: Number(from.value), to: Number(to.value), speed: Number(speed.value),
    });
    const go = h('button', { type: 'button', class: 'btn btn--primary' }, [i18n.t("Export")]);
    const close = h('button', { type: 'button', class: 'btn' }, [i18n.t("Close")]);
    const update = (): void => {
      const o = options();
      const valid = o.to > o.from;
      go.disabled = !!controller || !valid;
      to.setAttribute('aria-invalid', String(!valid));
      const frames = valid ? videoFrames(times, o).length : 0;
      summary.textContent = valid
        ? i18n.t("{p1} s of video, {p2} frames at {p3} per second, H.264 MP4.", { p1: i18n.formatNumber(frames / VIDEO_FPS, 1), p2: frames, p3: VIDEO_FPS })
        : i18n.t("The end must come after the start.");
    };
    for (const el of [layout, size, from, to, speed]) el.onchange = update;
    let controller: AbortController | null = null;
    go.onclick = async () => {
      if (controller || this.exportTask) return;
      const o = options();
      const ownController = new AbortController();
      controller = ownController;
      const panel = this.exportPanel;
      for (const el of [layout, size, from, to, speed]) el.disabled = true;
      go.disabled = true;
      close.textContent = i18n.t("Cancel");
      close.focus();
      bar.hidden = false;
      status.classList.remove('flame-analysis__status--error');
      const t0 = performance.now();
      try {
        const pending = this.exportVideo(o, (done, total) => {
          bar.value = done / total;
          status.textContent = i18n.t("Encoding frame {p1} of {p2}…", { p1: done, p2: total });
        }, ownController.signal);
        const operation = this.exportId;
        const blob = await pending;
        checkExportSignal(ownController.signal);
        if (operation !== this.exportId || panel !== this.exportPanel || !this.isOpen) return;
        status.textContent = i18n.t("Encoded in {p1} s; choose where to save it.", { p1: i18n.formatNumber((performance.now() - t0) / 1000, 0) });
        this.lastVideo = blob;
        const saved = await saveMedia(blob, `${event.id}_${o.layout}_${o.width}.mp4`, 'video');
        status.textContent = saved ? i18n.t("Saved {p1}.", { p1: saved }) : i18n.t("Not saved.");
      } catch (error) {
        const aborted = (error as Error).name === 'AbortError';
        status.textContent = aborted ? i18n.t("The export was cancelled.") : (error as Error).message;
        status.classList.toggle('flame-analysis__status--error', !aborted);
      } finally {
        controller = null;
        for (const el of [layout, size, from, to, speed]) el.disabled = false;
        update();
        close.textContent = i18n.t("Close");
        bar.hidden = true;
      }
    };
    close.onclick = () => { if (controller) controller.abort(); else void this.closeExport(); };
    this.exportAbort = () => controller?.abort();
    this.exportPanel = h('div', { class: 'flame-analysis__zoom flame-analysis__export-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'flame-analysis-export-title' }, [
      h('div', { class: 'flame-analysis__drawer-bar' }, [h('h2', { id: 'flame-analysis-export-title' }, [i18n.t("Export video")]), close]),
      h('p', { class: 'flame-analysis__note' }, [i18n.t("A fixed 16:9 picture of the board for slides: the pictures as the board shows them (close-up or whole, outline on or off), the 3-D view from its current angle, and the plots. Each instant is held, never interpolated.")]),
      h('div', { class: 'flame-analysis__export-form' }, [
        h('label', {}, [i18n.t("Layout"), layout]), h('label', {}, [i18n.t("Size"), size]),
        h('label', {}, [i18n.t("From"), from]), h('label', {}, [i18n.t("To"), to]), h('label', {}, [i18n.t("Speed"), speed]),
      ]),
      summary, h('div', { class: 'flame-analysis__export-actions' }, [go, bar]), status,
    ]);
    this.dialog.append(this.exportPanel);
    this.exportRestore = this.holdBoard(this.exportPanel);
    update();
    layout.focus();
  }

  /** Make `panel` the only part of the board that can be reached: everything else in
   *  the dialog is inert and Tab stays inside the panel. The returned function undoes it.
   *  The board's state follows the panels that hold it, not the order they close in. */
  private holdBoard(panel: HTMLElement): () => void {
    this.holders.push(panel);
    this.applyHold();
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)')];
      const next = controls[e.shiftKey ? controls.length - 1 : 0];
      const boundary = controls[e.shiftKey ? 0 : controls.length - 1];
      if (document.activeElement === boundary) { e.preventDefault(); next?.focus(); }
    });
    return () => {
      this.holders = this.holders.filter((held) => held !== panel);
      this.applyHold();
    };
  }

  /** Only the panel opened last can be reached; with none, the whole board can. */
  private applyHold(): void {
    const top = this.holders.at(-1);
    for (const child of this.dialog.children) {
      if (child instanceof HTMLElement) child.inert = top !== undefined && child !== top;
    }
  }

  private escapeExport(): void {
    if (this.exportController) this.exportController.abort();
    else if (this.exportTask) this.exportAbort?.();
    else void this.closeExport();
  }

  private async closeExport(): Promise<void> {
    await this.stopExport();
    const panel = this.exportPanel;
    if (!panel) return;
    panel.remove();
    this.exportPanel = undefined;
    this.exportAbort = undefined;
    this.exportRestore?.();
    this.exportRestore = undefined;
    this.body.querySelector<HTMLElement>('.flame-analysis__export button')?.focus();
  }

  // -- the clock -------------------------------------------------------------------

  private tick = (now: number): void => {
    if (!this.isOpen) return;
    const elapsed = this.lastTick ? (now - this.lastTick) / 1000 : 0;
    this.lastTick = now;
    if (this.playhead.playing) this.playhead.advance(Math.min(elapsed, 0.25));
    this.raf = requestAnimationFrame(this.tick);
  };

  private seekIndex(index: number): void {
    const times = this.loaded?.event.instants.t_s;
    if (!times?.length) return;
    this.playhead.seek(times[Math.min(Math.max(index, 0), times.length - 1)]);
  }

  private seekTime(t: number): void {
    const times = this.loaded?.event.instants.t_s;
    if (!times?.length) return;
    this.seekIndex(Math.max(instantAt(times, t), 0));
  }

  private showTime(t: number): void {
    const loaded = this.loaded;
    if (!loaded) return;
    const { event } = loaded;
    const times = event.instants.t_s;
    const index = Math.max(instantAt(times, t), 0);
    if (index !== this.index) {
      this.index = index;
      this.scene?.setFrame(loaded.sequence ? index : -1);
      loaded.tiles.show(index);
      if (this.playhead.playing) loaded.tiles.prefetch(Array.from({ length: PREFETCH }, (_, k) => index + k + 1));
      this.slider.value = String(index);
    }
    loaded.plots.setTime(times[index]);
    this.showGauges();
    const relative = times[index] - event.onset_s;
    const base = this.analysis?.timeBase.label ?? '';
    const text = i18n.t("t = {p1} s from the onset ({p2} {p3} s)", {
      p1: `${relative > 0 ? '+' : ''}${i18n.formatNumber(relative, 1)}`, p2: base, p3: i18n.formatNumber(times[index], 2),
    });
    this.readout.textContent = text;
    this.stamp.textContent = i18n.t("{p1} · instant {p2}/{p3}", { p1: `${relative > 0 ? '+' : ''}${i18n.formatNumber(relative, 1)} s`, p2: index + 1, p3: times.length });
  }

  // -- the steps -------------------------------------------------------------------

  private renderSteps(analysis: AnalysisManifest): void {
    const titles = STEP_TITLES();
    const buttons = STEP_IDS.map((step, n) => {
      const own = analysis.steps?.[step]?.title;
      const label = own ? localText(own) : titles[step];
      return h('button', {
        type: 'button', class: `flame-analysis__step${step === 'limitations' ? ' flame-analysis__step--about' : ''}`,
        'aria-expanded': 'false', 'aria-controls': 'flame-analysis-drawer', dataset: { step },
        onclick: () => this.toggleStep(step),
      }, [step === 'limitations' ? h('span', { 'aria-hidden': 'true' }, ['ⓘ ']) : h('span', { class: 'flame-analysis__step-n', 'aria-hidden': 'true' }, [String(n + 1)]), label]);
    });
    this.steps.replaceChildren(...buttons);
  }

  private toggleStep(step: StepId): void {
    if (this.drawerStep === step) { this.closeDrawer(); return; }
    const analysis = this.analysis, loaded = this.loaded;
    if (!analysis || !loaded) return;
    this.drawerStep = step;
    const entry = analysis.steps?.[step];
    const note = loaded.event.notes?.[step];
    const title = entry?.title ? localText(entry.title) : STEP_TITLES()[step];
    this.drawer.replaceChildren(
      h('div', { class: 'flame-analysis__drawer-bar' }, [
        h('h2', { id: 'flame-analysis-drawer-title' }, [title]),
        h('button', { type: 'button', class: 'btn btn--small', onclick: () => this.closeDrawer() }, [i18n.t("Close")]),
      ]),
      h('p', {}, [entry ? localText(entry.text) : i18n.t("This analysis folder has no explanation for this step.")]),
      ...(entry?.watchFor ? [h('h3', {}, [i18n.t("Watch for")]), h('p', {}, [localText(entry.watchFor)])] : []),
      ...(note ? [h('h3', {}, [i18n.t("In this event")]), h('p', {}, [localText(note)])] : []),
    );
    this.drawer.setAttribute('aria-labelledby', 'flame-analysis-drawer-title');
    this.drawer.hidden = false;
    for (const button of this.steps.querySelectorAll<HTMLButtonElement>('button')) {
      button.setAttribute('aria-expanded', String(button.dataset.step === step));
    }
    const target = STEP_TARGET[step];
    // A step about a plot shows the plots it explains.
    if ((target === 'size' || target === 'hrr') && !this.plotsShown) this.setPlotsShown(true);
    // Over the plots for a step about the pictures or the 3-D view, over those for one
    // about a plot; without plots, over the panel the step is not about.
    this.drawer.classList.toggle('flame-analysis__drawer--left',
      this.plotsShown ? target === 'size' || target === 'hrr' : target === 'scene');
    this.body.querySelectorAll('[data-target], [data-plot]').forEach((el) => el.classList.remove('flame-analysis--pointed'));
    if (target === 'cameras' || target === 'scene') this.body.querySelector(`[data-target="${target}"]`)?.classList.add('flame-analysis--pointed');
    else if (target) loaded.plots.section(target === 'size' ? 'volume' : target)?.classList.add('flame-analysis--pointed');
    if (target === 'size') loaded.plots.section('area')?.classList.add('flame-analysis--pointed');
    if (step === 'segmentation') this.setOutlines(true);
    this.drawer.focus();
  }

  private closeDrawer(): void {
    if (!this.drawerStep) { this.drawer.hidden = true; return; }
    const step = this.drawerStep;
    this.drawerStep = null;
    this.drawer.hidden = true;
    this.body.querySelectorAll('.flame-analysis--pointed').forEach((el) => el.classList.remove('flame-analysis--pointed'));
    for (const button of this.steps.querySelectorAll<HTMLButtonElement>('button')) button.setAttribute('aria-expanded', 'false');
    this.steps.querySelector<HTMLButtonElement>(`[data-step="${step}"]`)?.focus();
  }

  // -- full resolution ---------------------------------------------------------------

  private async openZoom(cam: string): Promise<void> {
    const loaded = this.loaded, source = this.source;
    // One panel over the board at a time: not behind the export, and one picture.
    if (!loaded || !source || this.index < 0 || this.exportPanel) return;
    this.closeZoom();
    this.playhead.pause();
    const { event, folder } = loaded;
    this.zoomFocus = this.body.querySelector<HTMLElement>(`.flame-analysis__tile-open[data-camera="${cam}"]`) ?? undefined;
    const index = this.index;
    const canvas = h('canvas', { class: 'flame-analysis__zoom-picture', width: 0, height: 0, role: 'img', 'aria-label': this.cameraLabel(cam) });
    const close = h('button', { type: 'button', class: 'btn', onclick: () => this.closeZoom() }, [i18n.t("Close")]);
    const note = h('p', { class: 'flame-analysis__note', role: 'status' }, [i18n.t("Reading the full-resolution picture…")]);
    this.zoom = h('div', { class: 'flame-analysis__zoom', role: 'dialog', 'aria-modal': 'true', 'aria-label': this.cameraLabel(cam) }, [
      h('div', { class: 'flame-analysis__drawer-bar' }, [h('h2', {}, [this.cameraLabel(cam)]), this.readout.cloneNode(true), close]),
      note, canvas,
    ]);
    this.dialog.append(this.zoom);
    // A dialog over the board, like the export panel: the board behind is out of reach.
    this.zoomRestore = this.holdBoard(this.zoom);
    close.focus();
    try {
      const template = event.files.frame ?? event.files.display;
      const blob = await source.blob(joinPath(folder, fillTemplate(template, cam, event.instants.stem[index])));
      const bitmap = await createImageBitmap(blob);
      if (!this.zoom?.contains(canvas)) { bitmap.close(); return; }
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const image = event.images[cam];
      if (this.hullCheck) {
        const projection = this.hullProjection(cam, index);
        if (projection) drawHull(ctx, projection, { ...placement(image, 'whole'), scale: bitmap.width / image.size_px[0] });
      }
      if (this.outlinesShown) drawOutline(ctx, loaded.outlines.get(cam)?.[index] ?? [], { ...placement(image, 'whole'), scale: bitmap.width / image.size_px[0] }, 1, Math.max(2, bitmap.width / 800));
      bitmap.close();
      note.textContent = event.files.frame ? '' : i18n.t("This folder has no full-resolution pictures; the display copy is shown.");
    } catch (error) {
      note.textContent = (error as Error).message;
    }
  }

  private closeZoom(): void {
    if (!this.zoom) return;
    this.zoom.remove();
    this.zoom = undefined;
    this.zoomRestore?.();
    this.zoomRestore = undefined;
    this.zoomFocus?.focus();
    this.zoomFocus = undefined;
  }
}
