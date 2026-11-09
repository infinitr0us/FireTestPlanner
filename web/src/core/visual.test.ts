import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEVICE_KINDS, deviceKind } from './fds-devices';
import { defaultDeviceMap } from './fds';
import { TYPE_COLORS } from './plan';
import { COLORS } from '../scene/builders';

describe('instrument identity across import, plan and results', () => {
  it.each([...defaultDeviceMap()].filter(([, type]) => type !== null))('%s keeps its planning color in results', (quantity, type) => {
    const kind = deviceKind({ id: 'probe', quantity, position: [0, 0, 0] });
    const resultColor = DEVICE_KINDS[kind].color;
    expect(resultColor).toBe(TYPE_COLORS[type!]);
    expect(parseInt(resultColor.slice(1), 16)).toBe(({ thermocouple: COLORS.thermocouple, heatFluxSensor: COLORS.heatFlux, velocityProbe: COLORS.velocity, gasSampling: COLORS.gas }[type!]));
  });
  it.each(['PRESSURE'])('%s remains an unclassified numerical probe', quantity => {
    expect(deviceKind({ id: 'probe', quantity, position: [0, 0, 0] })).toBe('other');
  });
  it('normalizes quantity spelling without changing the source record', () => {
    const probe = { id: 'gas', quantity: ' temperature ', position: [0, 0, 0] as [number, number, number] };
    expect(deviceKind(probe)).toBe('thermocouple');
    expect(probe.quantity).toBe(' temperature ');
  });
});

// These presentation consumers must use shared identity/theme tokens. Legacy
// geometry, print and scientific palettes remain outside this focused guard.
it.each(['../ui/fds-results.ts', '../ui/reconstruction-plot.ts', '../ui/panels.ts', '../ui/export-fds.ts',
  '../ui/plot-panel.ts', '../ui/plot-svg.ts', '../ui/instrument-plot.ts', '../ui/test-data.ts', '../ui/test-data-model.ts',
  '../ui/hrr-curve-editor.ts', '../ui/playback-bar.ts',
  '../ui/flame-analysis.ts', '../ui/flame-analysis-cameras.ts', '../ui/flame-analysis-plots.ts', '../ui/flame-analysis-video.ts',
  '../scene/fds-devices.ts', './fds-devices.ts'])('%s introduces no private color literals', path => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  expect(source.match(/#[\da-f]{3,8}\b|\b0x[\da-f]{6}\b/gi) ?? []).toEqual([]);
});
