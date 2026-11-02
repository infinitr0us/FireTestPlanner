import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newPlan, checkPlan } from './plan';
import { serializePlan } from './serialize';
import { FORMAT_VERSIONS, FORMAT_VERSION_LATEST, requiredFormatVersion } from './types';
import { parseAndValidatePlan } from './validate';

const text = readFileSync(new URL('../../../fixtures/ft-in.ftp.json', import.meta.url), 'utf8');

describe('format 1.5 feet and inches (mirrored by test_ft_in_format.py)', () => {
  it('loads and writes the shared canonical fixture byte for byte', () => {
    const doc = parseAndValidatePlan(text);
    expect(serializePlan(doc)).toBe(text);
    expect(requiredFormatVersion(doc)).toBe('1.5.0');
    expect(FORMAT_VERSIONS).toContain('1.5.0');
    expect(FORMAT_VERSION_LATEST).toBe('1.5.0');
    doc.version = '1.0.0';
    expect(checkPlan(doc).some(i => i.code === 'version-understated')).toBe(true);
    expect(serializePlan(doc)).toBe(text);
    doc.version = '2.0.0';
    expect(JSON.parse(serializePlan(doc)).version).toBe('2.0.0');
  });

  it.each(['m', 'cm', 'mm', 'ft', 'in'] as const)('does not bump %s', unit => {
    const doc = newPlan();
    doc.units.display!.length = unit;
    expect(JSON.parse(serializePlan(doc)).version).toBe('1.0.0');
    doc.units.display!.length = 'ft-in';
    expect(JSON.parse(serializePlan(doc)).version).toBe('1.5.0');
  });

  it.each([
    'pool-fire-camera-row.ftp.json', 'flame/flame-test.ftp.json',
    'linked-files/linked-test.ftp.json', 'fds/room_corner.ftp.json',
  ])('preserves the existing %s fixture and version', path => {
    const original = readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url), 'utf8');
    expect(serializePlan(parseAndValidatePlan(original))).toBe(original);
  });
});
