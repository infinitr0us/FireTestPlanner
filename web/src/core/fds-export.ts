/** Deterministic instrument-only FDS writer. Mirror of fireplan/fds_export.py. */
import { FDS_SPECIES } from './fds';
import { forwardOf, normalize, roundMicro } from './math';
import { mountingIor, nearestMountingIor } from './occlusion';
import { beadPositions, gaugeNormal, positionOf, quatOf } from './plan';
import { isHeatFluxSensor, isThermocouple, isVelocityProbe, isGasSampling, isLoadCell, type PlanDocument, type Vec3 } from './types';

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

/** The `&DEVC` IDs the export gives each gauge and each bead, keyed by object id (one
 *  per bead, in bead order). The test data session suggests mappings from these, so a
 *  run's `_devc.csv` maps to the instruments by exactly the names this file wrote. */
export function exportedDeviceIds(doc: PlanDocument): Map<string, string[]> {
  const taken = new Set<string>();
  const bases = new Set<string>();
  const unique = (base: string, count: number, importedIds?: string[], species?: string[]): string[] => {
    let suffix = 1;
    for (;;) {
      const name = suffix === 1 ? base : `${base}_${suffix}`;
      const ids = species ? species.map(s => `${name}_${s}`) : suffix === 1 && importedIds ? importedIds
        : count === 1 ? [name] : Array.from({ length: count }, (_, i) => `${name}_${i + 1}`);
      if (!bases.has(name) && ids.every(id => !taken.has(id))) {
        bases.add(name);
        ids.forEach(id => taken.add(id));
        return ids;
      }
      suffix += 1;
    }
  };
  const out = new Map<string, string[]>();
  for (const obj of doc.objects) {
    if (!isHeatFluxSensor(obj) && !isThermocouple(obj) && !isVelocityProbe(obj) && !isGasSampling(obj) && !isLoadCell(obj)) continue;
    const base = safeId(obj.name || obj.id);
    if (isLoadCell(obj)) continue;
    if (isGasSampling(obj)) out.set(obj.id, unique(base, obj.species.length, undefined, obj.species));
    else if (isHeatFluxSensor(obj) || isVelocityProbe(obj)) out.set(obj.id, unique(base, 1));
    else {
      const count = beadPositions(obj).length;
      out.set(obj.id, unique(base, count, importedBeadIds(obj.name ?? '', count)));
    }
  }
  return out;
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
  const idsOf = exportedDeviceIds(doc);
  const xyz = (p: Vec3): string => p.map((v, i) => metres(v + offset[i])).join(',');
  for (const obj of doc.objects) {
    if (!isHeatFluxSensor(obj) && !isThermocouple(obj) && !isVelocityProbe(obj) && !isGasSampling(obj) && !isLoadCell(obj)) continue;
    if (isLoadCell(obj)) {
      devices.push(`! ${oneLine(obj.name || obj.id)}: load cell omitted; no FDS device equivalent.`);
    } else if (isGasSampling(obj)) {
      devices.push(`! ${oneLine(obj.name || obj.id)}: FDS needs each sampled species defined.`);
      obj.species.forEach((s, i) => devices.push(`&DEVC ID='${idsOf.get(obj.id)![i]}', XYZ=${xyz(positionOf(obj))}, QUANTITY='VOLUME FRACTION', SPEC_ID='${FDS_SPECIES[s]}' /`));
    } else if (isVelocityProbe(obj)) {
      const [id] = idsOf.get(obj.id)!;
      const normal = obj.transform?.rotation_quat ? forwardOf(quatOf(obj)) : null;
      const axis = normal ? normal.reduce((best, v, i) => Math.abs(v) > Math.abs(normal[best]) ? i : best, 0) : -1;
      const aligned = normal !== null && Math.abs(normal[axis]) >= Math.cos(5 * Math.PI / 180) - 1e-10;
      const quantity = aligned ? `${['U', 'V', 'W'][axis]}-VELOCITY` : 'VELOCITY';
      if (!aligned) devices.push(`! ${id}: ${normal ? 'axis is more than 5 degrees from an FDS axis' : 'no axis recorded'}; exporting velocity magnitude.`);
      else if (normal![axis] < 0) devices.push(`! ${id}: probe points along negative ${['X', 'Y', 'Z'][axis]}; FDS reports the positive-axis component.`);
      devices.push(`&DEVC ID='${id}', XYZ=${xyz(positionOf(obj))}, QUANTITY='${quantity}' /`);
    } else if (isHeatFluxSensor(obj)) {
      const [id] = idsOf.get(obj.id)!;
      const normal = normalize(gaugeNormal(obj));
      const ior = exportGaugeIor(doc, positionOf(obj), normal);
      const quantity = ior === null ? 'RADIATIVE HEAT FLUX GAS' : 'GAUGE HEAT FLUX';
      const direction = normal.map(orientation).join(',');
      // IOR chooses the mounting face. Keep a tilted gauge's recorded normal too:
      // the importer's ORIENTATION precedence preserves the sub-axis facing.
      const tilted = ior !== null && normal.some((v, i) =>
        orientation(v) !== orientation(i === Math.abs(ior) - 1 ? Math.sign(ior) : 0));
      const facing = ior === null ? `ORIENTATION=${direction}`
        : `IOR=${ior}${tilted ? `, ORIENTATION=${direction}` : ''}`;
      if (ior !== null && Math.abs(normal[Math.abs(ior) - 1]) < Math.cos(5 * Math.PI / 180) - 1e-10) {
        devices.push(`! ${id}: tilt exceeds 5 degrees; FDS reports the flux normal to the face, a factor cos(tilt) on the direct component.`);
      }
      devices.push(`&DEVC ID='${id}', XYZ=${xyz(positionOf(obj))}, QUANTITY='${quantity}', ${facing} /`);
    } else {
      const beads = beadPositions(obj);
      const ids = idsOf.get(obj.id)!;
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

/** Export probes along candidate face normals, so the 50 mm distance is normal
 * to the face, independent of the gauge tilt. Occlusion keeps its 5 degree rule. */
function exportGaugeIor(doc: PlanDocument, position: Vec3, normal: Vec3): number | null {
  const axes = [0, 1, 2].sort((a, b) => Math.abs(normal[b]) - Math.abs(normal[a]));
  for (const axis of axes) {
    if (Math.abs(normal[axis]) < Math.cos(Math.PI / 4) - 1e-10) continue;
    const face: Vec3 = [0, 0, 0];
    face[axis] = Math.sign(normal[axis]);
    const ior = mountingIor(doc, position, face);
    if (ior !== null) return ior;
  }
  return null;
}
