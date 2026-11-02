import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkPlan, newPlan } from './plan';
import { serializePlan } from './serialize';
import { parseAndValidatePlan, validateStructure } from './validate';
import { FORMAT_VERSION_LATEST, requiredFormatVersion, type PlanDocument, type TestDataSource } from './types';
import { channelUnits, readDelimited, type Grid } from './tables';
import { readSheet, workbookChannelUnits } from './xlsx';
import { decimateMinMax, manifestFor, manifestMismatch, seriesKey, sourceSeries, targetUnits, testDataProblem } from './test-data';

const folder = new URL('../../../fixtures/test-data/', import.meta.url);
const disk = readFileSync(new URL('test-data.ftp.json', folder), 'utf8');
const load = (): PlanDocument => JSON.parse(disk);
const expected = JSON.parse(readFileSync(new URL('series-expected.json', folder), 'utf8')) as {
  object: string; bead: number | null; sourceId: string; source: string; role: string; unit: string;
  samples: number; missing: number; first: number[]; last: number[];
}[];

async function read(source: TestDataSource): Promise<{ grid: Grid; units: Map<string, string>; size: number }> {
  const bytes = readFileSync(new URL(source.file.path, folder));
  if (source.table.sheet === null) return { grid: readDelimited(bytes.toString('utf8')), units: new Map(), size: bytes.length };
  const units = !('unitsSheet' in source.table) ? new Map<string, string>() : source.table.unitsSheet === null
    ? await workbookChannelUnits(bytes) : channelUnits(await readSheet(bytes, source.table.unitsSheet!));
  return { grid: await readSheet(bytes, source.table.sheet), units, size: bytes.length };
}

describe('format 1.6 test data', () => {
  it('writes the Python fixture byte for byte, with the correct version and no semantic mapping warnings', () => {
    const doc = parseAndValidatePlan(disk);
    expect(serializePlan(doc)).toBe(disk);
    expect(requiredFormatVersion(doc)).toBe('1.6.0');
    expect(FORMAT_VERSION_LATEST).toBe('1.7.0');
    expect(checkPlan(doc).filter(i => i.code.startsWith('test-data-'))).toEqual([]);
    doc.version = '1.0.0';
    expect(checkPlan(doc).some(i => i.code === 'version-understated')).toBe(true);
    expect(serializePlan(doc)).toBe(disk);
    doc.version = '2.0.0';
    expect(JSON.parse(serializePlan(doc)).version).toBe('2.0.0');
    const empty = newPlan(); empty.testData = [];
    expect(requiredFormatVersion(empty)).toBe('1.0.0');
    expect(JSON.parse(serializePlan(empty))).not.toHaveProperty('testData');
    empty.version = '1.6.0';
    expect(JSON.parse(serializePlan(empty)).version).toBe('1.6.0');
  });

  it('preserves calibration, offset, manifest and unknown-key precision and key order without mutating inputs', () => {
    const doc = load(), source = doc.testData![0];
    const tiny = 1.23456789012345e-8;
    source.channels[0].scale = tiny; source.timeOffset_s = tiny;
    source.manifest.channels[0].t0 = -tiny;
    const future = source as unknown as Record<string, unknown>;
    future.extra = { coefficient: tiny };
    const before = JSON.stringify(doc), result = JSON.parse(serializePlan(doc));
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.testData[0]).toEqual(source);
    expect(Object.keys(result).at(-1)).toBe('testData');
    expect(Object.keys(result.testData[0])).toEqual(['id', 'name', 'role', 'file', 'table', 'timeOffset_s', 'channels', 'manifest', 'extra']);
    expect(testDataProblem(doc.testData)).toMatch(/unsupported/);
  });

  it('matches every Python series summary at relative 1e-12 and the raw manifest', async () => {
    const doc = load(); let count = 0;
    for (const source of doc.testData!) {
      const { grid, units, size } = await read(source);
      const before = JSON.stringify(grid);
      const series = sourceSeries(source, grid, { channels: units, targets: targetUnits(doc.objects) });
      const info = { size, modified: null, units, table: source.table };
      expect(manifestFor(source, grid, info)).toEqual(source.manifest);
      expect(manifestMismatch(source.manifest, info, grid)).toEqual([]);
      for (const e of expected.filter(e => e.sourceId === source.id)) {
        const s = series.get(seriesKey(e.object, e.bead))!;
        expect([s.sourceName, s.role, s.unit, s.t.length, s.missing]).toEqual([e.source, e.role, e.unit, e.samples, e.missing]);
        expect(s.t).toBeInstanceOf(Float64Array); expect(s.values).toBeInstanceOf(Float64Array);
        [s.t[0], s.values[0], s.t.at(-1)!, s.values.at(-1)!].forEach((value, i) => {
          const want = [...e.first, ...e.last][i];
          expect(Math.abs(value - want)).toBeLessThanOrEqual(Math.abs(want) * 1e-12);
        });
        count++;
      }
      expect(JSON.stringify(grid)).toBe(before);
    }
    expect(count).toBe(expected.length);
  });

  it.each([
    ['source ID', (s: Record<string, any>) => { s.id = ''; }],
    ['role', s => { s.role = ['measured']; }], ['file kind', s => { s.file.kind = 'video'; }],
    ['file path', s => { s.file.path = 'https://example.test/a.xlsx'; }],
    ['file extra', s => { s.file.extra = 1; }], ['file plot', s => { s.file.plot = {}; }],
    ['shape', s => { s.table.shape = 'other'; }], ['header row', s => { s.table.headerRow = 0; }],
    ['units row', s => { s.table.unitsRow = 0.5; }], ['data row', s => { s.table.dataRow = null; }],
    ['time column', s => { s.table.shape = 'plain'; }], ['units source', s => { s.table.unitsSheet = 4; }],
    ['sheet', s => { s.table.sheet = null; }], ['scale', s => { s.channels[0].scale = 0; }],
    ['offset', s => { s.channels[0].offset = null; }], ['bead', s => { s.channels[0].bead = -1; }],
    ['time offset', s => { s.timeOffset_s = Infinity; }], ['size', s => { s.manifest.size = -1; }],
    ['modified', s => { s.manifest.modified = 3; }], ['rows', s => { s.manifest.rows = 1.5; }],
    ['span', s => { s.manifest.channels[0].t1 = -1; }], ['samples', s => { s.manifest.channels[0].samples = 0; }],
    ['manifest extra', s => { s.manifest.extra = 1; }], ['manifest missing', s => { s.manifest.channels.pop(); }],
  ] as [string, (s: Record<string, any>) => void][])('rejects malformed %s', (_name, edit) => {
    const doc = load(); edit(doc.testData![0]);
    expect(validateStructure(doc).map(i => i.code)).toContain('bad-test-data');
  });

  it('rejects duplicate source IDs and non-array sources', () => {
    const sources = load().testData!;
    expect(testDataProblem([sources[0], sources[0]])).toMatch(/unique/);
    for (const value of [null, {}, 4]) expect(testDataProblem(value)).toMatch(/array/);
  });

  it('warns on dangling or duplicate targets within each source, including bead identity', () => {
    const doc = load(), c = doc.testData![0].channels;
    c[0].object = 'absent'; c[1].object = 'tc-tree'; c[2].bead = 5;
    c.push({ ...c[3] });
    const issues = checkPlan(doc).filter(i => i.code.startsWith('test-data-'));
    expect(issues.map(i => i.code)).toEqual(['test-data-dangling', 'test-data-dangling', 'test-data-dangling', 'test-data-duplicate']);
    expect(issues.every(i => i.severity === 'warning')).toBe(true);
    c[0].object = 'burner'; c[0].bead = 0;
    doc.objects.find(o => o.id === 'hf-west')!.type = 'futureInstrument'; c[1].object = 'hf-west';
    expect(checkPlan(doc).filter(i => i.code === 'test-data-dangling')).toHaveLength(3);
  });

  it('uses explicit layout, reports missing channels and never silently merges duplicate targets', () => {
    const s = load().testData![1];
    s.channels = [{ channel: 'Power', object: 'burner', scale: -2, offset: 7 }];
    s.table = { sheet: null, shape: 'plain', headerRow: 2, unitsRow: 3, dataRow: 4, timeColumn: 1 };
    s.timeOffset_s = 10;
    const grid: Grid = [['note'], ['Power', 'Time'], ['V', 's'], [3, 10], [null, 11], [4, 12], [8, 12]];
    const units = { targets: new Map([['burner', 'kW' as const]]) };
    const series = sourceSeries(s, grid, units).get(seriesKey('burner'))!;
    expect([...series.t]).toEqual([0, 2]); expect([...series.values]).toEqual([1, -1]); expect(series.missing).toBe(1);
    expect(series.unit).toBe('kW');
    expect(() => sourceSeries(s, grid)).toThrow(/Target unit/);
    const info = { size: 50, modified: null, table: s.table };
    const manifest = manifestFor(s, grid, info);
    expect(manifestMismatch(manifest, info, grid)).toEqual([]);
    grid[2][0] = 'W';
    // A modification time alone is not a change: a copied or browser-attached file has
    // another one with the same data.
    expect(manifestMismatch(manifest, { ...info, modified: '2026-11-02T00:00:00Z' }, grid.map((r, i) => (i === 2 ? ['V', 's'] : [...r])))).toEqual([]);
    expect(manifestMismatch(manifest, { ...info, size: 51, modified: 'changed' }, grid)).toEqual([
      'File size changed.', 'Unit of mapped channel "Power" changed.',
    ]);
    grid[2][0] = 'V'; grid[4][0] = 5;
    expect(manifestMismatch(manifest, info, grid)).toEqual(['Mapped channel "Power" now has 3 samples (was 2).']);
    grid[4][0] = null;
    s.channels.push({ ...s.channels[0] }); expect(() => sourceSeries(s, grid, units)).toThrow(/more than once/);
    s.channels.pop(); grid[1][0] = 'renamed';
    expect(manifestMismatch(manifest, info, grid)).toEqual(['Mapped channel "Power" is missing.']);
    expect(() => sourceSeries(s, grid, units)).toThrow(/missing/);
    expect(() => manifestFor(s, grid, info)).toThrow(/missing/);
  });
});

describe('min/max decimation', () => {
  it('preserves endpoints and bucket extrema in time order within even or odd budgets', () => {
    const t = Float64Array.from({ length: 10000 }, (_, i) => i / 10);
    const v = Float64Array.from(t, (_, i) => Math.sin(i) * 10); v[100] = 100; v[9900] = -100;
    for (const budget of [2, 3, 4, 11, 2000]) {
      const out = decimateMinMax(t, v, budget);
      expect(out.t.length).toBeLessThanOrEqual(budget);
      expect([out.t[0], out.t.at(-1)]).toEqual([t[0], t.at(-1)]);
      expect([...out.t].every((time, i) => i === 0 || time > out.t[i - 1])).toBe(true);
      if (budget >= 4) { expect([...out.values]).toContain(100); expect([...out.values]).toContain(-100); }
      for (let i = 0; i < out.t.length; i++) expect(out.values[i]).toBe(v[Math.round(out.t[i] * 10)]);
    }
    expect([...decimateMinMax([0, 1, 2, 3, 4, 5], [0, 8, -8, 1, 2, 0], 4).t]).toEqual([0, 1, 2, 5]);
    expect(decimateMinMax([], []).t).toHaveLength(0);
    expect([...decimateMinMax([1], [2]).values]).toEqual([2]);
  });
  it('rejects invalid lengths, budgets and time order', () => {
    expect(() => decimateMinMax([0], [])).toThrow(/equal lengths/);
    for (const budget of [1, 0, 2.5, NaN]) expect(() => decimateMinMax([], [], budget)).toThrow(/maxPoints/);
    expect(() => decimateMinMax([0, 0], [1, 2])).toThrow(/increasing/);
    expect(() => decimateMinMax([0], [Infinity])).toThrow(/finite/);
  });
});
