import { parseSmv, parseResultCsv, ResultReader, resultText, type ResultDevice, type ResultCase, type ResultField, type ResultSeries, type ResultSource } from '../core/fds-results';
import { browserResultsSource, desktopResultsSource } from '../io/fds-results-source';
import { openShellResults, saveResultPng, shell } from '../io/files';
import { FdsResultScene } from '../scene/fds-results';
import { h } from './dom';
import { deviceHistory } from '../core/fds-devices';
import { FdsDevicePanel } from './fds-devices';

interface Dataset { label: string; fields: ResultField[] }
const button = (text: string, action: () => void) => h('button', { type: 'button', onclick: action }, [text]);
const numeric = (n: number): string => Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—';
const pathOf = (f: File) => f.webkitRelativePath || f.name;

/** A modal results workspace owns its own scene, clock and file session. It never
 * touches the plan store or the planning correlation / reconstruction clocks. */
export class FdsResultsDialog {
  private dialog = h('dialog', { class: 'fds-results', 'aria-label': 'FDS simulation results' });
  private body = h('div', { class: 'fds-results__body' });
  private title = h('strong', {}, ['FDS simulation results']);
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
  private timer?: ReturnType<typeof setTimeout>;
  private time = 0;
  private currentIndex = 0;
  private speed = 10;
  private low = 0;
  private high = 100;
  private opacity = .9;
  private selection = h('select', { 'aria-label': 'Result dataset' });
  private meshSelection = h('select', { 'aria-label': 'Result mesh' });
  private slider = h('input', { type: 'range', min: 0, max: 0, step: 1, value: 0, 'aria-label': 'Simulation frame' });
  private play = button('Play', () => this.togglePlay());
  private stamp = h('output');
  private rangeLow = h('input', { type: 'number', value: 0, step: 'any', 'aria-label': 'Color scale minimum' });
  private rangeHigh = h('input', { type: 'number', value: 100, step: 'any', 'aria-label': 'Color scale maximum' });
  private legend = h('div', { class: 'fds-results__legend' });
  private graph = h('canvas', { width: 600, height: 240, class: 'fds-results__graph', 'aria-label': 'Selected result history' });
  private readout = h('div', { class: 'fds-results__reading' });
  private historySelect = h('select', { 'aria-label': 'Device or heat release history' });
  private info = h('div', { class: 'fds-results__info' });
  private fieldNote = h('div', { class: 'fds-results__note' });
  private focusBefore?: HTMLElement;

  constructor() {
    this.dialog.append(h('header', {}, [this.title, button('Back to plan', () => this.close())]), this.body);
    this.dialog.addEventListener('cancel', e => { e.preventDefault(); this.close(); });
    this.dialog.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.code === 'Space' && (e.target as HTMLElement).tagName === 'CANVAS') { e.preventDefault(); this.togglePlay(); }
    });
    this.selection.onchange = () => { void this.loadDataset(); };
    this.meshSelection.onchange = () => { void this.loadDataset(); };
    this.slider.oninput = () => { this.pause(); this.requestFrame(Number(this.slider.value)); };
    this.historySelect.onchange = () => {
      this.selectedSeries = this.historySelect.value === '' ? undefined : this.series[Number(this.historySelect.value)];
      this.selectedDevice = this.deviceSeries.includes(this.selectedSeries!)
        ? this.data?.devices.find(d => deviceHistory(d, this.deviceSeries) === this.selectedSeries) : undefined;
      this.devicePanel?.selectDevice(this.selectedDevice, true);
      this.scene?.devices.setSelected(this.selectedDevice); this.drawHistory();
    };
    const scale = () => {
      const low = this.rangeLow.valueAsNumber, high = this.rangeHigh.valueAsNumber;
      if (!Number.isFinite(low) || !Number.isFinite(high) || low >= high) { this.status.textContent = 'Color scale needs finite minimum < maximum.'; return; }
      this.low = low; this.high = high; this.requestFrame(this.currentIndex);
    };
    this.rangeLow.onchange = scale; this.rangeHigh.onchange = scale;
  }
  get isOpen(): boolean { return this.dialog.open; }
  open(): void {
    if (this.isOpen) return;
    this.focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    document.body.append(this.dialog); this.dialog.showModal(); this.welcome();
  }
  private welcome(): void {
    this.title.textContent = 'FDS simulation results';
    this.body.replaceChildren(h('div', { class: 'fds-results__welcome' }, [
      h('h2', {}, ['Replay an FDS simulation']),
      h('p', {}, ['Open the simulation output folder containing its .smv metadata and associated result files. Files are read locally as you move through time.']),
      button(shell() ? 'Open .smv file…' : 'Choose results folder…', () => { void this.choose(); }),
      h('p', { class: 'fds-results__note' }, ['Recorded slices · wall fields · smoke/fire preview · sensor and heat-release histories']),
      h('p', { class: 'fds-results__note' }, ['Your test plan stays open. Results are a separate session and are not saved in the plan or its shared HTML.']),
      this.status,
    ]));
    this.status.textContent = '';
  }
  private async choose(): Promise<void> {
    const epoch = ++this.epoch;
    try {
      if (shell()) {
        const opened = await openShellResults();
        if (!opened) return;
        const source = desktopResultsSource(opened);
        if (!this.isOpen || epoch !== this.epoch) { source.close?.(); return; }
        await this.load(source, opened.smv);
        return;
      }
      const input = h('input', { type: 'file', multiple: true, hidden: true });
      input.setAttribute('webkitdirectory', '');
      this.dialog.append(input);
      const files = await new Promise<File[]>(resolve => {
        input.onchange = () => { resolve(Array.from(input.files ?? [])); input.remove(); };
        input.addEventListener('cancel', () => { resolve([]); input.remove(); }, { once: true });
        input.click();
      });
      if (!this.isOpen || epoch !== this.epoch || !files.length) return;
      const smvs = files.filter(f => f.name.toLowerCase().endsWith('.smv'));
      if (!smvs.length) throw new Error('No .smv metadata file found in the selected folder.');
      if (smvs.length === 1) await this.load(browserResultsSource(files, pathOf(smvs[0])), smvs[0].name);
      else {
        const select = h('select', { 'aria-label': 'Simulation metadata file' }, smvs.map(f => h('option', { value: pathOf(f) }, [pathOf(f)])));
        this.body.replaceChildren(h('div', { class: 'fds-results__welcome' }, [h('p', {}, ['Select the simulation to open.']), select,
          button('Open simulation', () => { const path = select.value; void this.load(browserResultsSource(files, path), path.split('/').pop()!); }), this.status]));
      }
    } catch (error) { if (this.isOpen && epoch === this.epoch) this.status.textContent = (error as Error).message; }
  }
  /** Public for integration hosts that already have explicit file handles. */
  async load(source: ResultSource, smvName: string): Promise<void> {
    this.pause(); const epoch = ++this.epoch; ++this.frameRequest;
    this.source?.close?.(); this.source = source;
    this.scene?.dispose(); this.scene = undefined;
    this.deviceSeries = []; this.selectedDevice = undefined; this.devicePanel = undefined; this.data = undefined;
    this.readers = []; this.series = []; this.selectedSeries = undefined; this.time = 0; this.currentIndex = 0;
    this.busy = false; this.pending = null;
    this.play.disabled = true; this.slider.disabled = true; this.stamp.textContent = '';
    this.legend.replaceChildren(); this.fieldNote.textContent = '';
    this.status.textContent = 'Reading simulation metadata…';
    this.body.replaceChildren(h('div', { class: 'fds-results__welcome' }, [this.status]));
    try {
      const data = parseSmv(await resultText(source, smvName));
      if (!this.isOpen || epoch !== this.epoch) return;
      this.data = data; this.title.textContent = `FDS results · ${data.chid || smvName}`;
      const missing = data.fields.filter(f => !source.files.has(f.file));
      for (const f of missing) data.warnings.push(`Missing: ${f.file}`);
      const groups = new Map<string, Dataset>();
      for (const field of data.fields.filter(f => source.files.has(f.file))) {
        const plane = field.kind === 'slice' ? ` · plane ${field.plane ?? 'all'}` : '';
        const label = `${field.kind === 'slice' ? 'Slice' : field.kind === 'boundary' ? 'Wall' : '3D preview'} · ${field.quantity}${plane}`;
        const key = `${label}/${field.unit}`;
        if (!groups.has(key)) groups.set(key, { label, fields: [] });
        groups.get(key)!.fields.push(field);
      }
      this.datasets = [...groups.values()].sort((a, b) => ({ slice: 0, boundary: 1, smoke: 2 }[a.fields[0].kind] - { slice: 0, boundary: 1, smoke: 2 }[b.fields[0].kind]));
      this.selection.replaceChildren(...this.datasets.map((d, i) => h('option', { value: i }, [d.label])));
      this.meshSelection.replaceChildren(h('option', { value: 'all' }, ['All recorded meshes']),
        ...data.meshes.map((m, i) => h('option', { value: i }, [`${i + 1} · ${m.id}`])));
      const view = h('div', { class: 'fds-results__view' });
      const speed = h('select', { 'aria-label': 'Playback speed', onchange: (e: Event) => { this.speed = Number((e.target as HTMLSelectElement).value); } },
        [1, 5, 10, 30, 60].map(n => h('option', { value: n, selected: n === this.speed }, [`${n}×`])));
      const opacity = h('input', { type: 'range', min: .05, max: 1, step: .05, value: this.opacity, 'aria-label': 'Field opacity', oninput: (e: Event) => {
        this.opacity = Number((e.target as HTMLInputElement).value); this.requestFrame(this.currentIndex);
      } });
      const cutHeight = h('input', { type: 'number', step: .1, value: 2, 'aria-label': 'Cutaway height in metres' });
      const cut = h('input', { type: 'checkbox', 'aria-label': 'Cut away above height' });
      const applyCut = () => {
        if (!cut.checked) this.scene?.setCutaway();
        else if (Number.isFinite(cutHeight.valueAsNumber)) this.scene?.setCutaway(cutHeight.valueAsNumber);
      };
      cut.onchange = applyCut; cutHeight.oninput = applyCut;
      const warnings = h('details', { class: 'fds-results__warnings' }, [h('summary', {}, ['Coverage and limitations']),
        h('p', {}, ['Structured 2D slices and obstruction boundary fields; original FDS coordinates in metres. 3D smoke/fire is a quantized preview. Particle, isosurface, Plot3D, unstructured and Smokezip output are not displayed.']),
        h('p', {}, ['Results are external to the plan. Reopen the folder for a new session. Use Smokeview for unsupported output and reference comparisons.']),
        ...data.warnings.map(w => h('p', {}, [w])),
      ]);
      if (data.warnings.length) warnings.open = true;
      this.info.textContent = `${data.version} · ${data.meshes.length} meshes · ${data.fields.length - missing.length}/${data.fields.length} field files available`;
      this.devicePanel = new FdsDevicePanel(data.devices, device => this.selectDevice(device), display => this.scene?.devices.setDisplay(display));
      this.body.replaceChildren(h('aside', { class: 'fds-results__sidebar' }, [
        h('div', { class: 'fds-results__title' }, [data.title]), this.info,
        h('label', {}, ['Recorded field', this.selection]), h('label', {}, ['Mesh coverage', this.meshSelection]), this.fieldNote,
        this.legend, h('div', { class: 'fds-results__scale' }, [h('label', {}, ['Min', this.rangeLow]), h('label', {}, ['Max', this.rangeHigh])]),
        button('Scale to this frame', () => { void this.autoScale(); }), h('label', {}, ['Opacity / smoke density', opacity]),
        h('label', {}, [cut, 'Cut away above Z (m)', cutHeight]),
        h('hr'), this.devicePanel.root, h('hr'), h('label', {}, ['Sensor / heat-release history', this.historySelect]), this.readout, this.graph,
        warnings, button('Open another simulation…', () => { void this.choose(); }),
      ]), h('section', { class: 'fds-results__main' }, [view,
        h('div', { class: 'fds-results__transport' }, [this.play, button('Previous', () => { this.pause(); this.requestFrame(this.currentIndex - 1); }),
          button('Next', () => { this.pause(); this.requestFrame(this.currentIndex + 1); }), this.slider, this.stamp, speed,
          button('Fit', () => this.scene?.fit()), button('PNG', () => this.snapshot())]), this.status]));
      this.scene = new FdsResultScene(view); this.scene.setCase(data);
      this.scene.devices.onPick = devices => this.devicePanel?.pick(devices);
      for (const csv of data.csv) {
        try {
          const series = parseResultCsv(await resultText(source, csv.file));
          if (epoch !== this.epoch) return;
          this.series.push(...series);
          if (csv.kind === 'devc') this.deviceSeries.push(...series);
        } catch (error) { if (epoch === this.epoch) warnings.append(h('p', {}, [`${csv.file}: ${(error as Error).message}`])); }
      }
      if (epoch !== this.epoch) return;
      this.historySelect.replaceChildren(h('option', { value: '' }, ['Choose a history…']), ...this.series.map((s, i) => h('option', { value: i }, [`${s.name} (${s.unit})`])));
      this.historySelect.disabled = !this.series.length;
      if (this.selectedDevice) this.selectDevice(this.selectedDevice);
      else {
        this.selectedSeries = this.series.find(s => s.name === 'HRR') ?? this.series[0];
        this.historySelect.value = this.selectedSeries ? String(this.series.indexOf(this.selectedSeries)) : '';
        this.drawHistory();
      }
      await this.loadDataset();
    } catch (error) {
      if (epoch === this.epoch && this.isOpen) { this.status.textContent = `Could not open results: ${(error as Error).message}`; this.pause(); }
    }
  }
  private async loadDataset(): Promise<void> {
    this.pause(); const request = ++this.frameRequest, epoch = this.epoch;
    this.pending = null; this.busy = false; this.scene?.clearFields();
    this.readers.forEach(r => r.clearFrame()); this.readers = [];
    const dataset = this.datasets[Number(this.selection.value)];
    const fields = dataset?.fields.filter(f => this.meshSelection.value === 'all' || f.mesh === Number(this.meshSelection.value)) ?? [];
    this.play.disabled = true; this.slider.disabled = true;
    if (!fields.length || !this.source || !this.data) { this.status.textContent = 'No recorded field for this selection. Choose another mesh or dataset.'; return; }
    this.status.textContent = `Opening ${fields.length} field file(s)…`;
    try {
      const readers: ResultReader[] = [];
      // Four concurrent file reads keep both browser memory and local HTTP queues bounded.
      for (let i = 0; i < fields.length; i += 4) {
        const batch = await Promise.all(fields.slice(i, i + 4).map(f => new ResultReader(this.source!, f, this.data!.meshes[f.mesh]).init()));
        if (epoch !== this.epoch || request !== this.frameRequest) return;
        readers.push(...batch);
      }
      const samples = readers.reduce((n, r) => n + r.patches.reduce((m, p) => m + p.count, 0), 0);
      if (samples * (fields[0].kind === 'smoke' ? 1 : 4) > 128 * 1024 * 1024 || (fields[0].kind !== 'smoke' && samples * 6 > 6000000)) {
        throw new Error('This selection exceeds the display memory limit. Choose one mesh.');
      }
      this.readers = readers;
      const field = fields[0];
      this.fieldNote.textContent = field.kind === 'smoke' ? 'Quantized 3D preview. Appearance controls do not change physical values. Use slices and wall fields for quantitative readings.' :
        `${field.unit} · ${field.cellCentered ? 'Cell-centered' : 'Node-centered'} · ${readers.length} mesh file(s). Separate mesh planes retain their recorded positions.`;
      this.rangeLow.disabled = this.rangeHigh.disabled = field.kind === 'smoke';
      this.low = /TEMPERATURE/.test(field.quantity) ? 20 : 0;
      this.high = /TEMPERATURE/.test(field.quantity) ? 500 : field.unit === 'm/s' ? 5 : field.unit === 'kg/m2/s' ? .1 : 100;
      if (/^[UVW]-VELOCITY/.test(field.quantity)) this.low = -this.high;
      // FDS .bnd sidecars describe the whole recorded run, giving a stable scale.
      if (field.kind !== 'smoke') {
        let min = Infinity, max = -Infinity;
        for (const f of fields) if (this.source.files.has(f.file + '.bnd')) {
          const parts = (await resultText(this.source, f.file + '.bnd')).trim().split(/\s+/).map(Number);
          if (parts.length >= 3 && Number.isFinite(parts[1]) && Number.isFinite(parts[2])) { min = Math.min(min, parts[1]); max = Math.max(max, parts[2]); }
        }
        if (epoch !== this.epoch || request !== this.frameRequest) return;
        if (max > min) { this.low = min; this.high = max; }
      }
      this.rangeLow.value = String(this.low); this.rangeHigh.value = String(this.high);
      this.slider.max = String(readers[0].count - 1);
      const index = await readers[0].nearest(this.time) ?? 0;
      if (epoch !== this.epoch || request !== this.frameRequest) return;
      this.slider.disabled = false; this.play.disabled = false;
      this.requestFrame(index);
    } catch (error) { if (epoch === this.epoch && request === this.frameRequest) { this.readers = []; this.status.textContent = `Dataset unavailable: ${(error as Error).message}`; } }
  }
  private requestFrame(index: number): void {
    if (!this.readers.length) return;
    this.pending = Math.min(this.readers[0].count - 1, Math.max(0, index));
    if (!this.busy) void this.drainFrames();
  }
  private async drainFrames(): Promise<void> {
    this.busy = true;
    const epoch = this.epoch, request = this.frameRequest;
    const readers = this.readers;
    try {
      while (this.pending !== null && epoch === this.epoch && request === this.frameRequest) {
        const index = this.pending; this.pending = null;
        this.status.textContent = `Loading frame ${index + 1}… (displaying ${numeric(this.time)} s)`;
        const primary = await readers[0].frame(index);
        const entries = [{ field: readers[0].field, mesh: readers[0].mesh, frame: primary }];
        let missing = 0;
        for (let i = 1; i < readers.length; i += 4) {
          const batch = await Promise.all(readers.slice(i, i + 4).map(async r => {
            const at = await r.nearest(primary.time, index);
            if (at === null) return null;
            return { field: r.field, mesh: r.mesh, frame: await r.frame(at) };
          }));
          if (epoch !== this.epoch || request !== this.frameRequest) return;
          for (const entry of batch) { if (entry) entries.push(entry); else missing++; }
        }
        if (epoch !== this.epoch || request !== this.frameRequest || !this.isOpen) return;
        if (this.pending !== null) continue; // Never paint an obsolete scrub request.
        this.scene?.showFrames(entries, this.low, this.high, this.opacity);
        this.time = primary.time; this.currentIndex = index; this.slider.value = String(index);
        this.stamp.textContent = `${numeric(this.time)} s · ${index + 1}/${readers[0].count}`;
        const times = entries.map(e => e.frame.time), min = Math.min(...times), max = Math.max(...times);
        this.status.textContent = `${entries.length} mesh file(s) shown${missing ? ` · ${missing} outside time coverage` : ''}${max - min > .001 ? ` · sampled times ${numeric(min)}–${numeric(max)} s` : ''}`;
        this.updateLegend(); this.drawHistory();
      }
    } catch (error) {
      if (epoch === this.epoch && request === this.frameRequest) { this.pause(); this.scene?.hideFields(); this.status.textContent = `Frame unavailable: ${(error as Error).message}`; }
    } finally {
      if (epoch === this.epoch && request === this.frameRequest) {
        this.busy = false;
        if (this.playing) void this.scheduleNext(epoch, request);
      }
    }
  }
  private updateLegend(): void {
    const field = this.readers[0]?.field;
    this.legend.replaceChildren(field?.kind === 'smoke' ? h('span', {}, ['3D appearance preview · 8-bit encoded output']) :
      h('div', {}, [h('div', { class: 'fds-results__ramp' }), h('div', {}, [`${numeric(this.low)} — ${numeric(this.high)} ${field?.unit ?? ''}`])]));
  }
  private async autoScale(): Promise<void> {
    if (this.busy || !this.readers.length || this.readers[0].field.kind === 'smoke') return;
    const epoch = this.epoch, request = this.frameRequest;
    try {
      let min = Infinity, max = -Infinity;
      for (const r of this.readers) {
        const index = await r.nearest(this.time, this.currentIndex); if (index === null) continue;
        const frame = await r.frame(index);
        for (const value of frame.values) if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
      }
      if (epoch !== this.epoch || request !== this.frameRequest) return;
      if (Number.isFinite(min)) { this.low = min; this.high = max > min ? max : min + 1; this.rangeLow.value = String(this.low); this.rangeHigh.value = String(this.high); this.requestFrame(this.currentIndex); }
    } catch (error) { if (epoch === this.epoch) this.status.textContent = (error as Error).message; }
  }
  private pause(): void { this.playing = false; clearTimeout(this.timer); this.timer = undefined; this.play.textContent = 'Play'; }
  private togglePlay(): void {
    if (this.playing) { this.pause(); return; }
    if (!this.readers.length) return;
    this.playing = true; this.play.textContent = 'Pause';
    if (this.currentIndex >= this.readers[0].count - 1) this.requestFrame(0);
    else if (!this.busy) void this.scheduleNext(this.epoch, this.frameRequest);
  }
  private async scheduleNext(epoch: number, request: number): Promise<void> {
    if (!this.playing) return;
    const next = this.currentIndex + 1;
    if (next >= this.readers[0].count) { this.pause(); return; }
    try {
      const time = await this.readers[0].time(next);
      if (epoch !== this.epoch || request !== this.frameRequest || !this.playing) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { if (this.playing && epoch === this.epoch && request === this.frameRequest) this.requestFrame(next); }, Math.max(16, (time - this.time) * 1000 / this.speed));
    } catch (error) { if (epoch === this.epoch) { this.pause(); this.status.textContent = (error as Error).message; } }
  }
  private selectDevice(device?: ResultDevice): void {
    this.selectedDevice = device;
    this.selectedSeries = device ? deviceHistory(device, this.deviceSeries) : undefined;
    this.historySelect.value = this.selectedSeries ? String(this.series.indexOf(this.selectedSeries)) : '';
    this.scene?.devices.setSelected(device); this.drawHistory();
  }
  private drawHistory(): void {
    const s = this.selectedSeries, ctx = this.graph.getContext('2d');
    if (!ctx) return;
    const w = this.graph.width, height = this.graph.height;
    ctx.clearRect(0, 0, w, height);
    if (!s || !s.times.length) { this.readout.textContent = this.selectedDevice ? `${this.selectedDevice.id}: no matching device history available.` : 'No device or heat-release history selected.'; this.graph.setAttribute('aria-label', 'No history selected'); return; }
    const start = s.times[0], end = s.times[s.times.length - 1];
    const values = s.values.filter(Number.isFinite), min = values.reduce((a, b) => Math.min(a, b), Infinity), max = values.reduce((a, b) => Math.max(a, b), -Infinity);
    if (!values.length) { this.readout.textContent = `${s.name}: no finite samples`; return; }
    let at = 0; while (at + 1 < s.times.length && Math.abs(s.times[at + 1] - this.time) < Math.abs(s.times[at] - this.time)) at++;
    this.readout.textContent = this.time < start || this.time > end ? `${s.name}: outside recorded time coverage` :
      `${s.name}: ${numeric(s.values[at])} ${s.unit} · sample at ${numeric(s.times[at])} s`;
    this.graph.setAttribute('aria-label', `${s.name} history, ${s.unit}, ${numeric(start)} to ${numeric(end)} seconds`);
    const x = (t: number) => 62 + (w - 82) * (t - start) / (end - start || 1);
    const y = (v: number) => height - 35 - (height - 64) * (v - min) / (max - min || 1);
    ctx.font = '20px system-ui'; ctx.fillStyle = '#a8bad1';
    ctx.fillText(numeric(max), 3, 22); ctx.fillText(numeric(min), 3, height - 34);
    ctx.fillText(`${numeric(start)} s`, 62, height - 6); ctx.textAlign = 'right'; ctx.fillText(`${numeric(end)} s`, w - 12, height - 6); ctx.textAlign = 'left';
    ctx.strokeStyle = '#67e8f9'; ctx.lineWidth = 2; ctx.beginPath(); let pen = false;
    s.values.forEach((v, i) => { if (!Number.isFinite(v)) { pen = false; return; } if (pen) ctx.lineTo(x(s.times[i]), y(v)); else ctx.moveTo(x(s.times[i]), y(v)); pen = true; }); ctx.stroke();
    ctx.strokeStyle = '#f8c471'; ctx.beginPath(); ctx.moveTo(x(Math.min(end, Math.max(start, this.time))), 10); ctx.lineTo(x(Math.min(end, Math.max(start, this.time))), height - 30); ctx.stroke();
  }
  private async snapshot(): Promise<void> {
    if (!this.scene || this.busy) { this.status.textContent = 'Wait for the displayed frame to finish loading before exporting.'; return; }
    this.pause(); const epoch = this.epoch; this.scene.render();
    const canvas = document.createElement('canvas'), view = this.scene.renderer.domElement;
    canvas.width = view.width; canvas.height = view.height + 65;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#101b2c'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(view, 0, 0); ctx.drawImage(this.scene.devices.canvas, 0, 0, view.width, view.height);
    ctx.fillStyle = '#ffffff'; ctx.font = '18px system-ui';
    const field = this.readers[0]?.field;
    ctx.fillText(`${this.data?.chid} · ${field?.quantity ?? ''} · ${numeric(this.time)} s`, 16, view.height + 25);
    ctx.fillText(field?.kind === 'smoke' ? 'Quantized 3D appearance preview' : `${numeric(this.low)} – ${numeric(this.high)} ${field?.unit ?? ''}`, 16, view.height + 51);
    try {
      if (shell()) {
        const path = await saveResultPng(canvas.toDataURL('image/png'));
        if (epoch === this.epoch) this.status.textContent = path ? `Snapshot saved: ${path}` : 'Snapshot save cancelled.';
      } else {
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG encoding failed.')), 'image/png'));
        if (epoch !== this.epoch) return;
        const url = URL.createObjectURL(blob), link = h('a', { href: url, download: 'fds-results.png' });
        this.dialog.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        this.status.textContent = 'PNG download requested: fds-results.png';
      }
    } catch (error) { if (epoch === this.epoch) this.status.textContent = `Snapshot was not saved: ${(error as Error).message}`; }
  }
  close(): void {
    this.pause(); ++this.epoch; ++this.frameRequest; this.pending = null;
    this.scene?.dispose(); this.scene = undefined;
    this.source?.close?.(); this.source = undefined;
    this.readers = []; this.series = []; this.data = undefined; this.selectedSeries = undefined;
    this.devicePanel = undefined; this.deviceSeries = []; this.selectedDevice = undefined;
    this.dialog.close(); this.dialog.remove(); this.body.replaceChildren(); this.focusBefore?.focus();
  }
}
