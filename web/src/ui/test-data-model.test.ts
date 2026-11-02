import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calibrationHint } from '../core/tables';
import { parseAndValidatePlan } from '../core/validate';
import {
  beadLabel, calibrationNote, defaultRole, mappingNote, nextSourceId, parseTargetKey, prefill, previewRows,
  sameUnit, shiftHintLabel, targetKey, targetOptions, updateManifestChannels,
} from './test-data-model';

const doc = () => parseAndValidatePlan(readFileSync(new URL('../../../fixtures/test-data/test-data.ftp.json', import.meta.url), 'utf8'));

describe('test data targets', () => {
  it('lists gauges, every bead with rake name and height, then burners', () => {
    const targets = targetOptions(doc(), 'm');
    expect(targets.map(t => t.label)).toEqual([
      'HF east', 'HF west',
      'TC low · bead 1 at 1 m', 'TC low · bead 2 at 1.5 m', 'TC low · bead 3 at 2 m', 'TC low · bead 4 at 2.5 m', 'TC low · bead 5 at 3 m',
      'Synthetic burner (HRR)',
    ]);
    expect(targets.map(t => t.unit)).toEqual(['kW/m2', 'kW/m2', '°C', '°C', '°C', '°C', '°C', 'kW']);
    expect(targetOptions(doc(), 'ft-in')[3].label).toBe(`TC low · bead 2 at 4' 11 1/16"`);
    expect(targetOptions(doc(), 'mm')[2].label).toBe('TC low · bead 1 at 1000 mm');
  });
  it('labels a single thermocouple without a bead number', () => {
    expect(beadLabel('Plume TC', 0, 1, 1.25, 'cm')).toBe('Plume TC at 125 cm');
    expect(beadLabel('Rake', 2, 6, 1.25, 'm')).toBe('Rake · bead 3 at 1.25 m');
  });
  it('round-trips target keys, a bead included only for thermocouples', () => {
    expect(parseTargetKey(targetKey({ object: 'tc-tree', bead: 0 }))).toEqual({ object: 'tc-tree', bead: 0 });
    expect(parseTargetKey(targetKey({ object: 'a,b"c' }))).toEqual({ object: 'a,b"c' });
  });
});

describe('calibration pre-fill', () => {
  const gauge = targetOptions(doc(), 'm')[0], bead = targetOptions(doc(), 'm')[2];
  it('takes a gauge constant in volts from the channel name and says where it came from', () => {
    const channel = { name: 'HF east_23.17kW/m2permV', unit: 'V' };
    expect(prefill(channel, gauge)).toEqual({ scale: 23170 });
    expect(calibrationNote(calibrationHint(channel.name, channel.unit)!)).toBe('23.17 kW/m² per mV, from the channel name');
    expect(mappingNote(channel, gauge, { scale: 23170 })).toEqual({ text: '23.17 kW/m² per mV, from the channel name', tone: 'info' });
    // A constant typed over the hint is the user's, and no longer attributed to the name.
    expect(mappingNote(channel, gauge, { scale: 20000 })).toBeNull();
    expect(prefill({ name: 'G 9.5 kW/m2 per mV', unit: 'mV' }, gauge)).toEqual({ scale: 9.5 });
  });
  it('gives a channel already in kW/m² a scale of 1, and warns about an unconverted unit', () => {
    expect(prefill({ name: 'HF east', unit: 'kW/m2' }, gauge, { offset: 0.5 })).toEqual({ scale: 1, offset: 0.5 });
    expect(mappingNote({ name: 'HF east', unit: 'kW/m2' }, gauge, { scale: 1 })?.tone).toBe('info');
    expect(mappingNote({ name: 'Gauge', unit: 'V' }, gauge, {})).toEqual({ text: 'Recorded in V; enter the scale that gives kW/m²', tone: 'warn' });
    expect(mappingNote({ name: 'TC', unit: '°C' }, bead, {})).toBeNull();
    expect(mappingNote({ name: 'TC', unit: 'mV' }, bead, { scale: 25 })).toBeNull();
  });
  it('keeps the calibration of a re-targeted non-gauge mapping', () => {
    expect(prefill({ name: 'TC 1', unit: '°C' }, bead, { scale: 1.01, offset: -0.4 })).toEqual({ scale: 1.01, offset: -0.4 });
    expect(prefill({ name: 'TC 1', unit: '°C' }, bead)).toEqual({});
  });
  it('compares unit spellings loosely', () => {
    expect(sameUnit('kW/m²', 'kW/m2')).toBe(true);
    expect(sameUnit('kw / m2', 'kW/m2')).toBe(true);
    expect(sameUnit('C', '°C')).toBe(true);
    expect(sameUnit('V', 'kW/m2')).toBe(false);
    expect(sameUnit(null, 'kW')).toBe(false);
  });
});

describe('manifest upkeep', () => {
  it('keeps recorded entries and describes newly mapped channels, in first-mapping order', () => {
    const source = doc().testData![1];
    const before = JSON.stringify(source.manifest.channels[0]);
    const next = updateManifestChannels(source.manifest,
      [{ channel: 'TC high', object: 'tc-tree', bead: 1 }, ...source.channels],
      [{ name: 'TC high', unit: '°C', samples: 61, t0: 0, t1: 600 }]);
    expect(next.channels.map(c => c.name)).toEqual(['TC high', 'HF east', 'TC low']);
    expect(JSON.stringify(next.channels[1])).toBe(before);
    expect(next.size).toBe(source.manifest.size);
    expect(updateManifestChannels(source.manifest, [], []).channels).toEqual([]);
    expect(() => updateManifestChannels(source.manifest, [{ channel: 'Nope', object: 'hf-east' }], [])).toThrow('Channel "Nope" is not in this file.');
  });
});

describe('dialog helpers', () => {
  it('previews the first rows, or windows around a layout further down', () => {
    expect(previewRows(600, { headerRow: 1, unitsRow: null, dataRow: 2 })).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(previewRows(5, { headerRow: 1, unitsRow: 2, dataRow: 3 })).toEqual([1, 2, 3, 4, 5]);
    expect(previewRows(600, { headerRow: 20, unitsRow: 21, dataRow: 25 })).toEqual([1, 2, 3, null, 19, 20, 21, 22, null, 25, 26, 27, 28]);
  });
  it('words the shift hint with its numbers and sheet names', () => {
    expect(shiftHintLabel({ seconds: 420, sheets: ['HRR', 'HF', 'TC'] })).toBe('Use 420 s from the sheets HRR, HF, TC');
    expect(shiftHintLabel({ seconds: 120, sheets: ['Processed'] })).toBe('Use 120 s from the sheet Processed');
  });
  it('defaults FDS output to simulated and picks a free source id', () => {
    expect(defaultRole({ shape: 'fds' })).toBe('simulated');
    expect(defaultRole({ shape: 'paired-time' })).toBe('measured');
    const d = doc();
    expect(nextSourceId(d)).toBe('td-1');
    d.testData![0].id = 'td-1';
    expect(nextSourceId(d)).toBe('td-2');
  });
});

describe('targets for the instruments added in format 1.7', () => {
  it('lists velocity probes, gas points and load cells with their units, and no unit warning for gas', async () => {
    const { createVelocityProbe, createGasSampling, createLoadCell } = await import('../core/factory');
    const { targetOptions, mappingNote, TARGET_GROUPS } = await import('./test-data-model');
    const d = doc();
    d.objects.push(createVelocityProbe(d), createGasSampling(d), createLoadCell(d));
    const added = targetOptions(d, 'm').filter(t => ['velocityProbe', 'gasSampling', 'loadCell'].includes(t.group));
    expect(added.map(t => [t.group, t.unit])).toEqual([['velocityProbe', 'm/s'], ['gasSampling', null], ['loadCell', 'kg']]);
    expect(Object.keys(TARGET_GROUPS)).toEqual(['gauge', 'thermocouple', 'velocityProbe', 'gasSampling', 'loadCell', 'burner']);
    expect(mappingNote({ name: 'O2', unit: '%Vol' }, added[1], {})).toBeNull();
    expect(mappingNote({ name: 'Mass', unit: 'g' }, added[2], {})?.tone).toBe('warn');
  });
});
