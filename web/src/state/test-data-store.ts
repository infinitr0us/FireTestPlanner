/** Session data beside the plan. Loaded bytes and samples never enter undo or Save. */
import { isNetworkPath } from '../core/linked-files';
import { beadOffsetsOf } from '../core/plan';
import { manifestMismatch, seriesKey, sourceSeries, targetUnits, type FileInfo, type Series } from '../core/test-data';
import { isThermocouple, type TestDataMapping, type TestDataSource } from '../core/types';
import { draftFromFile, parseTestData, TEST_DATA_FILE_CAP, yieldToPage,
  type Draft, type ParsedTable, type TestDataBytes, type TestDataReader } from '../io/test-data-sources';
import type { Store } from './store';

export type TestDataStatus = 'unloaded' | 'needs-load' | 'needs-file' | 'loading' | 'loaded' | 'embedded' | 'error';
export interface TestDataEntry extends Partial<ParsedTable> {
  status: TestDataStatus;
  series: Series[];
  mismatches: string[];
  fileInfo?: FileInfo;
  error?: string;
}
interface CachedEntry extends TestDataEntry {
  key: string;
  filePath: string;
  supplied?: { name: string; read: () => Promise<TestDataBytes> };
  derived?: string;
  pending?: Promise<TestDataEntry>;
  embedded?: { source: TestDataSource; series: Series[] };
}
const dataKey = (s: TestDataSource): string => JSON.stringify([s.file.path, s.table]);

export class TestDataStore {
  private entries = new Map<string, CachedEntry>();
  private listeners = new Set<() => void>();
  private documentId: number;
  private unsubscribe: () => void;

  constructor(private store: Store, private reader?: TestDataReader) {
    this.documentId = store.documentId;
    this.unsubscribe = store.subscribe(event => { if (event === 'document') this.sync(); });
    this.sync();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
  get(sourceId: string): TestDataEntry | undefined {
    return this.store.document.testData?.some(s => s.id === sourceId) ? this.entries.get(sourceId) : undefined;
  }
  seriesFor(objectId: string, bead?: number): Series[] {
    return (this.store.document.testData ?? []).flatMap(s => this.entries.get(s.id)?.series ?? [])
      .filter(s => s.objectId === objectId && s.bead === (bead ?? null));
  }
  clear(): void { this.entries.clear(); this.emit(); }
  dispose(): void { this.unsubscribe(); this.clear(); this.listeners.clear(); }
  /** Called when the desktop bridge connects; undefined selects browser file input. */
  setReader(reader?: TestDataReader): void { this.reader = reader; this.sync(); }
  draftFromFile(name: string, bytes: Uint8Array): Promise<Draft> {
    return draftFromFile(name, bytes, this.store.document);
  }

  private valid(c: TestDataMapping): boolean {
    const o = this.store.document.objects.find(o => o.id === c.object);
    return o && isThermocouple(o)
      ? c.bead !== undefined && Number.isInteger(c.bead) && c.bead >= 0 && c.bead < beadOffsetsOf(o).length
      : (o?.type === 'heatFluxSensor' || o?.type === 'burner') && c.bead === undefined;
  }
  private derive(source: TestDataSource, entry: CachedEntry): void {
    const channels = source.channels.filter(c => this.valid(c));
    const targets = targetUnits(this.store.document.objects);
    const signature = JSON.stringify([source, channels.map(c => [c, targets.get(c.object)])]);
    if (entry.derived === signature) return;
    entry.derived = signature;
    entry.series = [];
    delete entry.error;
    try {
      if (entry.grid && entry.fileInfo) {
        entry.mismatches = manifestMismatch(source.manifest, { ...entry.fileInfo, table: source.table, units: entry.units }, entry.grid);
        entry.series = [...sourceSeries({ ...source, channels }, entry.grid, { channels: entry.units, targets }).values()];
        entry.status = 'loaded';
      } else if (entry.embedded) {
        const original = entry.embedded;
        const seen = new Set<string>();
        const result: Series[] = [];
        for (const c of channels) {
          if (!Number.isFinite(c.scale ?? 1) || (c.scale ?? 1) === 0 || !Number.isFinite(c.offset ?? 0)
            || !Number.isFinite(source.timeOffset_s ?? 0)) throw new Error('Invalid test data calibration or time offset.');
          const key = seriesKey(c.object, c.bead);
          if (seen.has(key)) throw new Error(`Source "${source.name}" maps target ${key} more than once.`);
          seen.add(key);
          const old = original.source.channels.find(m => m.channel === c.channel);
          const series = old && original.series.find(s => seriesKey(s.objectId, s.bead) === seriesKey(old.object, old.bead));
          if (!old || !series) throw new Error(`Channel "${c.channel}" was not embedded. Pick the original file to load it.`);
          const sameCalibration = (c.scale ?? 1) === (old.scale ?? 1) && (c.offset ?? 0) === (old.offset ?? 0);
          const shift = (original.source.timeOffset_s ?? 0) - (source.timeOffset_s ?? 0);
          const t = shift === 0 ? series.t : Float64Array.from(series.t, t => t + shift);
          const values = sameCalibration ? series.values : Float64Array.from(series.values,
            v => (v - (old.offset ?? 0)) / (old.scale ?? 1) * (c.scale ?? 1) + (c.offset ?? 0));
          if (!t.every(Number.isFinite) || !values.every(Number.isFinite)) throw new Error('Test data calibration or time offset overflowed.');
          result.push({ ...series, sourceId: source.id, sourceName: source.name, role: source.role,
            objectId: c.object, bead: c.bead ?? null, unit: targets.get(c.object)!, t, values });
        }
        entry.series = result;
        entry.status = 'embedded';
      }
    } catch (err) { entry.status = 'error'; entry.error = (err as Error).message; entry.series = []; }
  }

  private sync(): void {
    if (this.documentId !== this.store.documentId) {
      this.documentId = this.store.documentId;
      this.entries.clear();
    }
    const sources = this.store.document.testData ?? [];
    // Retain completed data for undo/redo, as the flame session does. A removed
    // source is invisible through get/seriesFor and cannot finish an in-flight read.
    for (const [id, entry] of this.entries) {
      if (entry.pending && !sources.some(s => s.id === id)) this.entries.delete(id);
    }
    for (const source of sources) {
      let entry = this.entries.get(source.id);
      if (!entry || entry.key !== dataKey(source)) {
        const supplied = entry?.filePath === source.file.path ? entry.supplied : undefined;
        entry = { key: dataKey(source), filePath: source.file.path, supplied, status: 'unloaded', series: [], mismatches: [] };
        this.entries.set(source.id, entry);
      }
      if (entry.grid || entry.embedded) this.derive(source, entry);
      else if (['unloaded', 'needs-file', 'needs-load'].includes(entry.status)) {
        entry.status = entry.supplied ? 'unloaded'
          : this.reader ? (isNetworkPath(source.file.path) ? 'needs-load' : 'unloaded') : 'needs-file';
        if (entry.status === 'unloaded') void this.load(source.id).catch(() => { /* entry reports the failure */ });
      }
    }
    this.emit();
  }

  /** Explicit desktop Load data, also used for local auto-load. Errors update the entry and reject. */
  load(sourceId: string): Promise<TestDataEntry> {
    if (!this.store.document.testData?.some(s => s.id === sourceId)) return Promise.reject(new Error(`Unknown test data source: ${sourceId}`));
    const entry = this.entries.get(sourceId);
    if (entry?.pending) return entry.pending;
    if (entry && (entry.status === 'loaded' || entry.status === 'embedded')) return Promise.resolve(entry);
    if (entry?.supplied) return this.read(sourceId, entry.supplied.read, entry.supplied.name, true);
    if (!this.reader) return Promise.reject(new Error('Pick the source file in this browser tab.'));
    const reader = this.reader;
    return this.read(sourceId, source => reader(source.file.path));
  }
  attachFile(sourceId: string, file: File): Promise<TestDataEntry> {
    return this.read(sourceId, async () => {
      if (file.size > TEST_DATA_FILE_CAP) throw new Error('Test data exceeds the 64 MiB limit.');
      return { bytes: new Uint8Array(await file.arrayBuffer()), modified: new Date(file.lastModified).toISOString() };
    }, file.name, true);
  }
  attachBytes(sourceId: string, name: string, data: TestDataBytes): Promise<TestDataEntry> {
    return this.read(sourceId, async () => data, name, true);
  }
  attachEmbedded(sourceId: string, series: Series[]): void {
    const source = this.store.document.testData?.find(s => s.id === sourceId);
    if (!source) return;
    const entry: CachedEntry = { key: dataKey(source), filePath: source.file.path, status: 'embedded', series: [], mismatches: [],
      embedded: { source: structuredClone(source), series } };
    this.entries.set(sourceId, entry);
    this.derive(source, entry);
    this.emit();
  }

  private read(sourceId: string, read: (s: TestDataSource) => Promise<TestDataBytes>, name?: string, retain = false): Promise<TestDataEntry> {
    const source = this.store.document.testData?.find(s => s.id === sourceId);
    if (!source) return Promise.reject(new Error(`Unknown test data source: ${sourceId}`));
    const entry: CachedEntry = { key: dataKey(source), filePath: source.file.path, status: 'loading', series: [], mismatches: [],
      supplied: retain ? { name: name ?? source.file.path, read: () => read(source) } : undefined };
    this.entries.set(sourceId, entry);
    const current = (): boolean => this.entries.get(sourceId) === entry;
    entry.pending = (async () => {
      try {
        await yieldToPage();
        if (!current()) throw new Error('Test data load cancelled.');
        const data = await read(source);
        if (!current()) throw new Error('Test data load cancelled.');
        const parsed = await parseTestData(name ?? source.file.path, data.bytes, source.table);
        if (!current()) throw new Error('Test data load cancelled.');
        Object.assign(entry, parsed, { fileInfo: { size: data.bytes.length, modified: data.modified } });
        this.derive(this.store.document.testData!.find(s => s.id === sourceId)!, entry);
        if (entry.error) throw new Error(entry.error);
        return entry;
      } catch (err) {
        if (current()) { entry.status = 'error'; entry.error = (err as Error).message; entry.series = []; }
        throw err;
      } finally {
        delete entry.pending;
        if (current()) this.emit();
      }
    })();
    this.emit();
    return entry.pending;
  }
}
