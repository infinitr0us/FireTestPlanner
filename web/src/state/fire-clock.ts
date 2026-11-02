/**
 * The fire clock: playback over the plan's heat release rate curves.
 *
 * A plan with a burner curve and no loaded flame sequence gets the playback bar
 * (one bar, the shared transport) with these marks. When a flame sequence is
 * loaded its frames are the clock instead, and the cone follows that clock too.
 * Either way the predicted cone takes Heskestad's height at each burner's Q(t)
 * once the clock has been played or moved, and shows the peak while the clock is
 * at rest (paused at its first mark, where a plan opens), so the 3D view starts
 * from the worst case the checks and the drawing use.
 */
import { hrrAt } from '../core/hrr';
import { burnerFlameHeightM, burners } from '../core/plan';
import type { LengthUnit, PlanDocument } from '../core/types';
import { formatLengthWithUnit } from '../core/units';

/** Marks the fire clock aims for over its span: stepping is about 1 % of the test. */
export const FIRE_CLOCK_STEPS = 120;

/**
 * From the earliest curve start to the latest curve end, or null when no burner
 * has a curve. With every curve starting at ignition, this is the longest curve.
 */
export function fireClockSpan(doc: PlanDocument): { start: number; end: number } | null {
  let start = Infinity, end = -Infinity;
  for (const b of burners(doc)) {
    const points = b.fire?.hrrCurve?.points;
    if (!points?.length) continue;
    start = Math.min(start, points[0][0]);
    end = Math.max(end, points[points.length - 1][0]);
  }
  return end > start ? { start, end } : null;
}

/** 1, 2 or 5 times a power of ten, near `span / target`. */
function roundStep(span: number, target: number): number {
  const raw = span / target, power = 10 ** Math.floor(Math.log10(raw)), fraction = raw / power;
  return (fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10) * power;
}

/**
 * The instants the fire clock steps and snaps to: a round step over the span,
 * plus both ends. Empty when no burner has a curve.
 */
export function fireClockMarks(doc: PlanDocument): number[] {
  const span = fireClockSpan(doc);
  if (!span) return [];
  const step = roundStep(span.end - span.start, FIRE_CLOCK_STEPS);
  const marks = [span.start];
  for (let i = Math.floor(span.start / step + 1e-9) + 1; i * step < span.end - step * 1e-6; i++) {
    marks.push(Number((i * step).toPrecision(12)));
  }
  marks.push(span.end);
  return marks;
}

/** The time the predicted cone is drawn at: undefined (the peak) at rest or without a clock. */
export function coneTime(clock: { hasRange: boolean; atRest: boolean; time_s: number }): number | undefined {
  return clock.hasRange && !clock.atRest ? clock.time_s : undefined;
}

export const formatKw = (q: number): string => `${Number(q.toFixed(1))} kW`;
export const formatClockTime = (t: number): string => `${t.toFixed(1)} s`;

/** Whether any burner's heat release rate changes with time. */
export const hasHrrCurve = (doc: PlanDocument): boolean => burners(doc).some((b) => b.fire?.hrrCurve);

/**
 * What the cone shows: the total heat release rate of the plan's fires and the
 * mean flame height (the tallest, with several burners), at `t` or at the peak.
 */
export function fireAt(doc: PlanDocument, t?: number): { q: number; burners: number; flame: number | null } {
  let q = 0, count = 0, flame: number | null = null;
  for (const b of burners(doc)) {
    const value = hrrAt(b, t);
    if (value === null) continue;
    q += value; count += 1;
    const height = burnerFlameHeightM(b, t);
    if (height !== null && height > 0) flame = Math.max(flame ?? 0, height);
  }
  return { q, burners: count, flame };
}

type Fire = ReturnType<typeof fireAt>;
const qText = (fire: Fire): string => `Q = ${formatKw(fire.q)}${fire.burners > 1 ? ` over ${fire.burners} burners` : ''}`;
const flameText = (fire: Fire, unit: LengthUnit): string => fire.flame === null ? ''
  : ` · ${fire.burners > 1 ? 'flames up to' : 'flame'} ${formatLengthWithUnit(fire.flame, unit)}`;

/**
 * The cone's part of a playback readout: `Q = 168.8 kW · flame 1.23 m` while the
 * clock is followed, `cone at peak, Q = 1000 kW · flame 2.95 m` at rest.
 */
export function conePart(doc: PlanDocument, t: number | undefined, unit: LengthUnit): string {
  const fire = fireAt(doc, t);
  return `${t === undefined ? 'cone at peak, ' : ''}${qText(fire)}${flameText(fire, unit)}`;
}

/**
 * The fire clock's readout: `Q = 168.8 kW at t = 60.0 s · flame 1.23 m` while it
 * runs, and `Cone at peak, Q = 1000 kW · flame 2.95 m · t = 0.0 s` at rest.
 */
export function fireReadout(doc: PlanDocument, clockTime: number, cone: number | undefined, unit: LengthUnit): string {
  const fire = fireAt(doc, cone);
  return cone === undefined
    ? `Cone at peak, ${qText(fire)}${flameText(fire, unit)} · t = ${formatClockTime(clockTime)}`
    : `${qText(fire)} at t = ${formatClockTime(clockTime)}${flameText(fire, unit)}`;
}
