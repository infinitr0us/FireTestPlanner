/**
 * Shared pieces of the viewport plots: SVG construction, number and time
 * formatting, axis ticks, and the line styles that tell sources and beads apart.
 * Colours are the `--plot-*` tokens of styles.css :root; nothing here holds a
 * colour value of its own (docs/visual-language.md).
 */

export const fmt = (v: number): string => Number(v.toPrecision(4)).toString();

const NS = 'http://www.w3.org/2000/svg';
export function svgElement(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Round step sizes, 1, 2 or 5 times a power of ten, near `target` intervals. */
export function niceStep(span: number, target = 4): number {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const raw = span / Math.max(1, target);
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  // Nearest round step on a log scale, so the count stays close to the target.
  return (fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10) * power;
}

/** Tick values inside [lo, hi] on a round step. */
export function niceTicks(lo: number, hi: number, target = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) return [lo];
  const step = niceStep(hi - lo, target);
  const ticks: number[] = [];
  for (let i = Math.ceil(lo / step - 1e-9); i * step <= hi + step * 1e-9; i++) ticks.push(Number((i * step).toPrecision(12)));
  return ticks;
}

/** A value axis widened to round bounds, with its ticks. A flat series gets a band. */
export function valueExtent(lo: number, hi: number, target = 4): { lo: number; hi: number; ticks: number[] } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1, ticks: [0, 0.5, 1] };
  if (hi === lo) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.1 : 1;
    lo -= pad; hi += pad;
  }
  const step = niceStep(hi - lo, target);
  const low = Math.floor(lo / step + 1e-9) * step, high = Math.ceil(hi / step - 1e-9) * step;
  return { lo: Number(low.toPrecision(12)), hi: Number(high.toPrecision(12)), ticks: niceTicks(low, high, target) };
}

/**
 * The time axis of an instrument plot: plan time in seconds from ignition, or in
 * minutes once the span passes half an hour. Ticks are in seconds either way.
 */
export interface TimeAxis { unit: 's' | 'min'; scale: number; ticks: number[]; label: string }
export function timeAxis(t0: number, t1: number, target = 4): TimeAxis {
  const minutes = Math.abs(t1 - t0) > 1800;
  const scale = minutes ? 60 : 1;
  const unit = minutes ? 'min' : 's';
  return { unit, scale, ticks: niceTicks(t0 / scale, t1 / scale, target).map(v => v * scale),
    label: `Time from ignition (${unit})` };
}
export const formatTime = (t: number, axis: Pick<TimeAxis, 'unit' | 'scale'>): string => `${fmt(t / axis.scale)} ${axis.unit}`;

/** Index of the last sorted value at or before `time`, or -1 before the first. */
export function lastIndexAtOrBefore(sorted: ArrayLike<number>, time: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= time) lo = mid + 1; else hi = mid;
  }
  return lo - 1;
}

/** The sample a series holds at `time`: its last one at or before it, and none
 *  outside the series' own span. No interpolation (docs/test-data-design.md). */
export function valueAt(t: ArrayLike<number>, values: ArrayLike<number>, time: number): number | null {
  if (!t.length || time < t[0] || time > t[t.length - 1]) return null;
  const i = lastIndexAtOrBefore(t, time);
  return i < 0 ? null : values[i];
}

/** Sorted, unique union of several sample-time arrays: the stops of a plot's slider. */
export function unionTimes(arrays: ArrayLike<number>[]): Float64Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const all = new Float64Array(total);
  let n = 0;
  for (const a of arrays) for (let i = 0; i < a.length; i++) all[n++] = a[i];
  all.sort();
  let unique = 0;
  for (let i = 0; i < all.length; i++) if (i === 0 || all[i] !== all[unique - 1]) all[unique++] = all[i];
  return all.slice(0, unique);
}

/**
 * Index ranges `[start, end)` of a series' continuous runs. A run breaks where the
 * time step exceeds three times the series' median step, so a stretch of missing
 * samples shows as a gap rather than a straight line across it.
 */
export function runs(t: ArrayLike<number>): [number, number][] {
  const n = t.length;
  if (n < 3) return n ? [[0, n]] : [];
  const steps = new Float64Array(n - 1);
  for (let i = 1; i < n; i++) steps[i - 1] = t[i] - t[i - 1];
  const median = Float64Array.from(steps).sort()[Math.floor((n - 1) / 2)];
  const result: [number, number][] = [];
  let start = 0;
  for (let i = 1; i < n; i++) {
    if (median > 0 && steps[i - 1] > 3 * median) { result.push([start, i]); start = i; }
  }
  result.push([start, n]);
  return result;
}

/** Ranks of bead heights, lowest 0; equal heights share a rank. */
export function heightRanks(heights: readonly number[]): { ranks: number[]; count: number } {
  const distinct = [...new Set(heights)].sort((a, b) => a - b);
  return { ranks: heights.map(h => distinct.indexOf(h)), count: distinct.length };
}

/**
 * A rake bead's line colour: an ordinal one-hue ramp between the `--plot-ramp-low`
 * and `--plot-ramp-high` tokens, by height rank. Lowest bead darkest, highest
 * lightest; mixed in OKLab so the lightness steps stay even.
 */
export function beadColor(rank: number, count: number): string {
  if (count <= 1) return 'var(--plot-ramp-low)';
  const share = Math.round((Math.min(Math.max(rank, 0), count - 1) / (count - 1)) * 100);
  if (share === 0) return 'var(--plot-ramp-low)';
  if (share === 100) return 'var(--plot-ramp-high)';
  return `color-mix(in oklab, var(--plot-ramp-high) ${share}%, var(--plot-ramp-low))`;
}

/** The colour of a single instrument's series: measured primary, simulated secondary. */
export const roleColor = (role: 'measured' | 'simulated'): string =>
  role === 'measured' ? 'var(--plot-primary)' : 'var(--plot-secondary)';

/**
 * Dash patterns. Solid is measured and dashed is simulated, whatever the colour;
 * a second source of the same role takes the next pattern of its family. Planned
 * values are long dashes and a gauge's full-scale range a dotted line.
 */
const MEASURED_DASH = ['', '1.5 2.5', '7 2 1.5 2'];
const SIMULATED_DASH = ['5 3', '9 3 2 3', '3 1.5'];
export const PLANNED_DASH = '10 4';
export const RANGE_DASH = '1.5 3';
export function seriesDash(role: 'measured' | 'simulated', nth: number): string {
  const family = role === 'measured' ? MEASURED_DASH : SIMULATED_DASH;
  return family[Math.min(Math.max(nth, 0), family.length - 1)];
}
