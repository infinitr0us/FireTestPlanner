import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { fdsExportSummary } from './export-fds';

it.each([
  ['flame-test', '9 devices: 1 gauge heat flux, 1 radiative heat flux gas, 3 thermocouple beads, 4 surface thermocouple beads.'],
  ['room_corner', '37 devices: 13 gauge heat flux, 12 thermocouple beads, 12 surface thermocouple beads.'],
])('%s preview accounts for every exported quantity', (fixture, summary) => {
  const text = readFileSync(new URL(`../../../fixtures/fds/${fixture}-devices.fds`, import.meta.url), 'utf8');
  expect(fdsExportSummary(text)).toBe(summary + ' Cameras and geometry are not exported.');
});
