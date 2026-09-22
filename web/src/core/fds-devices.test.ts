import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deviceHistory, deviceKind, deviceKinds, deviceSites, pickDevices, type DeviceDisplay } from './fds-devices';
import { parseSmv, type ResultDevice, type ResultSeries } from './fds-results';

const all = (): DeviceDisplay => ({ visible: true, kinds: new Set(deviceKinds), labels: false, direction: true });
const probes: ResultDevice[] = [
  { id: 'C1', quantity: 'WALL TEMPERATURE', position: [.1, 0, .2] },
  { id: 'HF_1', quantity: 'GAUGE HEAT FLUX', position: [.1, 0, .2] },
  { id: 'TC1', quantity: 'THERMOCOUPLE', position: [.1, 0, .2] },
  { id: 'gas', quantity: 'TEMPERATURE', position: [.1, 0, .200001] },
];

describe('simulation probe identity and visibility', () => {
  it('distinguishes surface measurements and numerical gas probes from thermocouples', () => {
    expect(probes.map(deviceKind)).toEqual(['surface', 'flux', 'thermocouple', 'other']);
  });
  it('groups exact coincident positions without changing or rounding source coordinates', () => {
    const before = structuredClone(probes), sites = deviceSites(probes, all());
    expect(sites.map(s => s.devices.map(d => d.id))).toEqual([['C1', 'HF_1', 'TC1'], ['gas']]);
    expect(probes).toEqual(before);
    expect(sites[1].position[2]).toBe(.200001);
  });
  it('filters members of a shared site independently and honors the master switch', () => {
    const display = all(); display.kinds.delete('flux');
    expect(deviceSites(probes, display)[0].devices.map(d => d.id)).toEqual(['C1', 'TC1']);
    display.visible = false; expect(deviceSites(probes, display)).toEqual([]);
    display.visible = true; display.kinds.clear(); expect(deviceSites(probes, display)).toEqual([]);
  });
  it('offers every coincident or projected-overlapping device, with nearest site first', () => {
    const sites = deviceSites(probes, all());
    const projected = [{ site: sites[0], x: 30, y: 40 }, { site: sites[1], x: 30, y: 45 }];
    expect(pickDevices(projected, 30, 45).map(d => d.id)).toEqual(['gas', 'C1', 'HF_1', 'TC1']);
    expect(pickDevices(projected, 100, 100)).toEqual([]);
  });
  it('does not substitute another column when a probe has a missing or ambiguous history', () => {
    const history: ResultSeries = { name: 'TC1', unit: 'C', times: [0, 1], values: [20, 25] };
    expect(deviceHistory(probes[2], [history])).toBe(history);
    expect(deviceHistory(probes[0], [history])).toBeUndefined();
    expect(deviceHistory(probes[2], [history, { ...history }])).toBeUndefined();
  });
});

const metadata = `GRID mesh\n1 1 1\nPDIM\n0 1 0 1 0 1\nTRNX\n0\n0 0\n1 1\nTRNY\n0\n0 0\n1 1\nTRNZ\n0\n0 0\n1 1\n`;
describe('SMV probe directions', () => {
  it('preserves coordinates and normalizes a recorded direction without reading flags as geometry', () => {
    const data = parseSmv(metadata + 'DEVICE\nHF % GAUGE HEAT FLUX\n.1 0 .2 0 2 0 1 0 % null\n');
    expect(data.devices[0]).toEqual({ id: 'HF', quantity: 'GAUGE HEAT FLUX', position: [.1, 0, .2], orientation: [0, 1, 0] });
  });
  it.each(['', '0 0 0', 'NaN 0 1', '1 0', '1e309 0 0'])('does not invent a direction for %s', direction => {
    const data = parseSmv(metadata + `DEVICE\nTC % THERMOCOUPLE\n.1 0 .2 ${direction}\n`);
    expect(data.devices[0].position).toEqual([.1, 0, .2]);
    expect(data.devices[0].orientation).toBeUndefined();
  });
});

const path = fileURLToPath(new URL('../../../fixtures/fds_2/RC_BS_2.smv', import.meta.url));
it.skipIf(!existsSync(path))('retains all 67 supplied probes at 23 locations, including the upward floor gauge', () => {
  const data = parseSmv(readFileSync(path, 'utf8'));
  expect(deviceKinds.map(k => data.devices.filter(d => deviceKind(d) === k).length)).toEqual([22, 22, 23, 0]);
  const sites = deviceSites(data.devices, all());
  expect(sites).toHaveLength(23); expect(sites.filter(s => s.devices.length === 3)).toHaveLength(22);
  expect(data.devices.find(d => d.id === 'HF_23')).toMatchObject({ position: [1.1995, 1.8, 0], orientation: [0, 0, 1] });
});
