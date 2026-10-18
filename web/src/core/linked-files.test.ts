import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isNetworkPath, linkedFilesProblem, parseReconstructionCsv } from './linked-files';
import { newPlan } from './plan';
import { serializePlan } from './serialize';
import { requiredFormatVersion, type BurnerObject, type PlanDocument } from './types';
import { parseAndValidatePlan } from './validate';
import { Store } from '../state/store';

const CSV = readFileSync(new URL('../../../fixtures/linked-files/volumes.csv', import.meta.url), 'utf8');
const DATE = '2026-09-05T18:00:00Z';
const cases = JSON.parse(readFileSync(new URL('../../../fixtures/linked-files/csv-cases.json', import.meta.url), 'utf8')) as
  { name: string; text: string; samples?: number[][]; error?: string }[];
const header = 'timestamp_s,volume_m3,surface_area_m2\n';
const burner = (): BurnerObject => ({ id: 'fire', type: 'burner', footprint: { shape: 'circle', diameter_m: 1 },
  linkedFiles: [{ id: 'data', kind: 'spreadsheet', path: 'data/volumes.csv', plot: parseReconstructionCsv(CSV, DATE) }] });

describe('reconstruction CSV', () => {
  it.each(cases)('matches the shared Python CSV case: $name', (c) => {
    if (c.error) expect(() => parseReconstructionCsv(c.text, DATE)).toThrow(c.error);
    else expect(parseReconstructionCsv(c.text, DATE)).toEqual({ importedAt: DATE, samples: c.samples });
  });
  it('reproduces the complete synthetic snapshot', () => {
    const doc = JSON.parse(readFileSync(new URL('../../../fixtures/linked-files/linked-test.ftp.json', import.meta.url), 'utf8')) as PlanDocument;
    expect(parseReconstructionCsv(CSV, DATE)).toEqual(doc.objects.find((o) => o.id === 'burner-main')!.linkedFiles![0].plot);
  });
  it('reads all synthetic samples in SI with the expected endpoints', () => {
    const plot = parseReconstructionCsv(CSV, DATE);
    expect(plot.samples).toHaveLength(100);
    expect(plot.samples[0]).toEqual([0, 0, 0]);
    expect(plot.samples[1]).toEqual([2, 0.005168, 0.1798]);
    expect(plot.samples.at(-1)![0]).toBe(198);
    expect(plot.importedAt).toBe(DATE);
  });
  it('supports BOM, CRLF, quotes, reordered columns, extras and TSV', () => {
    const quoted = '\uFEFF"surface_area_m2","description","timestamp_s","volume_m3"\r\n2,"a, b ""quoted""",0,1\r\n';
    expect(parseReconstructionCsv(quoted).samples).toEqual([[0, 1, 2]]);
    expect(parseReconstructionCsv('timestamp_s\tvolume_m3\tsurface_area_m2\n0\t1\t2').samples).toEqual([[0, 1, 2]]);
    expect(parseReconstructionCsv('timestamp_s;volume_m3;surface_area_m2\n0;1;2').samples).toEqual([[0, 1, 2]]);
  });
  it.each(['0,,1', '0,abc,1', '0,1e999,1', '0,-1,1', '0,NaN,1', '0,0x10,1', '0,1,2,3', '0,"1,2'])('refuses corrupt row %s', (line) => {
    expect(() => parseReconstructionCsv(header + line)).toThrow();
  });
  it.each(['0,1,2\n0,2,3', '2,1,2\n1,2,3'])('rejects duplicate or out-of-order time', (line) => {
    expect(() => parseReconstructionCsv(header + line)).toThrow(/increase strictly/);
  });
  it('does not invent samples, missing fields or units', () => {
    expect(() => parseReconstructionCsv(header)).toThrow(/no measurements/);
    expect(() => parseReconstructionCsv('time,liters,area\n0,1,2')).toThrow(/timestamp_s/);
    expect(() => parseReconstructionCsv('timestamp_s,volume_m3,surface_area_m2,volume_m3\n0,1,2,3')).toThrow(/exactly one/);
  });
  it('bounds plot import without silently truncating rows', () => {
    expect(() => parseReconstructionCsv(header + ' '.repeat(5 * 1024 * 1024))).toThrow(/5 MiB/);
    expect(() => parseReconstructionCsv(header + Array.from({ length: 20001 }, (_, i) => `${i},1,2`).join('\n'))).toThrow(/20,000/);
  });
});

describe('linked records', () => {
  it.each(['link', 'plot'])('rejects unknown keys in the closed %s block', (block) => {
    const doc = newPlan(), obj = burner(); doc.objects.push(obj);
    Object.assign(block === 'link' ? obj.linkedFiles![0] : obj.linkedFiles![0].plot!, { extra: 1 });
    expect(() => parseAndValidatePlan(serializePlan(doc))).toThrow(/unsupported field/);
  });
  it('accepts pre-ignition times through the load and canonical write gates', () => {
    const doc = newPlan(), obj = burner(); doc.objects.push(obj);
    obj.linkedFiles![0].plot = parseReconstructionCsv(header + '-5,0,0\n0,1,2', DATE);
    expect(parseAndValidatePlan(serializePlan(doc)).objects[0].linkedFiles![0].plot!.samples).toEqual([[-5, 0, 0], [0, 1, 2]]);
  });
  it('bumps only plans that use the feature, even if an obstruction precedes the links', () => {
    const doc = newPlan();
    expect(requiredFormatVersion(doc)).toBe('1.0.0');
    doc.objects.push({ id: 'box', type: 'obstruction', size_m: [1, 1, 1] }, burner());
    expect(requiredFormatVersion(doc)).toBe('1.3.0');
    expect(parseAndValidatePlan(serializePlan(doc)).version).toBe('1.3.0');
  });
  it('keeps measured precision and strictly increasing sub-microsecond times on save', () => {
    const obj = burner();
    obj.linkedFiles![0].plot!.samples = [[0, 0, 0], [1e-8, 1.23456789123, 0.00000000789]];
    const doc = newPlan(); doc.objects.push(obj);
    expect(parseAndValidatePlan(serializePlan(doc)).objects[0].linkedFiles).toEqual(obj.linkedFiles);
  });
  it('survives undo, redo, object duplication and document round-trip', () => {
    const store = new Store(newPlan());
    store.addObject(burner());
    store.duplicateSelected();
    expect(store.document.objects[1].linkedFiles).toEqual(store.document.objects[0].linkedFiles);
    store.undo(); expect(store.document.objects).toHaveLength(1);
    store.redo(); expect(store.document.objects).toHaveLength(2);
    store.loadFromText(store.serialize(), 'saved.ftp.json');
    expect(store.document.objects[1].linkedFiles![0].plot!.samples).toHaveLength(100);
  });
  it('rejects invalid paths, IDs, shapes and kind/object mismatches before adoption', () => {
    const obj = burner();
    obj.linkedFiles!.push({ ...obj.linkedFiles![0] });
    expect(linkedFilesProblem(obj)).toMatch(/unique/);
    obj.linkedFiles!.pop();
    obj.linkedFiles![0].path = 'https://host/video.mp4';
    expect(linkedFilesProblem(obj)).toMatch(/local/);
    obj.linkedFiles![0].path = 'C:/test/volumes.csv';
    expect(linkedFilesProblem(obj)).toBeNull();
    obj.linkedFiles![0].kind = 'video';
    expect(linkedFilesProblem(obj)).toMatch(/Cameras/);
    obj.linkedFiles![0].kind = 'spreadsheet';
    obj.linkedFiles![0].plot!.samples = [[1, 0, 0], [1, 0, 0]];
    expect(linkedFilesProblem(obj)).toMatch(/increasing/);
  });
  it('agrees byte-for-byte with the Python-written linked fixture', () => {
    const text = readFileSync(new URL('../../../fixtures/linked-files/linked-test.ftp.json', import.meta.url), 'utf8');
    expect(serializePlan(JSON.parse(text) as PlanDocument)).toBe(text);
    expect(() => parseAndValidatePlan(text)).not.toThrow();
  });
});

describe('network paths', () => {
  it('recognises every spelling Windows sends over the network, and nothing local', () => {
    // Resolving any of these contacts the host; a received plan must not do that
    // on open (the desktop auto-load skips them).
    for (const p of ['\\\\attacker\\share\\voxels', '//198.51.100.7/share/voxels', '\\\\host@SSL\\dav\\v',
      '\\\\?\\UNC\\host\\share', '\\\\.\\pipe\\x']) expect(isNetworkPath(p)).toBe(true);
    for (const p of ['C:\\data\\voxels', 'C:/data/voxels', 'voxels', '../run/voxels', '/mnt/data/voxels'])
      expect(isNetworkPath(p)).toBe(false);
  });
});
