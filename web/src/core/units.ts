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
  'ft-in': 1 / 0.3048, // bare input is feet; formatting is fractional inches
  in: 1 / 0.0254,
};

/** How many decimals to show so the displayed precision is roughly 1 mm. */
const DECIMALS = { m: 3, cm: 1, mm: 0, ft: 3, in: 2 };

export const toDisplay = (metres: number, unit: LengthUnit): number =>
  metres * PER_METRE[unit];

export const fromDisplay = (value: number, unit: LengthUnit): number =>
  value / PER_METRE[unit];

export interface LengthFormatOptions { fixed?: boolean }

/** Round the magnitude once, in sixteenths, before splitting feet and inches.
 * This carries through both inch and foot boundaries and rounds ties away from
 * zero. A negative value smaller than half a sixteenth has no printed sign. */
function formatFeetInches(metres: number): string {
  const ticks = Math.round(Math.abs(metres) / 0.0254 * 16);
  const feet = Math.floor(ticks / 192);
  const inches = Math.floor(ticks % 192 / 16);
  let numerator = ticks % 16;
  let denominator = 16;
  while (numerator > 0 && numerator % 2 === 0) {
    numerator /= 2;
    denominator /= 2;
  }
  return `${metres < 0 && ticks > 0 ? '-' : ''}${feet}' ${inches}${numerator ? ` ${numerator}/${denominator}` : ''}"`;
}

export function formatLength(metres: number, unit: LengthUnit, opts: LengthFormatOptions = {}): string {
  if (!Number.isFinite(metres)) return String(metres);
  if (unit === 'ft-in') return formatFeetInches(metres);
  const v = toDisplay(metres, unit);
  const rounded = v.toFixed(DECIMALS[unit]);
  // Fields trim; adjacent dimensions and set-out coordinates retain precision.
  // Number also removes a minus sign on rounded zero.
  return opts.fixed ? Number(rounded).toFixed(DECIMALS[unit]) : String(Number(rounded));
}

export const formatLengthWithUnit = (metres: number, unit: LengthUnit, opts: LengthFormatOptions = {}): string =>
  `${formatLength(metres, unit, opts)}${unit === 'ft-in' ? '' : ` ${unit}`}`;

/**
 * One run of digits, dots and commas, with its commas read -- or null.
 *
 * Commas used to be deleted outright, so `2,5` -- two and a half, typed with a
 * decimal comma -- was stored as 25 m. Grouping is still read (`1,250.5`,
 * `12,500,000`) and a comma that cannot be grouping is a decimal comma (`2,5`,
 * `0,25`). A single comma before exactly three digits (`1,250`) is either, 1250 or
 * 1.25, and is refused rather than guessed.
 */
function readCommas(token: string): string | null {
  if (!token.includes(',')) return token;
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(token)) {
    return token.includes('.') || token.split(',').length > 2 ? token.replace(/,/g, '') : null;
  }
  return /^\d*,\d+$/.test(token) ? token.replace(',', '.') : null;
}

/** A number as typed: digits with an optional fraction, a leading `.5`, or a
 *  trailing `5.` -- which used to be refused. */
const NUMBER = String.raw`(?:\d+\.?\d*|\.\d+)`;
const FRACTION = String.raw`\d+\s*/\s*\d+`;
const INCH_VALUE = String.raw`(?:\d+\s+${FRACTION}|${FRACTION}|${NUMBER})`;
const FEET_INCHES = new RegExp(String.raw`^(-?${NUMBER})\s*(?:'|ft|feet|foot)\s*(${INCH_VALUE})\s*(?:"|in|inch|inches)?$`);
const FRACTIONAL_INCHES = new RegExp(String.raw`^(-?)(${INCH_VALUE})\s*(?:"|in|inch|inches)$`);
const SINGLE = new RegExp(String.raw`^(-?${NUMBER}(?:e[+-]?\d+)?)\s*([a-z"']*)$`);

function readInches(text: string): number {
  const fraction = text.match(/^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/);
  return fraction ? Number(fraction[1] ?? 0) + Number(fraction[2]) / Number(fraction[3]) : Number(text);
}

/**
 * Parse a length the user typed, in metres.
 *
 * A bare number means the current display unit, but an explicit suffix always
 * wins -- so someone working in metres can type `9ft` into any field without
 * switching modes, and feet-and-inches (`5' 6"`, `5ft 6in`) parses as one value.
 * Returns null when the text is not a length at all, or its commas are ambiguous.
 */
export function parseLength(text: string, displayUnit: LengthUnit): number | null {
  let ambiguous = false;
  const s = text.trim().toLowerCase().replace(/[\d.,]+/g, (token) => {
    const read = readCommas(token);
    if (read === null) ambiguous = true;
    return read ?? token;
  });
  if (!s || ambiguous) return null;

  // Feet-and-inches, e.g. 5' 6", 5ft6in, 5 ft 6 in
  const feetInches = s.match(FEET_INCHES);
  if (feetInches) {
    const sign = feetInches[1].startsWith('-') ? -1 : 1;
    const feet = Math.abs(parseFloat(feetInches[1]));
    const inches = readInches(feetInches[2]);
    const result = sign * (feet * 0.3048 + inches * 0.0254);
    return Number.isFinite(result) ? result : null;
  }

  const fractionalInches = s.match(FRACTIONAL_INCHES);
  if (fractionalInches) {
    const result = (fractionalInches[1] ? -1 : 1) * readInches(fractionalInches[2]) * 0.0254;
    return Number.isFinite(result) ? result : null;
  }
  const single = s.match(SINGLE);
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
  return unit === 'ft' || unit === 'ft-in' || unit === 'in' ? 0.3048 : 1;
}
