import { beadOffsetsOf, displayName, gaugeRangeKwM2, positionOf, quatOf, toWorld } from './plan';
import { forwardOf } from './math';
import { facingText } from './facing';
import { formatLength } from './units';
import { isAimable, isCamera, isHeatFluxSensor, isThermocouple, type LengthUnit, type PlanDocument } from './types';

const csv = (s: string): string => /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

/** Crew set-out coordinates, one physical bead per row, with source-order channels. */
export function instrumentScheduleCsv(doc: PlanDocument, unit: LengthUnit): string {
  const sources = doc.testData ?? [];
  const rows: string[][] = [['Name', 'Type', 'ID', `X (${unit})`, `Y (${unit})`, `Height (${unit})`,
    `Aim point (${unit}; X, Y, Z)`, 'Facing', 'Gauge range (kW/m²)', ...sources.map(s => s.name)]];
  const fmt = (v: number): string => formatLength(v, unit, { fixed: true });
  for (const o of doc.objects) {
    if (!isHeatFluxSensor(o) && !isThermocouple(o) && !isCamera(o)) continue;
    const beads = isThermocouple(o) ? beadOffsetsOf(o) : [null];
    beads.forEach((offset, bead) => {
      const p = offset === null ? positionOf(o) : toWorld(o, [0, 0, offset]);
      const name = displayName(o) + (beads.length > 1 ? `_${bead + 1}` : '');
      const aim = isAimable(o) ? o.transform?.aimTarget_m : undefined;
      const range = isHeatFluxSensor(o) ? gaugeRangeKwM2(o) : null;
      rows.push([name, isHeatFluxSensor(o) ? 'Heat flux gauge' : isCamera(o) ? 'Camera' : 'Thermocouple bead',
        isThermocouple(o) ? `${o.id}[${bead}]` : o.id, ...p.map(fmt), aim ? aim.map(fmt).join(', ') : '',
        isAimable(o) ? facingText(forwardOf(quatOf(o))) : '', range === null ? '' : String(range),
        ...sources.map(s => s.channels.filter(c => c.object === o.id
          && (isThermocouple(o) ? c.bead === bead : c.bead === undefined)).map(c => c.channel).join('; '))]);
    });
  }
  return '\uFEFF' + rows.map(row => row.map(csv).join(',')).join('\r\n') + '\r\n';
}
