import * as i18n from './i18n';
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
  get slow() { return i18n.t("Slow"); }, get medium() { return i18n.t("Medium"); }, get fast() { return i18n.t("Fast"); }, get 'ultra-fast'() { return i18n.t("Ultra-fast"); }, get custom() { return i18n.t("Custom α"); },
};

const number = (v: number): string => i18n.numberText(Number(v.toFixed(6)));
const seconds = (v: number): string => i18n.formatQuantity(Number(v.toFixed(1)), 's');

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
  if (source?.startsWith('fds-ramp:')) return i18n.t("From FDS: {p1}", { p1: source.slice(9) });
  if (source === 'fds-tau_q') return i18n.t("From FDS: TAU_Q");
  return source ? i18n.t("Imported: {p1}", { p1: source }) : i18n.t("Imported");
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
  if (!(alpha > 0) || !Number.isFinite(alpha)) { invalid.push('alpha'); problems.push(i18n.t("α must be a positive number of kW/s²")); }
  if (!(peak > 0) || !Number.isFinite(peak)) { invalid.push('peak'); problems.push(i18n.t("the peak must be above 0 kW")); }
  if (!(hold >= 0) || !Number.isFinite(hold)) { invalid.push('hold'); problems.push(i18n.t("the hold must be 0 s or longer")); }
  if (!(decay > 0) || !Number.isFinite(decay)) { invalid.push('decay'); problems.push(i18n.t("the decay must be longer than 0 s")); }
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
      i18n.t("Time to peak {p1} · holds to {p2} · ends at {p3}", { p1: seconds(growth), p2: seconds(growth + hold), p3: seconds(growth + hold + decay) }) };
  } catch {
    return { curve: null, error: true, invalid: ['peak', 'hold', 'decay'],
      readout: i18n.t("Time to peak {p1}, but the curve would need more than 10,000 points. Shorten it.", { p1: seconds(growth) }) };
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
  if (!lines.length) return { error: i18n.t("Paste two columns: time (s) and HRR (kW), one point per row.") };
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
      return { error: i18n.plural("Row {p1} has {p2} value; paste two columns, time (s) and HRR (kW).", "Row {p1} has {p2} values; paste two columns, time (s) and HRR (kW).", cells.length, { p1: row, p2: cells.length }) };
    }
    const bad = numbers.findIndex(n => !Number.isFinite(n));
    if (bad >= 0) return { error: i18n.t("Row {p1}: \"{p2}\" is not a number.", { p1: row, p2: cells[bad] }) };
    const [t, q] = numbers;
    if (t < 0) return { error: i18n.t("Row {p1}: time {p2} s is before ignition; times start at 0 s or later.", { p1: row, p2: number(t) }) };
    if (q < 0) return { error: i18n.t("Row {p1}: {p2} kW is negative; a heat release rate is 0 kW or more.", { p1: row, p2: number(q) }) };
    const previous = points[points.length - 1];
    if (previous && t <= previous[0]) {
      return { error: i18n.t("Row {p1}: time {p2} s does not follow {p3} s; times must increase strictly.", { p1: row, p2: number(t), p3: number(previous[0]) }) };
    }
    points.push([t, q]);
  }
  if (points.length < 2) return { error: i18n.t("A curve needs at least two points; the table has {p1}.", { p1: points.length }) };
  if (points.length > 10000) return { error: i18n.t("A curve holds at most 10,000 points; the table has {p1}.", { p1: points.length.toLocaleString(i18n.language() === 'fr' ? 'fr-CA' : undefined) }) };
  const curve: HrrCurve = { points, source: 'table' };
  const problem = curveProblem(curve);
  if (problem) return { error: problem };
  const peak = curvePeak(curve), at = points.find(p => p[1] === peak)![0];
  return { curve, summary: i18n.t("{p1} points from {p2} s to {p3} s, peak {p4} kW at {p5} s", { p1: points.length, p2: number(points[0][0]), p3: number(points[points.length - 1][0]), p4: number(peak), p5: number(at) }) };
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
  if (t.length < 2) throw new Error(i18n.plural("{p1} has {p2} sample at or after ignition; a curve needs two.", "{p1} has {p2} samples at or after ignition; a curve needs two.", t.length, { p1: series.sourceName, p2: t.length }));
  const { curve, notes } = curveFromSeries(t, values, maxPoints);
  curve.source = `${series.role}:${series.sourceId}`;
  const problem = curveProblem(curve);
  if (problem) throw new Error(`${series.sourceName}: ${problem}`);
  const kept = i18n.t("Kept {p1} of {p2} samples, with the extremes.", { p1: curve.points.length, p2: t.length.toLocaleString(i18n.language() === 'fr' ? 'fr-CA' : undefined) });
  const dropped = first ? i18n.plural(" Dropped {p1} sample before ignition.", " Dropped {p1} samples before ignition.", first, { p1: first.toLocaleString(i18n.language() === 'fr' ? 'fr-CA' : undefined) }) : '';
  return { curve, message: [kept + dropped, ...notes].join(' ') };
}
