/** Heat release curves, in seconds and kW. Mirror of fireplan/hrr.py. */
import type { BurnerObject, HrrCurve } from './types';
import { decimateMinMax } from './test-data';

export const GROWTH_RATES = { slow: 0.00293, medium: 0.01172, fast: 0.0469, 'ultra-fast': 0.1876 } as const;

export function curveProblem(curve: unknown): string | null {
  if (curve == null) return null;
  if (typeof curve !== 'object' || Array.isArray(curve)) return 'HRR curve must be an object or null.';
  const c = curve as Record<string, unknown>;
  if (Object.keys(c).some(k => k !== 'points' && k !== 'source')
      || (c.source !== undefined && typeof c.source !== 'string')) return 'HRR curve accepts points and an optional text source.';
  if (!Array.isArray(c.points) || c.points.length < 2 || c.points.length > 10000) return 'HRR curve needs 2 to 10000 points.';
  let previous = -1;
  for (const p of c.points) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)
        || p[0] <= previous) return 'HRR curve needs finite non-negative [seconds, kW] pairs with strictly increasing times.';
    previous = p[0];
  }
  return null;
}

export function curvePeak(curve: HrrCurve): number { return Math.max(...curve.points.map(p => p[1])); }

export function curveAt(curve: HrrCurve, t: number): number {
  if (!Number.isFinite(t)) throw new Error('HRR time must be finite.');
  const p = curve.points;
  if (t <= p[0][0]) return p[0][1];
  if (t >= p[p.length - 1][0]) return p[p.length - 1][1];
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (p[m][0] <= t) lo = m; else hi = m; }
  const fraction = (t - p[lo][0]) / (p[hi][0] - p[lo][0]);
  return p[lo][1] + fraction * (p[hi][1] - p[lo][1]);
}

export function hrrAt(b: BurnerObject, t?: number): number | null {
  if (t !== undefined && !Number.isFinite(t)) throw new Error('HRR time must be finite.');
  const c = b.fire?.hrrCurve;
  return c ? t === undefined ? curvePeak(c) : curveAt(c, t) : b.fire?.hrr_kw ?? null;
}

/** Shared readout for the inspector, drawing and import preview. */
export function curveSummary(curve: HrrCurve): string {
  const peak = curvePeak(curve), time = curve.points.find(p => p[1] === peak)![0];
  const number = (v: number) => String(Number(v.toFixed(6)));
  return `Curve: ${curve.points.length} points, peak ${number(peak)} kW at ${number(time)} s`
    + (curve.source !== undefined ? `, source ${curve.source}` : '');
}

export function t2Curve({ alpha_kW_s2, peak_kW, hold_s, decay_s, step_s = 10 }: {
  alpha_kW_s2: number; peak_kW: number; hold_s: number; decay_s: number; step_s?: number;
}): HrrCurve {
  if (![alpha_kW_s2, peak_kW, hold_s, decay_s, step_s].every(Number.isFinite)
      || alpha_kW_s2 <= 0 || peak_kW <= 0 || hold_s < 0 || decay_s <= 0 || step_s <= 0) {
    throw new Error('t² curve needs positive alpha, peak, decay and step, and a non-negative hold.');
  }
  const growth = Math.sqrt(peak_kW / alpha_kW_s2), endHold = growth + hold_s, end = endHold + decay_s;
  if (!Number.isFinite(end) || end <= endHold || Math.ceil(end / step_s) + 3 > 10000) throw new Error('t² curve exceeds the point or time limits.');
  const times = new Set([0, growth, endHold, end]);
  for (let i = 1; i * step_s < end; i++) times.add(i * step_s);
  const curve: HrrCurve = { points: [...times].sort((a, b) => a - b).map(t => [t,
    t < growth ? peak_kW * (t / growth) ** 2 : t <= endHold ? peak_kW : peak_kW * ((end - t) / decay_s)]), source: 't2' };
  const problem = curveProblem(curve); if (problem) throw new Error(problem);
  return curve;
}

export function curveFromSeries(t: ArrayLike<number>, values: ArrayLike<number>, maxPoints = 200): { curve: HrrCurve; notes: string[] } {
  if (t.length < 2 || Array.from(t).some(x => x < 0) || maxPoints > 10000) throw new Error('HRR series needs at least two non-negative times and at most 10000 output points.');
  let clamped = 0;
  const clean = Array.from(values, v => { if (v < 0) clamped++; return Math.max(0, v); });
  // Validate original samples too: -Infinity must not turn into a valid zero.
  if (!Array.from(values).every(Number.isFinite)) throw new Error('HRR series needs finite values.');
  const thin = decimateMinMax(t, clean, maxPoints);
  return { curve: { points: Array.from(thin.t, (t, i) => [t, thin.values[i]]), source: 'measured' },
    notes: clamped ? [`Clamped ${clamped} negative HRR samples to 0 kW.`] : [] };
}
