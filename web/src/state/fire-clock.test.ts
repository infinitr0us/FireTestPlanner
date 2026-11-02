import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GROWTH_RATES, t2Curve } from '../core/hrr';
import { burnerFlameHeightM } from '../core/plan';
import { isBurner, type BurnerObject, type PlanDocument } from '../core/types';
import { formatLengthWithUnit } from '../core/units';
import { parseAndValidatePlan } from '../core/validate';
import { conePart, coneTime, fireAt, fireClockMarks, fireClockSpan, fireReadout, hasHrrCurve } from './fire-clock';
import { Playhead } from './playhead';

const fixture = (path: string): PlanDocument =>
  parseAndValidatePlan(readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url), 'utf8'));

/** The Example with a t² fast curve on its burner, as the inspector makes it. */
function example(): { doc: PlanDocument; burner: BurnerObject } {
  const doc = fixture('flame/flame-test.ftp.json');
  const burner = doc.objects.find(isBurner)!;
  const curve = t2Curve({ alpha_kW_s2: GROWTH_RATES.fast, peak_kW: 80, hold_s: 300, decay_s: 300 });
  burner.fire = { ...burner.fire, hrr_kw: 80, hrrCurve: { ...curve, source: 't2-fast' } };
  return { doc, burner };
}

describe('the fire clock', () => {
  it('spans the curves, the longest when several burners have one', () => {
    const { doc, burner } = example();
    const growth = Math.sqrt(80 / GROWTH_RATES.fast);
    expect(fireClockSpan(doc)).toEqual({ start: 0, end: growth + 600 });
    const second: BurnerObject = { ...structuredClone(burner), id: 'second',
      fire: { hrr_kw: 50, hrrCurve: { points: [[10, 0], [20, 50], [1000, 0]] } } };
    doc.objects.push(second);
    expect(fireClockSpan(doc)).toEqual({ start: 0, end: 1000 });
    for (const b of doc.objects.filter(isBurner)) b.fire!.hrrCurve = null;
    expect(fireClockSpan(doc)).toBeNull();
    expect(fireClockMarks(doc)).toEqual([]);
    expect(hasHrrCurve(doc)).toBe(false);
  });

  it('steps on a round interval and ends on the curve end', () => {
    const { doc } = example();
    const marks = fireClockMarks(doc);
    expect(marks.slice(0, 4)).toEqual([0, 5, 10, 15]);
    expect(marks.at(-2)).toBe(640);
    expect(marks.at(-1)).toBeCloseTo(641.3, 1);
    // The FDS import's five-point curve over 60 s steps by half a second.
    const room = fixture('fds/room_corner.ftp.json');
    expect(fireClockSpan(room)).toEqual({ start: 0, end: 60 });
    expect(fireClockMarks(room).length).toBe(121);
    expect(fireClockMarks(room)[1]).toBe(0.5);
  });

  it('draws the cone at the peak at rest and at Q(t) once played or moved', () => {
    const clock = new Playhead();
    expect(coneTime(clock)).toBeUndefined();
    clock.setMarks([0, 5, 10], 'fire');
    expect(clock.kind).toBe('fire');
    expect(clock.atRest).toBe(true);
    expect(coneTime(clock)).toBeUndefined();
    clock.step(1);
    expect(coneTime(clock)).toBe(5);
    clock.seek(0);
    expect(coneTime(clock)).toBeUndefined();
    clock.play();
    expect(coneTime(clock)).toBe(0);
    clock.pause();
    clock.setMarks([], 'fire');
    expect(clock.kind).toBeNull();
    expect(coneTime(clock)).toBeUndefined();
    // A flame's frames are the clock when they are loaded; the kind says so.
    clock.setMarks([0, 5], 'flame');
    expect(clock.kind).toBe('flame');
  });

  it('reads out Q and the flame height the cone shows', () => {
    const { doc, burner } = example();
    const height = (t?: number) => formatLengthWithUnit(burnerFlameHeightM(burner, t)!, 'm');
    expect(fireReadout(doc, 60, 60, 'm')).toBe(`Q = 80 kW at t = 60.0 s · flame ${height(60)}`);
    expect(fireReadout(doc, 20, 20, 'm')).toBe(`Q = 18.8 kW at t = 20.0 s · flame ${height(20)}`);
    expect(burnerFlameHeightM(burner, 20)).toBeLessThan(burnerFlameHeightM(burner, 60)! / 2);
    expect(fireReadout(doc, 0, undefined, 'm')).toBe(`Cone at peak, Q = 80 kW · flame ${height()} · t = 0.0 s`);
    // No flame at zero heat release: the readout says so by leaving the height out.
    expect(fireReadout(doc, 0, 0, 'm')).toBe('Q = 0 kW at t = 0.0 s');
    expect(conePart(doc, 20, 'mm')).toBe(`Q = 18.8 kW · flame ${formatLengthWithUnit(burnerFlameHeightM(burner, 20)!, 'mm')}`);
    expect(conePart(doc, undefined, 'm')).toMatch(/^cone at peak, Q = 80 kW · flame /);
    // Several burners: the total, and the tallest flame.
    doc.objects.push({ ...structuredClone(burner), id: 'second', fire: { hrr_kw: 50, hrrCurve: null } });
    expect(fireAt(doc, 20)).toMatchObject({ q: 0.0469 * 400 + 50, burners: 2 });
    expect(fireReadout(doc, 20, 20, 'm')).toMatch(/^Q = 68\.8 kW over 2 burners at t = 20\.0 s · flames up to /);
  });
});
