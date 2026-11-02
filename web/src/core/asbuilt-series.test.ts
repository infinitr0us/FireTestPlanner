import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseAndValidatePlan, validateStructure } from './validate';
import { serializePlan } from './serialize';
import { requiredFormatVersion } from './types';
import { setOutCheck, nextTest, recordAsBuilt } from './asbuilt';
import { buildReportBody } from '../export/report';
import { instrumentScheduleCsv } from './instrument-schedule';
import { delimitedRows } from './delimited';
import { Store } from '../state/store';
import { checkPlan } from './plan';

const fixture = readFileSync(new URL('../../../fixtures/asbuilt-series.ftp.json', import.meta.url), 'utf8');
const fresh = () => parseAndValidatePlan(fixture);

it('round trips byte identically, bumps only for asBuilt and keeps series at 1.0', () => {
  const doc = fresh();
  expect(serializePlan(doc)).toBe(fixture);
  expect(requiredFormatVersion(doc)).toBe('1.7.0');
  doc.objects.forEach(o => delete o.asBuilt);
  expect(JSON.parse(serializePlan(doc)).version).toBe('1.1.0');
  doc.objects = [];
  expect(requiredFormatVersion(doc)).toBe('1.0.0');
});

it('canonicalizes survey order and rounds geometry while preserving unknown precision', () => {
  const doc = fresh();
  doc.meta = Object.fromEntries(Object.entries(doc.meta!).reverse());
  for (const o of doc.objects) {
    const a = o.asBuilt!; delete o.asBuilt;
    a.transform = Object.fromEntries(Object.entries(a.transform).reverse()) as typeof a.transform;
    o.asBuilt = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
  }
  doc.objects[0].asBuilt!.transform.position_m[0] = 1.30000000001;
  const unknown = doc.objects[2], a = unknown.asBuilt!;
  a.transform.position_m[0] = 0.123456789;
  delete unknown.asBuilt; doc.objects[2] = { asBuilt: a, ...unknown };
  expect(serializePlan(doc)).toBe(fixture);
});

it.each([null, {}, { transform: { position_m: [1, 2] }, measured: null, note: null },
  { transform: { position_m: [1, 2, 3] }, measured: '2026-02-30', note: null },
  { transform: { position_m: [1, 2, 3] }, measured: null, note: 3 },
  { transform: { position_m: [NaN, 2, 3] }, measured: null, note: null },
  { transform: { position_m: [1, 2, 3], rotation_quat: [0, 0, Infinity, 1] }, measured: null, note: null }])('rejects invalid asBuilt %j', bad => {
  const doc = fresh(); doc.objects[0].asBuilt = bad as never;
  expect(validateStructure(doc).some(i => i.code === 'bad-as-built')).toBe(true);
});

it('requires a planned transform even on unknown types', () => {
  const doc = fresh(); doc.objects[0].type = 'future'; delete doc.objects[0].transform;
  expect(validateStructure(doc).some(i => i.code === 'bad-as-built')).toBe(true);
});

it('reports survey numbers, drawing row, and measured bead coordinates', () => {
  const doc = fresh(), row = setOutCheck(doc)[0];
  expect(row.plan_distance_m).toBeCloseTo(0.5);
  expect(row.height_difference_m).toBeCloseTo(-0.04);
  expect(row.aim_difference_deg).toBeCloseTo(180);
  expect(setOutCheck(doc)[1].aim_difference_deg).toBeNull();
  const html = buildReportBody(doc, 'm');
  expect(html).toContain('Set-out check');
  expect(html).toContain('0.500'); expect(html).toContain('-0.040'); expect(html).toContain('180.0');
  const csv = delimitedRows(instrumentScheduleCsv(doc, 'm'), ',');
  const x = csv[0].indexOf('Measured X (m)');
  expect(x).toBeGreaterThan(0);
  expect(csv[1].slice(x, x + 3)).toEqual(['1.300', '2.400', '2.960']);
  expect(csv[3].slice(x, x + 3)).toEqual(['0.100', '0.000', '-0.800']);
});

it.each([['T-007', 'T-008'], ['EX-001', 'EX-002'], ['T-099', 'T-100'], ['T-999', 'T-1000'],
  ['Test', 'Test-2'], ['', '-2'], [null, '-2'], ['X-9007199254740999', 'X-9007199254741000']])('next test %s -> %s', (old, next) => {
  const doc = fresh(); doc.meta!.testId = old; doc.testData = [{ id: 'old-data' } as never];
  doc.objects.push({ id: 'flame', type: 'reconstructedFlame' }, { id: 'future', type: 'future', linkedFiles: [] });
  doc.objects.slice(0, 2).forEach(o => o.linkedFiles = []);
  const before = structuredClone(doc), result = nextTest(doc);
  expect(doc).toEqual(before);
  expect(result.meta!.testId).toBe(next); expect(result.meta!.series).toBe(doc.meta!.series);
  expect(result.meta!.revision).toBeNull();
  expect(result.meta!.created).toBe(result.meta!.modified); expect(result.meta!.created).not.toBe(doc.meta!.created);
  expect(result.testData).toBeUndefined(); expect(result.objects.map(o => o.type)).toEqual(['camera', 'thermocouple', 'future', 'future']);
  expect(result.objects.every(o => !('asBuilt' in o) && !('linkedFiles' in o))).toBe(true);
  result.objects[0].transform!.position_m[0] = 9; expect(doc).toEqual(before);
});

it('records an independent starting pose as one undoable edit', () => {
  const doc = fresh(); delete doc.objects[0].asBuilt;
  const store = new Store(doc);
  store.edit('Record as built', d => recordAsBuilt(d.objects[0])); store.commit();
  expect(store.document.objects[0].asBuilt!.transform).toEqual(doc.objects[0].transform);
  store.undo(); expect(store.document.objects[0].asBuilt).toBeUndefined();
});

it('accepts surveys on every placed type and keeps planning checks unchanged', () => {
  const doc = parseAndValidatePlan(readFileSync(new URL('../../../fixtures/flame/flame-test.ftp.json', import.meta.url), 'utf8'));
  const instruments = parseAndValidatePlan(readFileSync(new URL('../../../fixtures/instruments17.ftp.json', import.meta.url), 'utf8'));
  doc.objects.push(...instruments.objects);
  doc.version = '1.7.0';
  const before = checkPlan(doc);
  for (const o of doc.objects) {
    o.transform ??= { position_m: [0, 0, 0] };
    recordAsBuilt(o); o.asBuilt!.transform.position_m = [91, 92, 93];
  }
  expect(validateStructure(doc)).toEqual([]);
  expect(checkPlan(doc)).toEqual(before);
  expect(serializePlan(parseAndValidatePlan(serializePlan(doc)))).toBe(serializePlan(doc));
});
