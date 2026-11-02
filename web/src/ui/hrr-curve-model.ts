/**
 * The burner inspector's ways to make a heat release rate curve, without the DOM:
 * reading a pasted table, the t² form and its readout, and thinning a mapped test
 * data series. Every way ends in an ordinary `fire.hrrCurve` (CONVENTIONS 5).
 */
import { curvePeak, curveFromSeries, curveProblem, GROWTH_RATES, t2Curve } from '../core/hrr';
import type { Series } from '../core/test-data';
import type { HrrCurve } from '../core/types';

/** The ways the Curve select offers; `imported` is a curve made elsewhere (FDS, a script). */
export type CurveMode = 'steady' | 't2' | 'table' | 'measured' | 'imported';
export type GrowthRate = keyof typeof GROWTH_RATES | 'custom';

export const GROWTH_LABELS: Record<GrowthRate, string> = {
  slow: 'Slow', medium: 'Medium', fast: 'Fast', 'ultra-fast': 'Ultra-fast', custom: 'Custom α',
};

const number = (v: number): string => String(Number(v.toFixed(6)));
const seconds = (v: number): string => `${Number(v.toFixed(1))} s`;

/** Which way made a curve, from its free-text source. */
export function curveMode(curve: HrrCurve | null | undefined): CurveMode {
  if (!curve) return 'steady';
  const source = curve.source ?? '';
  if (/^t2(?:$|[-:])/.test(source)) return 't2';
  if (source === 'table') return 'table';
  if (/^(?:measured|simulated)(?:$|:)/.test(source)) return 'measured';
  return 'imported';
}

/** The Curve select's word for a curve made elsewhere. */
export function importedLabel(source: string | undefined): string {
  if (source?.startsWith('fds-ramp:')) return `From FDS: ${source.slice(9)}`;
  if (source === 'fds-tau_q') return 'From FDS: TAU_Q';
  return source ? `Imported: ${source}` : 'Imported';
}

// -- t² growth -------------------------------------------------------------

/** The t² form as typed: strings, so a half-typed number survives a repaint. */
export interface T2Draft { rate: GrowthRate; alpha: string; peak: string; hold: string; decay: string }
export interface T2Result {
  curve: HrrCurve | null;
  /** The resulting times, for the readout, or why there is no curve. */
  readout: string;
  error: boolean;
  /** Fields the error is about, for `aria-invalid`. */
  invalid: (keyof T2Draft)[];
}

/** A fresh form for a burner: medium growth to its current rate, 300 s hold and decay. */
export function t2Draft(peak: number | null, curve?: HrrCurve | null): T2Draft {
  const draft: T2Draft = { rate: 'medium', alpha: String(GROWTH_RATES.medium), peak: number(peak && peak > 0 ? peak : 1000), hold: '300', decay: '300' };
  if (!curve || curveMode(curve) !== 't2') return draft;
  // A t² curve's own parameters: growth to the first peak point, hold to the last,
  // then the decay to the end.
  const p = curve.points, top = curvePeak(curve);
  const first = p.findIndex(q => q[1] === top), last = p.length - 1 - [...p].reverse().findIndex(q => q[1] === top);
  const growth = p[first][0] - p[0][0];
  if (!(top > 0) || !(growth > 0) || last === p.length - 1) return { ...draft, peak: number(top) };
  const alpha = top / growth ** 2;
  const named = /^t2-(.+)$/.exec(curve.source ?? '')?.[1];
  const rate = (Object.keys(GROWTH_RATES) as (keyof typeof GROWTH_RATES)[])
    .find(r => r === named || Math.abs(GROWTH_RATES[r] - alpha) <= GROWTH_RATES[r] * 1e-6) ?? 'custom';
  return { rate, alpha: number(rate === 'custom' ? alpha : GROWTH_RATES[rate]), peak: number(top),
    hold: number(p[last][0] - p[first][0]), decay: number(p[p.length - 1][0] - p[last][0]) };
}

const parseNumber = (text: string): number => {
  const trimmed = text.trim().replace(/^(-?\d*),(\d+)$/, '$1.$2');
  return trimmed === '' ? NaN : Number(trimmed);
};

/** The curve a t² form makes, and the time to peak it implies. */
export function t2FromDraft(d: T2Draft): T2Result {
  const alpha = d.rate === 'custom' ? parseNumber(d.alpha) : GROWTH_RATES[d.rate];
  const peak = parseNumber(d.peak), hold = parseNumber(d.hold), decay = parseNumber(d.decay);
  const invalid: (keyof T2Draft)[] = [];
  const problems: string[] = [];
  if (!(alpha > 0) || !Number.isFinite(alpha)) { invalid.push('alpha'); problems.push('α must be a positive number of kW/s²'); }
  if (!(peak > 0) || !Number.isFinite(peak)) { invalid.push('peak'); problems.push('the peak must be above 0 kW'); }
  if (!(hold >= 0) || !Number.isFinite(hold)) { invalid.push('hold'); problems.push('the hold must be 0 s or longer'); }
  if (!(decay > 0) || !Number.isFinite(decay)) { invalid.push('decay'); problems.push('the decay must be longer than 0 s'); }
  if (problems.length) {
    const text = problems.join('; ');
    // Sentence case, but α stays a lower-case alpha.
    return { curve: null, readout: `${text.replace(/^[a-z]/, (c) => c.toUpperCase())}.`, error: true, invalid };
  }
  const growth = Math.sqrt(peak / alpha);
  try {
    const curve = t2Curve({ alpha_kW_s2: alpha, peak_kW: peak, hold_s: hold, decay_s: decay });
    curve.source = d.rate === 'custom' ? 't2' : `t2-${d.rate}`;
    return { curve, error: false, invalid, readout:
      `Time to peak ${seconds(growth)} · holds to ${seconds(growth + hold)} · ends at ${seconds(growth + hold + decay)}` };
  } catch {
    return { curve: null, error: true, invalid: ['peak', 'hold', 'decay'],
      readout: `Time to peak ${seconds(growth)}, but the curve would need more than 10,000 points. Shorten it.` };
  }
}

// -- a pasted table ----------------------------------------------------------

export type TableResult = { curve: HrrCurve; summary: string; error?: undefined } | { curve?: undefined; summary?: undefined; error: string };

/**
 * Two columns pasted from a spreadsheet: time (s) and HRR (kW). Cells are split
 * by tab, else semicolon, else comma, else spaces; with a tab or semicolon a cell
 * may use a decimal comma. One header row of text is skipped. Times must increase
 * strictly from 0 s or later, rates must be 0 kW or more, and there must be two
 * points at least, as every curve must (CONVENTIONS 5).
 */
export function parseCurveTable(text: string): TableResult {
  const lines = text.split(/\r\n|\r|\n/).map((line, i) => ({ line, row: i + 1 })).filter(l => l.line.trim() !== '');
  if (!lines.length) return { error: 'Paste two columns: time (s) and HRR (kW), one point per row.' };
  const separator = /\t/.test(text) ? '\t' : /;/.test(text) ? ';' : /,/.test(text) ? ',' : null;
  // Beside a tab or semicolon a comma is part of the number: a decimal comma, or a
  // thousands separator in a table whose decimals are points.
  const commaInCells = separator === '\t' || separator === ';';
  const pointDecimals = /\d\.\d/.test(text);
  const cellsOf = (line: string): string[] => {
    const cells = (separator ? line.split(separator) : line.trim().split(/\s+/)).map(c => c.trim());
    while (cells.length > 2 && cells[cells.length - 1] === '') cells.pop();
    return cells;
  };
  const value = (cell: string): number => {
    let c = cell;
    if (commaInCells && c.includes(',')) {
      c = pointDecimals ? (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(c) ? c.replace(/,/g, '') : c)
        : c.replace(/^([+-]?\d*),(\d+)$/, '$1.$2');
    }
    return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(c) ? Number(c) : NaN;
  };
  const points: [number, number][] = [];
  for (const [i, { line, row }] of lines.entries()) {
    const cells = cellsOf(line);
    const numbers = cells.map(value);
    // A header is a first row with no number in it: "Time (s)	HRR (kW)".
    if (i === 0 && numbers.every(Number.isNaN)) continue;
    if (cells.length !== 2) {
      return { error: `Row ${row} has ${cells.length} value${cells.length === 1 ? '' : 's'}; paste two columns, time (s) and HRR (kW).` };
    }
    const bad = numbers.findIndex(n => !Number.isFinite(n));
    if (bad >= 0) return { error: `Row ${row}: "${cells[bad]}" is not a number.` };
    const [t, q] = numbers;
    if (t < 0) return { error: `Row ${row}: time ${number(t)} s is before ignition; times start at 0 s or later.` };
    if (q < 0) return { error: `Row ${row}: ${number(q)} kW is negative; a heat release rate is 0 kW or more.` };
    const previous = points[points.length - 1];
    if (previous && t <= previous[0]) {
      return { error: `Row ${row}: time ${number(t)} s does not follow ${number(previous[0])} s; times must increase strictly.` };
    }
    points.push([t, q]);
  }
  if (points.length < 2) return { error: `A curve needs at least two points; the table has ${points.length}.` };
  if (points.length > 10000) return { error: `A curve holds at most 10,000 points; the table has ${points.length.toLocaleString()}.` };
  const curve: HrrCurve = { points, source: 'table' };
  const problem = curveProblem(curve);
  if (problem) return { error: problem };
  const peak = curvePeak(curve), at = points.find(p => p[1] === peak)![0];
  return { curve, summary: `${points.length} points from ${number(points[0][0])} s to ${number(points[points.length - 1][0])} s, peak ${number(peak)} kW at ${number(at)} s` };
}

/** A curve as table text, one `time<TAB>kW` row per point, for editing as a table. */
export const curveTable = (curve: HrrCurve): string => curve.points.map(([t, q]) => `${number(t)}\t${number(q)}`).join('\n');

// -- from test data ------------------------------------------------------------

export interface MeasuredResult { curve: HrrCurve; message: string }

/**
 * A mapped HRR series thinned to at most 200 points keeping its extremes, with
 * the source recorded as `measured:<source id>` (`simulated:` for a simulated
 * source). Samples before ignition are dropped, since a curve starts at 0 s or
 * later, and negative rates are clamped to 0 kW; the message says how many.
 */
export function curveFromTestSeries(series: Series, maxPoints = 200): MeasuredResult {
  let first = 0;
  while (first < series.t.length && series.t[first] < 0) first++;
  const t = series.t.subarray(first), values = series.values.subarray(first);
  if (t.length < 2) throw new Error(`${series.sourceName} has ${t.length} sample${t.length === 1 ? '' : 's'} at or after ignition; a curve needs two.`);
  const { curve, notes } = curveFromSeries(t, values, maxPoints);
  curve.source = `${series.role}:${series.sourceId}`;
  const problem = curveProblem(curve);
  if (problem) throw new Error(`${series.sourceName}: ${problem}`);
  const kept = `Kept ${curve.points.length} of ${t.length.toLocaleString()} samples, with the extremes.`;
  const dropped = first ? ` Dropped ${first.toLocaleString()} sample${first === 1 ? '' : 's'} before ignition.` : '';
  return { curve, message: [kept + dropped, ...notes].join(' ') };
}
