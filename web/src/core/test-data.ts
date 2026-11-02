/** Plan-bound measured/simulated data. No I/O, interpolation or unit guessing. */
import { linkedFilesProblem } from './linked-files';
import { detectShape, extractSeries, isNumber, type Grid, type Layout } from './tables';
import type { Issue, PlanDocument, PlanObject, TestDataManifest, TestDataSource } from './types';

export type TargetUnit = 'kW/m2' | '°C' | 'kW';
export interface Series {
  sourceId: string;
  sourceName: string;
  role: 'measured' | 'simulated';
  objectId: string;
  bead: number | null;
  unit: TargetUnit;
  t: Float64Array;
  values: Float64Array;
  missing: number;
}
export interface SeriesUnits {
  /** Metadata-sheet fallback passed unchanged to extractSeries. */
  channels?: ReadonlyMap<string, string>;
  /** Authoritative target quantities, normally targetUnits(plan.objects). */
  targets?: ReadonlyMap<string, TargetUnit>;
}
export interface FileInfo {
  size: number;
  modified: string | null;
  units?: ReadonlyMap<string, string>;
  /** Supply the saved layout for mismatch checking after an override. */
  table?: Layout;
}

/** JSON tuple encoding avoids collisions even when object IDs contain separators. */
export const seriesKey = (object: string, bead?: number | null): string => JSON.stringify([object, bead ?? null]);

export function targetUnits(objects: readonly PlanObject[]): Map<string, TargetUnit> {
  const units = new Map<string, TargetUnit>();
  for (const o of objects) {
    if (o.type === 'heatFluxSensor') units.set(o.id, 'kW/m2');
    if (o.type === 'thermocouple') units.set(o.id, '°C');
    if (o.type === 'burner') units.set(o.id, 'kW');
  }
  return units;
}

export function sourceSeries(source: TestDataSource, grid: Grid, units: SeriesUnits = {}): Map<string, Series> {
  const channels = new Map(extractSeries(grid, source.table, units.channels).channels.map(c => [c.name, c]));
  const result = new Map<string, Series>();
  for (const mapping of source.channels) {
    const channel = channels.get(mapping.channel);
    if (!channel) throw new Error(`Source "${source.name}": mapped channel "${mapping.channel}" is missing.`);
    const key = seriesKey(mapping.object, mapping.bead);
    if (result.has(key)) throw new Error(`Source "${source.name}" maps target ${key} more than once.`);
    // A bead identifies the thermocouple quantity. Object IDs alone cannot tell
    // a voltage-calibrated gauge from a voltage-calibrated burner.
    const unit = units.targets?.get(mapping.object) ?? (mapping.bead !== undefined ? '°C' : undefined);
    if (!unit) throw new Error(`Target unit for object "${mapping.object}" is required.`);
    const scale = mapping.scale ?? 1, offset = mapping.offset ?? 0, shift = source.timeOffset_s ?? 0;
    if (!isNumber(scale) || scale === 0 || !isNumber(offset) || !isNumber(shift)) throw new Error('Invalid test data calibration or time offset.');
    const t = Float64Array.from(channel.t, time => time - shift);
    const values = Float64Array.from(channel.values, value => value * scale + offset);
    if (!t.every(Number.isFinite) || !values.every(Number.isFinite)) throw new Error('Test data calibration or time offset overflowed.');
    result.set(key, { sourceId: source.id, sourceName: source.name, role: source.role,
      objectId: mapping.object, bead: mapping.bead ?? null, unit, t, values, missing: channel.missing });
  }
  return result;
}

/** Endpoints plus each interior bucket's extrema, in original time order.
 * Odd budgets can leave one slot unused; maxPoints=2 keeps only endpoints. */
export function decimateMinMax(t: ArrayLike<number>, v: ArrayLike<number>, maxPoints = 2000): { t: Float64Array; values: Float64Array } {
  if (t.length !== v.length) throw new Error('Time and value arrays must have equal lengths.');
  if (!Number.isInteger(maxPoints) || maxPoints < 2) throw new Error('maxPoints must be an integer of at least 2.');
  for (let i = 0; i < t.length; i++) {
    if (!Number.isFinite(t[i]) || !Number.isFinite(v[i]) || (i > 0 && t[i] <= t[i - 1])) throw new Error('Decimation needs finite samples with strictly increasing times.');
  }
  if (t.length <= maxPoints) return { t: Float64Array.from(t), values: Float64Array.from(v) };
  const indices = [0], buckets = Math.floor((maxPoints - 2) / 2), interior = t.length - 2;
  for (let b = 0; b < buckets; b++) {
    const start = 1 + Math.floor(b * interior / buckets), end = 1 + Math.floor((b + 1) * interior / buckets);
    let low = start, high = start;
    for (let i = start + 1; i < end; i++) {
      if (v[i] < v[low]) low = i;
      if (v[i] > v[high]) high = i;
    }
    indices.push(...(low === high ? [low] : [low, high].sort((a, b) => a - b)));
  }
  indices.push(t.length - 1);
  return { t: Float64Array.from(indices, i => t[i]), values: Float64Array.from(indices, i => v[i]) };
}

export function manifestFor(source: TestDataSource, grid: Grid, fileInfo: FileInfo): TestDataManifest {
  const channels = new Map(extractSeries(grid, source.table, fileInfo.units).channels.map(c => [c.name, c]));
  return { size: fileInfo.size, modified: fileInfo.modified, rows: grid.length,
    channels: [...new Set(source.channels.map(c => c.channel))].map(name => {
      const c = channels.get(name);
      if (!c) throw new Error(`Source "${source.name}": mapped channel "${name}" is missing.`);
      return { name, unit: c.unit, samples: c.t.length, t0: c.t[0] ?? null, t1: c.t.at(-1) ?? null };
    }) };
}

export function manifestMismatch(manifest: TestDataManifest, fileInfo: FileInfo, grid: Grid): string[] {
  const changes: string[] = [];
  if (manifest.size !== fileInfo.size) changes.push('File size changed.');
  if (manifest.modified !== fileInfo.modified) changes.push('File modification time changed.');
  const channels = new Map(extractSeries(grid, fileInfo.table ?? detectShape(grid), fileInfo.units).channels.map(c => [c.name, c]));
  for (const old of manifest.channels) {
    const channel = channels.get(old.name);
    if (!channel) changes.push(`Mapped channel "${old.name}" is missing.`);
    else if (channel.unit !== old.unit) changes.push(`Unit of mapped channel "${old.name}" changed.`);
  }
  return changes;
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const integer = (v: unknown, min: number): v is number => isNumber(v) && Number.isInteger(v) && v >= min;
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const fields = (o: Record<string, unknown>, allowed: string[]): boolean => Object.keys(o).every(k => allowed.includes(k));

/** Shape validation is strict for the new closed blocks; existing open/unknown
 * object handling stays with the established validator and writers. */
export function testDataProblem(data: unknown): string | null {
  if (data === undefined) return null;
  if (!Array.isArray(data)) return 'testData must be an array.';
  const ids = new Set<string>();
  for (const s of data) {
    if (!object(s) || !text(s.id) || ids.has(s.id)) return 'Test data source IDs must be non-empty and unique.';
    ids.add(s.id);
    if (!fields(s, ['id', 'name', 'role', 'file', 'table', 'timeOffset_s', 'channels', 'manifest'])) return 'Test data source contains an unsupported field.';
    if (typeof s.name !== 'string' || typeof s.role !== 'string' || !['measured', 'simulated'].includes(s.role)) return 'Test data needs a name and a measured or simulated role.';
    if (!object(s.file)) return 'Test data needs a spreadsheet linked file.';
    const linkProblem = linkedFilesProblem({ id: s.id, type: 'heatFluxSensor', linkedFiles: [s.file] } as unknown as PlanObject);
    if (linkProblem) return linkProblem;
    const t = s.table;
    if (!object(t) || !fields(t, ['sheet', 'shape', 'headerRow', 'unitsRow', 'dataRow', 'timeColumn', 'unitsSheet'])
      || !(t.sheet === null || text(t.sheet)) || typeof t.shape !== 'string' || !['paired-time', 'processed', 'fds', 'plain'].includes(t.shape)
      || !integer(t.headerRow, 1) || !integer(t.dataRow, 1) || !(t.unitsRow === null || integer(t.unitsRow, 1))
      || !(integer(t.timeColumn, 0) || (t.shape === 'paired-time' && t.timeColumn === null))
      || ('unitsSheet' in t && (t.sheet === null || !(t.unitsSheet === null || text(t.unitsSheet))))) return 'Invalid test data table layout.';
    if ('timeOffset_s' in s && !isNumber(s.timeOffset_s)) return 'Test data timeOffset_s must be finite.';
    if (!Array.isArray(s.channels)) return 'Test data channels must be an array.';
    for (const c of s.channels) {
      if (!object(c) || !fields(c, ['channel', 'object', 'bead', 'scale', 'offset']) || !text(c.channel) || !text(c.object)
        || ('bead' in c && !integer(c.bead, 0)) || ('scale' in c && (!isNumber(c.scale) || c.scale === 0))
        || ('offset' in c && !isNumber(c.offset))) return 'Invalid test data channel mapping.';
    }
    const m = s.manifest;
    if (!object(m) || !fields(m, ['size', 'modified', 'rows', 'channels']) || !integer(m.size, 0) || !integer(m.rows, 0)
      || !(m.modified === null || typeof m.modified === 'string') || !Array.isArray(m.channels)) return 'Invalid test data manifest.';
    const names = new Set<string>();
    for (const c of m.channels) {
      if (!object(c) || !fields(c, ['name', 'unit', 'samples', 't0', 't1']) || !text(c.name) || names.has(c.name)
        || !(c.unit === null || typeof c.unit === 'string') || !integer(c.samples, 0)
        || (c.samples === 0 ? c.t0 !== null || c.t1 !== null
          : !isNumber(c.t0) || !isNumber(c.t1) || (c.samples === 1 ? c.t0 !== c.t1 : c.t0 >= c.t1))) return 'Invalid test data manifest channel.';
      names.add(c.name);
    }
    const mapped = new Set(s.channels.map(c => c.channel));
    if (names.size !== mapped.size || [...mapped].some(n => !names.has(n))) return 'Test data manifest must describe exactly the mapped channels.';
  }
  return null;
}

export function testDataChecks(plan: PlanDocument): Issue[] {
  const objects = new Map(plan.objects.map(o => [o.id, o])), issues: Issue[] = [];
  for (const source of plan.testData ?? []) {
    const seen = new Set<string>();
    for (const c of source.channels) {
      const o = objects.get(c.object), key = seriesKey(c.object, c.bead);
      const valid = o?.type === 'thermocouple'
        ? integer(c.bead, 0) && c.bead < ((o.beadOffsets_m as number[] | undefined)?.length ?? 1)
        : (o?.type === 'heatFluxSensor' || o?.type === 'burner') && c.bead === undefined;
      if (!valid) issues.push({ severity: 'warning', code: 'test-data-dangling', objectId: c.object,
        message: `Source "${source.name}": channel "${c.channel}" targets a missing or incompatible object or bead.` });
      if (seen.has(key)) issues.push({ severity: 'warning', code: 'test-data-duplicate', objectId: c.object,
        message: `Source "${source.name}" maps object "${c.object}" and bead ${c.bead ?? 'none'} more than once.` });
      seen.add(key);
    }
  }
  return issues;
}
