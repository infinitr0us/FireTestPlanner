/**
 * Unit display and input parsing.
 *
 * Stored values are always metres (CONVENTIONS.md section 2). This module is the
 * only place that converts, so no other code has to know what the user picked.
 */

import type { LengthUnit } from './types';

const PER_METRE: Record<LengthUnit, number> = {
  m: 1,
  cm: 100,
  mm: 1000,
  ft: 1 / 0.3048,
  in: 1 / 0.0254,
};

/** How many decimals to show so the displayed precision is roughly 1 mm. */
const DECIMALS: Record<LengthUnit, number> = { m: 3, cm: 1, mm: 0, ft: 3, in: 2 };

export const toDisplay = (metres: number, unit: LengthUnit): number =>
  metres * PER_METRE[unit];

export const fromDisplay = (value: number, unit: LengthUnit): number =>
  value / PER_METRE[unit];

export function formatLength(metres: number, unit: LengthUnit): string {
  const v = toDisplay(metres, unit);
  // Trim trailing zeros: "2.740" reads worse than "2.74" on a dimension line.
  return String(Number(v.toFixed(DECIMALS[unit])));
}

export const formatLengthWithUnit = (metres: number, unit: LengthUnit): string =>
  `${formatLength(metres, unit)} ${unit}`;

/**
 * Parse a length the user typed, in metres.
 *
 * A bare number means the current display unit, but an explicit suffix always
 * wins -- so someone working in metres can type `9ft` into any field without
 * switching modes, and feet-and-inches (`5' 6"`, `5ft 6in`) parses as one value.
 * Returns null when the text is not a length at all.
 */
export function parseLength(text: string, displayUnit: LengthUnit): number | null {
  const s = text.trim().toLowerCase().replace(/,/g, '');
  if (!s) return null;

  // Feet-and-inches, e.g. 5' 6", 5ft6in, 5 ft 6 in
  const feetInches = s.match(
    /^(-?\d*\.?\d+)\s*(?:'|ft|feet|foot)\s*(\d*\.?\d+)\s*(?:"|in|inch|inches)?$/,
  );
  if (feetInches) {
    const sign = feetInches[1].startsWith('-') ? -1 : 1;
    const feet = Math.abs(parseFloat(feetInches[1]));
    const inches = parseFloat(feetInches[2]);
    return sign * (feet * 0.3048 + inches * 0.0254);
  }

  const single = s.match(/^(-?\d*\.?\d+(?:e[+-]?\d+)?)\s*([a-z"']*)$/);
  if (!single) return null;

  const value = parseFloat(single[1]);
  if (!Number.isFinite(value)) return null;

  const suffix = single[2];
  if (!suffix) return fromDisplay(value, displayUnit);

  switch (suffix) {
    case 'm':
    case 'metre':
    case 'metres':
    case 'meter':
    case 'meters':
      return value;
    case 'cm':
      return value / 100;
    case 'mm':
      return value / 1000;
    case 'ft':
    case 'feet':
    case 'foot':
    case "'":
      return value * 0.3048;
    case 'in':
    case 'inch':
    case 'inches':
    case '"':
      return value * 0.0254;
    default:
      return null;
  }
}

export const radToDeg = (r: number): number => (r * 180) / Math.PI;
export const degToRad = (d: number): number => (d * Math.PI) / 180;

export function formatAngleDeg(radians: number): string {
  return String(Number(radToDeg(radians).toFixed(1)));
}

/** A grid step that stays readable in the active unit: 1 m, or 1 ft in imperial. */
export function gridStep(unit: LengthUnit): number {
  return unit === 'ft' || unit === 'in' ? 0.3048 : 1;
}
