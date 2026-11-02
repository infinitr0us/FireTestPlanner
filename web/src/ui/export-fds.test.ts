import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { fdsExportSummary } from './export-fds';

it.each([
  ['flame-test', '9 devices: 2 gauge heat flux, 3 thermocouple beads, 4 surface thermocouple beads.'],
  ['room_corner', '40 devices: 13 gauge heat flux, 12 thermocouple beads, 12 surface thermocouple beads, 3 Y velocity probes.'],
])('%s preview accounts for every exported quantity', (fixture, summary) => {
  const text = readFileSync(new URL(`../../../fixtures/fds/${fixture}-devices.fds`, import.meta.url), 'utf8');
  expect(fdsExportSummary(text)).toBe(summary + ' Cameras and geometry are not exported.');
});
