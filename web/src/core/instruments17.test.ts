import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createVelocityProbe, createGasSampling, createLoadCell } from './factory';
import { checkPlan, instrumentChecks, newPlan } from './plan';
import { nearestOpening, loadCellUnderFuel } from './instrument-placement';
import { forwardOf, lookAtQuat } from './math';
import { serializePlan } from './serialize';
import { parseAndValidatePlan, validateStructure } from './validate';
import { requiredFormatVersion, isGasSampling, type Vec3 } from './types';
import { devicesToFds } from './fds-export';
import { fdsToPlan } from './fds';
import { readNamelist } from './namelist';
import { plannedValue } from './planned-value';
import { sourceSeries, targetUnits, seriesKey } from './test-data';
import { instrumentScheduleCsv } from './instrument-schedule';
import { buildViewSvg } from '../export/drawing';
import { buildReportBody } from '../export/report';
import { delimitedRows } from './delimited';
import { isNewInstrument, type PlanObject } from './types';

const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8');
const fresh = () => parseAndValidatePlan(fixture('instruments17.ftp.json'));

it('round trips all three types byte identically and requires only 1.7', () => {
  const doc = fresh();
  expect(serializePlan(doc)).toBe(fixture('instruments17.ftp.json'));
  for (const obj of doc.objects) {
    const single = { ...doc, objects: [obj] };
    expect(requiredFormatVersion(single)).toBe('1.7.0');
    expect(validateStructure(single)).toEqual([]);
  }
  const empty = newPlan();
  expect([createVelocityProbe(empty).type, createGasSampling(empty).type, createLoadCell(empty).type])
    .toEqual(['velocityProbe', 'gasSampling', 'loadCell']);
});

it('checks finite opening patches, translated and rotated walls, and alignment reach', () => {
  const doc = newPlan(), p = createVelocityProbe(doc, [1, 0.1, 1]); doc.objects.push(p);
  doc.objects.push({ id: 'wall', type: 'wall', polyline_m: [[0, 0], [3, 0]], height_m: 3,
    openings: [{ offset_m: 0.5, width_m: 1, height_m: 2 }] });
  const codes = () => instrumentChecks(doc).map(i => i.code);
  expect(codes()).not.toContain('probe-not-in-opening');
  p.transform!.position_m[1] = 0.1001;
  expect(codes()).toContain('probe-not-in-opening');
  expect(nearestOpening(doc, p.transform!.position_m, 1)?.normal).toEqual([0, -1, 0]);
  p.transform!.position_m = [20, 0, 1];
  expect(nearestOpening(doc, p.transform!.position_m, 1)).toBeNull();
  expect(codes()).toContain('probe-not-in-opening');
  doc.objects[1].transform = { position_m: [4, 5, 2], rotation_quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2] };
  p.transform!.position_m = [4.1, 6, 3];
  expect(codes()).not.toContain('probe-not-in-opening');
  expect(nearestOpening(doc, p.transform!.position_m, 1)!.normal[0]).toBeCloseTo(1);
});

it('checks platform overlap including rotated, circular and unlit fuel above the cell', () => {
  const doc = newPlan(), c = createLoadCell(doc, [0, 0, 0]); c.platform_m = [2, 1]; doc.objects.push(c);
  const burner = { id: 'fuel', type: 'burner', transform: { position_m: [1.1, 0, 0.2] as Vec3 },
    footprint: { shape: 'circle' as const, diameter_m: 0.4 } }; doc.objects.push(burner);
  expect(loadCellUnderFuel(doc, c)).toBe(true);
  c.platform_m = null;
  expect(instrumentChecks(doc).find(i => i.code === 'load-cell-not-under-fuel')?.severity).toBe('info');
  burner.transform.position_m = [0, 0, -1];
  expect(loadCellUnderFuel(doc, c)).toBe(false);
  burner.transform.position_m = [0, 0, 1];
  expect(loadCellUnderFuel(doc, c)).toBe(true);
});

it('checks yawed platforms and the portion below fuel on a tilted platform', () => {
  const doc = newPlan(), c = createLoadCell(doc); c.platform_m = [2, 0.2];
  c.transform!.rotation_quat = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const b = { id: 'fuel', type: 'burner', transform: { position_m: [0, 0.8, 0.2] as Vec3 },
    footprint: { shape: 'rectangle' as const, size_m: [0.1, 0.1] as [number, number] } };
  doc.objects = [c, b];
  expect(loadCellUnderFuel(doc, c)).toBe(true);
  b.transform.position_m = [0.8, 0, 0.2];
  expect(loadCellUnderFuel(doc, c)).toBe(false);
  c.transform!.rotation_quat = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)];
  b.transform.position_m = [0.5, 0, 0];
  expect(loadCellUnderFuel(doc, c)).toBe(true);
  b.transform.position_m = [-0.5, 0, 0];
  expect(loadCellUnderFuel(doc, c)).toBe(false);
});

it('imports components and magnitude, merging gas species at the same exact point', () => {
  const { doc, devices } = fdsToPlan(fixture('fds/instruments17.fds'), null, { originM: [0, 0, 0] });
  const probes = doc.objects.filter(o => o.type === 'velocityProbe');
  expect(probes).toHaveLength(4);
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach((axis, i) =>
    forwardOf(probes[i].transform!.rotation_quat!).forEach((v, j) => expect(v).toBeCloseTo(axis[j])));
  expect(probes[3].transform!.rotation_quat).toBeUndefined();
  expect(probes[3].notes).toMatch(/magnitude/i);
  const gas = doc.objects.filter(isGasSampling);
  expect(gas).toHaveLength(1); expect(gas[0].species).toEqual(['O2', 'CO2']);
  expect(devices.filter(d => d.mappedTo === 'gasSampling').reduce((n, d) => n + d.objects, 0)).toBe(1);
});

it('exports axis components at the 5 degree boundary and gas species, omitting load cells', () => {
  const doc = fresh();
  expect(devicesToFds(doc)).toBe(fixture('fds/instruments17-devices.fds'));
  const p = createVelocityProbe(doc, [0, 0, 1]); doc.objects = [p];
  for (const [angle, quantity] of [[5, 'U-VELOCITY'], [5.01, 'VELOCITY']] as const) {
    const a = angle * Math.PI / 180;
    p.transform!.rotation_quat = lookAtQuat([0, 0, 1], [Math.cos(a), Math.sin(a), 1]);
    expect(readNamelist(devicesToFds(doc)).find(r => r.group === 'DEVC')!.string('QUANTITY')).toBe(quantity);
  }
  p.transform!.rotation_quat = lookAtQuat([0, 0, 1], [-1, 0, 1]);
  expect(devicesToFds(doc)).toContain('negative X');
});

it('accepts targets without predictions and keeps the gas column unit', () => {
  const doc = fresh(), template = JSON.parse(fixture('test-data/test-data.ftp.json')).testData[0];
  const units = targetUnits(doc.objects);
  expect(units.get('vp')).toBe('m/s'); expect(units.get('lc')).toBe('kg'); expect(units.get('gas')).toBeNull();
  for (const obj of doc.objects) expect(plannedValue(doc, obj.id)).toMatchObject({ value: null, note: 'No prediction model.' });
  const source = { ...template, table: { sheet: null, shape: 'plain', headerRow: 1, unitsRow: 2, dataRow: 3, timeColumn: 0 },
    channels: [{ channel: 'oxygen', object: 'gas' }] };
  const series = sourceSeries(source, [['Time', 'oxygen'], ['s', '%'], [0, 20.9], [1, 19]], { targets: units });
  expect(series.get(seriesKey('gas'))!.unit).toBe('%');
  doc.testData = [{ ...source, channels: doc.objects.map(o => ({ channel: 'oxygen', object: o.id })) }];
  expect(checkPlan(doc).filter(i => i.code === 'test-data-dangling')).toEqual([]);
});

it('rejects malformed fields and accepts both documentary gauge kinds', () => {
  const doc = newPlan();
  for (const object of [{ id: 'p', type: 'velocityProbe', range_m_s: -1 },
    { id: 'g', type: 'gasSampling', species: ['NOPE'], inDuct: false },
    { id: 'l', type: 'loadCell', platform_m: [1, 0], capacity_kg: null }]) {
    doc.objects = [object]; expect(validateStructure(doc).length).toBeGreaterThan(0);
  }
  for (const kind of ['plate-thermometer', 'thin-skin']) {
    doc.objects = [{ id: 'g', type: 'heatFluxSensor', gauge: { kind } }];
    expect(requiredFormatVersion(doc)).toBe('1.7.0'); expect(validateStructure(doc)).toEqual([]);
  }
});

it('reproduces the additional Python FDS conversion bytes', () => {
  const { doc } = fdsToPlan(fixture('fds/instruments17.fds'), 'instruments17.fds', {
    originM: [0, 0, 0], importedAt: '2026-11-02T00:00:00Z' });
  doc.meta!.created = doc.meta!.modified = '2026-11-02T00:00:00Z';
  expect(serializePlan(doc)).toBe(fixture('fds/instruments17.ftp.json'));
});

const exportCases = JSON.parse(fixture('fds/device-export-cases.json')).instruments17 as {
  name: string; type: string; normal?: Vec3; quantity?: string; species?: string[]; specIds?: string[];
}[];
it.each(exportCases)('shared device export: $name', c => {
  const doc = newPlan(c.name), at: Vec3 = [1, 2, 3];
  const obj: PlanObject = { id: 'extra', name: c.name, type: c.type, transform: { position_m: at } };
  if (c.normal) obj.transform!.rotation_quat = lookAtQuat(at, at.map((v, i) => v + c.normal![i]) as Vec3);
  if (c.species) Object.assign(obj, { species: c.species, inDuct: false });
  doc.objects = [obj];
  const text = devicesToFds(doc), records = readNamelist(text);
  if (c.type === 'loadCell') { expect(records).toEqual([]); expect(text).toContain('load cell omitted'); }
  else if (c.species) {
    expect(records.map(r => r.string('SPEC_ID'))).toEqual(c.specIds);
    expect(records.map(r => r.string('ID'))).toEqual(c.species.map(s => `${c.name}_${s}`));
    expect(records.every(r => r.string('QUANTITY') === 'VOLUME FRACTION')).toBe(true);
  } else expect(records[0].string('QUANTITY')).toBe(c.quantity);
});

it('shows all three identities in plan, elevations, equipment, set-out and schedule', () => {
  const doc = fresh();
  for (const view of ['plan', 'front', 'side'] as const) {
    const svg = buildViewSvg(doc, view, 'm');
    for (const obj of doc.objects.filter(isNewInstrument)) expect(svg).toContain(`data-instrument="${obj.type}"`);
  }
  const body = buildReportBody(doc, 'm');
  expect(body).toContain('toward +X'); expect(body).toContain('O2, CO2'); expect(body).toContain('100 kg');
  const rows = delimitedRows(instrumentScheduleCsv(doc, 'm'), ',');
  expect(rows).toHaveLength(4);
  const row = (id: string) => rows.find(r => r[2] === id)!;
  expect(row('vp')[7]).toBe('toward +X'); expect(row('vp')[9]).toBe('20');
  expect(row('gas')[10]).toBe('O2; CO2'); expect(row('lc').slice(12, 14)).toEqual(['100', '1.000, 0.500']);
  doc.objects[0].display = { color: '#123456' };
  expect(buildViewSvg(doc, 'plan', 'm')).toContain('#123456');
});

it('keeps close gas sites separate, reports unsupported species and invalid bead targets', () => {
  const text = "&DEVC ID='a', XYZ=0,0,1, QUANTITY='VOLUME FRACTION', SPEC_ID='O2' /\n"
    + "&DEVC ID='b', XYZ=0,0,1.00001, QUANTITY='MASS FRACTION', SPEC_ID='CO' /\n"
    + "&DEVC ID='skip', XYZ=0,0,1, QUANTITY='VOLUME FRACTION', SPEC_ID='UNKNOWN' /\n";
  const imported = fdsToPlan(text, null, { originM: [0, 0, 0] });
  expect(imported.doc.objects.filter(isGasSampling)).toHaveLength(2);
  expect(imported.devices[0].note).toContain('1 with unsupported');
  const doc = fresh(), source = JSON.parse(fixture('test-data/test-data.ftp.json')).testData[0];
  source.channels = doc.objects.map(o => ({ channel: 'x', object: o.id, bead: 0 })); doc.testData = [source];
  expect(checkPlan(doc).filter(i => i.code === 'test-data-dangling')).toHaveLength(3);
  source.channels.forEach((c: { bead?: number }) => delete c.bead); doc.objects.pop();
  expect(checkPlan(doc).filter(i => i.code === 'test-data-dangling')).toHaveLength(1);
});
