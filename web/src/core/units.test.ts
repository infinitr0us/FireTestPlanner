import { describe, expect, it } from 'vitest';
import { formatLength, formatLengthWithUnit, gridStep, parseLength } from './units';

describe('feet and fractional inches', () => {
  it.each([
    [108.4375, `9' 0 7/16"`], [7.25, `0' 7 1/4"`], [144, `12' 0"`],
    [-29.5, `-2' 5 1/2"`], [-0.01, `0' 0"`], [0, `0' 0"`],
    [11.99, `1' 0"`], [11.96875, `1' 0"`], [-11.96875, `-1' 0"`],
    [0.5, `0' 0 1/2"`], [0.125, `0' 0 1/8"`],
  ])('formats %s inches as %s', (inches, expected) => {
    expect(formatLength(inches * 0.0254, 'ft-in')).toBe(expected);
    expect(formatLengthWithUnit(inches * 0.0254, 'ft-in')).toBe(expected);
  });

  it.each([
    [`5' 6 1/2"`, 66.5], ['5ft 6 1/2in', 66.5], ['6 1/2"', 6.5],
    ['1/2"', 0.5], [`-0' 7 1/4"`, -7.25], ['-6 1/2"', -6.5],
    [`5' 6"`, 66], ['5ft6in', 66], ['9', 108],
  ])('parses %s', (value, inches) => {
    expect(parseLength(value, 'ft-in')).toBeCloseTo(inches * 0.0254, 12);
  });

  it('rejects invalid fractions without committing a non-finite value', () => {
    for (const value of ['1/0"', '1/-2"', `5' -6 1/2"`, '1/2/3"', '6 1/"']) {
      expect(parseLength(value, 'ft-in')).toBeNull();
    }
  });

  it('round trips every 7 mm from -5 m to 20 m within half a sixteenth inch', () => {
    for (let mm = -5000; mm <= 20000; mm += 7) {
      const value = mm / 1000;
      const formatted = formatLength(value, 'ft-in');
      const parsed = parseLength(formatted, 'ft-in');
      expect(parsed).not.toBeNull();
      expect(Math.abs(parsed! - value)).toBeLessThanOrEqual(0.0254 / 32 + 1e-12);
      expect(formatLength(parsed!, 'ft-in')).toBe(formatted);
    }
    expect(gridStep('ft-in')).toBe(0.3048);
  });
});

describe('fixed precision for dimensions and set-out', () => {
  it.each([
    ['m', '1.000'], ['cm', '100.0'], ['mm', '1000'], ['ft', '3.281'], ['in', '39.37'],
  ] as const)('uses the existing precision for %s', (unit, expected) => {
    expect(formatLength(1, unit, { fixed: true })).toBe(expected);
    expect(formatLengthWithUnit(1, unit, { fixed: true })).toBe(`${expected} ${unit}`);
  });
  it('retains trimmed fields and avoids negative zero in labels', () => {
    expect(formatLength(0.3048, 'ft')).toBe('1');
    expect(formatLength(0.3048, 'ft', { fixed: true })).toBe('1.000');
    expect(formatLength(-0.00001, 'm', { fixed: true })).toBe('0.000');
    expect(formatLength(0.3048, 'ft-in', { fixed: true })).toBe(`1' 0"`);
  });
});
