import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { devicesToFds } from './fds-export';
import { fdsToPlan } from './fds';
import { angleBetweenDeg, lookAtQuat } from './math';
import { readNamelist } from './namelist';
import { gaugeNormal, newPlan, positionOf, thermocoupleBeads } from './plan';
import { isHeatFluxSensor, isThermocouple, type PlanDocument, type PlanObject, type Vec3 } from './types';

const fixture = (path: string): string => readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url), 'utf8');
const sources = ['flame/flame-test', 'pool-fire-camera-row', 'fds/room_corner'];
const records = (text: string) => readNamelist(text).filter(r => r.group === 'DEVC');
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]));
const surfaceNote = "FDS &DEVC QUANTITY='WALL TEMPERATURE' -- a surface temperature, not a gas temperature";

describe('instrument export and existing importer', () => {
  for (const source of sources) it(`${source}: exact shared bytes and round trip`, () => {
    const doc = JSON.parse(fixture(`${source}.ftp.json`)) as PlanDocument;
    const before = JSON.stringify(doc);
    const text = devicesToFds(doc);
    expect(text).toBe(fixture(`fds/${source.split('/').at(-1)}-devices.fds`));
    expect(devicesToFds(doc)).toBe(text);
    expect(JSON.stringify(doc)).toBe(before);
    expect(text).not.toContain('\r');
    expect(text.split('\n')[4]).toBe('! Written by FireTestPlanner');
    expect(text).not.toContain('BEAD_DIAMETER=');
    expect(readNamelist(text).every(r => ['PROP', 'DEVC'].includes(r.group))).toBe(true);
    const exported = records(text);
    const originM = doc.meta?.source?.originOffset_m ?? [0, 0, 0];
    const options = { originM, importedAt: '2026-11-02T00:00:00Z' };
    const single = fdsToPlan(text, null, { ...options, groupRakes: false });
    expect(single.doc.objects).toHaveLength(exported.length);
    expect(single.devices.every(g => g.mappedTo !== null && g.objects === g.count)).toBe(true);
    for (const obj of doc.objects) {
      if (isHeatFluxSensor(obj)) {
        const copy = single.doc.objects.find(o => o.name === obj.name)!;
        expect(isHeatFluxSensor(copy)).toBe(true);
        expect(distance(positionOf(obj), positionOf(copy))).toBeLessThan(0.001);
        if (isHeatFluxSensor(copy)) expect(angleBetweenDeg(gaugeNormal(obj), gaugeNormal(copy))).toBeLessThan(0.5);
      } else if (isThermocouple(obj)) {
        const beads = thermocoupleBeads(doc, obj);
        beads.forEach((bead, i) => {
          const name = source === 'fds/room_corner' ? `${obj.name!.split('-')[0].replace(/[0-9]+$/, '')}${i + 1}`
            : beads.length === 1 ? obj.name : `${obj.name}_${i + 1}`;
          const copy = single.doc.objects.find(o => o.name === name)!;
          expect(isThermocouple(copy)).toBe(true);
          expect(distance(bead.world, positionOf(copy))).toBeLessThan(0.001);
          if (isThermocouple(copy)) {
            const surface = obj.mount?.type === 'wall' || obj.mount?.type === 'ceiling';
            expect(copy.thermocouple?.beadDiameter_mm ?? null).toBe(surface ? null : obj.thermocouple?.beadDiameter_mm ?? null);
            if (surface) {
              expect(copy.mount?.type).toBe('wall');
              expect(copy.notes).toBe(surfaceNote);
              if (source === 'fds/room_corner') expect(copy.notes).toBe(obj.notes);
            }
          }
        });
      }
    }
    // Quantity and IOR keep coincident gas and surface runs separate.
    const grouped = fdsToPlan(text, null, options);
    expect(grouped.devices.every(g => g.mappedTo !== null && g.note === '')).toBe(true);
    const temperatures = exported.filter(r => ['THERMOCOUPLE', 'WALL TEMPERATURE'].includes(r.string('QUANTITY')!));
    const runs = new Map<string, typeof temperatures>();
    for (const r of temperatures) {
      const key = [r.string('QUANTITY'), r.number('IOR'),
        ...r.numbers('XYZ').slice(0, 2).map(v => (Number(v.toFixed(4)) + 0).toFixed(4))].join('|');
      runs.set(key, [...(runs.get(key) ?? []), r]);
    }
    const rakes = grouped.doc.objects.filter(isThermocouple);
    expect(rakes).toHaveLength(runs.size);
    [...runs.values()].forEach((run, i) => {
      run.sort((a, b) => a.numbers('XYZ')[2] - b.numbers('XYZ')[2]);
      expect(rakes[i].name).toBe(run.length === 1 ? run[0].string('ID') : `${run[0].string('ID')}-${run.at(-1)!.string('ID')}`);
      if (run[0].string('QUANTITY') === 'WALL TEMPERATURE') {
        expect(rakes[i].mount?.type).toBe('wall');
        expect(rakes[i].notes).toBe(surfaceNote);
      }
      thermocoupleBeads(grouped.doc, rakes[i]).forEach((bead, j) => {
        expect(distance(bead.world, run[j].numbers('XYZ').map((v, k) => v - originM[k]))).toBeLessThan(0.001);
      });
    });
    const gauges = exported.filter(r => r.string('QUANTITY')!.includes('HEAT FLUX'));
    if (source === 'fds/room_corner') {
      expect(gauges.filter(r => r.number('IOR') === 2).map(r => r.string('ID')))
        .toEqual(Array.from({ length: 6 }, (_, i) => `BACK_HF_${i + 1}`));
      expect(gauges.filter(r => r.number('IOR') === 1).map(r => r.string('ID')))
        .toEqual(Array.from({ length: 6 }, (_, i) => `SIDE_HF_${i + 1}`));
      expect(gauges.filter(r => r.number('IOR') === 3).map(r => r.string('ID'))).toEqual(['FLOOR_HF']);
      expect(gauges.every(r => r.string('QUANTITY') === 'GAUGE HEAT FLUX')).toBe(true);
      const original = records(fixture('fds/room_corner.fds'));
      expect(exported.map(r => r.string('ID')).sort()).toEqual(original
        .map(r => r.string('ID')).sort());
      for (const device of exported) {
        const name = device.string('ID')!;
        const input = original.find(r => r.string('ID') === name)!;
        expect(input, name).toBeDefined();
        expect(distance(device.numbers('XYZ'), input.numbers('XYZ'))).toBeLessThan(0.001);
        if (name.includes('_WT_')) {
          expect(device.string('QUANTITY')).toBe(input.string('QUANTITY'));
          expect(device.number('IOR')).toBe(input.number('IOR'));
          expect(device.string('PROP_ID')).toBeNull();
        }
      }
      expect(exported.filter(r => r.string('QUANTITY') === 'WALL TEMPERATURE')).toHaveLength(12);
      expect(rakes).toHaveLength(4);
    } else {
      expect(gauges.map(r => [r.string('ID'), r.number('IOR')])).toEqual([
        ['East wall gauge', null], ['North wall gauge', -2],
      ]);
      expect(gauges[1].numbers('ORIENTATION')).toHaveLength(3);
    }
  });
});

const shared = JSON.parse(fixture('fds/device-export-cases.json')) as {
  solids: Record<string, PlanObject>;
  cases: Array<{ name: string; solid?: string; at: Vec3; normal: Vec3; ior: number | null }>;
  beadNames: Array<{ name: string; count: number; ids: string[] }>;
  surfaceCases: Array<{ name: string; solids?: string[]; mount?: 'wall' | 'ceiling'; at: Vec3; ior: number | null }>;
};

it.each(shared.surfaceCases)('$name preserves the surface quantity or explains its fallback', c => {
  const doc = newPlan(c.name);
  doc.objects = [...(c.solids ?? []).map(key => structuredClone(shared.solids[key])),
    { id: 'bead', type: 'thermocouple', name: 'Bead', transform: { position_m: c.at },
      mount: { type: c.mount ?? 'wall' }, thermocouple: { beadDiameter_mm: 2 } }];
  const before = JSON.stringify(doc);
  const text = devicesToFds(doc);
  expect(JSON.stringify(doc)).toBe(before);
  const [r] = records(text);
  expect(r.number('IOR')).toBe(c.ior);
  expect(r.string('QUANTITY')).toBe(c.ior === null ? 'THERMOCOUPLE' : 'WALL TEMPERATURE');
  expect(r.string('PROP_ID')).toBe(c.ior === null ? 'TC 2 mm' : null);
  expect(readNamelist(text).filter(r => r.group === 'PROP')).toHaveLength(c.ior === null ? 1 : 0);
  if (c.ior === null) expect(text).toContain(
    "! Bead: surface thermocouple with no surface in the plan at that point.\n&DEVC ID='Bead'");
  const copy = fdsToPlan(text, null, { originM: [0, 0, 0] }).doc.objects.find(isThermocouple)!;
  expect(copy.mount?.type).toBe(c.ior === null ? 'pole' : 'wall');
  if (c.ior !== null) expect(copy.notes).toBe(surfaceNote);
  doc.objects.reverse();
  expect(devicesToFds(doc)).toBe(text);
});

it('classifies every bead of a rotated surface rake separately and leaves gas mounts alone', () => {
  const doc = newPlan();
  doc.objects = [structuredClone(shared.solids.wall), {
    id: 'rake', type: 'thermocouple', name: 'Rake', mount: { type: 'wall' },
    transform: { position_m: [0.5, -0.12, 1], rotation_quat: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
    beadOffsets_m: [0, 1, 2], thermocouple: { beadDiameter_mm: 2 },
  }];
  const text = devicesToFds(doc), r = records(text);
  expect(r.map(r => [r.string('QUANTITY'), r.number('IOR'), r.string('PROP_ID')])).toEqual([
    ['WALL TEMPERATURE', -2, null], ['THERMOCOUPLE', null, 'TC 2 mm'], ['WALL TEMPERATURE', -2, null],
  ]);
  expect(r.map(r => r.numbers('XYZ'))).toEqual([[0.5, -0.12, 1], [1.5, -0.12, 1], [2.5, -0.12, 1]]);
  expect(text).toContain("! Rake_2: surface thermocouple with no surface in the plan at that point.\n&DEVC ID='Rake_2'");
  for (const type of ['pole', 'floor', undefined] as const) {
    const gas = structuredClone(doc);
    const rake = gas.objects[1];
    if (isThermocouple(rake)) rake.mount = type ? { type } : undefined;
    const output = devicesToFds(gas);
    expect(records(output).every(r => r.string('QUANTITY') === 'THERMOCOUPLE' && r.string('PROP_ID') === 'TC 2 mm')).toBe(true);
    expect(output).not.toContain('no surface in the plan');
  }
});
it.each(shared.cases)('$name mounting classification', c => {
  const doc = newPlan(c.name);
  const gauge = { id: 'g', type: 'heatFluxSensor', transform: { position_m: c.at,
    rotation_quat: lookAtQuat(c.at, c.at.map((v, i) => v + c.normal[i]) as Vec3) } };
  doc.objects = [...(c.solid ? [structuredClone(shared.solids[c.solid])] : []), gauge];
  const [r] = records(devicesToFds(doc));
  expect(r.number('IOR')).toBe(c.ior);
  expect(r.string('QUANTITY')).toBe(c.ior === null ? 'RADIATIVE HEAT FLUX GAS' : 'GAUGE HEAT FLUX');
});

it.each(shared.beadNames)('$name recovers only a matching consecutive range', c => {
  const doc = newPlan();
  doc.objects = [{ id: 'tc', type: 'thermocouple', name: c.name,
    beadOffsets_m: Array.from({ length: c.count }, (_, i) => i * 0.5) }];
  expect(records(devicesToFds(doc)).map(r => r.string('ID'))).toEqual(c.ids);
});

it('keeps recovered IDs unique when a source range or device name is repeated', () => {
  const doc = newPlan();
  const rake = { id: 'a', name: 'TC_3-TC_5', type: 'thermocouple', beadOffsets_m: [0, 0.5, 1] };
  doc.objects = [rake, { ...rake, id: 'b' }, { id: 'g', type: 'heatFluxSensor', name: 'TC_3' }];
  expect(records(devicesToFds(doc)).map(r => r.string('ID'))).toEqual([
    'TC_3', 'TC_4', 'TC_5', 'TC_3-TC_5_2_1', 'TC_3-TC_5_2_2', 'TC_3-TC_5_2_3', 'TC_3_2',
  ]);
});

it.each(['DIAMETER', 'BEAD_DIAMETER'])('still imports %s on a thermocouple property', field => {
  const result = fdsToPlan(`&PROP ID='bead', ${field}=0.002 /\n&DEVC ID='tc', XYZ=0,0,1, QUANTITY='THERMOCOUPLE', PROP_ID='bead' /`);
  const tc = result.doc.objects.find(isThermocouple)!;
  expect(tc.thermocouple?.beadDiameter_mm).toBe(2);
});

it('handles rotated beads, colliding names, absent properties and metre rounding', () => {
  const doc = newPlan("Title\n&OBST ID='injected' /");
  const tc = (id: string, name: string, x: number, diameter: number | null): PlanObject => ({
    id, name, type: 'thermocouple', transform: { position_m: [x, 0, 1], rotation_quat: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
    beadOffsets_m: [0, 0.5], thermocouple: { beadDiameter_mm: diameter },
  });
  doc.objects = [tc('a', 'A', 0, 1.5), tc('b', 'A', 2, 1.5), tc('c', "O'Brien", 4, 2),
    { id: 'd', name: 'A_1', type: 'heatFluxSensor' }, { id: 'e', name: 'O_Brien', type: 'thermocouple' },
    { id: 'fallback', type: 'thermocouple', transform: { position_m: [0.0015875, -0.0000004, 1.23456789] } },
    { id: 'camera', type: 'camera' }, { id: 'future', type: 'futureProbe' }];
  const text = devicesToFds(doc), r = records(text);
  expect(r.map(d => d.string('ID'))).toEqual(['A_1', 'A_2', 'A_2_1', 'A_2_2', 'O_Brien_1', 'O_Brien_2', 'A_1_2', 'O_Brien_3', 'fallback']);
  expect(r[1].numbers('XYZ')).toEqual([0.5, 0, 1]);
  expect(r.at(-1)!.numbers('XYZ')).toEqual([0.001587, 0, 1.234568]);
  expect(r[7].string('PROP_ID')).toBeNull();
  expect(readNamelist(text).filter(d => d.group === 'PROP').map(p => p.number('DIAMETER'))).toEqual([0.0015, 0.002]);
  expect(readNamelist(text)).toHaveLength(11);
  const imported = fdsToPlan(text, null, { groupRakes: false, originM: [0, 0, 0] });
  expect(imported.doc.objects.map(o => o.name).sort()).toEqual(r.map(d => d.string('ID')).sort());
});

it('exports the empty header without changing the plan or requiring metadata', () => {
  const doc = newPlan(); delete doc.meta;
  const before = JSON.stringify(doc);
  expect(devicesToFds(doc)).toContain('! No instruments: nothing to export.\n');
  expect(readNamelist(devicesToFds(doc))).toEqual([]);
  expect(JSON.stringify(doc)).toBe(before);
});
