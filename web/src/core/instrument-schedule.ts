import { beadOffsetsOf, displayName, gaugeRangeKwM2, positionOf, quatOf, toWorld } from './plan';
import { forwardOf } from './math';
import { facingText } from './facing';
import { formatLength } from './units';
import { isNewInstrument, isVelocityProbe, isGasSampling, isLoadCell, isAimable, isCamera, isHeatFluxSensor, isThermocouple, type LengthUnit, type PlanDocument } from './types';

const csv = (s: string): string => /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

/** Crew set-out coordinates, one physical bead per row, with source-order channels. */
export function instrumentScheduleCsv(doc: PlanDocument, unit: LengthUnit): string {
  const sources = doc.testData ?? [];
  const rows: string[][] = [['Name', 'Type', 'ID', `X (${unit})`, `Y (${unit})`, `Height (${unit})`,
    `Aim point (${unit}; X, Y, Z)`, 'Facing', 'Gauge range (kW/m²)', 'Probe range (m/s)', 'Gas species', 'In duct', 'Capacity (kg)', `Platform (${unit}; W, D)`,
    `Measured X (${unit})`, `Measured Y (${unit})`, `Measured Z (${unit})`, ...sources.map(s => s.name)]];
  const fmt = (v: number): string => formatLength(v, unit, { fixed: true });
  for (const o of doc.objects) {
    if (!isHeatFluxSensor(o) && !isThermocouple(o) && !isCamera(o) && !isNewInstrument(o)) continue;
    const beads = isThermocouple(o) ? beadOffsetsOf(o) : [null];
    beads.forEach((offset, bead) => {
      const p = offset === null ? positionOf(o) : toWorld(o, [0, 0, offset]);
      const surveyed = o.asBuilt ? { ...o, transform: o.asBuilt.transform } : null;
      const measured = surveyed ? (offset === null ? positionOf(surveyed) : toWorld(surveyed, [0, 0, offset])) : null;
      const name = displayName(o) + (beads.length > 1 ? `_${bead + 1}` : '');
      const aim = isAimable(o) ? o.transform?.aimTarget_m : undefined;
      const range = isHeatFluxSensor(o) ? gaugeRangeKwM2(o) : null;
      rows.push([name, isHeatFluxSensor(o) ? 'Heat flux gauge' : isCamera(o) ? 'Camera' : isVelocityProbe(o) ? 'Velocity probe' : isGasSampling(o) ? 'Gas sample' : isLoadCell(o) ? 'Load cell' : 'Thermocouple bead',
        isThermocouple(o) ? `${o.id}[${bead}]` : o.id, ...p.map(fmt), aim ? aim.map(fmt).join(', ') : '',
        isVelocityProbe(o) && !o.transform?.rotation_quat ? 'axis unstated' : isAimable(o) ? facingText(forwardOf(quatOf(o))) : '', range === null ? '' : String(range),
        isVelocityProbe(o) && o.range_m_s != null ? String(o.range_m_s) : '',
        isGasSampling(o) ? o.species.join('; ') : '', isGasSampling(o) ? String(o.inDuct) : '',
        isLoadCell(o) && o.capacity_kg != null ? String(o.capacity_kg) : '',
        isLoadCell(o) && o.platform_m ? o.platform_m.map(fmt).join(', ') : '',
        ...(measured ? measured.map(fmt) : ['', '', '']),
        ...sources.map(s => s.channels.filter(c => c.object === o.id
          && (isThermocouple(o) ? c.bead === bead : c.bead === undefined)).map(c => c.channel).join('; '))]);
    });
  }
  return '\uFEFF' + rows.map(row => row.map(csv).join(',')).join('\r\n') + '\r\n';
}
