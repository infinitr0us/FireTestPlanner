/**
 * Test data… : the plan's measured and simulated sources, and the mapping of
 * their channels onto instruments.
 *
 * The sources, their layouts and mappings are document edits, each one undoable
 * step. The file's bytes, a draft of every sheet and the browser File handles are
 * session state: reading a file is never an edit. A new source is drafted from its
 * file (every sheet, with progress and Cancel), set up here, and added in one edit.
 */
import { columnName, extractSeries, calibrationHint, channelUnits, detectShape, type Channel, type Grid } from '../core/tables';
import { fileName, isNetworkPath } from '../core/linked-files';
import { manifestFor, testDataChecks, testDataProblem, type FileInfo } from '../core/test-data';
import type { TestDataMapping, TestDataSource, TestDataTable } from '../core/types';
import { shell } from '../io/files';
import { TEST_DATA_FILE_CAP, type Draft } from '../io/test-data-sources';
import type { Store } from '../state/store';
import type { TestDataEntry, TestDataStore } from '../state/test-data-store';
import { h } from './dom';
import { button } from './fields';
import { fmt } from './plot-svg';
import {
  defaultRole, mappingNote, nextSourceId, parseTargetKey, prefill, previewRows, shiftHintLabel, statusText,
  targetKey, targetOptions, unitLabel, updateManifestChannels, type ChannelInfo, type Target,
} from './test-data-model';

const SHAPES: Record<TestDataTable['shape'], string> = {
  'paired-time': 'Logger export, a time column per channel',
  processed: 'Processed sheet, several header rows',
  fds: 'FDS device or HRR output',
  plain: 'Plain table, one header row',
};
const SHAPE_SHORT: Record<TestDataTable['shape'], string> = { 'paired-time': 'logger', processed: 'processed', fds: 'FDS', plain: 'plain' };
const ACCEPT = '.xlsx,.xlsm,.csv,.tsv,.txt';

/** A file read for drafting, kept for the session so sheet changes need no re-read. */
interface Cached { path: string; draft: Draft; size: number; modified: string | null; bytes: Uint8Array; file?: File }
/** A source being set up from a draft, not yet in the plan. */
interface Pending { cached: Cached; source: TestDataSource; suggested: Set<string>; roleTouched: boolean }
type View =
  | { kind: 'list' }
  | { kind: 'edit'; sourceId: string }
  | { kind: 'new'; pending: Pending }
  | { kind: 'reading'; name: string; abort: AbortController; text: string; step: number; steps: number };
/** The grid a source's layout is checked against, with its metadata units and file. */
interface Context { grid: Grid; units: ReadonlyMap<string, string>; fileInfo: FileInfo }

/** A typed number: null when empty, NaN when not a number. A decimal comma is read as one. */
function parseNumber(text: string): number | null {
  const t = text.trim().replace(/^([+-]?\d*),(\d+)$/, '$1.$2');
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : Number.NaN;
}
const precise = (v: number): string => String(Number(v.toPrecision(15)));
const cellText = (v: Grid[number][number]): string => v === null ? '' : typeof v === 'number' ? String(Number(v.toPrecision(6))) : v;
const extractionCache = new WeakMap<Grid, Map<string, ReturnType<typeof extractSeries>>>();
/** Extraction is pure in grid, layout and units; repaints reuse it. */
function extract(grid: Grid, table: TestDataTable, units: ReadonlyMap<string, string>): ReturnType<typeof extractSeries> {
  let cache = extractionCache.get(grid);
  if (!cache) extractionCache.set(grid, cache = new Map());
  const key = JSON.stringify([table.shape, table.headerRow, table.unitsRow, table.dataRow, table.timeColumn, [...units]]);
  let result = cache.get(key);
  if (!result) {
    result = extractSeries(grid, table, units);
    if (cache.size > 16) cache.clear();
    cache.set(key, result);
  }
  return result;
}
const info = (c: Channel): ChannelInfo & { missing: number } =>
  ({ name: c.name, unit: c.unit, samples: c.t.length, t0: c.t[0] ?? null, t1: c.t.at(-1) ?? null, missing: c.missing });

export class TestDataDialog {
  private root: HTMLDialogElement | null = null;
  private view: View = { kind: 'list' };
  private drafts = new Map<string, Cached>();
  private files = new Map<string, File>();
  private documentId = -1;
  private filter = '';
  private status: { text: string; tone: 'dim' | 'good' | 'warn' | 'bad' } | null = null;
  private unsubscribe: Array<() => void> = [];
  private busy = false;
  private progress: HTMLElement | null = null;
  /** A repaint waits while a mouse button is down, so the click lands on the button pressed. */
  private pointerDown = false;
  private repaintAfterPointer = false;
  /** The control that last had focus, restored after a busy spell disabled it. */
  private lastFocus: string | undefined;
  /** Which view the scroll positions belong to; a different view starts at the top. */
  private shown = '';

  constructor(private store: Store, private data: TestDataStore, private onOpenChange: (open: boolean) => void,
    private onClosed: () => void = () => {}) {}

  get isOpen(): boolean { return this.root !== null; }

  /** Open at the sources list, or at one source's editor; `reveal` scrolls to its first flagged mapping. */
  open(sourceId?: string, reveal = false): void {
    this.syncSession();
    const exists = sourceId && this.store.document.testData?.some((s) => s.id === sourceId);
    this.view = exists ? { kind: 'edit', sourceId: sourceId! } : { kind: 'list' };
    this.status = null;
    this.filter = '';
    if (this.root) { this.render(); if (reveal) this.reveal(); return; }
    const dialog = h('dialog', { class: 'modal__panel test-data', 'aria-labelledby': 'test-data-title' });
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); this.close(); });
    dialog.addEventListener('keydown', (e) => this.key(e));
    dialog.addEventListener('pointerdown', () => { this.pointerDown = true; });
    const release = (): void => {
      if (!this.pointerDown) return;
      this.pointerDown = false;
      if (this.repaintAfterPointer) setTimeout(() => { this.repaintAfterPointer = false; this.render(); }, 0);
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    this.unsubscribe.push(() => { window.removeEventListener('pointerup', release, true); window.removeEventListener('pointercancel', release, true); });
    this.root = dialog;
    document.body.append(dialog);
    this.unsubscribe.push(
      this.store.subscribe((event) => { if (event === 'document') this.render(); }),
      this.data.subscribe(() => this.render()),
    );
    this.onOpenChange(true);
    dialog.showModal();
    this.render();
    this.focusFirst();
    if (reveal) this.reveal();
  }

  /** Bring the first mapping with a warning into view and give it the keyboard. */
  private reveal(): void {
    const row = [...this.root?.querySelectorAll<HTMLTableRowElement>('.test-data__map tbody tr') ?? []]
      .find((tr) => tr.querySelector('.test-data__note--warn'));
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.querySelector<HTMLSelectElement>('select')?.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.root) return;
    if (this.view.kind === 'reading') this.view.abort.abort();
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.root.close();
    this.root.remove();
    this.root = null;
    this.progress = null;
    this.view = { kind: 'list' };
    this.shown = '';
    this.lastFocus = undefined;
    this.onOpenChange(false);
    this.onClosed();
  }

  /** Undo and redo reach the plan while a select or button has focus; a text field keeps its own. */
  private key(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    const text = target instanceof HTMLTextAreaElement
      || (target instanceof HTMLInputElement && !/^(range|checkbox|radio|file|button)$/.test(target.type));
    if (!(e.ctrlKey || e.metaKey) || text || this.view.kind === 'new') return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.store.undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); this.store.redo(); }
  }

  /** A different plan: what this dialog kept for the old one does not apply. */
  private syncSession(): void {
    if (this.documentId === this.store.documentId) return;
    this.documentId = this.store.documentId;
    this.drafts.clear();
    this.files.clear();
    if (this.view.kind === 'reading') this.view.abort.abort();
    this.view = { kind: 'list' };
  }

  private source(id: string): TestDataSource | undefined {
    return this.store.document.testData?.find((s) => s.id === id);
  }

  private setStatus(text: string, tone: 'dim' | 'good' | 'warn' | 'bad' = 'dim'): void {
    this.status = { text, tone };
    this.render();
  }

  /** Run an asynchronous action with the dialog's buttons disabled, reporting failure. */
  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.status = null;
    this.render();
    try { await action(); }
    catch (err) {
      if ((err as DOMException).name === 'AbortError') this.status = { text: 'Reading the file was cancelled.', tone: 'dim' };
      else this.status = { text: (err as Error).message, tone: 'bad' };
    } finally { this.busy = false; this.render(); }
  }

  /**
   * A read for one existing source. Several can run at once, each shown by its
   * source's own status, so they do not take the dialog's busy guard.
   */
  private async act(action: () => Promise<void>): Promise<void> {
    try { await action(); }
    catch (err) {
      this.status = { text: (err as Error).message, tone: 'bad' };
      this.render();
    }
  }

  // -- rendering ------------------------------------------------------------

  private render(): void {
    const dialog = this.root;
    if (!dialog) return;
    if (this.pointerDown) { this.repaintAfterPointer = true; return; }
    if (this.documentId !== this.store.documentId) this.syncSession();
    if (this.view.kind === 'edit' && !this.source(this.view.sourceId)) this.view = { kind: 'list' };
    // Keep the keyboard where it was across a repaint, including text being typed.
    const active = document.activeElement as HTMLElement | null;
    const inside = active !== null && active !== dialog && dialog.contains(active);
    const focusKey = inside ? active.dataset.key : this.lastFocus;
    this.lastFocus = focusKey;
    const typed = active instanceof HTMLInputElement && active.dataset.typed
      ? { value: active.value, start: active.selectionStart, end: active.selectionEnd } : null;
    const body = dialog.querySelector<HTMLElement>('.test-data__body');
    const scroll = body?.scrollTop ?? 0;
    const channelScroll = dialog.querySelector<HTMLElement>('.test-data__channels')?.scrollTop ?? 0;

    const view = this.view;
    const shown = view.kind === 'edit' ? `edit:${view.sourceId}` : view.kind;
    const sameView = shown === this.shown;
    this.shown = shown;
    const title = view.kind === 'edit' ? `Test data · ${this.source(view.sourceId)!.name}`
      : view.kind === 'new' ? `New source · ${fileName(view.pending.source.file.path)}` : 'Test data';
    const content = view.kind === 'list' ? this.renderList()
      : view.kind === 'reading' ? this.renderReading(view)
        : view.kind === 'new' ? this.renderEditor(view.pending.source, view.pending)
          : this.renderEditor(this.source(view.sourceId)!, null);
    const status = h('p', { class: `fds-export__status test-data__message test-data__message--${this.status?.tone ?? 'dim'}`,
      role: 'status', 'aria-live': 'polite' }, [this.status?.text ?? '']);
    dialog.replaceChildren(
      h('h2', { class: 'modal__title', id: 'test-data-title' }, [title]),
      h('p', { class: 'import__intro' }, [view.kind === 'list'
        ? 'Measured and simulated channels on the plan\'s instruments. The plan keeps the file reference, the mapping and a manifest of what was read, never the samples.'
        : view.kind === 'new' ? 'Nothing changes in the plan until Add source, which adds the source and its mappings as one undoable edit.'
          : 'Each change here is one undoable edit. Reading the file is not an edit.']),
      h('div', { class: 'test-data__body' }, [content.body]),
      status,
      h('div', { class: 'import__actions' }, content.actions),
    );
    if (view.kind === 'reading') this.progress = dialog.querySelector('.test-data__reading');
    const nextBody = dialog.querySelector<HTMLElement>('.test-data__body');
    const channels = dialog.querySelector<HTMLElement>('.test-data__channels');
    if (sameView) {
      if (nextBody) nextBody.scrollTop = scroll;
      if (channels) channels.scrollTop = channelScroll;
    }
    if (focusKey) {
      const next = dialog.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`);
      if (next && !(next as HTMLButtonElement).disabled && next.offsetParent !== null) {
        next.focus({ preventScroll: true });
        if (typed && next instanceof HTMLInputElement) {
          next.value = typed.value;
          next.dataset.typed = '1';
          next.setSelectionRange(typed.start, typed.end);
        }
      }
    }
  }

  private focusFirst(): void {
    const target = this.root?.querySelector<HTMLElement>('[data-key="add"], [data-autofocus]');
    target?.focus();
  }

  private btn(label: string, key: string, onClick: () => void, cls = '', title?: string): HTMLButtonElement {
    const b = button(label, onClick, cls);
    b.dataset.key = key;
    b.disabled = this.busy;
    if (title) b.title = title;
    return b;
  }

  /** A text control that commits on change. `commit` returns a reason to refuse it. */
  private input(key: string, value: string, label: string, commit: (text: string) => string | null | void,
    opts: { decimal?: boolean; placeholder?: string; size?: number } = {}): HTMLInputElement {
    const input = h('input', { class: 'field__input', type: 'text', value, 'aria-label': label, dataset: { key },
      inputMode: opts.decimal ? 'decimal' : 'text', placeholder: opts.placeholder ?? '', size: opts.size ?? 8,
      spellcheck: false, disabled: this.busy });
    input.addEventListener('input', () => {
      input.dataset.typed = '1';
      input.removeAttribute('aria-invalid');
    });
    input.addEventListener('change', () => {
      delete input.dataset.typed;
      const problem = commit(input.value);
      if (problem) {
        input.setAttribute('aria-invalid', 'true');
        this.status = { text: problem, tone: 'bad' };
        const status = this.root?.querySelector('.test-data__message');
        if (status) { status.textContent = problem; status.className = 'fds-export__status test-data__message test-data__message--bad'; }
      }
    });
    return input;
  }

  private field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    return h('label', { class: 'test-data__field' }, [h('span', { class: 'field__label', title: hint ?? '' }, [label]), control]);
  }

  // -- the sources list -----------------------------------------------------

  private renderList(): { body: HTMLElement; actions: HTMLElement[] } {
    const sources = this.store.document.testData ?? [];
    const issues = testDataChecks(this.store.document);
    const body = h('div', { class: 'test-data__list' });
    if (!sources.length) {
      body.append(h('p', { class: 'panel__hint' }, [
        'No sources yet. Add a logger workbook, a processed sheet, an FDS _devc.csv or _hrr.csv, or a plain table, '
        + 'then map its channels to the gauges, thermocouple beads and burners.']));
    }
    body.append(h('ul', { class: 'test-data__sources' }, sources.map((source) => {
      const entry = this.data.get(source.id);
      const status = statusText(entry?.status ?? 'unloaded', entry?.error);
      const mapped = source.channels.length;
      const loadedText = entry?.status === 'loaded' || entry?.status === 'embedded'
        ? ` · ${entry.series.length} of ${mapped} mapping${mapped === 1 ? '' : 's'} plotting` : ` · ${mapped} mapping${mapped === 1 ? '' : 's'}`;
      const card = h('li', { class: 'test-data__source', dataset: { sourceId: source.id } }, [
        h('div', { class: 'test-data__source-head' }, [
          h('strong', {}, [source.name || source.id]),
          h('span', { class: `import__chip test-data__role test-data__role--${source.role}` }, [source.role === 'measured' ? 'Measured' : 'Simulated']),
          h('span', { class: 'test-data__file', title: source.file.path }, [
            `${fileName(source.file.path)}${source.table.sheet ? ` · ${source.table.sheet}` : ''}`
            + `${source.timeOffset_s ? ` · ignition at ${precise(source.timeOffset_s)} s` : ''}`]),
        ]),
        h('p', { class: `test-data__status test-data__status--${status.tone}` }, [status.text, entry?.status === 'error' ? '' : loadedText]),
      ]);
      if (entry?.mismatches.length) {
        card.append(h('div', { class: 'test-data__mismatch', role: 'note' }, [
          h('p', {}, [`The file differs from the one the plan recorded: ${entry.mismatches.join(' ')}`]),
          this.btn('Accept the file as read', `accept:${source.id}`, () => this.accept(source.id), '',
            'Record this file\'s size, modification time and channels in the plan. One undoable edit.'),
        ]));
      }
      for (const issue of issues.filter((i) => i.sourceId === source.id)) {
        card.append(h('p', { class: 'test-data__issue' }, [h('code', {}, [issue.code]), ' ', issue.message]));
      }
      const actions = h('div', { class: 'linked-file__actions' });
      actions.append(...this.loadActions(source, entry));
      actions.append(
        this.btn('Edit…', `edit:${source.id}`, () => { this.view = { kind: 'edit', sourceId: source.id }; this.status = null; this.filter = ''; this.render(); this.focusFirst(); }),
        this.btn('Remove', `remove:${source.id}`, () => this.remove(source.id), 'btn--danger', 'Remove this source and its mappings; the file stays on disk'),
      );
      card.append(actions);
      return card;
    })));
    const add = this.btn('Add a source…', 'add', () => { void this.add(); }, 'btn--primary');
    const inputs = shell() ? [] : [this.fileInput('add-file', 'Test data file to add', (file) => { void this.addFile(file); })];
    return { body, actions: [...inputs, this.btn('Close', 'close', () => this.close()), add] };
  }

  /** The hidden file input a browser tab needs; its button clicks it. */
  private fileInput(key: string, label: string, onFile: (file: File) => void): HTMLInputElement {
    const input = h('input', { type: 'file', accept: ACCEPT, hidden: true, 'aria-label': label, dataset: { key } });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) onFile(file);
    });
    return input;
  }

  /** Choose file… in a browser tab; Load data for a network share; Reload otherwise. */
  private loadActions(source: TestDataSource, entry: TestDataEntry | undefined): HTMLElement[] {
    const bridge = shell();
    const status = entry?.status ?? 'unloaded';
    if (!bridge) {
      const input = this.fileInput(`file:${source.id}`, `File for ${source.name}`, (file) => this.attach(source.id, file));
      input.dataset.sourceId = source.id;
      const known = this.files.get(source.id);
      return [input,
        this.btn(status === 'loaded' ? 'Choose another file…' : 'Choose file…', `choose:${source.id}`, () => input.click(),
          status === 'needs-file' || status === 'embedded' ? 'btn--primary' : '',
          `Pick ${fileName(source.file.path)} in this browser tab. Reading it is not an edit.`),
        ...(known && status !== 'loading' ? [this.btn('Reload', `reload:${source.id}`, () => this.attach(source.id, known),
          '', 'Read the chosen file again')] : [])];
    }
    if (status === 'needs-load') {
      return [this.btn('Load data', `load:${source.id}`, () => { void this.act(async () => { await this.data.load(source.id); }); }, 'btn--primary',
        'Read this file from the network share now')];
    }
    return [this.btn('Reload', `reload:${source.id}`, () => { void this.reload(source.id); }, '',
      isNetworkPath(source.file.path) ? 'Read the file from the network share again' : 'Read the file from disk again')];
  }

  private attach(sourceId: string, file: File): void {
    this.files.set(sourceId, file);
    this.drafts.delete(sourceId);
    void this.act(async () => {
      const source = this.source(sourceId);
      await this.data.attachFile(sourceId, file);
      if (source && file.name !== fileName(source.file.path)) {
        this.status = { text: `Read ${file.name} for ${fileName(source.file.path)}. The plan keeps its own file name.`, tone: 'warn' };
        this.render();
      }
    });
  }

  private reload(sourceId: string): Promise<void> {
    const bridge = shell();
    const source = this.source(sourceId);
    if (!bridge || !source) return Promise.resolve();
    this.drafts.delete(sourceId);
    return this.act(async () => {
      const read = await bridge.readTestDataFile(source.file.path);
      await this.data.attachBytes(sourceId, fileName(source.file.path), read);
    });
  }

  private edit(sourceId: string, label: string, mutate: (source: TestDataSource) => void): void {
    this.store.edit(label, (doc) => {
      const source = doc.testData?.find((s) => s.id === sourceId);
      if (source) mutate(source);
    });
    this.store.commit();
  }

  private remove(sourceId: string): void {
    this.store.edit('Remove test data source', (doc) => {
      doc.testData = doc.testData?.filter((s) => s.id !== sourceId);
      if (!doc.testData?.length) delete doc.testData;
    });
    this.store.commit();
    this.drafts.delete(sourceId);
    this.view = { kind: 'list' };
    this.setStatus('Source removed. Undo puts it back.');
  }

  /** The manifest re-recorded from the file as read now, dropping mappings it no longer has. */
  private accept(sourceId: string): void {
    const source = this.source(sourceId), context = source && this.context(source);
    if (!source || !context) return;
    const names = new Set(extract(context.grid, source.table, context.units).channels.map((c) => c.name));
    const kept = source.channels.filter((c) => names.has(c.channel));
    const manifest = manifestFor({ ...source, channels: kept }, context.grid, context.fileInfo);
    this.edit(sourceId, 'Accept test data file', (s) => { s.channels = kept; s.manifest = manifest; });
    const dropped = source.channels.length - kept.length;
    this.setStatus(dropped ? `Recorded the file as read; ${dropped} mapping${dropped > 1 ? 's' : ''} removed, their channels are gone.`
      : 'Recorded the file as read.', dropped ? 'warn' : 'good');
  }

  // -- adding a source --------------------------------------------------------

  private async add(): Promise<void> {
    const bridge = shell();
    if (!bridge) {
      this.root?.querySelector<HTMLInputElement>('[data-key="add-file"]')?.click();
      return;
    }
    await this.run(async () => {
      const picked = await bridge.pickLinkedFiles('spreadsheet');
      if (!picked.length) return;
      const path = picked[0].path;
      const read = await bridge.readTestDataFile(path);
      await this.draft({ path, bytes: read.bytes, modified: read.modified });
      if (picked.length > 1) this.status = { text: 'Added one source at a time: the first file chosen is shown.', tone: 'warn' };
    });
  }

  private async addFile(file: File): Promise<void> {
    await this.run(async () => {
      if (file.size > TEST_DATA_FILE_CAP) throw new Error('Test data exceeds the 64 MiB limit.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      await this.draft({ path: file.name, bytes, modified: new Date(file.lastModified).toISOString(), file });
    });
  }

  /** Read every sheet with progress; Cancel aborts at the next sheet. */
  private async readDraft(name: string, bytes: Uint8Array): Promise<Draft> {
    const abort = new AbortController();
    const previous = this.view;
    const reading: View & { kind: 'reading' } = { kind: 'reading', name, abort, text: `Reading ${name}…`, step: 0, steps: 1 };
    this.view = reading;
    this.render();
    this.root?.querySelector<HTMLElement>('[data-key="cancel-reading"]')?.focus();
    try {
      return await this.data.draftFromFile(name, bytes, { signal: abort.signal, onProgress: ({ step, steps, sheet }) => {
        reading.step = step;
        reading.steps = steps;
        reading.text = sheet === null ? `Reading ${name}: workbook metadata (step ${step} of ${steps})`
          : `Reading ${name}: step ${step} of ${steps}, sheet ${sheet}`;
        const bar = this.progress?.querySelector('progress');
        const text = this.progress?.querySelector('p');
        if (bar) { bar.max = steps; bar.value = step; }
        if (text) text.textContent = reading.text;
      } });
    } finally {
      if (this.view.kind === 'reading') this.view = previous;
    }
  }

  private async draft(file: { path: string; bytes: Uint8Array; modified: string | null; file?: File }): Promise<void> {
    const name = fileName(file.path);
    const draft = await this.readDraft(name, file.bytes);
    const cached: Cached = { path: file.path, draft, size: file.bytes.length, modified: file.modified, bytes: file.bytes, file: file.file };
    const index = draft.defaultSheetIndex;
    if (index === null) throw new Error(`${name} has no time series on any sheet.`);
    const sheet = draft.sheets[index];
    const source: TestDataSource = {
      id: nextSourceId(this.store.document), name, role: defaultRole(sheet.table),
      file: { id: `file-${crypto.randomUUID()}`, kind: 'spreadsheet', path: file.path },
      table: { ...sheet.table }, channels: [], manifest: { size: cached.size, modified: cached.modified, rows: sheet.grid.length, channels: [] },
    };
    const pending: Pending = { cached, source, suggested: new Set(), roleTouched: false };
    this.suggest(pending, index);
    this.view = { kind: 'new', pending };
    this.filter = '';
    this.status = pending.suggested.size
      ? { text: `${pending.suggested.size} channel${pending.suggested.size > 1 ? 's' : ''} pre-selected from matching FDS names. Check them before adding.`, tone: 'dim' }
      : null;
  }

  /** A sheet's exact-name suggestions, with gauge constants pre-filled. */
  private suggest(pending: Pending, index: number): void {
    const sheet = pending.cached.draft.sheets[index];
    const targets = targetOptions(this.store.document, this.store.displayUnit);
    pending.suggested = new Set();
    pending.source.channels = sheet.suggestedMappings.map((m) => {
      const channel = sheet.channels.find((c) => c.name === m.channel)!;
      const target = targets.find((t) => t.key === targetKey(m));
      pending.suggested.add(`${m.channel}\0${targetKey(m)}`);
      return target ? { ...m, ...prefill(channel, target) } : m;
    });
  }

  private commitNew(pending: Pending): void {
    const source = structuredClone(pending.source);
    const context = this.context(source, pending);
    if (!context) return;
    try {
      source.manifest = manifestFor(source, context.grid, context.fileInfo);
    } catch (err) { this.setStatus((err as Error).message, 'bad'); return; }
    if (this.store.document.testData?.some((s) => s.id === source.id)) source.id = nextSourceId(this.store.document);
    const problem = testDataProblem([...(this.store.document.testData ?? []), source]);
    if (problem) { this.setStatus(problem, 'bad'); return; }
    this.store.edit('Add test data source', (doc) => { (doc.testData ??= []).push(source); });
    this.store.commit();
    const cached = pending.cached;
    this.drafts.set(source.id, cached);
    if (cached.file) { this.files.set(source.id, cached.file); void this.data.attachFile(source.id, cached.file).catch(() => {}); }
    else void this.data.attachBytes(source.id, fileName(cached.path), { bytes: cached.bytes, modified: cached.modified }).catch(() => {});
    this.view = { kind: 'edit', sourceId: source.id };
    this.setStatus(`Added ${source.name} with ${source.channels.length} mapping${source.channels.length === 1 ? '' : 's'}. Undo removes it.`, 'good');
  }

  private renderReading(view: View & { kind: 'reading' }): { body: HTMLElement; actions: HTMLElement[] } {
    const body = h('div', { class: 'test-data__reading', role: 'status', 'aria-live': 'polite' }, [
      h('p', {}, [view.text]),
      h('progress', { max: view.steps, value: view.step, 'aria-label': 'Reading progress' }),
      h('p', { class: 'panel__hint' }, ['Every sheet is read so the sheet can be changed without reading the file again. A large workbook takes a few seconds.']),
    ]);
    const cancel = button('Cancel', () => { if (this.view.kind === 'reading') this.view.abort.abort(); });
    cancel.dataset.key = 'cancel-reading';
    cancel.dataset.autofocus = '';
    return { body, actions: [cancel] };
  }

  // -- the editor -------------------------------------------------------------

  /** The grid this source's layout reads: a draft of the file when there is one, else the loaded sheet. */
  private context(source: TestDataSource, pending?: Pending | null, table: TestDataTable = source.table): Context | null {
    const cached = pending?.cached ?? this.drafts.get(source.id);
    if (cached && cached.path === source.file.path) {
      const sheet = cached.draft.sheets.find((s) => s.name === table.sheet);
      if (sheet) {
        const units = table.unitsSheet === undefined ? new Map<string, string>()
          : table.unitsSheet === null ? sheet.units
            : channelUnits(cached.draft.sheets.find((s) => s.name === table.unitsSheet)?.grid ?? sheet.grid);
        return { grid: sheet.grid, units, fileInfo: { size: cached.size, modified: cached.modified, units } };
      }
    }
    const entry = this.data.get(source.id);
    if (entry?.grid && entry.fileInfo && table.sheet === source.table.sheet && table.unitsSheet === source.table.unitsSheet) {
      const units = entry.units ?? new Map<string, string>();
      return { grid: entry.grid, units, fileInfo: { ...entry.fileInfo, units } };
    }
    return null;
  }

  private renderEditor(source: TestDataSource, pending: Pending | null): { body: HTMLElement; actions: HTMLElement[] } {
    const context = this.context(source, pending);
    const cached = pending?.cached ?? (this.drafts.get(source.id)?.path === source.file.path ? this.drafts.get(source.id) : undefined);
    const apply = (label: string, mutate: (s: TestDataSource) => void): void => {
      if (pending) { mutate(pending.source); this.render(); } else this.edit(source.id, label, mutate);
    };
    const body = h('div', { class: 'test-data__editor' }, [
      this.sourceFields(source, pending, cached, apply),
      this.tableSection(source, pending, cached, context, apply),
      this.channelSection(source, pending, context, apply),
    ]);
    const actions = pending
      ? [this.btn('Cancel', 'cancel-new', () => { this.view = { kind: 'list' }; this.status = null; this.render(); this.focusFirst(); }),
        this.btn('Add source', 'commit-new', () => this.commitNew(pending), 'btn--primary',
          'Add this source and its mappings to the plan, as one undoable edit')]
      : [this.btn('Remove source', `remove:${source.id}`, () => this.remove(source.id), 'btn--danger'),
        this.btn('Back to sources', 'back', () => { this.view = { kind: 'list' }; this.status = null; this.render(); this.focusFirst(); }),
        this.btn('Close', 'close', () => this.close())];
    return { body, actions };
  }

  private sourceFields(source: TestDataSource, pending: Pending | null, cached: Cached | undefined,
    apply: (label: string, mutate: (s: TestDataSource) => void) => void): HTMLElement {
    const name = this.input('name', source.name, 'Source name', (text) => {
      if (!text.trim()) return 'A source needs a name: it labels the plots.';
      apply('Rename test data source', (s) => { s.name = text.trim(); });
      return null;
    }, { size: 22 });
    name.dataset.autofocus = '';
    const role = h('select', { class: 'field__input', 'aria-label': 'Role', dataset: { key: 'role' }, disabled: this.busy,
      onchange: (e: Event) => {
        if (pending) pending.roleTouched = true;
        apply('Set test data role', (s) => { s.role = (e.target as HTMLSelectElement).value as TestDataSource['role']; });
      } }, (['measured', 'simulated'] as const).map((r) => h('option', { value: r, selected: source.role === r }, [r === 'measured' ? 'Measured' : 'Simulated'])));
    const offset = this.input('offset', source.timeOffset_s === undefined ? '' : precise(source.timeOffset_s), 'Ignition at (s)', (text) => {
      const v = parseNumber(text);
      if (Number.isNaN(v)) return 'The time offset is a number of seconds.';
      apply('Set test data time offset', (s) => { if (v === null || v === 0) delete s.timeOffset_s; else s.timeOffset_s = v; });
      return null;
    }, { decimal: true, placeholder: '0', size: 8 });
    const hint = cached?.draft.shiftHint;
    const offsetHelp = h('div', { class: 'test-data__offset-help' }, [
      h('p', { class: 'panel__hint' }, ['Plan time is seconds from ignition. Enter this file\'s own time at ignition; it is subtracted from every sample. A sheet already shifted to ignition has 0.']),
      hint && hint.seconds !== (source.timeOffset_s ?? 0)
        ? this.btn(shiftHintLabel(hint), 'shift-hint', () => apply('Set test data time offset', (s) => { s.timeOffset_s = hint.seconds; }), '',
          `The workbook's processed sheets record a ${fmt(hint.seconds)} s shift to ignition. Use it when this sheet is not already shifted.`)
        : null,
    ]);
    return h('section', { class: 'test-data__section', 'aria-label': 'Source' }, [
      h('div', { class: 'test-data__row' }, [
        this.field('Name', name),
        this.field('Role', role, 'Measured: a data-acquisition channel. Simulated: an FDS device or other model output.'),
        this.field('Ignition at (s)', offset, 'The file\'s own time at ignition'),
      ]),
      offsetHelp,
    ]);
  }

  private tableSection(source: TestDataSource, pending: Pending | null, cached: Cached | undefined, context: Context | null,
    apply: (label: string, mutate: (s: TestDataSource) => void) => void): HTMLElement {
    const table = source.table;
    const section = h('section', { class: 'test-data__section', 'aria-labelledby': 'test-data-table' }, [
      h('h3', { class: 'panel__section', id: 'test-data-table' }, ['File and layout']),
      h('p', { class: 'test-data__path', title: source.file.path }, [source.file.path]),
    ]);
    /** A layout change: drop mappings whose channels the new layout lacks, and re-record the manifest. */
    const setTable = (next: TestDataTable, label = 'Change test data layout'): void => {
      const ctx = this.context(source, pending, next);
      if (!ctx) { this.setStatus('Read the file before changing its layout.', 'warn'); return; }
      let channels: Channel[];
      try { channels = extract(ctx.grid, next, ctx.units).channels; }
      catch (err) { this.setStatus((err as Error).message, 'bad'); return; }
      if (pending) {
        const index = cached!.draft.sheets.findIndex((s) => s.name === next.sheet);
        pending.source.table = next;
        if (next.sheet !== table.sheet) {
          this.suggest(pending, index);
          if (!pending.roleTouched) pending.source.role = defaultRole(next);
        }
        const names = new Set(channels.map((c) => c.name));
        pending.source.channels = pending.source.channels.filter((c) => names.has(c.channel));
        this.status = null;
        this.render();
        return;
      }
      const names = new Set(channels.map((c) => c.name));
      const kept = source.channels.filter((c) => names.has(c.channel));
      const manifest = manifestFor({ ...source, table: next, channels: kept }, ctx.grid, ctx.fileInfo);
      const dropped = source.channels.length - kept.length;
      apply(label, (s) => { s.table = next; s.channels = kept; s.manifest = manifest; });
      this.setStatus(dropped ? `${dropped} mapping${dropped > 1 ? 's' : ''} removed: their channels are not in this layout. Undo restores them.` : 'Layout changed.',
        dropped ? 'warn' : 'dim');
    };

    // Sheet: every sheet of the draft, or the current one with a way to read the rest.
    const sheets = cached?.draft.sheets.filter((s) => s.name !== null) ?? [];
    let sheetControl: HTMLElement;
    if (table.sheet === null) sheetControl = h('span', { class: 'field__static' }, ['Delimited text, one table']);
    else if (sheets.length) {
      sheetControl = h('select', { class: 'field__input', 'aria-label': 'Sheet', dataset: { key: 'sheet' }, disabled: this.busy,
        onchange: (e: Event) => {
          const sheet = sheets.find((s) => s.name === (e.target as HTMLSelectElement).value)!;
          setTable({ ...sheet.table, ...(table.unitsSheet !== undefined ? { unitsSheet: table.unitsSheet } : {}) }, 'Change test data sheet');
        } }, sheets.map((s) => h('option', { value: s.name!, selected: s.name === table.sheet },
        [`${s.name} · ${s.channelCount ? `${SHAPE_SHORT[s.table.shape]}, ${s.channelCount} channel${s.channelCount === 1 ? '' : 's'}` : 'no time series'}`])));
    } else {
      const canRead = Boolean(shell()) || this.files.has(source.id);
      sheetControl = h('div', { class: 'test-data__inline' }, [
        h('span', { class: 'field__static' }, [table.sheet]),
        canRead ? this.btn('Read all sheets…', 'read-sheets', () => { void this.redraft(source.id); }, '',
          'Read every sheet of the file so another can be chosen') : null,
      ]);
    }
    const detected = context ? (cached?.draft.sheets.find((s) => s.name === table.sheet)?.table ?? { sheet: table.sheet, ...detectShape(context.grid) }) : null;
    const disabled = this.busy || !context;
    const shape = h('select', { class: 'field__input', 'aria-label': 'Shape', dataset: { key: 'shape' }, disabled,
      onchange: (e: Event) => {
        const next = (e.target as HTMLSelectElement).value as TestDataTable['shape'];
        setTable({ ...table, shape: next, timeColumn: next === 'paired-time' ? null : table.timeColumn ?? 0 });
      } }, (Object.keys(SHAPES) as TestDataTable['shape'][]).map((s) => h('option', { value: s, selected: s === table.shape }, [SHAPES[s]])));
    const rows = context?.grid.length ?? Infinity;
    const rowInput = (key: 'headerRow' | 'unitsRow' | 'dataRow', label: string): HTMLInputElement => {
      const input = this.input(key, table[key] === null ? '' : String(table[key]), label, (text) => {
        const v = parseNumber(text);
        if (v === null && key === 'unitsRow') { setTable({ ...table, unitsRow: null }); return null; }
        if (v === null || !Number.isInteger(v) || v < 1 || v > rows) return `${label} is a sheet row from 1 to ${rows}.`;
        setTable({ ...table, [key]: v });
        return null;
      }, { decimal: true, size: 4, placeholder: key === 'unitsRow' ? 'none' : '' });
      input.disabled = disabled;
      return input;
    };
    const width = context ? Math.max(0, ...context.grid.map((r) => r.length)) : 0;
    const header = context?.grid[table.headerRow - 1] ?? [];
    const time = h('select', { class: 'field__input', 'aria-label': 'Time column', dataset: { key: 'timeColumn' },
      disabled: disabled || table.shape === 'paired-time',
      onchange: (e: Event) => setTable({ ...table, timeColumn: Number((e.target as HTMLSelectElement).value) }) },
    table.shape === 'paired-time' ? [h('option', { value: '' }, ['Each channel\'s own _Time column'])]
      : Array.from({ length: Math.max(width, (table.timeColumn ?? 0) + 1) }, (_, c) => h('option', { value: c, selected: c === table.timeColumn },
        [`${columnName(c)}${typeof header[c] === 'string' && header[c] ? `: ${String(header[c]).slice(0, 24)}` : ''}`])));
    section.append(h('div', { class: 'test-data__row test-data__row--layout' }, [
      this.field('Sheet', sheetControl),
      this.field('Shape', shape),
      this.field('Names row', rowInput('headerRow', 'Names row'), 'The row with the channel names. A processed sheet composes names from every row above the data.'),
      this.field('Units row', rowInput('unitsRow', 'Units row'), 'Empty when the sheet has none; metadata tables can still supply units'),
      this.field('First data row', rowInput('dataRow', 'First data row')),
      this.field('Time column', time),
    ]));
    if (detected) {
      const same = detected.shape === table.shape && detected.headerRow === table.headerRow && detected.unitsRow === table.unitsRow
        && detected.dataRow === table.dataRow && detected.timeColumn === table.timeColumn;
      section.append(h('div', { class: 'test-data__inline' }, [
        h('p', { class: 'panel__hint' }, [`${same ? 'Detected' : 'Changed from the detected'} layout: ${SHAPES[detected.shape]}, `
          + `names in row ${detected.headerRow}${detected.unitsRow ? `, units in row ${detected.unitsRow}` : ''}, data from row ${detected.dataRow}`
          + `${detected.timeColumn === null ? '' : `, time in column ${columnName(detected.timeColumn)}`}.`]),
        same ? null : this.btn('Use detected', 'use-detected', () => setTable({ ...table, shape: detected.shape, headerRow: detected.headerRow,
          unitsRow: detected.unitsRow, dataRow: detected.dataRow, timeColumn: detected.timeColumn })),
      ]));
    }
    if (context) section.append(this.preview(context.grid, table));
    else {
      const entry = this.data.get(source.id);
      section.append(h('div', { class: 'test-data__inline' }, [
        h('p', { class: 'panel__hint' }, [entry?.status === 'embedded'
          ? 'This shared page carries the mapped series, not the file. Choose the original file to change the sheet or layout, or to map other channels.'
          : 'The file is not loaded, so the preview and the layout are unavailable. The mappings below come from the plan\'s manifest.']),
        ...this.loadActions(source, entry),
      ]));
    }
    return section;
  }

  /** Read every sheet of an existing source's file, for the sheet selector. */
  private redraft(sourceId: string): Promise<void> {
    const source = this.source(sourceId);
    if (!source) return Promise.resolve();
    return this.run(async () => {
      let bytes: Uint8Array, modified: string | null, file: File | undefined;
      const bridge = shell();
      if (bridge) ({ bytes, modified } = await bridge.readTestDataFile(source.file.path));
      else {
        file = this.files.get(sourceId);
        if (!file) throw new Error('Choose the file in this browser tab first.');
        bytes = new Uint8Array(await file.arrayBuffer());
        modified = new Date(file.lastModified).toISOString();
      }
      const draft = await this.readDraft(fileName(source.file.path), bytes);
      this.drafts.set(sourceId, { path: source.file.path, draft, size: bytes.length, modified, bytes, file });
    });
  }

  /** The first rows of the sheet, with the names, units and first data rows and the time column marked. */
  private preview(grid: Grid, table: TestDataTable): HTMLElement {
    const rows = previewRows(grid.length, table);
    const width = Math.max(0, ...rows.map((r) => (r === null ? 0 : grid[r - 1]?.length ?? 0)));
    const errors = new Map((grid.errors ?? []).map((e) => [`${e.row},${e.column}`, e.code]));
    const header = grid[table.headerRow - 1] ?? [];
    const timeColumns = new Set(table.shape === 'paired-time'
      ? header.flatMap((v, c) => (typeof v === 'string' && /_Time\*?$/i.test(v.trim()) ? [c] : []))
      : table.timeColumn === null ? [] : [table.timeColumn]);
    const mark = (r: number): string | null => r === table.headerRow ? 'names' : r === table.unitsRow ? 'units' : r === table.dataRow ? 'data' : null;
    const head = h('tr', {}, [h('th', { scope: 'col' }, ['Row']), ...Array.from({ length: width }, (_, c) =>
      h('th', { scope: 'col', class: timeColumns.has(c) ? 'test-data__time' : '' }, [columnName(c), timeColumns.has(c) ? h('span', { class: 'test-data__tag' }, ['time']) : null]))]);
    const body = rows.map((r) => {
      if (r === null) return h('tr', { class: 'test-data__gap' }, [h('td', { colSpan: width + 1 }, ['⋮'])]);
      const tag = mark(r);
      return h('tr', { class: `${tag ? `test-data__mark test-data__mark--${tag}` : ''}${r > table.dataRow ? ' test-data__datarow' : ''}` }, [
        h('th', { scope: 'row' }, [String(r), tag ? h('span', { class: 'test-data__tag' }, [tag]) : null]),
        ...Array.from({ length: width }, (_, c) => {
          const code = errors.get(`${r},${c}`);
          const text = code ?? cellText(grid[r - 1]?.[c] ?? null);
          return h('td', { class: `${code ? 'test-data__error-cell' : ''}${timeColumns.has(c) ? ' test-data__time' : ''}`, title: text.length > 14 ? text : '' },
            [text.length > 14 ? `${text.slice(0, 13)}…` : text]);
        }),
      ]);
    });
    return h('div', { class: 'test-data__preview', role: 'region', 'aria-label': `Sheet preview, ${grid.length} rows`, tabIndex: 0 }, [
      h('table', { class: 'import__table test-data__grid' }, [h('thead', {}, [head]), h('tbody', {}, body)]),
    ]);
  }

  private channelSection(source: TestDataSource, pending: Pending | null, context: Context | null,
    apply: (label: string, mutate: (s: TestDataSource) => void) => void): HTMLElement {
    const extraction = context ? (() => { try { return extract(context.grid, source.table, context.units); } catch { return null; } })() : null;
    // The channels of the file as read, or, without the file, the plan's own record of the mapped ones.
    const channels: (ChannelInfo & { missing?: number })[] = extraction ? extraction.channels.map(info)
      : source.manifest.channels.map((c) => ({ ...c }));
    const targets = targetOptions(this.store.document, this.store.displayUnit);
    const byKey = new Map(targets.map((t) => [t.key, t]));
    const counts = new Map<string, number>();
    for (const m of source.channels) counts.set(targetKey(m), (counts.get(targetKey(m)) ?? 0) + 1);

    type Row = { channel: ChannelInfo & { missing?: number }; index: number | null; known: boolean };
    const rows: Row[] = [];
    for (const channel of channels) {
      const indices = source.channels.flatMap((m, i) => (m.channel === channel.name ? [i] : []));
      if (indices.length) for (const index of indices) rows.push({ channel, index, known: true });
      else rows.push({ channel, index: null, known: true });
    }
    source.channels.forEach((m, index) => {
      if (!channels.some((c) => c.name === m.channel)) rows.push({ channel: { name: m.channel, unit: null, samples: 0, t0: null, t1: null }, index, known: false });
    });

    const setMapping = (row: Row, key: string): void => {
      const target = key ? byKey.get(key) ?? { ...parseTargetKey(key), key, label: key, group: 'gauge' as const, unit: 'kW/m2' as const } : null;
      apply(key ? 'Map test data channel' : 'Unmap test data channel', (s) => {
        const previous = row.index === null ? undefined : s.channels[row.index];
        if (!target) { if (row.index !== null) s.channels.splice(row.index, 1); }
        else {
          const { object, bead } = parseTargetKey(target.key);
          const mapping: TestDataMapping = { channel: row.channel.name, object, ...(bead !== undefined ? { bead } : {}),
            ...prefill(row.channel, target as Target, previous) };
          if (row.index === null) s.channels.push(mapping); else s.channels[row.index] = mapping;
        }
        if (!pending) s.manifest = updateManifestChannels(s.manifest, s.channels, channels);
      });
    };
    const setNumber = (row: Row, field: 'scale' | 'offset', text: string): string | null => {
      const v = parseNumber(text);
      if (Number.isNaN(v) || (field === 'scale' && v === 0)) return field === 'scale' ? 'The scale is a non-zero number; negative calibration is allowed.' : 'The offset is a number.';
      apply(field === 'scale' ? 'Set test data scale' : 'Set test data offset', (s) => {
        const m = s.channels[row.index!];
        if (!m) return;
        if (v === null) delete m[field]; else m[field] = v;
      });
      return null;
    };

    const filter = h('input', { class: 'field__input test-data__filter', type: 'search', placeholder: 'Filter channels',
      'aria-label': 'Filter channels', value: this.filter, dataset: { key: 'filter' } });
    const body = h('tbody');
    const visible = (row: Row): boolean => !this.filter || row.channel.name.toLowerCase().includes(this.filter.toLowerCase());
    filter.addEventListener('input', () => {
      this.filter = filter.value;
      for (const tr of body.querySelectorAll<HTMLTableRowElement>('tr[data-channel]')) {
        tr.hidden = Boolean(this.filter) && !tr.dataset.channel!.toLowerCase().includes(this.filter.toLowerCase());
      }
    });
    rows.forEach((row, i) => {
      const mapping = row.index === null ? null : source.channels[row.index];
      const key = mapping ? targetKey(mapping) : '';
      const target = mapping ? byKey.get(key) : undefined;
      const select = h('select', { class: 'field__input', 'aria-label': `Instrument for ${row.channel.name}`, dataset: { key: `target:${i}:${row.channel.name}` },
        disabled: this.busy, onchange: (e: Event) => setMapping(row, (e.target as HTMLSelectElement).value) }, [
        h('option', { value: '', selected: !mapping }, ['Not mapped']),
        mapping && !target ? h('option', { value: key, selected: true }, [`Missing: ${mapping.object}${mapping.bead === undefined ? '' : ` bead ${mapping.bead + 1}`}`]) : null,
        ...(['gauge', 'thermocouple', 'burner'] as const).map((group) => {
          const list = targets.filter((t) => t.group === group);
          return list.length ? h('optgroup', { label: group === 'gauge' ? 'Heat flux gauges' : group === 'thermocouple' ? 'Thermocouple beads' : 'Burners (HRR)' },
            list.map((t) => h('option', { value: t.key, selected: t.key === key }, [t.label]))) : null;
        }),
      ]);
      const notes: HTMLElement[] = [];
      if (!row.known) notes.push(h('span', { class: 'test-data__note test-data__note--warn' }, ['Not in the file as read: unmap it or fix the layout.']));
      if (mapping && !target) notes.push(h('span', { class: 'test-data__note test-data__note--warn' }, ['The instrument is gone or cannot take this mapping.']));
      if (mapping && (counts.get(key) ?? 0) > 1) notes.push(h('span', { class: 'test-data__note test-data__note--warn' }, ['Another channel of this source maps the same instrument; neither plots until one is changed.']));
      if (pending && mapping && pending.suggested.has(`${row.channel.name}\0${key}`)) notes.push(h('span', { class: 'test-data__badge', title: 'The channel name equals this instrument\'s name or its exported FDS device ID' }, ['suggested']));
      const note = mapping ? mappingNote(row.channel, target, mapping) : null;
      if (note) notes.push(h('span', { class: `test-data__note test-data__note--${note.tone}` }, [note.text]));
      if (!mapping && extraction && row.channel.unit !== null) {
        const hint = calibrationHint(row.channel.name, row.channel.unit);
        if (hint) notes.push(h('span', { class: 'test-data__note' }, [`Gauge constant in the name: ${fmt(hint.inputUnit === 'V' ? hint.scale / 1000 : hint.scale)} kW/m² per mV`]));
      }
      const scale = this.input(`scale:${i}:${row.channel.name}`, mapping?.scale === undefined ? '' : precise(mapping.scale), `Scale for ${row.channel.name}`,
        (text) => setNumber(row, 'scale', text), { decimal: true, placeholder: '1', size: 7 });
      const offset = this.input(`offset:${i}:${row.channel.name}`, mapping?.offset === undefined ? '' : precise(mapping.offset), `Offset for ${row.channel.name}`,
        (text) => setNumber(row, 'offset', text), { decimal: true, placeholder: '0', size: 6 });
      scale.disabled ||= !mapping;
      offset.disabled ||= !mapping;
      const span = row.channel.t0 === null ? '–' : `${fmt(row.channel.t0)} to ${fmt(row.channel.t1!)}`;
      const tr = h('tr', { dataset: { channel: row.channel.name }, class: mapping ? 'test-data__mapped' : '' }, [
        h('th', { scope: 'row' }, [h('span', { class: 'test-data__channel' }, [row.channel.name]), notes.length ? h('span', { class: 'test-data__notes' }, notes) : null]),
        h('td', {}, [row.channel.unit === null ? '–' : unitLabel(row.channel.unit)]),
        h('td', { class: 'import__num' }, [`${row.channel.samples.toLocaleString()}${row.channel.missing ? ` (${row.channel.missing} missing)` : ''}`]),
        h('td', { class: 'import__num' }, [span]),
        h('td', {}, [select]),
        h('td', {}, [scale]),
        h('td', {}, [offset]),
      ]);
      tr.hidden = !visible(row);
      body.append(tr);
    });
    const mapped = source.channels.length;
    const section = h('section', { class: 'test-data__section', 'aria-labelledby': 'test-data-channels' }, [
      h('div', { class: 'test-data__inline test-data__inline--spread' }, [
        h('h3', { class: 'panel__section', id: 'test-data-channels' }, [`Channels`, h('span', { class: 'panel__count' },
          [`${channels.length} in ${extraction ? 'the file' : 'the manifest'} · ${mapped} mapped`])]),
        filter,
      ]),
      h('div', { class: 'test-data__channels' }, [h('table', { class: 'import__table test-data__map' }, [
        h('thead', {}, [h('tr', {}, ['Channel', 'Unit', 'Samples', 'File time (s)', 'Instrument', 'Scale', 'Offset'].map((t) => h('th', { scope: 'col' }, [t])))]),
        body,
      ])]),
      h('p', { class: 'panel__hint' }, ['value = raw × scale + offset, in the instrument\'s quantity: kW/m² for a gauge, °C for a bead, kW for a burner. '
        + 'Matching FDS names are suggested; nothing else is guessed.']),
    ]);
    if (extraction?.warnings.length) {
      section.append(h('details', { class: 'test-data__warnings' }, [
        h('summary', {}, [`Reader notes (${extraction.warnings.length})`]),
        h('ul', {}, extraction.warnings.slice(0, 200).map((w) => h('li', {}, [w]))),
      ]));
    }
    return section;
  }
}
