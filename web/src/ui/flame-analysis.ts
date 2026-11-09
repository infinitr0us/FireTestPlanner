/**
 * The flame analysis board: a read-only workspace that walks an engineer through
 * one processed fire event filmed by several calibrated cameras (design:
 * docs/flame-analysis-board-design.md; format: CONVENTIONS.md section 13).
 *
 * Like the FDS results workspace it owns its scene, clock and file session and
 * never touches the plan open in the editor. What it says about how the data were
 * made comes from the analysis folder, never from this code.
 */

import { FlameSequence, parseFrameData, type RawFrame } from '../core/flame';
import {
  centredMean, fillTemplate, folderOf, instantAt, joinPath, keyNumbers, localText,
  parseAnalysisManifest, parseEventManifest, parseOutlines, parseSeriesCsv, STEP_IDS,
  type AnalysisManifest, type EventManifest, type KeyNumbers, type Series, type StepId,
} from '../core/flame-analysis';
import { cameras as planCameras, displayName } from '../core/plan';
import type { CameraObject, LengthUnit, PlanDocument } from '../core/types';
import { parseAndValidatePlan } from '../core/validate';
import { openShellAnalysis, saveMedia, shell } from '../io/files';
import {
  pickedAnalysisSource, readText, shellAnalysisSource, type AnalysisSource,
} from '../io/flame-analysis-source';
import { AnalysisScene, type SceneView } from '../scene/flame-analysis';
import { ANALYSIS_DEFAULT_SPEED, ANALYSIS_SPEEDS, Playhead } from '../state/playhead';
import { h } from './dom';
import { CameraTiles, drawOutline, placement, type PictureMode } from './flame-analysis-cameras';
import { AnalysisPlots, type Band, type Moment, type PlotLine, type PlotSpec } from './flame-analysis-plots';
import {
  Composer, encodePng, encodeVideo, VIDEO_FPS, videoFrames, type VideoLayout, type VideoOptions,
} from './flame-analysis-video';
import * as i18n from './i18n';
import { fmt } from './plot-svg';
import { handleTransportKey, setTransportPlaying, transportButton } from './transport';

const IMPERIAL = new Set<LengthUnit>(['ft', 'ft-in', 'in']);
const PREFETCH = 8;
const READ_CONCURRENCY = 8;

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

interface LoadedEvent {
  event: EventManifest;
  folder: string;
  series: Map<string, Series>;
  outlines: Map<string, Float32Array[][]>;
  sequence: FlameSequence | null;
  numbers: KeyNumbers;
  tiles: CameraTiles;
  plots: AnalysisPlots;
  /** What the plots draw, for the video and PNG composition. */
  plotData: { specs: PlotSpec[]; bands: Band[]; moments: Moment[]; window: [number, number] };
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
  private source?: AnalysisSource;
  private analysis?: AnalysisManifest;
  private plan?: PlanDocument;
  private loaded?: LoadedEvent;
  private scene?: AnalysisScene;
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
  private exportPanel?: HTMLElement;
  private exportAbort?: () => void;
  /** The last video the export panel made (for hosts and tests). */
  lastVideo?: Blob;
  private focusBefore?: HTMLElement;
  private outlinesShown = false;

  constructor(private onOpenChange: (open: boolean) => void = () => {}, private options: FlameAnalysisOptions = {}) {
    this.dialog.append(
      h('header', { class: 'flame-analysis__header' }, [
        this.title,
        h('label', { class: 'flame-analysis__event' }, [i18n.t("Event"), this.eventSelect]),
        this.readout,
        h('button', { type: 'button', class: 'btn', onclick: () => this.close() }, [i18n.t("Back to plan")]),
      ]),
      this.body,
    );
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (this.exportPanel) this.closeExport();
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
        if (this.exportPanel) this.closeExport();
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
    this.tick(performance.now());
  }

  close(): void {
    if (!this.isOpen) return;
    this.closeExport();
    this.playhead.pause();
    cancelAnimationFrame(this.raf);
    this.dialog.close();
    this.dialog.remove();
    this.onOpenChange(false);
    this.focusBefore?.focus();
  }

  /** Release everything: the session, the scene and its pictures. */
  dispose(): void {
    this.close();
    ++this.epoch;
    this.loaded?.tiles.dispose();
    this.scene?.dispose();
    this.source?.close();
  }

  private welcome(message = ''): void {
    this.title.textContent = i18n.t("Flame analysis");
    this.eventSelect.parentElement!.hidden = true;
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

  private async choose(): Promise<void> {
    const epoch = ++this.epoch;
    try {
      if (shell()) {
        const opened = await openShellAnalysis();
        if (!opened || epoch !== this.epoch) return;
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
      if (!files.length || epoch !== this.epoch) return;
      await this.load(pickedAnalysisSource(files));
    } catch (error) {
      if (epoch === this.epoch) this.setStatus((error as Error).message, 'error');
    }
  }

  /** Open a folder. Public so tests and hosts can hand over a source directly. */
  async load(source: AnalysisSource): Promise<void> {
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
      await this.selectEvent(analysis.events[0].id);
    } catch (error) {
      if (epoch === this.epoch) this.welcome((error as Error).message);
    }
  }

  private unloadEvent(): void {
    this.loaded?.tiles.dispose();
    this.loaded?.plots.dispose();
    this.loaded = undefined;
    this.index = -1;
    this.closeZoom();
  }

  async selectEvent(id: string): Promise<void> {
    const analysis = this.analysis, source = this.source, plan = this.plan;
    if (!analysis || !source || !plan) return;
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
      for (const cam of event.cameras) {
        const file = joinPath(folder, fillTemplate(event.files.outlines, cam));
        outlines.set(cam, parseOutlines(await textOf(file), cam, event.instants.t_s.length, file));
      }
      const sequence = await this.readHull(source, event, folder, epoch);
      if (epoch !== this.epoch) return;
      this.setStatus('');
      this.build(analysis, plan, event, folder, series, outlines, sequence, source);
    } catch (error) {
      if (epoch === this.epoch) this.welcome((error as Error).message);
    }
  }

  private async readHull(source: AnalysisSource, event: EventManifest, folder: string, epoch: number): Promise<FlameSequence | null> {
    const { t_s, stem } = event.instants;
    const raw: RawFrame[] = new Array(t_s.length);
    let next = 0, done = 0;
    const worker = async (): Promise<void> => {
      while (next < t_s.length && epoch === this.epoch) {
        const i = next++;
        const file = joinPath(folder, fillTemplate(event.files.hull, undefined, stem[i]));
        raw[i] = await parseFrameData(file, await source.read(file), t_s[i]);
        done += 1;
        if (done % 20 === 0 || done === t_s.length) this.setStatus(i18n.t("Reading the 3-D flame… {p1} of {p2} instants", { p1: done, p2: t_s.length }));
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
    const { plots, plotData } = this.makePlots(event, series);
    this.loaded = { event, folder, series, outlines, sequence, numbers, tiles, plots, plotData };

    const sceneHost = h('div', { class: 'flame-analysis__scene-host' });
    const viewButtons = (['site', 'flame'] as SceneView[]).map((view) => h('button', {
      type: 'button', class: 'btn flame-analysis__toggle', 'aria-pressed': String(view === this.sceneView),
      onclick: () => this.setSceneView(view),
    }, [view === 'site' ? i18n.t("Whole site") : i18n.t("Flame close-up")]));
    const pictureButtons = (['closeup', 'whole'] as PictureMode[]).map((mode) => h('button', {
      type: 'button', class: 'btn flame-analysis__toggle', 'aria-pressed': String(mode === tiles.pictureMode),
      disabled: mode === 'closeup' && !tiles.hasCloseups,
      onclick: () => {
        tiles.setMode(mode);
        pictureButtons.forEach((b, k) => b.setAttribute('aria-pressed', String((['closeup', 'whole'] as PictureMode[])[k] === tiles.pictureMode)));
      },
    }, [mode === 'closeup' ? i18n.t("Close-up") : i18n.t("Whole picture")]));
    const outlineToggle = h('button', {
      type: 'button', class: 'btn flame-analysis__toggle flame-analysis__outline-toggle', 'aria-pressed': String(this.outlinesShown),
      onclick: () => this.setOutlines(!this.outlinesShown),
    }, [i18n.t("Flame outline")]);
    tiles.setOutlines(this.outlinesShown);

    const cameraPanel = h('section', { class: 'flame-analysis__panel flame-analysis__cameras', dataset: { target: 'cameras' }, 'aria-label': i18n.t("Camera pictures") }, [
      h('div', { class: 'flame-analysis__panel-bar' }, [
        h('h2', {}, [i18n.t("Cameras")]),
        h('div', { class: 'flame-analysis__group', role: 'group', 'aria-label': i18n.t("Picture") }, pictureButtons),
        outlineToggle,
      ]),
      tiles.element,
    ]);
    const scenePanel = h('section', { class: 'flame-analysis__panel flame-analysis__scene', dataset: { target: 'scene' }, 'aria-label': i18n.t("3-D view") }, [
      h('div', { class: 'flame-analysis__panel-bar' }, [
        h('h2', {}, [i18n.t("3-D flame in the site")]),
        h('div', { class: 'flame-analysis__group', role: 'group', 'aria-label': i18n.t("3-D view") }, viewButtons),
      ]),
      sceneHost,
      sequence ? null : h('p', { class: 'flame-analysis__note' }, [i18n.t("This event has no 3-D flame at any instant.")]),
    ]);
    const plotPanel = h('section', { class: 'flame-analysis__panel flame-analysis__charts', 'aria-label': i18n.t("Plots") }, [plots.element]);
    const main = h('div', { class: 'flame-analysis__main' }, [
      h('div', { class: 'flame-analysis__left' }, [cameraPanel, scenePanel]),
      plotPanel,
      this.drawer,
    ]);
    this.renderSteps(analysis);
    this.body.replaceChildren(
      this.steps,
      this.numbersRow(numbers, event),
      main,
      this.transport(event),
      this.status,
    );

    if (!this.scene) {
      this.scene = new AnalysisScene(sceneHost);
      this.scene.setSite(plan, new Map(analysis.cameras.map((c) => [c.planCameraId, this.cameraLabel(c.id)])));
    } else {
      this.scene.attach(sceneHost);
    }
    this.scene.setFlame(sequence, this.planCamera(event.cameras[0]));
    this.setSceneView(this.sceneView, viewButtons);

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

  private setOutlines(shown: boolean): void {
    this.outlinesShown = shown;
    this.loaded?.tiles.setOutlines(shown);
    this.body.querySelector('.flame-analysis__outline-toggle')?.setAttribute('aria-pressed', String(shown));
  }

  private setSceneView(view: SceneView, buttons?: HTMLButtonElement[]): void {
    this.sceneView = view;
    this.scene?.setView(view);
    const list = buttons ?? [...this.body.querySelectorAll<HTMLButtonElement>('.flame-analysis__scene .flame-analysis__toggle')];
    list.forEach((b, k) => b.setAttribute('aria-pressed', String((['site', 'flame'] as SceneView[])[k] === view)));
  }

  private units(): { volume: [number, string]; area: [number, string]; height: [number, string] } {
    const unit = this.options.lengthUnit?.() ?? 'm';
    return IMPERIAL.has(unit)
      ? { volume: [35.3146667, 'ft³'], area: [10.7639104, 'ft²'], height: [1 / 0.3048, 'ft'] }
      : { volume: [1000, 'L'], area: [1, 'm²'], height: [1, 'm'] };
  }

  private makePlots(event: EventManifest, series: Map<string, Series>): { plots: AnalysisPlots; plotData: LoadedEvent['plotData'] } {
    const units = this.units();
    const line = (id: string, role: PlotLine['role'], nth: number, extra: Partial<PlotLine> = {}): PlotLine => {
      const s = event.series.find((x) => x.id === id)!;
      const data = series.get(id)!;
      return { label: localText(s.label), t: data.t, v: data.v, role, nth, ...extra };
    };
    const plots: PlotSpec[] = [];
    const hrr = event.series.filter((s) => s.quantity === 'hrr');
    if (hrr.length) {
      const bases = new Set(hrr.map((s) => s.basis));
      const basis = bases.size === 1 && hrr[0].basis ? hrr[0].basis : null;
      const lines: PlotLine[] = [];
      let nEstimated = 0;
      for (const s of [...hrr.filter((x) => x.role === 'measured'), ...hrr.filter((x) => x.role !== 'measured')]) {
        lines.push(line(s.id, s.role === 'estimated' ? 'estimated' : 'measured', s.role === 'estimated' ? nEstimated++ : 0));
      }
      plots.push({
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
    if (height) plots.push({ id: 'height', title: localText(height.label), unit: units.height[1], scale: units.height[0], lines: [line(height.id, 'reconstructed', 0)] });

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
    return {
      plots: new AnalysisPlots(plots, window, event.onset_s, bands, moments, (t) => this.seekTime(t)),
      plotData: { specs: plots, bands, moments, window },
    };
  }

  private numbersRow(numbers: KeyNumbers, event: EventManifest): HTMLElement {
    const units = this.units();
    const window = i18n.t("Between the first and last instant, {p1} s to {p2} s from the onset", {
      p1: fmt(numbers.window[0] - event.onset_s), p2: fmt(numbers.window[1] - event.onset_s),
    });
    const at = (t: number): string => i18n.t("at {p1} s", { p1: `${t - event.onset_s > 0 ? '+' : ''}${fmt(t - event.onset_s)}` });
    const percent = (ratio: number | null): string => {
      if (ratio === null) return '';
      const p = Math.round((ratio - 1) * 100);
      return ` (${p > 0 ? '+' : p < 0 ? '−' : ''}${i18n.formatQuantity(Math.abs(p), '%')})`;
    };
    const quantity = (value: number, unit: string): string => i18n.formatQuantity(Number(value.toPrecision(3)), unit);
    const tile = (label: string, value: string, detail: string, tip: string): HTMLElement =>
      h('div', { class: 'flame-analysis__number', title: tip }, [
        h('span', { class: 'flame-analysis__number-label' }, [label]),
        h('strong', {}, [value]),
        h('span', { class: 'flame-analysis__number-detail' }, [detail]),
      ]);
    const tiles: HTMLElement[] = [];
    const hood = numbers.hood;
    if (hood) {
      tiles.push(tile(i18n.t("Hood peak"), quantity(hood.peak.value, 'kW'), at(hood.peak.t),
        i18n.t("The largest measured heat release rate. {p1}.", { p1: window })));
      tiles.push(tile(i18n.t("Heat released, hood"), quantity(hood.heat_kJ / 1000, 'MJ'), '',
        i18n.t("The measured heat release rate integrated over time. {p1}.", { p1: window })));
    }
    for (const estimate of numbers.estimates) {
      const s = event.series.find((x) => x.id === estimate.id)!;
      tiles.push(tile(localText(s.label),
        `${quantity(estimate.peak.value, 'kW')}${percent(estimate.peakRatio)}`,
        i18n.t("heat {p1}{p2}", { p1: quantity(estimate.heat_kJ / 1000, 'MJ'), p2: percent(estimate.heatRatio) }),
        i18n.t("Peak and heat released of this estimate, and how far each is from the hood's. {p1}.", { p1: window })));
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
    return new Composer({
      title: localText(analysis.title),
      eventLabel: localText(event.label),
      onset: event.onset_s,
      timeBase: analysis.timeBase.label,
      times: event.instants.t_s,
      cameras: event.cameras.map((id) => ({ id, label: this.cameraLabel(id), image: event.images[id] })),
      pictureMode: tiles.pictureMode,
      outlines: tiles.outlinesOn ? loaded.outlines : null,
      outsideFrame: event.quality?.outsideFrame ?? {},
      picture: (camera, index) => tiles.picture(camera, index),
      scene: this.scene ?? null,
      plots: loaded.plotData,
    }, layout, width);
  }

  /** Encode a video of the board; public so tests and hosts can call it directly. */
  async exportVideo(options: VideoOptions, progress: (done: number, total: number) => void = () => {},
    signal?: AbortSignal): Promise<Blob> {
    const composer = this.composer(options.layout, options.width);
    if (!composer || !this.loaded) throw new Error(i18n.t("No event is open."));
    this.playhead.pause();
    try {
      const bytes = await encodeVideo(composer, this.loaded.event.instants.t_s, options, progress, signal);
      return new Blob([bytes as BlobPart], { type: 'video/mp4' });
    } finally {
      this.scene?.setFrame(this.loaded?.sequence ? this.index : -1);
    }
  }

  /** The board at the playback instant as a PNG, in the full-board layout. */
  async exportPng(width: 1920 | 1280 = 1920, layout: VideoLayout = 'board'): Promise<Blob> {
    const composer = this.composer(layout, width);
    if (!composer || this.index < 0) throw new Error(i18n.t("No event is open."));
    return encodePng(composer, this.index);
  }

  private async savePng(): Promise<void> {
    const event = this.loaded?.event;
    if (!event) return;
    const relative = event.instants.t_s[Math.max(this.index, 0)] - event.onset_s;
    const name = `${event.id}_${relative >= 0 ? '+' : '-'}${Math.abs(relative).toFixed(1)}s.png`;
    try {
      const saved = await saveMedia(await this.exportPng(), name, 'png');
      this.setStatus(saved ? i18n.t("Saved {p1}.", { p1: saved }) : '');
    } catch (error) {
      this.setStatus((error as Error).message, 'error');
    }
  }

  private openExport(): void {
    const loaded = this.loaded;
    if (!loaded || this.exportPanel) return;
    this.playhead.pause();
    const { event } = loaded;
    const times = event.instants.t_s;
    const select = (label: string, options: [string, string][], value: string): HTMLSelectElement => {
      const el = h('select', { class: 'field__input', 'aria-label': label },
        options.map(([v, text]) => h('option', { value: v, selected: v === value }, [text])));
      return el;
    };
    const hasPlots = loaded.plotData.specs.length > 0;
    const layout = select(i18n.t("Layout"), [
      ['board', i18n.t("Full board")], ['cameras', i18n.t("Cameras and 3-D")], ...(hasPlots ? [['plots', i18n.t("3-D and plots")] as [string, string]] : []),
    ], 'board');
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
      go.disabled = !valid;
      to.setAttribute('aria-invalid', String(!valid));
      const frames = valid ? videoFrames(times, o).length : 0;
      summary.textContent = valid
        ? i18n.t("{p1} s of video, {p2} frames at {p3} per second, H.264 MP4.", { p1: i18n.formatNumber(frames / VIDEO_FPS, 1), p2: frames, p3: VIDEO_FPS })
        : i18n.t("The end must come after the start.");
    };
    for (const el of [layout, size, from, to, speed]) el.onchange = update;
    let controller: AbortController | null = null;
    go.onclick = async () => {
      const o = options();
      controller = new AbortController();
      go.disabled = true;
      close.textContent = i18n.t("Cancel");
      bar.hidden = false;
      status.classList.remove('flame-analysis__status--error');
      const t0 = performance.now();
      try {
        const blob = await this.exportVideo(o, (done, total) => {
          bar.value = done / total;
          status.textContent = i18n.t("Encoding frame {p1} of {p2}…", { p1: done, p2: total });
        }, controller.signal);
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
        go.disabled = false;
        close.textContent = i18n.t("Close");
        bar.hidden = true;
      }
    };
    close.onclick = () => { if (controller) controller.abort(); else this.closeExport(); };
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
    update();
    layout.focus();
  }

  private closeExport(): void {
    if (!this.exportPanel) return;
    this.exportAbort?.();
    this.exportPanel.remove();
    this.exportPanel = undefined;
    this.exportAbort = undefined;
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
    // Over the plots for a step about the pictures or the 3-D view, over those for one about a plot.
    this.drawer.classList.toggle('flame-analysis__drawer--left', target === 'size' || target === 'hrr');
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
    if (!loaded || !source || this.index < 0) return;
    this.playhead.pause();
    const { event, folder } = loaded;
    const index = this.index;
    const canvas = h('canvas', { class: 'flame-analysis__zoom-picture', width: 0, height: 0, role: 'img', 'aria-label': this.cameraLabel(cam) });
    const close = h('button', { type: 'button', class: 'btn', onclick: () => this.closeZoom() }, [i18n.t("Close")]);
    const note = h('p', { class: 'flame-analysis__note', role: 'status' }, [i18n.t("Reading the full-resolution picture…")]);
    this.zoom = h('div', { class: 'flame-analysis__zoom', role: 'dialog', 'aria-modal': 'true', 'aria-label': this.cameraLabel(cam) }, [
      h('div', { class: 'flame-analysis__drawer-bar' }, [h('h2', {}, [this.cameraLabel(cam)]), this.readout.cloneNode(true), close]),
      note, canvas,
    ]);
    this.dialog.append(this.zoom);
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
    this.body.querySelector<HTMLElement>('.flame-analysis__tile-open')?.focus();
  }
}
