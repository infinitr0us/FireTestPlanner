import { heatFluxEstimate, hrrKwOf, thermocoupleBeads } from './plan';
import type { TargetUnit } from './test-data';
import { isHeatFluxSensor, isBurner, isThermocouple, type PlanDocument } from './types';

export interface PlannedValue { value: number | null; unit: TargetUnit; note: string }
/** Null is an unsupported/missing target; a null value carries the reason no line applies. */
export function plannedValue(doc: PlanDocument, objectId: string, bead?: number): PlannedValue | null {
  const o = doc.objects.find(o => o.id === objectId);
  if (o && isHeatFluxSensor(o) && bead === undefined) {
    const value = heatFluxEstimate(doc, o)?.incidentKwM2;
    return { value: value !== undefined && Number.isFinite(value) ? value : null, unit: 'kW/m2',
      note: value !== undefined && Number.isFinite(value) ? 'Predicted incident flux, including line of sight.' : 'No incident flux estimate applies.' };
  }
  if (o && isBurner(o) && bead === undefined) {
    const value = hrrKwOf(o);
    return { value, unit: 'kW', note: value === null ? 'No planned heat release rate is set.' : 'Planned heat release rate.' };
  }
  if (o && isThermocouple(o) && bead !== undefined) {
    const b = thermocoupleBeads(doc, o)[bead];
    if (!b) return null;
    return { value: b.gasTemperatureC, unit: '°C', note: b.gasTemperatureC !== null
      ? 'Plume centreline temperature, an upper bound for an off-axis bead.'
      : b.region === 'flame' || b.flameZone ? 'No gas temperature correlation applies in the flame zone.'
        : 'No gas temperature correlation applies outside a predicted plume.' };
  }
  return null;
}
