import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { delimitedRows } from './delimited';
import { instrumentScheduleCsv } from './instrument-schedule';
import { plannedValue } from './planned-value';
import { heatFluxSensors, heatFluxEstimate, thermocouples, thermocoupleBeads } from './plan';
import { parseAndValidatePlan } from './validate';
import { formatLength } from './units';

const example = () => parseAndValidatePlan(readFileSync(new URL('../../../fixtures/flame/flame-test.ftp.json', import.meta.url), 'utf8'));

describe('planned values', () => {
  it('uses the Example incident flux, bead correlation and 80 kW burner', () => {
    const doc = example();
    for (const g of heatFluxSensors(doc)) expect(plannedValue(doc, g.id)).toMatchObject({ value: heatFluxEstimate(doc, g)!.incidentKwM2, unit: 'kW/m2' });
    let correlated = 0, absent = 0;
    for (const tc of thermocouples(doc)) for (const b of thermocoupleBeads(doc, tc)) {
      const value = plannedValue(doc, tc.id, b.index)!;
      expect(value.value).toBe(b.gasTemperatureC); expect(value.unit).toBe('°C');
      if (value.value === null) { absent++; expect(value.note).toContain('No gas temperature correlation'); }
      else correlated++;
    }
    expect(correlated).toBeGreaterThan(0); expect(absent).toBeGreaterThan(0);
    expect(plannedValue(doc, 'burner-main')).toMatchObject({ value: 80, unit: 'kW' });
    expect(plannedValue(doc, 'cam-mwir')).toBeNull();
    expect(plannedValue(doc, 'absent')).toBeNull();
  });
});

describe('instrument schedule CSV', () => {
  it.each(['m', 'ft-in'] as const)('lists every Example instrument in %s with transformed bead positions and fixed formatting', unit => {
    const doc = example(), text = instrumentScheduleCsv(doc, unit), rows = delimitedRows(text, ',');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(rows).toHaveLength(14); // heading, four cameras, two gauges, seven beads
    expect(rows[0]).toContain(`Height (${unit})`);
    expect(rows.filter(r => r[1] === 'Thermocouple bead')).toHaveLength(7);
    for (const tc of thermocouples(doc)) for (const bead of thermocoupleBeads(doc, tc)) {
      const row = rows.find(r => r[2] === `${tc.id}[${bead.index}]`)!;
      expect(row.slice(3, 6)).toEqual(bead.world.map(v => formatLength(v, unit, { fixed: true })));
    }
    const gauge = rows.find(r => r[1] === 'Heat flux gauge')!;
    expect(gauge[7]).toContain('toward'); expect(Number(gauge[8])).toBeGreaterThan(0);
    if (unit === 'ft-in') expect(text).toContain('""');
    else expect(gauge[5]).toMatch(/^-?\d+\.\d{3}$/);
  });

  it('quotes commas, newlines and quotes and includes each source channel column', () => {
    const doc = example(), gauge = heatFluxSensors(doc)[0], tc = thermocouples(doc)[0];
    gauge.name = 'Gauge, "east"\r\nwall';
    const model = parseAndValidatePlan(readFileSync(new URL('../../../fixtures/test-data/test-data.ftp.json', import.meta.url), 'utf8'));
    doc.testData = model.testData;
    doc.testData![0].channels = [{ channel: 'Volts, "raw"', object: gauge.id }, { channel: 'TC 2', object: tc.id, bead: 1 }];
    const rows = delimitedRows(instrumentScheduleCsv(doc, 'm'), ',');
    expect(rows[0].slice(-2)).toEqual(['Synthetic logger', 'Synthetic FDS']);
    expect(rows.find(r => r[2] === gauge.id)!.slice(-2)).toEqual(['Volts, "raw"', 'HF east']);
    expect(rows.find(r => r[2] === gauge.id)![0]).toBe(gauge.name);
    expect(rows.find(r => r[2] === `${tc.id}[1]`)!.at(-2)).toBe('TC 2');
    expect(rows.find(r => r[2] === `${tc.id}[0]`)!.at(-2)).toBe('');
  });
});
