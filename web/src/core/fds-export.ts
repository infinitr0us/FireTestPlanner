/** Deterministic instrument-only FDS writer. Mirror of fireplan/fds_export.py. */
import { normalize, roundMicro } from './math';
import { mountingIor, nearestMountingIor } from './occlusion';
import { beadPositions, gaugeNormal, positionOf } from './plan';
import { isHeatFluxSensor, isThermocouple, type PlanDocument, type Vec3 } from './types';

const metres = (v: number): string => String(roundMicro(v));
const oneLine = (s: string): string => s.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ');
const safeId = (s: string): string => oneLine(s).replace(/'/g, '_');
const orientation = (v: number): string => (Number(v.toFixed(4)) + 0).toFixed(4);

/** Recover consecutive source device IDs from the importer's range name. */
function importedBeadIds(name: string, count: number): string[] | undefined {
  const match = /^(.*?)([0-9]+)-\1([0-9]+)$/.exec(name);
  if (!match) return undefined;
  const first = BigInt(match[2]), last = BigInt(match[3]);
  if (first >= last || last - first + 1n !== BigInt(count)) return undefined;
  return Array.from({ length: count }, (_, i) => safeId(`${match[1]}${first + BigInt(i)}`));
}

export function devicesToFds(doc: PlanDocument): string {
  const offset = doc.meta?.source?.originOffset_m ?? [0, 0, 0];
  const imported = doc.meta?.source?.tool === 'FDS';
  const lines = [
    `! Plan: ${oneLine(doc.meta?.title ?? 'Untitled')}`,
    `! Test ID: ${oneLine(doc.meta?.testId ?? '(none)')}`,
    '! Instruments only: no geometry, mesh, surfaces or reactions',
    imported ? "! coordinates in the source FDS file's frame"
      : '! plan frame: origin at the burner centre at floor level',
    '! Written by FireTestPlanner',
  ];
  const props = new Map<number, string>();
  const devices: string[] = [];
  const taken = new Set<string>();
  const bases = new Set<string>();
  const unique = (base: string, count: number, importedIds?: string[]): string[] => {
    let suffix = 1;
    for (;;) {
      const name = suffix === 1 ? base : `${base}_${suffix}`;
      const ids = suffix === 1 && importedIds ? importedIds
        : count === 1 ? [name] : Array.from({ length: count }, (_, i) => `${name}_${i + 1}`);
      if (!bases.has(name) && ids.every(id => !taken.has(id))) {
        bases.add(name);
        ids.forEach(id => taken.add(id));
        return ids;
      }
      suffix += 1;
    }
  };
  const xyz = (p: Vec3): string => p.map((v, i) => metres(v + offset[i])).join(',');
  for (const obj of doc.objects) {
    if (!isHeatFluxSensor(obj) && !isThermocouple(obj)) continue;
    const base = safeId(obj.name || obj.id);
    if (isHeatFluxSensor(obj)) {
      const [id] = unique(base, 1);
      const normal = normalize(gaugeNormal(obj));
      const ior = mountingIor(doc, positionOf(obj), normal);
      const quantity = ior === null ? 'RADIATIVE HEAT FLUX GAS' : 'GAUGE HEAT FLUX';
      const direction = normal.map(orientation).join(',');
      // IOR chooses the mounting face. Keep a tilted gauge's recorded normal too:
      // the importer's ORIENTATION precedence preserves the sub-axis facing.
      const tilted = ior !== null && normal.some((v, i) =>
        orientation(v) !== orientation(i === Math.abs(ior) - 1 ? Math.sign(ior) : 0));
      const facing = ior === null ? `ORIENTATION=${direction}`
        : `IOR=${ior}${tilted ? `, ORIENTATION=${direction}` : ''}`;
      devices.push(`&DEVC ID='${id}', XYZ=${xyz(positionOf(obj))}, QUANTITY='${quantity}', ${facing} /`);
    } else {
      const beads = beadPositions(obj);
      const ids = unique(base, beads.length, importedBeadIds(obj.name ?? '', beads.length));
      const diameter = obj.thermocouple?.beadDiameter_mm;
      const surface = obj.mount?.type === 'wall' || obj.mount?.type === 'ceiling';
      beads.forEach((bead, i) => {
        const ior = surface ? nearestMountingIor(doc, bead) : null;
        if (ior !== null) {
          devices.push(`&DEVC ID='${ids[i]}', XYZ=${xyz(bead)}, QUANTITY='WALL TEMPERATURE', IOR=${ior} /`);
          return;
        }
        if (surface) devices.push(`! ${ids[i]}: surface thermocouple with no surface in the plan at that point.`);
        let prop = '';
        if (diameter != null) {
          // Surface temperatures do not use a bead property; create one only for gas devices.
          if (!props.has(diameter)) props.set(diameter, `TC ${String(diameter)} mm`);
          prop = `, PROP_ID='${props.get(diameter)}'`;
        }
        devices.push(`&DEVC ID='${ids[i]}', XYZ=${xyz(bead)}, QUANTITY='THERMOCOUPLE'${prop} /`);
      });
    }
  }
  lines.push('');
  for (const [diameter, id] of props) lines.push(`&PROP ID='${id}', DIAMETER=${metres(diameter / 1000)} /`);
  if (props.size) lines.push('');
  if (devices.length) for (const device of devices) lines.push(device);
  else lines.push('! No instruments: nothing to export.');
  return lines.join('\n') + '\n';
}
