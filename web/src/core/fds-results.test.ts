import { describe, expect, it } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decodeRle, parseResultCsv, parseSmv, Records, ResultReader, safeResultPath, type ResultSource, type ResultMesh, type ResultField } from './fds-results';
import { resultSurface } from '../scene/fds-results';

function record(data: Uint8Array, little = true): Uint8Array {
  const out = new Uint8Array(data.length + 8), view = new DataView(out.buffer);
  view.setInt32(0, data.length, little); out.set(data, 4); view.setInt32(data.length + 4, data.length, little); return out;
}
function binary(values: number[], floats = false, little = true): Uint8Array {
  const data = new Uint8Array(values.length * 4), view = new DataView(data.buffer);
  values.forEach((v, i) => floats ? view.setFloat32(4 * i, v, little) : view.setInt32(4 * i, v, little)); return data;
}
function join(...arrays: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0)); let p = 0;
  for (const a of arrays) { out.set(a, p); p += a.length; } return out;
}
const field: ResultField = { kind: 'slice', file: 'test.sf', mesh: 0, quantity: 'TEMPERATURE', shortName: 'temp', unit: 'C', cellCentered: true };
const mesh: ResultMesh = { id: 'A', cells: [2, 2, 2], bounds: [0, 3, 0, 6, 0, 9], coordinates: [[0, 1, 3], [0, 2, 6], [0, 3, 9]], obstructions: [] };
function slice(little = true): Uint8Array {
  return join(...['TEMPERATURE', 'temp', 'C'].map(s => record(new TextEncoder().encode(s.padEnd(30)), little)),
    record(binary([1, 1, 0, 2, 0, 2], false, little), little),
    ...[0, .7, 2].flatMap((t, frame) => [record(binary([t], true, little), little), record(binary(Array.from({ length: 9 }, (_, n) => frame * 100 + n), true, little), little)]));
}
function source(bytes: Uint8Array): ResultSource {
  return { files: new Map([['test.sf', bytes.length]]), async read(_name, offset, length) {
    if (offset + length > bytes.length) throw new Error('range'); return bytes.slice(offset, offset + length);
  } };
}

describe('bounded output reader', () => {
  it.each([true, false])('reads unaligned labels, endian=%s, and irregular times without loading the series', async little => {
    const reader = await new ResultReader(source(slice(little)), field, mesh).init();
    expect(reader.count).toBe(3); expect(await reader.nearest(.9)).toBe(1);
    expect(await reader.nearest(-1)).toBeNull(); expect(await reader.nearest(3)).toBeNull();
    expect((await reader.frame(2)).values).toEqual(new Float32Array([200, 201, 202, 203, 204, 205, 206, 207, 208]));
  });
  it('rejects truncated frames and corrupt record trailers', async () => {
    const bytes = slice();
    await expect(new ResultReader(source(bytes.slice(0, -1)), field, mesh).init()).rejects.toThrow('Truncated');
    bytes[bytes.length - 1] = 4;
    const reader = await new ResultReader(source(bytes), field, mesh).init();
    await expect(reader.frame(2)).rejects.toThrow('markers disagree');
  });
  it('refuses metadata mismatch and out-of-mesh dimensions', async () => {
    await expect(new ResultReader(source(slice()), { ...field, unit: 'K' }, mesh).init()).rejects.toThrow('labels disagree');
    await expect(new ResultReader(source(slice()), field, { ...mesh, cells: [1, 1, 1] }).init()).rejects.toThrow('exceed');
  });
  it('validates RLE input length and output extent', () => {
    expect([...decodeRle(new Uint8Array([2, 255, 4, 3, 5]), 5)]).toEqual([2, 4, 4, 4, 5]);
    for (const bytes of [[255], [255, 4], [255, 4, 0], [255, 4, 6], [1]]) expect(() => decodeRle(new Uint8Array(bytes), 5)).toThrow();
  });
  it('rejects unsafe result paths', () => {
    for (const name of ['../x.sf', 'C:\\x.sf', '/x.sf', 'a/../x.sf', 'a//x.sf']) expect(() => safeResultPath(name)).toThrow();
    expect(safeResultPath('sub\\test.sf')).toBe('sub/test.sf');
  });
  it('rejects truncated record headers', () => { expect(() => new Records(new Uint8Array(2))).toThrow(); });
});

describe('scientific placement', () => {
  it('drops slice ghost values and places cell centres on the source nonuniform mesh', async () => {
    const reader = await new ResultReader(source(slice()), field, mesh).init();
    const surface = resultSurface(mesh, field, reader.patches);
    expect([...surface.positions.slice(0, 9)]).toEqual([.5, 0, 0, .5, 2, 0, .5, 2, 3]);
    expect([...surface.indices.slice(0, 6)]).toEqual([4, 4, 4, 4, 4, 4]);
    expect(new Set(surface.indices)).toEqual(new Set([4, 5, 7, 8]));
  });
  it('retains nodal interpolation and uses the low cell data for BNDC', async () => {
    const reader = await new ResultReader(source(slice()), field, mesh).init();
    const nodal = resultSurface(mesh, { ...field, cellCentered: false }, reader.patches);
    expect([...nodal.indices.slice(0, 6)]).toEqual([0, 1, 4, 0, 4, 3]);
    const boundary = resultSurface(mesh, { ...field, kind: 'boundary' }, reader.patches.map(p => ({ ...p, obstruction: 1, orientation: 1 })));
    expect([...boundary.indices.slice(0, 6)]).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it('masks slice cells inside solid obstructions', async () => {
    const reader = await new ResultReader(source(slice()), field, mesh).init();
    const blocked = { ...mesh, obstructions: [[0, 1, 0, 6, 0, 9] as [number, number, number, number, number, number]] };
    expect(resultSurface(blocked, field, reader.patches).positions.length).toBe(0);
  });
});

describe('FDS histories', () => {
  it('retains units, quoted names, irregular time, and missing values without inventing zero', () => {
    const [s] = parseResultCsv('s,kW\nTime,"HRR, total"\n0,1\n0.7,\n2,3');
    expect(s.name).toBe('HRR, total'); expect(s.unit).toBe('kW'); expect(s.times).toEqual([0, .7, 2]); expect(s.values[1]).toBeNaN();
  });
  it('rejects malformed and restarted histories', () => {
    for (const text of ['s,kW\nTime,HRR\n0,1\n0,2', 's,kW\nTime,HRR\n0,1,2', 's,kW\nTime,HRR\n,1']) expect(() => parseResultCsv(text)).toThrow();
  });
});

const portableFolder = fileURLToPath(new URL('../../../fixtures/fds-results/', import.meta.url));
const runs = [{ name: 'portable real FDS 6.9.1 samples', folder: portableFolder, full: false }];
if (process.env.FDS_FULL_RESULTS_DIR) runs.push({ name: 'explicit full external FDS inventory', folder: process.env.FDS_FULL_RESULTS_DIR, full: true });
describe.each(runs)('$name', ({ folder, full }) => {
  const caseSource: ResultSource = {
    files: new Map(readdirSync(folder).map(name => [name, statSync(folder + '/' + name).size])),
    async read(name, offset, length) {
      const f = await open(folder + '/' + name, 'r');
      try { const bytes = new Uint8Array(length); const { bytesRead } = await f.read(bytes, 0, length, offset); expect(bytesRead).toBe(length); return bytes; }
      finally { await f.close(); }
    },
  };
  it('inventories every actual field and decodes first, middle and last frames in every file', async () => {
    const data = parseSmv(readFileSync(folder + '/RC_BS_2.smv', 'utf8'));
    expect(data.version).toContain('6.9.1'); expect(data.meshes.length).toBe(20);
    expect(data.fields.filter(f => f.kind === 'slice').length).toBe(full ? 72 : 2);
    expect(data.fields.filter(f => f.kind === 'boundary').length).toBe(full ? 80 : 2);
    expect(data.fields.filter(f => f.kind === 'smoke').length).toBe(full ? 60 : 6);
    expect(data.devices.length).toBe(67); expect(data.warnings).toEqual([]);
    for (const f of data.fields) {
      const r = await new ResultReader(caseSource, f, data.meshes[f.mesh]).init();
      expect(r.count, f.file).toBe(full ? 3001 : 3);
      for (const i of [0, full ? 1500 : 1, r.count - 1]) {
        const frame = await r.frame(i);
        expect(frame.values.length).toBeGreaterThan(0); expect(Number.isFinite(frame.time)).toBe(true);
        if (i === 0) expect(frame.time).toBe(0);
        if (i === r.count - 1) expect(frame.time).toBeGreaterThanOrEqual(1199);
      }
      if (f.kind !== 'smoke' && (f.kind === 'slice' || r.patches.some(p => p.obstruction > 0))) expect(resultSurface(data.meshes[f.mesh], f, r.patches).positions.length, f.file).toBeGreaterThan(0);
      // Independent FDSreader 1.11.7 reference, with its low ghost row/column removed.
      if (f.file === 'RC_BS_2_1_1.sf') {
        const frame = await r.frame(full ? 1500 : 1);
        const used: number[] = [];
        for (let k = 1; k <= 66; k++) for (let j = 1; j <= 34; j++) used.push(frame.values[j + k * 35]);
        expect(frame.time).toBe(600.00341796875);
        expect(Math.min(...used)).toBe(19.99260902404785);
        expect(Math.max(...used)).toBe(1221.230712890625);
        expect([used[0], used[33], used[34 * 65], used[used.length - 1]]).toEqual([
          19.99999237060547, 20.00063705444336, 20.000335693359375, 20.000837326049805,
        ]);
        expect(resultSurface(data.meshes[f.mesh], f, r.patches).positions[0]).toBeCloseTo(.225);
      }
      r.clearFrame();
    }
  }, 30000);
});

it('decodes a BNDC file and preserves sample offsets after omitted exterior patches', async () => {
  const patches = [0, 1].map(obstruction => record(binary([1, 1, 0, 2, 0, 2, 1, obstruction, 1])));
  const bytes = join(...['TEMPERATURE', 'temp', 'C'].map(s => record(new TextEncoder().encode(s.padEnd(30)))),
    record(binary([2])), ...patches, record(binary([0], true)),
    record(binary(Array(9).fill(-100), true)), record(binary([10, 20, 99, 30, 40, 99, 99, 99, 99], true)));
  const boundaryField: ResultField = { ...field, kind: 'boundary' };
  const reader = await new ResultReader(source(bytes), boundaryField, mesh).init();
  const frame = await reader.frame(0);
  expect(reader.patches.map(p => p.obstruction)).toEqual([0, 1]);
  const surface = resultSurface(mesh, boundaryField, frame.patches);
  expect(surface.indices.length).toBe(24);
  expect([...new Set(surface.indices)].map(i => frame.values[i])).toEqual([10, 20, 30, 40]);
});
