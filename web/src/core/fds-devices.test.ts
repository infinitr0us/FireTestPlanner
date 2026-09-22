import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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
  it('groups gas temperatures with thermocouples while distinguishing surface measurements', () => {
    expect(probes.map(deviceKind)).toEqual(['surface', 'flux', 'thermocouple', 'thermocouple']);
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

const path = fileURLToPath(new URL('../../../fixtures/fds-results/RC_BS_2.smv', import.meta.url));
it('retains all 67 supplied probes at 23 locations, including the upward floor gauge', () => {
  const data = parseSmv(readFileSync(path, 'utf8'));
  expect(deviceKinds.map(k => data.devices.filter(d => deviceKind(d) === k).length)).toEqual([22, 22, 23, 0]);
  const sites = deviceSites(data.devices, all());
  expect(sites).toHaveLength(23); expect(sites.filter(s => s.devices.length === 3)).toHaveLength(22);
  expect(data.devices.find(d => d.id === 'HF_23')).toMatchObject({ position: [1.1995, 1.8, 0], orientation: [0, 0, 1] });
});

it.each(['THERMOCOUPLE', 'TEMPERATURE', 'PRESSURE'])('does not mistake the default SMV normal for a facing on %s', quantity => {
  const device = parseSmv(metadata + `DEVICE
probe % ${quantity}
0 0 0 0 0 -1
`).devices[0];
  expect(device.orientation).toBeUndefined();
});
it.each(['GAUGE HEAT FLUX', 'WALL TEMPERATURE'])('retains a real downward normal for %s', quantity => {
  const device = parseSmv(metadata + `DEVICE
probe % ${quantity}
0 0 0 0 0 -1
`).devices[0];
  expect(device.orientation).toEqual([0, 0, -1]);
});
it('opens supported data with a counted warning for all geometry event types', () => {
  const data = parseSmv(metadata + ['SHOW_OBST', 'HIDE_OBST', 'OPEN_VENT', 'CLOSE_VENT'].map(tag => tag + ' 1\n1 0\n').join('') + 'CSVF\ndevc\ncase_devc.csv\n');
  expect(data.meshes).toHaveLength(1);
  expect(data.csv).toEqual([{ kind: 'devc', file: 'case_devc.csv' }]);
  expect(data.warnings).toHaveLength(1);
  expect(data.warnings[0]).toContain('4 geometry events are not animated');
});
it('parses the counted HRRPUVCUT record even after the field inventory', () => {
  const fields = 'SMOKF3D 1 0\nfire.s3d\nHRRPUV\nhrrpuv\nkW/m3\nSMOKF3D 1 0\ntemp.s3d\nTEMPERATURE\ntemp\nC\n';
  const data = parseSmv(metadata + fields + 'HRRPUVCUT\n1\n200\n');
  expect(data.fields[0].fireCutoff).toBe(200);
  expect(data.fields[1].fireCutoff).toBeUndefined();
  expect(data.warnings).toEqual([]);
  expect(parseSmv(metadata + fields).warnings[0]).toContain('No HRRPUVCUT');
  expect(() => parseSmv(metadata + 'HRRPUVCUT\n1\nNaN')).toThrow('Invalid HRRPUVCUT');
});
