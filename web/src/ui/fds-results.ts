import * as i18n from './i18n';
import {
  parseSmv,
  parseResultCsv,
  ResultReader,
  resultText,
  type ResultDevice,
  type ResultCase,
  type ResultField,
  type ResultSeries,
  type ResultSource,
} from '../core/fds-results';
import { browserResultsSource, desktopResultsSource } from '../io/fds-results-source';
import { openShellResults, saveResultPng, shell } from '../io/files';
import { FdsResultScene, resultRampRgb } from '../scene/fds-results';
import { h } from './dom';
import { deviceHistory } from '../core/fds-devices';
import { rangeOf } from '../core/math';
import { FdsDevicePanel } from './fds-devices';
import { SPEEDS } from '../state/playhead';
import { handleTransportKey, setTransportPlaying, transportButton } from './transport';
import { visualTheme } from './theme';

interface Dataset {
  label: string;
  fields: ResultField[];
}
const button = (text: string, action: () => void) => h('button', { type: 'button', onclick: action }, [text]);
/** A time in seconds: up to three decimals, so nearby output frames stay distinct
 *  (docs/visual-language.md, Playback). */
const numeric = (n: number): string =>
  Number.isFinite(n) ? n.toLocaleString(i18n.language() === 'fr' ? 'fr-CA' : undefined, { maximumFractionDigits: 3 }) : '—';
/**
 * A measured value: four significant figures, and exponent notation below 0.01 or
 * from a million. Three fixed decimals printed a soot density of 3.1e-5 kg/m3 and a
 * CO fraction of 4.2e-4 as "0 — 0" in the legend, the history axes and the PNG
 * caption, while the scale boxes held the real numbers.
 */
export const measured = (n: number): string => {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  if (abs < 0.01 || abs >= 1e6) return i18n.numberText(n.toExponential(2).replace('e+', 'e'));
  return n.toLocaleString(i18n.language() === 'fr' ? 'fr-CA' : undefined, { maximumSignificantDigits: 4 });
};
const pathOf = (f: File) => f.webkitRelativePath || f.name;

/** A modal results workspace owns its own scene, clock and file session. It never
 * touches the plan store or the planning correlation / reconstruction clocks. */
export class FdsResultsDialog {
  private dialog = h('dialog', { class: 'fds-results', get 'aria-label'() { return i18n.t("FDS simulation results"); } });
  private body = h('div', { class: 'fds-results__body' });
  private title = h('strong', {}, [i18n.t("FDS simulation results")]);
  private status = h('div', { class: 'fds-results__status', role: 'status' });
  private scene?: FdsResultScene;
  private source?: ResultSource;
  private data?: ResultCase;
  private datasets: Dataset[] = [];
  private readers: ResultReader[] = [];
  private series: ResultSeries[] = [];
  private selectedSeries?: ResultSeries;
  private deviceSeries: ResultSeries[] = [];
  private selectedDevice?: ResultDevice;
  private devicePanel?: FdsDevicePanel;
  private epoch = 0;
  private frameRequest = 0;
  private busy = false;
  private pending: number | null = null;
  private playing = false;
  private playbackRequest = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private time = 0;
  private currentIndex = 0;
  private speed = 10;
  private loop = false;
  private low = 0;
  private high = 100;
  private opacity = 0.9;
  private selection = h('select', { get 'aria-label'() { return i18n.t("Result dataset"); } });
  private meshSelection = h('select', { get 'aria-label'() { return i18n.t("Result mesh"); } });
  private slider = h('input', {
    type: 'range',
    min: 0,
    max: 0,
    step: 1,
    value: 0,
    get 'aria-label'() { return i18n.t("Simulation frame"); },
  });
  private play = transportButton('play', () => this.togglePlay());
  private first = transportButton('first', () => this.seek(0));
  private previous = transportButton('previous', () => this.seek(this.currentIndex - 1));
  private next = transportButton('next', () => this.seek(this.currentIndex + 1));
  private last = transportButton('last', () => this.seek((this.readers[0]?.count ?? 1) - 1));
  private stamp = h('output', { 'aria-live': 'off' });
  private rangeLow = h('input', {
    type: 'number',
    value: 0,
    step: 'any',
    get 'aria-label'() { return i18n.t("Color scale minimum"); },
  });
  private rangeHigh = h('input', {
    type: 'number',
    value: 100,
    step: 'any',
    get 'aria-label'() { return i18n.t("Color scale maximum"); },
  });
  private autoScaleButton = button(i18n.t("Scale to this frame"), () => {
    void this.autoScale();
  });
  private legend = h('div', { class: 'fds-results__legend' });
  private graph = h('canvas', {
    width: 600,
    height: 240,
    class: 'fds-results__graph',
    get 'aria-label'() { return i18n.t("Selected result history"); },
  });
  private readout = h('div', { class: 'fds-results__reading' });
  private historySelect = h('select', { get 'aria-label'() { return i18n.t("Device or heat release history"); } });
  private info = h('div', { class: 'fds-results__info' });
  private fieldNote = h('div', { class: 'fds-results__note' });
  private boundaryCoverage = h('p', { class: 'fds-results__warning' });
  private coverage?: HTMLDetailsElement;
  private focusBefore?: HTMLElement;
  private theme = visualTheme();

  constructor(private onOpenChange: (open: boolean) => void = () => {}) {
    this.dialog.append(h('header', {}, [this.title, button(i18n.t("Back to plan"), () => this.close())]), this.body);
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.close();
    });
    this.dialog.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (!this.slider.disabled)
        handleTransportKey(
          e,
          {
            play: () => this.togglePlay(),
            previous: () => this.seek(this.currentIndex - 1),
            next: () => this.seek(this.currentIndex + 1),
            first: () => this.seek(0),
            last: () => this.seek((this.readers[0]?.count ?? 1) - 1),
          },
          this.slider
        );
    });
    this.selection.onchange = () => {
      void this.loadDataset();
    };
    this.meshSelection.onchange = () => {
      void this.loadDataset();
    };
    this.slider.oninput = () => {
      this.seek(Number(this.slider.value));
    };
    this.historySelect.onchange = () => {
      this.selectedSeries =
        this.historySelect.value === '' ? undefined : this.series[Number(this.historySelect.value)];
      this.selectedDevice = this.deviceSeries.includes(this.selectedSeries!)
        ? this.data?.devices.find((d) => deviceHistory(d, this.deviceSeries) === this.selectedSeries)
        : undefined;
      this.devicePanel?.selectDevice(this.selectedDevice, true);
      this.scene?.devices.setSelected(this.selectedDevice);
      this.drawHistory();
    };
    const scale = () => {
      const low = this.rangeLow.valueAsNumber,
        high = this.rangeHigh.valueAsNumber;
      if (!Number.isFinite(low) || !Number.isFinite(high) || low >= high) {
        this.rangeLow.setAttribute('aria-invalid', 'true');
        this.rangeHigh.setAttribute('aria-invalid', 'true');
        this.setStatus(i18n.t('Color scale needs finite minimum < maximum.'), 'error');
        return;
      }
      this.rangeLow.removeAttribute('aria-invalid');
      this.rangeHigh.removeAttribute('aria-invalid');
      this.low = low;
      this.high = high;
      this.requestFrame(this.currentIndex);
    };
    this.rangeLow.onchange = scale;
    this.rangeHigh.onchange = scale;
  }
  get isOpen(): boolean {
    return this.dialog.open;
  }
  open(): void {
    if (this.isOpen) return;
    this.focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    document.body.append(this.dialog);
    this.dialog.showModal();
    this.onOpenChange(true);
    this.welcome();
  }
  private welcome(message = ''): void {
    this.title.textContent = i18n.t("FDS simulation results");
    this.body.replaceChildren(
      h('div', { class: 'fds-results__welcome' }, [
        h('h2', {}, [i18n.t("Replay an FDS simulation")]),
        h('p', {}, [
          i18n.t("Open the simulation output folder containing its .smv metadata and associated result files. Files are read locally as you move through time."),
        ]),
        button(shell() ? i18n.t("Open .smv file…") : i18n.t("Choose results folder…"), () => {
          void this.choose();
        }),
        h('p', { class: 'fds-results__note' }, [
          i18n.t("Recorded slices · wall fields · smoke/fire preview · sensor and heat-release histories"),
        ]),
        h('p', { class: 'fds-results__note' }, [
          i18n.t("Your test plan stays open. Results are a separate session and are not saved in the plan or its shared HTML."),
        ]),
        this.status,
      ])
    );
    this.setStatus(message, message ? 'error' : 'info');
  }
  private async choose(): Promise<void> {
    const epoch = ++this.epoch;
    try {
      if (shell()) {
        const opened = await openShellResults();
        if (!opened) return;
        const source = desktopResultsSource(opened);
        if (!this.isOpen || epoch !== this.epoch) {
          source.close?.();
          return;
        }
        await this.load(source, opened.smv);
        return;
      }
      const input = h('input', { type: 'file', multiple: true, hidden: true });
      input.setAttribute('webkitdirectory', '');
      this.dialog.append(input);
      const files = await new Promise<File[]>((resolve) => {
        input.onchange = () => {
          resolve(Array.from(input.files ?? []));
          input.remove();
        };
        input.addEventListener(
          'cancel',
          () => {
            resolve([]);
            input.remove();
          },
          { once: true }
        );
        input.click();
      });
      if (!this.isOpen || epoch !== this.epoch || !files.length) return;
      const smvs = files.filter((f) => f.name.toLowerCase().endsWith('.smv'));
      if (!smvs.length) throw new Error(i18n.t("No .smv metadata file found in the selected folder."));
      if (smvs.length === 1) await this.load(browserResultsSource(files, pathOf(smvs[0])), smvs[0].name);
      else {
        const select = h(
          'select',
          { 'aria-label': i18n.t("Simulation metadata file") },
          smvs.map((f) => h('option', { value: pathOf(f) }, [pathOf(f)]))
        );
        this.body.replaceChildren(
          h('div', { class: 'fds-results__welcome' }, [
            h('p', {}, [i18n.t("Select the simulation to open.")]),
            select,
            button(i18n.t("Open simulation"), () => {
              const path = select.value;
              void this.load(browserResultsSource(files, path), path.split('/').pop()!);
            }),
            this.status,
          ])
        );
      }
    } catch (error) {
      if (this.isOpen && epoch === this.epoch) this.setStatus((error as Error).message, 'error');
    }
  }
  /** Public for integration hosts that already have explicit file handles. */
  async load(source: ResultSource, smvName: string): Promise<void> {
    this.pause();
    const epoch = ++this.epoch;
    ++this.frameRequest;
    this.source?.close?.();
    this.source = source;
    this.scene?.dispose();
    this.scene = undefined;
    this.deviceSeries = [];
    this.selectedDevice = undefined;
    this.devicePanel = undefined;
    this.data = undefined;
    this.readers = [];
    this.datasets = [];
    this.series = [];
    this.selectedSeries = undefined;
    this.time = 0;
    this.currentIndex = 0;
    this.coverage = undefined;
    this.boundaryCoverage.textContent = '';
    this.busy = false;
    this.pending = null;
    this.setTransportEnabled(false);
    this.stamp.textContent = '';
    this.legend.replaceChildren();
    this.fieldNote.textContent = '';
    this.setStatus(i18n.t("Reading simulation metadata…"));
    this.body.replaceChildren(h('div', { class: 'fds-results__welcome' }, [this.status]));
    try {
      const data = parseSmv(await resultText(source, smvName));
      if (!this.isOpen || epoch !== this.epoch) return;
      this.data = data;
      this.title.textContent = i18n.t("FDS results · {p1}", { p1: data.chid || smvName });
      const missing = data.fields.filter((f) => !source.files.has(f.file));
      for (const f of missing) data.warnings.push(i18n.t("Missing: {p1}", { p1: f.file }));
      const groups = new Map<string, Dataset>();
      for (const field of data.fields.filter((f) => source.files.has(f.file))) {
        const plane = field.kind === 'slice' ? i18n.t(" · request {p1}", { p1: field.plane ?? 'all' }) : '';
        const label = `${field.kind === 'slice' ? i18n.t("Slice") : field.kind === 'boundary' ? i18n.t("Wall") : i18n.t("3D preview")} · ${field.quantity}${plane}`;
        const key = `${label}/${field.unit}`;
        if (!groups.has(key)) groups.set(key, { label, fields: [] });
        groups.get(key)!.fields.push(field);
      }
      this.datasets = [...groups.values()].sort(
        (a, b) =>
          ({ slice: 0, boundary: 1, smoke: 2 })[a.fields[0].kind] -
          { slice: 0, boundary: 1, smoke: 2 }[b.fields[0].kind]
      );
      this.selection.replaceChildren(...this.datasets.map((d, i) => h('option', { value: i }, [d.label])));
      this.meshSelection.replaceChildren(
        h('option', { value: 'all' }, [i18n.t("All recorded meshes")]),
        ...data.meshes.map((m, i) => h('option', { value: i }, [`${i + 1} · ${m.id}`]))
      );
      const view = h('div', { class: 'fds-results__view' });
      const speed = h(
        'select',
        {
          'aria-label': i18n.t("Playback speed"),
          onchange: (e: Event) => {
            this.speed = Number((e.target as HTMLSelectElement).value);
            if (this.playing && !this.busy) void this.scheduleNext(this.epoch, this.frameRequest);
          },
        },
        SPEEDS.map((n) => h('option', { value: n, selected: n === this.speed }, ['×' + n]))
      );
      const loop = h('label', { class: 'playback-bar__loop', title: i18n.t("Start over at the end") }, [
        h('input', {
          type: 'checkbox',
          checked: this.loop,
          onchange: (e: Event) => {
            this.loop = (e.target as HTMLInputElement).checked;
            if (this.playing && !this.busy) void this.scheduleNext(this.epoch, this.frameRequest);
          },
        }),
        i18n.t("Loop"),
      ]);
      const opacity = h('input', {
        type: 'range',
        min: 0.05,
        max: 1,
        step: 0.05,
        value: this.opacity,
        'aria-label': i18n.t("Field opacity"),
        oninput: (e: Event) => {
          this.opacity = Number((e.target as HTMLInputElement).value);
          this.requestFrame(this.currentIndex);
        },
      });
      const cutHeight = h('input', {
        type: 'number',
        step: 0.1,
        value: 2,
        'aria-label': i18n.t("Cutaway height in metres"),
      });
      const cut = h('input', { type: 'checkbox' });
      const applyCut = () => {
        if (!cut.checked) this.scene?.setCutaway();
        else if (Number.isFinite(cutHeight.valueAsNumber)) this.scene?.setCutaway(cutHeight.valueAsNumber);
      };
      cut.onchange = applyCut;
      cutHeight.oninput = applyCut;
      const warnings = h('details', { class: 'fds-results__warnings' }, [
        h('summary', { class: data.warnings.length ? 'fds-results__warning' : '' }, [
          i18n.t("Coverage and limitations"),
        ]),
        h('p', {}, [
          i18n.t("Structured 2D slices and obstruction boundary fields; original FDS coordinates in metres. 3D smoke/fire is a quantized preview. Particle, isosurface, Plot3D, unstructured and Smokezip output are not displayed."),
        ]),
        h('p', {}, [
          i18n.t("Results are external to the plan. Reopen the folder for a new session. Use Smokeview for unsupported output and reference comparisons."),
        ]),
        h('p', {}, [
          i18n.t("Mesh-boundary patches (obstruction index 0) are not displayed. These may contain recorded floor or wall results. Select a boundary field for omitted-patch counts."),
        ]),
        this.boundaryCoverage,
        ...data.warnings.map((w) => h('p', { class: 'fds-results__warning' }, [w])),
      ]);
      this.coverage = warnings;
      if (data.warnings.length) warnings.open = true;
      this.info.textContent = i18n.t("{p1} · {p2} meshes · {p3}/{p4} field files available", { p1: data.version, p2: data.meshes.length, p3: data.fields.length - missing.length, p4: data.fields.length });
      this.devicePanel = new FdsDevicePanel(
        data.devices,
        (device) => this.selectDevice(device),
        (display) => this.scene?.devices.setDisplay(display)
      );
      this.body.replaceChildren(
        h('aside', { class: 'fds-results__sidebar' }, [
          h('div', { class: 'fds-results__title' }, [data.title]),
          this.info,
          h('label', {}, [i18n.t("Recorded field"), this.selection]),
          h('label', {}, [i18n.t("Mesh coverage"), this.meshSelection]),
          this.fieldNote,
          this.legend,
          h('div', { class: 'fds-results__scale' }, [
            h('label', {}, [i18n.t("Min"), this.rangeLow]),
            h('label', {}, [i18n.t("Max"), this.rangeHigh]),
          ]),
          this.autoScaleButton,
          h('label', {}, [i18n.t("Opacity / smoke density"), opacity]),
          h('div', { class: 'fds-results__cut' }, [
            h('label', { class: 'fds-results__check' }, [cut, i18n.t("Cut away above Z (m)")]),
            cutHeight,
          ]),
          h('hr'),
          this.devicePanel.root,
          h('hr'),
          h('label', {}, [i18n.t("Sensor / heat-release history"), this.historySelect]),
          this.readout,
          this.graph,
          warnings,
          button(i18n.t("Open another simulation…"), () => {
            void this.choose();
          }),
        ]),
        h('section', { class: 'fds-results__main' }, [
          view,
          h('div', { class: 'fds-results__transport' }, [
            this.first,
            this.previous,
            this.play,
            this.next,
            this.last,
            this.slider,
            this.stamp,
            speed,
            loop,
            button(i18n.t("Fit"), () => this.scene?.fit()),
            button('PNG', () => this.snapshot()),
          ]),
          this.status,
        ])
      );
      this.scene = new FdsResultScene(view);
      this.scene.setCase(data);
      this.scene.devices.onPick = (devices) => this.devicePanel?.pick(devices);
      for (const csv of data.csv) {
        try {
          const notes: string[] = [];
          const series = parseResultCsv(await resultText(source, csv.file), (m) => notes.push(m));
          if (epoch === this.epoch) {
            for (const note of notes) warnings.append(h('p', { class: 'fds-results__warning' }, [`${csv.file}: ${note}`]));
          }
          if (epoch !== this.epoch) return;
          this.series.push(...series);
          if (csv.kind === 'devc') this.deviceSeries.push(...series);
        } catch (error) {
          if (epoch === this.epoch)
            warnings.append(
              h('p', { class: 'fds-results__warning' }, [`${csv.file}: ${(error as Error).message}`])
            );
        }
      }
      if (epoch !== this.epoch) return;
      this.historySelect.replaceChildren(
        h('option', { value: '' }, [i18n.t("Choose a history…")]),
        ...this.series.map((s, i) => h('option', { value: i }, [`${s.name} (${s.unit})`]))
      );
      this.historySelect.disabled = !this.series.length;
      if (this.selectedDevice) this.selectDevice(this.selectedDevice);
      else {
        this.selectedSeries = this.series.find((s) => s.name === 'HRR') ?? this.series[0];
        this.historySelect.value = this.selectedSeries
          ? String(this.series.indexOf(this.selectedSeries))
          : '';
        this.drawHistory();
      }
      await this.loadDataset();
    } catch (error) {
      if (epoch === this.epoch && this.isOpen) {
        this.pause();
        this.scene?.dispose();
        this.scene = undefined;
        this.source?.close?.();
        this.source = undefined;
        this.readers = [];
        this.datasets = [];
        this.series = [];
        this.data = undefined;
        this.deviceSeries = [];
        this.selectedSeries = undefined;
        this.selectedDevice = undefined;
        this.devicePanel = undefined;
        this.coverage = undefined;
        this.welcome(i18n.t("Could not open results: {p1}", { p1: (error as Error).message }));
      }
    }
  }
  private async loadDataset(): Promise<void> {
    this.pause();
    const request = ++this.frameRequest,
      epoch = this.epoch;
    this.pending = null;
    this.busy = false;
    this.scene?.clearFields();
    this.boundaryCoverage.textContent = '';
    this.fieldNote.textContent = '';
    this.rangeLow.removeAttribute('aria-invalid');
    this.rangeHigh.removeAttribute('aria-invalid');
    this.readers.forEach((r) => r.clearFrame());
    this.readers = [];
    const dataset = this.datasets[Number(this.selection.value)];
    const fields =
      dataset?.fields.filter(
        (f) => this.meshSelection.value === 'all' || f.mesh === Number(this.meshSelection.value)
      ) ?? [];
    this.setTransportEnabled(false);
    this.autoScaleButton.disabled = this.rangeLow.disabled = this.rangeHigh.disabled = true;
    if (!fields.length || !this.source || !this.data) {
      this.setStatus(i18n.t("No recorded field for this selection. Choose another mesh or dataset."), 'warn');
      return;
    }
    this.setStatus(i18n.t("Opening {p1} field file(s)…", { p1: fields.length }));
    try {
      const readers: ResultReader[] = [];
      // Four concurrent file reads keep both browser memory and local HTTP queues bounded.
      for (let i = 0; i < fields.length; i += 4) {
        const batch = await Promise.all(
          fields
            .slice(i, i + 4)
            .map((f) => new ResultReader(this.source!, f, this.data!.meshes[f.mesh]).init())
        );
        if (epoch !== this.epoch || request !== this.frameRequest) return;
        readers.push(...batch);
      }
      const samples = readers.reduce((n, r) => n + r.patches.reduce((m, p) => m + p.count, 0), 0);
      if (
        samples * (fields[0].kind === 'smoke' ? 1 : 4) > 128 * 1024 * 1024 ||
        (fields[0].kind !== 'smoke' && samples * 6 > 6000000)
      ) {
        throw new Error(i18n.t("This selection exceeds the display memory limit. Choose one mesh."));
      }
      this.readers = readers;
      const field = fields[0];
      const partial = readers.filter((r) => r.incomplete).length;
      this.fieldNote.textContent =
        field.kind === 'smoke'
          ? i18n.t("Quantized 3D preview. Appearance controls do not change physical values. Use slices and wall fields for quantitative readings.")
          : i18n.t("{p1} · {p2} · {p3} mesh file(s). Separate mesh planes retain their recorded positions.", { p1: field.unit, p2: field.cellCentered ? i18n.t("Cell-centered") : i18n.t("Node-centered"), p3: readers.length });
      if (partial) {
        this.fieldNote.textContent += i18n.t(" {p1} file(s) end part-way through a frame (a run stopped mid-write); their complete frames are shown.", { p1: partial });
      }
      if (field.kind === 'boundary') {
        const skipped = readers.reduce(
          (n, reader) => n + reader.patches.filter((p) => p.obstruction === 0).length,
          0
        );
        this.boundaryCoverage.textContent = i18n.t("Selected boundary field: {p1} mesh-boundary patch(es) omitted across {p2} file(s).", { p1: skipped, p2: readers.length });
        if (skipped) {
          this.fieldNote.textContent += i18n.t(" {p1} mesh-boundary patch(es) omitted; see Coverage and limitations.", { p1: skipped });
          if (this.coverage) this.coverage.open = true;
        }
      }
      if (field.kind === 'smoke' && field.quantity.trim().toUpperCase() === 'HRRPUV') {
        this.fieldNote.textContent +=
          field.fireCutoff === undefined
            ? i18n.t(" No fire cutoff recorded.")
            : i18n.t(" Fire cutoff: {p1} kW/m³ (FDS 6.9.1 encoding).", { p1: measured(field.fireCutoff) });
      }
      this.autoScaleButton.disabled =
        this.rangeLow.disabled =
        this.rangeHigh.disabled =
          field.kind === 'smoke';
      this.low = /TEMPERATURE/.test(field.quantity) ? 20 : 0;
      this.high = /TEMPERATURE/.test(field.quantity)
        ? 500
        : field.unit === 'm/s'
          ? 5
          : field.unit === 'kg/m2/s'
            ? 0.1
            : 100;
      if (/^[UVW]-VELOCITY/.test(field.quantity)) this.low = -this.high;
      // FDS .bnd sidecars describe the whole recorded run, giving a stable scale.
      if (field.kind !== 'smoke') {
        let min = Infinity,
          max = -Infinity;
        for (const f of fields)
          if (this.source.files.has(f.file + '.bnd')) {
            const parts = (await resultText(this.source, f.file + '.bnd')).trim().split(/\s+/).map(Number);
            if (parts.length >= 3 && Number.isFinite(parts[1]) && Number.isFinite(parts[2])) {
              min = Math.min(min, parts[1]);
              max = Math.max(max, parts[2]);
            }
          }
        if (epoch !== this.epoch || request !== this.frameRequest) return;
        if (max > min) {
          this.low = min;
          this.high = max;
        }
      }
      this.rangeLow.value = String(this.low);
      this.rangeHigh.value = String(this.high);
      this.slider.max = String(readers[0].count - 1);
      const index = (await readers[0].nearest(this.time)) ?? 0;
      if (epoch !== this.epoch || request !== this.frameRequest) return;
      this.setTransportEnabled(true);
      this.requestFrame(index);
    } catch (error) {
      if (epoch === this.epoch && request === this.frameRequest) {
        this.readers = [];
        this.setStatus(i18n.t("Dataset unavailable: {p1}", { p1: (error as Error).message }), 'error');
      }
    }
  }
  private requestFrame(index: number): void {
    if (!this.readers.length) return;
    this.pending = Math.min(this.readers[0].count - 1, Math.max(0, index));
    if (!this.busy) void this.drainFrames();
  }
  private async drainFrames(): Promise<void> {
    this.busy = true;
    const epoch = this.epoch,
      request = this.frameRequest;
    const readers = this.readers;
    try {
      while (this.pending !== null && epoch === this.epoch && request === this.frameRequest) {
        const index = this.pending;
        this.pending = null;
        this.setStatus(i18n.t("Loading frame {p1}… (displaying {p2} s)", { p1: index + 1, p2: numeric(this.time) }));
        const primary = await readers[0].frame(index);
        const entries = [{ field: readers[0].field, mesh: readers[0].mesh, frame: primary }];
        let missing = 0;
        for (let i = 1; i < readers.length; i += 4) {
          const batch = await Promise.all(
            readers.slice(i, i + 4).map(async (r) => {
              const at = await r.nearest(primary.time, index);
              if (at === null) return null;
              return { field: r.field, mesh: r.mesh, frame: await r.frame(at) };
            })
          );
          if (epoch !== this.epoch || request !== this.frameRequest) return;
          for (const entry of batch) {
            if (entry) entries.push(entry);
            else missing++;
          }
        }
        if (epoch !== this.epoch || request !== this.frameRequest || !this.isOpen) return;
        if (this.pending !== null) continue; // Never paint an obsolete scrub request.
        this.scene?.showFrames(entries, this.low, this.high, this.opacity);
        this.time = primary.time;
        this.currentIndex = index;
        this.slider.value = String(index);
        this.stamp.textContent = i18n.t("t = {p1} s · frame {p2}/{p3}", { p1: numeric(this.time), p2: index + 1, p3: readers[0].count });
        const [min, max] = rangeOf(entries.map((e) => e.frame.time));
        this.setStatus(
          i18n.t("{p1} mesh file(s) shown{p2}{p3}", { p1: entries.length, p2: missing ? i18n.t(" · {p1} outside time coverage", { p1: missing }) : '', p3: max - min > 0.001 ? i18n.t(" · sampled times {p1}–{p2} s", { p1: numeric(min), p2: numeric(max) }) : '' }),
          missing || max - min > 0.001 ? 'warn' : 'info'
        );
        this.updateLegend();
        this.drawHistory();
      }
    } catch (error) {
      if (epoch === this.epoch && request === this.frameRequest) {
        this.pause();
        this.scene?.hideFields();
        this.setStatus(i18n.t("Frame unavailable: {p1}", { p1: (error as Error).message }), 'error');
      }
    } finally {
      if (epoch === this.epoch && request === this.frameRequest) {
        this.busy = false;
        if (this.playing) void this.scheduleNext(epoch, request);
      }
    }
  }
  private updateLegend(): void {
    const field = this.readers[0]?.field;
    this.legend.replaceChildren(
      field?.kind === 'smoke'
        ? h('span', {}, [i18n.t("3D appearance preview · 8-bit encoded output")])
        : h('div', {}, [
            h('div', { class: 'fds-results__ramp' }),
            h('div', {}, [`${measured(this.low)} — ${measured(this.high)}${i18n.unitSpace()}${field?.unit ?? ''}`]),
          ])
    );
  }
  private async autoScale(): Promise<void> {
    if (!this.readers.length || this.readers[0].field.kind === 'smoke') return;
    if (this.busy) {
      // Said, not swallowed: the button looked broken while a frame was loading.
      this.setStatus(i18n.t("A frame is still loading; choose Scale to this frame once it shows."), 'warn');
      return;
    }
    const epoch = this.epoch,
      request = this.frameRequest;
    // The frame on screen now, read once: the loop below awaits, and reading the
    // clock inside it mixed frames when playback moved on meanwhile.
    const time = this.time,
      current = this.currentIndex;
    try {
      let min = Infinity,
        max = -Infinity;
      for (const r of this.readers) {
        const index = await r.nearest(time, current);
        if (index === null) continue;
        const frame = await r.frame(index);
        for (const value of frame.values)
          if (Number.isFinite(value)) {
            min = Math.min(min, value);
            max = Math.max(max, value);
          }
      }
      if (epoch !== this.epoch || request !== this.frameRequest) return;
      if (Number.isFinite(min)) {
        this.low = min;
        this.high = max > min ? max : min + 1;
        this.rangeLow.value = String(this.low);
        this.rangeHigh.value = String(this.high);
        this.rangeLow.removeAttribute('aria-invalid');
        this.rangeHigh.removeAttribute('aria-invalid');
        this.requestFrame(this.currentIndex);
      }
    } catch (error) {
      if (epoch === this.epoch) this.setStatus((error as Error).message, 'error');
    }
  }
  private setStatus(message: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
    this.status.textContent = message;
    this.status.dataset.kind = kind;
  }
  private setTransportEnabled(enabled: boolean): void {
    for (const control of [this.first, this.previous, this.next, this.last, this.slider])
      control.disabled = !enabled;
    this.play.disabled = !enabled || (this.readers[0]?.count ?? 0) < 2;
  }
  private seek(index: number): void {
    this.pause();
    this.requestFrame(index);
  }
  private pause(): void {
    ++this.playbackRequest;
    this.playing = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    setTransportPlaying(this.play, false);
  }
  private togglePlay(): void {
    if (this.playing) {
      this.pause();
      return;
    }
    if (!this.readers.length || this.readers[0].count < 2) return;
    this.playing = true;
    setTransportPlaying(this.play, true);
    if (this.currentIndex >= this.readers[0].count - 1) this.requestFrame(0);
    else if (!this.busy) void this.scheduleNext(this.epoch, this.frameRequest);
  }
  private async scheduleNext(epoch: number, request: number): Promise<void> {
    if (!this.playing) return;
    const playbackRequest = ++this.playbackRequest;
    clearTimeout(this.timer);
    const next = this.loop && this.currentIndex === this.readers[0].count - 1 ? 0 : this.currentIndex + 1;
    if (next >= this.readers[0].count) {
      this.pause();
      return;
    }
    try {
      // Hold the final frame for the previous interval, as flame playback does.
      const delay =
        next === 0
          ? this.time - (await this.readers[0].time(this.currentIndex - 1))
          : (await this.readers[0].time(next)) - this.time;
      if (
        epoch !== this.epoch ||
        request !== this.frameRequest ||
        playbackRequest !== this.playbackRequest ||
        !this.playing
      )
        return;
      clearTimeout(this.timer);
      this.timer = setTimeout(
        () => {
          if (
            this.playing &&
            epoch === this.epoch &&
            request === this.frameRequest &&
            playbackRequest === this.playbackRequest
          )
            this.requestFrame(next);
        },
        Math.max(16, (delay * 1000) / this.speed)
      );
    } catch (error) {
      if (epoch === this.epoch && request === this.frameRequest && playbackRequest === this.playbackRequest) {
        this.pause();
        this.setStatus((error as Error).message, 'error');
      }
    }
  }
  private selectDevice(device?: ResultDevice): void {
    this.selectedDevice = device;
    this.selectedSeries = device ? deviceHistory(device, this.deviceSeries) : undefined;
    this.historySelect.value = this.selectedSeries ? String(this.series.indexOf(this.selectedSeries)) : '';
    this.scene?.devices.setSelected(device);
    this.drawHistory();
  }
  private drawHistory(): void {
    const s = this.selectedSeries,
      ctx = this.graph.getContext('2d');
    if (!ctx) return;
    const w = this.graph.width,
      height = this.graph.height;
    ctx.clearRect(0, 0, w, height);
    if (!s || !s.times.length) {
      this.readout.textContent = this.selectedDevice
        ? i18n.t("{p1}: no matching device history available.", { p1: this.selectedDevice.id })
        : i18n.t("No device or heat-release history selected.");
      this.graph.setAttribute('aria-label', i18n.t("No history selected"));
      return;
    }
    const start = s.times[0],
      end = s.times[s.times.length - 1];
    const values = s.values.filter(Number.isFinite),
      min = values.reduce((a, b) => Math.min(a, b), Infinity),
      max = values.reduce((a, b) => Math.max(a, b), -Infinity);
    if (!values.length) {
      this.readout.textContent = i18n.t("{p1}: no finite samples", { p1: s.name });
      return;
    }
    let at = 0;
    while (
      at + 1 < s.times.length &&
      Math.abs(s.times[at + 1] - this.time) < Math.abs(s.times[at] - this.time)
    )
      at++;
    this.readout.textContent =
      this.time < start || this.time > end
        ? i18n.t("{p1}: outside recorded time coverage", { p1: s.name })
        : i18n.t("{p1}: {p2} {p3} · sample at {p4} s", { p1: s.name, p2: measured(s.values[at]), p3: s.unit, p4: numeric(s.times[at]) });
    this.graph.setAttribute(
      'aria-label',
      i18n.t("{p1} history, {p2}, {p3} to {p4} seconds", { p1: s.name, p2: s.unit, p3: numeric(start), p4: numeric(end) })
    );
    const x = (t: number) => 62 + ((w - 82) * (t - start)) / (end - start || 1);
    const y = (v: number) => height - 35 - ((height - 64) * (v - min)) / (max - min || 1);
    const theme = this.theme;
    ctx.font = '20px ' + theme.font;
    ctx.fillStyle = theme.textDim;
    ctx.fillText(measured(max), 3, 22);
    ctx.fillText(measured(min), 3, height - 34);
    ctx.fillText(`${numeric(start)}${i18n.unitSpace()}s`, 62, height - 6);
    ctx.textAlign = 'right';
    ctx.fillText(`${numeric(end)}${i18n.unitSpace()}s`, w - 12, height - 6);
    ctx.textAlign = 'left';
    ctx.strokeStyle = theme.plotPrimary;
    ctx.setLineDash([]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    let pen = false;
    s.values.forEach((v, i) => {
      if (!Number.isFinite(v)) {
        pen = false;
        return;
      }
      if (pen) ctx.lineTo(x(s.times[i]), y(v));
      else ctx.moveTo(x(s.times[i]), y(v));
      pen = true;
    });
    ctx.stroke();
    ctx.strokeStyle = theme.plotCursor;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(x(Math.min(end, Math.max(start, this.time))), 10);
    ctx.lineTo(x(Math.min(end, Math.max(start, this.time))), height - 30);
    ctx.stroke();
  }
  private async snapshot(): Promise<void> {
    if (!this.scene || this.busy) {
      this.setStatus(i18n.t("Wait for the displayed frame to finish loading before exporting."), 'warn');
      return;
    }
    this.pause();
    const epoch = this.epoch;
    this.scene.render();
    const canvas = document.createElement('canvas'),
      view = this.scene.renderer.domElement;
    canvas.width = view.width;
    const staticGeometry = (this.data?.geometryEvents ?? 0) > 0;
    canvas.height = view.height + (staticGeometry ? 90 : 65);
    const ctx = canvas.getContext('2d')!;
    const theme = this.theme;
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(view, 0, 0);
    ctx.drawImage(this.scene.devices.canvas, 0, 0, view.width, view.height);
    ctx.fillStyle = theme.text;
    ctx.font = '18px ' + theme.font;
    const field = this.readers[0]?.field;
    // Which dataset and which meshes: a PNG is read away from the dialog that made it.
    const dataset = this.datasets[Number(this.selection.value)]?.label;
    const meshes = this.meshSelection.selectedOptions[0]?.textContent ?? '';
    ctx.fillText(
      [this.data?.chid, dataset ?? field?.quantity ?? '', meshes, `${numeric(this.time)}${i18n.unitSpace()}s`]
        .filter(Boolean).join(' · '),
      16,
      view.height + 25
    );
    if (field?.kind === 'smoke') {
      ctx.fillText(i18n.t("Quantized 3D appearance preview"), 16, view.height + 51);
    } else {
      // The colour scale itself, not only its end values: a scientific field keeps
      // its quantity, unit and legend (docs/visual-language.md). Stops from the
      // shader's own ramp, which the on-screen bar (.fds-results__ramp) also shows.
      const low = measured(this.low);
      const high = `${measured(this.high)}${i18n.unitSpace()}${field?.unit ?? ''}`.trim();
      const barX = 16 + ctx.measureText(low).width + 10;
      const barWidth = Math.min(260, Math.max(80, canvas.width - barX - ctx.measureText(high).width - 40));
      const ramp = ctx.createLinearGradient(barX, 0, barX + barWidth, 0);
      for (let i = 0; i <= 8; i += 1) ramp.addColorStop(i / 8, `rgb(${resultRampRgb(i / 8).join(',')})`);
      ctx.fillText(low, 16, view.height + 51);
      ctx.fillStyle = ramp;
      ctx.fillRect(barX, view.height + 38, barWidth, 16);
      ctx.fillStyle = theme.text;
      ctx.fillText(high, barX + barWidth + 10, view.height + 51);
    }
    if (staticGeometry)
      ctx.fillText(i18n.t("Static geometry only; geometry events are not animated"), 16, view.height + 77);
    try {
      if (shell()) {
        const path = await saveResultPng(canvas.toDataURL('image/png'));
        if (epoch === this.epoch)
          this.setStatus(path ? i18n.t("Snapshot saved: {p1}", { p1: path }) : i18n.t("Snapshot save cancelled."));
      } else {
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(i18n.t("PNG encoding failed.")))), 'image/png')
        );
        if (epoch !== this.epoch) return;
        const url = URL.createObjectURL(blob),
          link = h('a', { href: url, download: 'fds-results.png' });
        this.dialog.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        this.setStatus(i18n.t("PNG download requested: fds-results.png"));
      }
    } catch (error) {
      if (epoch === this.epoch)
        this.setStatus(i18n.t("Snapshot was not saved: {p1}", { p1: (error as Error).message }), 'error');
    }
  }
  close(): void {
    this.pause();
    ++this.epoch;
    ++this.frameRequest;
    this.pending = null;
    this.scene?.dispose();
    this.scene = undefined;
    this.source?.close?.();
    this.source = undefined;
    this.readers = [];
    this.series = [];
    this.data = undefined;
    this.selectedSeries = undefined;
    this.devicePanel = undefined;
    this.deviceSeries = [];
    this.selectedDevice = undefined;
    this.dialog.close();
    this.dialog.remove();
    this.body.replaceChildren();
    this.onOpenChange(false);
    this.focusBefore?.focus();
  }
}
