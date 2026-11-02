import { heatFluxEstimate, hrrAt, thermocoupleBeads } from './plan';
import { decimateMinMax } from './test-data';
import type { TargetUnit } from './test-data';
import { isNewInstrument, isVelocityProbe, isLoadCell, isHeatFluxSensor, isBurner, isThermocouple, type PlanDocument } from './types';

export interface PlannedValue { value: number | null; unit: TargetUnit; note: string }
/** Null is an unsupported/missing target; a null value carries the reason no line applies. */
export function plannedValue(doc: PlanDocument, objectId: string, bead?: number, t?: number): PlannedValue | null {
  const o = doc.objects.find(o => o.id === objectId);
  if (o && isHeatFluxSensor(o) && bead === undefined) {
    const value = heatFluxEstimate(doc, o, t)?.incidentKwM2;
    return { value: value !== undefined && Number.isFinite(value) ? value : null, unit: 'kW/m2',
      note: value !== undefined && Number.isFinite(value) ? 'Predicted incident flux, including line of sight.' : 'No incident flux estimate applies.' };
  }
  if (o && isBurner(o) && bead === undefined) {
    const value = hrrAt(o, t);
    return { value, unit: 'kW', note: value === null ? 'No planned heat release rate is set.' : 'Planned heat release rate.' };
  }
  if (o && isThermocouple(o) && bead !== undefined) {
    const b = thermocoupleBeads(doc, o, t)[bead];
    if (!b) return null;
    return { value: b.gasTemperatureC, unit: '°C', note: b.gasTemperatureC !== null
      ? 'Plume centreline temperature, an upper bound for an off-axis bead.'
      : b.region === 'flame' || b.flameZone ? 'No gas temperature correlation applies in the flame zone.'
        : 'No gas temperature correlation applies outside a predicted plume.' };
  }
  if (o && isNewInstrument(o) && bead === undefined) return { value: null, unit: isVelocityProbe(o) ? 'm/s' : isLoadCell(o) ? 'kg' : null, note: 'No prediction model.' };
  return null;
}

/** Null samples keep gaps where a temperature correlation does not apply.
 * All knots are retained when they fit; denser inputs use min/max thinning. */
export function plannedSeries(doc: PlanDocument, objectId: string, bead?: number): { t: number[]; values: (number | null)[] } | null {
  if (!plannedValue(doc, objectId, bead) || doc.objects.some(o => o.id === objectId && isNewInstrument(o))) return null;
  const target = doc.objects.find(o => o.id === objectId)!;
  const fires = doc.objects.filter(isBurner).filter(b => !isBurner(target) || b.id === target.id);
  let knots = [...new Set(fires.flatMap(b => b.fire?.hrrCurve?.points.map(p => p[0]) ?? []))].sort((a, b) => a - b);
  if (knots.length < 2) return null;
  if (knots.length > 2000) {
    const q = knots.map(t => fires.reduce((sum, b) => sum + (hrrAt(b, t) ?? 0), 0));
    knots = Array.from(decimateMinMax(knots, q, 2000).t);
  }
  const steps = Math.max(1, Math.min(20, Math.floor(1999 / (knots.length - 1))));
  const t: number[] = [];
  for (let i = 0; i < knots.length - 1; i++) {
    for (let j = 0; j < steps; j++) t.push(knots[i] + (knots[i + 1] - knots[i]) * j / steps);
  }
  t.push(knots[knots.length - 1]);
  return { t, values: t.map(time => plannedValue(doc, objectId, bead, time)!.value) };
}
