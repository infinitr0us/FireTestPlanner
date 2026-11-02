import { domainLabel } from '../ui/domain-labels';
import * as i18n from '../ui/i18n';
import { isNewInstrument, isVelocityProbe, isGasSampling, isLoadCell } from '../core/types';
import { curveSummary, hrrAt } from '../core/hrr';
import { setOutCheck } from '../core/asbuilt';
/**
 * The printable deliverable: dimensioned plan, elevations, equipment list and
 * camera coverage, in a layout you can staple to a test protocol.
 *
 * Output is HTML + inline SVG rather than a generated PDF. Printing to PDF from
 * the browser produces real vector output with selectable text, for none of the
 * weight of a PDF library -- and the same markup doubles as a shareable file.
 */

import {
  beadOffsetsOf,
  burnerDiameterM,
  burners,
  cameraColor,
  cameras,
  ceilingAreaM2,
  ceilingSoffitZM,
  ceilings,
  checkPlan,
  displayName,
  findObject,
  flameBoundsCorners,
  flameBurner,
  flameManifest,
  flameSequenceLink,
  flameTipZM,
  framingOf,
  fuelSurfaceZM,
  gaugeRangeKwM2,
  gaugeVerdict,
  gaugeViewAngleDeg,
  groundSampleDistanceM,
  heatFluxEstimate,
  heatFluxSensors,
  hfovDegOf,
  hoodIntakeHeightM,
  hoods,
  intrinsicsSourceOf,
  objectColor,
  obstructions,
  positionOf,
  quatOf,
  reconstructedFlames,
  standoffHorizontalM,
  standoffM,
  tcMaxTemperatureC,
  tcTypeOf,
  thermocoupleBeads,
  thermocouples,
  thermocoupleVerdict,
  toWorld,
  vfovDegOf,
  walls,
  zoomOf,
} from '../core/plan';
import { facingText } from '../core/facing';
export { facingText } from '../core/facing';
import { printedLensOf } from '../core/lenses';
import { fileName } from '../core/linked-files';
import { formatLength, formatLengthWithUnit } from '../ui/display-units';
import { forwardOf } from '../core/math';
import {
  isAimable, isBurner, isCamera, isCeiling, isHeatFluxSensor, isHood,
  isObstruction, isThermocouple, isWall,
  type Issue, type LengthUnit, type PlanDocument,
} from '../core/types';
import { buildViewSvg, elevationHeading, escapeXml } from './drawing';

const esc = escapeXml;

const cell = (v: string, cls = ''): string => `<td${cls ? ` class="${cls}"` : ''}>${esc(v)}</td>`;
const head = (v: string): string => `<th>${esc(v)}</th>`;

// -- tables ---------------------------------------------------------------

/** A heat release rate as a person writes it: an FDS import computes 300 kW as
 *  300.00000000000006, and the table printed every digit. */
export const formatKw = (q: number): string => i18n.numberText(Number(q.toFixed(2)));

/** Horizontal distance from the origin -- the burner centre every standoff is
 *  measured from (CONVENTIONS.md section 1). */
const planDistance = (p: readonly number[]): number => Math.hypot(p[0], p[1]);

/** One row per physical object. Coordinates stay in the plan frame; only the
 * printed strings use display units. Multiple wall vertices and rake beads stay
 * within their object's row, numbered in recorded order. */
function setOutTable(doc: PlanDocument, unit: LengthUnit): string {
  const fmt = (m: number): string => formatLength(m, unit, { fixed: true });
  const rows: string[] = [];
  for (const obj of doc.objects) {
    if (!(isCamera(obj) || isBurner(obj) || isHood(obj) || isHeatFluxSensor(obj)
      || isThermocouple(obj) || isNewInstrument(obj) || isObstruction(obj) || isWall(obj) || isCeiling(obj))) continue;
    const p = positionOf(obj);
    let x = fmt(p[0]), y = fmt(p[1]), z = fmt(p[2]);
    let type: string = obj.type;
    if (isBurner(obj)) z = i18n.t("Fuel surface {p1}", { p1: fmt(fuelSurfaceZM(obj)) });
    if (isHood(obj)) z = i18n.t("Intake {p1}", { p1: fmt(hoodIntakeHeightM(obj)) });
    if (isCeiling(obj)) z = i18n.t("Soffit {p1}", { p1: fmt(ceilingSoffitZM(obj)) });
    if (isObstruction(obj)) z = i18n.t("Base {p1}\nTop {p2}", { p1: fmt(p[2]), p2: fmt(p[2] + obj.size_m[2]) });
    if (isWall(obj)) {
      const points = obj.polyline_m.map(v => toWorld(obj, [v[0], v[1], obj.baseHeight_m ?? 0]));
      x = points.map((v, i) => `P${i + 1}: ${fmt(v[0])}`).join('\n');
      y = points.map((v, i) => `P${i + 1}: ${fmt(v[1])}`).join('\n');
      z = i18n.t("Base {p1}\nTop {p2}", { p1: fmt(p[2] + (obj.baseHeight_m ?? 0)), p2: fmt(p[2] + (obj.baseHeight_m ?? 0) + obj.height_m) });
    }
    if (isThermocouple(obj)) {
      const beads = beadOffsetsOf(obj).map(offset => toWorld(obj, [0, 0, offset]));
      type = beads.length > 1 ? i18n.t("TC rake") : 'thermocouple';
      z = i18n.t("Base {p1}\n{p2}", { p1: fmt(p[2]), p2: beads.map((v, i) => i18n.t("Bead {p1}: {p2}", { p1: i + 1, p2: fmt(v[2]) })).join('\n') });
      // A tilted rake also needs its bead XY positions to be set out correctly.
      if (beads.some(v => Math.hypot(v[0] - p[0], v[1] - p[1]) > 1e-9)) {
        x = i18n.t("Base {p1}\n{p2}", { p1: x, p2: beads.map((v, i) => i18n.t("Bead {p1}: {p2}", { p1: i + 1, p2: fmt(v[0]) })).join('\n') });
        y = i18n.t("Base {p1}\n{p2}", { p1: y, p2: beads.map((v, i) => i18n.t("Bead {p1}: {p2}", { p1: i + 1, p2: fmt(v[1]) })).join('\n') });
      }
    }
    const target = isAimable(obj) ? obj.transform?.aimTarget_m : null;
    const aim = target ? target.map((v, i) => `${['X', 'Y', 'Z'][i]} ${fmt(v)}`).join('\n') : '—';
    const standoff = isCamera(obj) ? `${fmt(standoffHorizontalM(obj))} / ${fmt(standoffM(obj))}` : '—';
    let facing = '—';
    if (isHeatFluxSensor(obj)) {
      type = 'heat flux';
      // Authoritative quaternion, not a direction inferred from the advisory aim.
      facing = facingText(forwardOf(quatOf(obj)), true);
    }
    if (isVelocityProbe(obj)) { type = 'velocity probe'; facing = obj.transform?.rotation_quat ? facingText(forwardOf(quatOf(obj)), true) : i18n.t("axis unstated"); }
    if (isGasSampling(obj)) { type = 'gas sample'; facing = i18n.t("Species: {p1}{p2}", { p1: obj.species.join(', ') || i18n.t("unstated"), p2: obj.inDuct ? i18n.t("; in duct") : '' }); }
    if (isLoadCell(obj)) { type = 'load cell'; facing = i18n.t("{p1} kg; platform {p2}", { p1: obj.capacity_kg ?? i18n.t("Unstated"), p2: obj.platform_m ? obj.platform_m.map(fmt).join(' x ') + i18n.unitSpace() + unit : i18n.t("unstated (point)") }); }
    rows.push(`<tr data-object-id="${esc(obj.id)}">`
      + [cell(displayName(obj)), cell(domainLabel(type)), ...[x, y, z, aim, standoff, facing].map(v => cell(v, 'coord'))].join('')
      + '</tr>');
  }
  const axis = (view: 'front' | 'side', label: string, page: string): string => {
    const heading = elevationHeading(doc, view);
    if (i18n.language() === 'fr') return i18n.t('{axis} : {heading} ({page} in plan)', { axis: label, heading, page: page === 'right' ? i18n.t('right') : i18n.t('up') });
    return heading.startsWith('looking along') ? i18n.t("{p1} {p2} in plan", { p1: label, p2: page })
      : i18n.t("{p1} {p2} ({p3} in plan)", { p1: label, p2: heading.replace('looking ', '').replace(/ \(\+[XY]\)$/, ''), p3: page });
  };
  return `<p class="note">${esc(i18n.t("Origin: burner centre at floor level; {p1}; {p2}; heights above the floor.", { p1: axis('side', '+X', 'right'), p2: axis('front', '+Y', 'up') }))}</p>
    <p class="note">${esc(i18n.t("Lengths in {p1}. P1, P2, … follow each wall polyline; base/top give its height limits. Aim is the recorded target; a gauge's facing names the plan axis its sensing face looks along, any turn off that axis, and its tilt.", { p1: unit }))}</p>
    <table class="set-out"><thead><tr>${[i18n.t("Item"), i18n.t("Type"), 'X', 'Y', i18n.t("Height (Z)"), i18n.t("Aim point (X, Y, Z)"), i18n.t("Standoff (plan / slant)"), i18n.t("Facing / setup")].map(head).join('')}</tr></thead>
    <tbody>${rows.join('\n')}</tbody></table>`;
}

function setOutCheckTable(doc: PlanDocument, unit: LengthUnit): string {
  const rows = setOutCheck(doc);
  if (!rows.length) return '';
  const fmt = (v: number): string => formatLength(v, unit, { fixed: true });
  return `<h2>${esc(i18n.t("Set-out check"))}</h2><p class="note">${esc(i18n.t("Survey of object origins in {p1}. Height difference is measured minus planned; aim difference compares facing directions. Sign-off: ____________________", { p1: unit }))}</p>
    <table class="set-out set-out-check"><thead><tr>${[i18n.t("Item"), i18n.t("Planned (X, Y, Z)"), i18n.t("Measured (X, Y, Z)"), i18n.t("Plan distance"), i18n.t("Height difference"), i18n.t("Aim difference (deg)"), i18n.t("Measured date")].map(head).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr data-object-id="${esc(r.id)}">${[r.name, r.planned.map(fmt).join(', '), r.measured.map(fmt).join(', '), fmt(r.plan_distance_m), fmt(r.height_difference_m), r.aim_difference_deg === null ? i18n.t("Unstated") : i18n.numberText(r.aim_difference_deg.toFixed(1)), r.date ?? i18n.t("Unstated")].map(v => cell(v, 'coord')).join('')}</tr>`).join('\n')}</tbody></table>`;
}

function equipmentTable(doc: PlanDocument, unit: LengthUnit): string {
  const rows: string[] = [];

  for (const cam of cameras(doc)) {
    // The lens is what the crew screws on, so a body with a lens choice names it.
    const lens = printedLensOf(cam);
    rows.push('<tr>' + [
      `<td><span class="swatch" style="background:${esc(cameraColor(cam))}"></span>${esc(displayName(cam))}</td>`,
      cell(domainLabel(cam.camera.modality)),
      cell(`${cam.camera.resolution_px[0]}×${cam.camera.resolution_px[1]}`
        + (lens ? `, ${lens.name}${lens.listed ? i18n.t(" lens") : i18n.t(", not a listed lens")}` : '')),
      cell(`${i18n.numberText(hfovDegOf(cam).toFixed(1))}° × ${i18n.numberText(vfovDegOf(cam).toFixed(1))}°`
        + (zoomOf(cam) === 1 ? '' : i18n.t(" at {p1}×", { p1: zoomOf(cam) }))),
      cell(formatLength(standoffHorizontalM(cam), unit), 'num'),
      cell(formatLength(positionOf(cam)[2], unit), 'num'),
      cell(domainLabel(intrinsicsSourceOf(cam))),
    ].join('') + '</tr>');
  }

  for (const b of burners(doc)) {
    const tip = flameTipZM(b);
    const q = hrrAt(b);
    const fire = q !== null ? `${formatKw(q)}${i18n.unitSpace(" ")}kW ${b.fire?.fuel ?? ''}`.trim() : null;
    const notes = [fire, b.fire?.hrrCurve ? curveSummary(b.fire.hrrCurve) : null, tip === null ? null : i18n.t("mean flame tip {p1}", { p1: formatLengthWithUnit(tip, unit) })]
      .filter((n): n is string => n !== null).join(', ');
    rows.push('<tr>' + [
      `<td>${esc(displayName(b))}</td>`,
      cell(domainLabel('burner')),
      cell(`${domainLabel(b.footprint.shape)}, D_eff ${formatLengthWithUnit(burnerDiameterM(b), unit)}`),
      cell(notes || '—'),
      cell(formatLength(planDistance(positionOf(b)), unit), 'num'),
      // The fuel surface, like every other row's own extent. This column used to
      // print the mean flame tip here, unlabelled, beside heights of equipment.
      cell(formatLength(fuelSurfaceZM(b), unit), 'num'),
      cell('—'),
    ].join('') + '</tr>');
  }

  for (const hd of hoods(doc)) {
    rows.push('<tr>' + [
      `<td>${esc(displayName(hd))}</td>`,
      cell(domainLabel('hood')),
      cell(i18n.t("{p1} × {p2} opening", { p1: formatLength(hd.opening_m[0], unit), p2: formatLengthWithUnit(hd.opening_m[1], unit) })),
      cell(hd.duct ? i18n.t("duct ⌀ {p1}", { p1: formatLengthWithUnit(hd.duct.diameter_m, unit) }) : i18n.t("no duct")),
      cell(formatLength(planDistance(positionOf(hd)), unit), 'num'),
      cell(formatLength(hoodIntakeHeightM(hd), unit), 'num'),
      cell('—'),
    ].join('') + '</tr>');
  }

  for (const wl of walls(doc)) {
    const length = wl.polyline_m.slice(1).reduce((acc, p, i) =>
      acc + Math.hypot(p[0] - wl.polyline_m[i][0], p[1] - wl.polyline_m[i][1]), 0);
    // The top of the wall above the floor: a 0.6 m upstand on a 2 m base was
    // printed as 0.6.
    const top = positionOf(wl)[2] + (wl.baseHeight_m ?? 0) + wl.height_m;
    rows.push('<tr>' + [
      `<td>${esc(displayName(wl))}</td>`,
      cell(domainLabel('wall')),
      cell(i18n.t("{p1} long, {p2} high", { p1: formatLengthWithUnit(length, unit), p2: formatLengthWithUnit(wl.height_m, unit) })),
      cell(i18n.t("{p1} opening(s)", { p1: (wl.openings ?? []).length })),
      cell('—'),
      cell(formatLength(top, unit), 'num'),
      cell('—'),
    ].join('') + '</tr>');
  }

  for (const cl of ceilings(doc)) {
    rows.push('<tr>' + [
      `<td>${esc(displayName(cl))}</td>`,
      cell(domainLabel('ceiling')),
      cell(i18n.t("{p1} m² slab", { p1: i18n.numberText(ceilingAreaM2(cl).toFixed(2)) })),
      cell(i18n.t("{p1}-sided", { p1: cl.polygon_m.length })),
      cell('—'),
      cell(formatLength(ceilingSoffitZM(cl), unit), 'num'),
      cell('—'),
    ].join('') + '</tr>');
  }

  for (const ob of obstructions(doc)) {
    const [dx, dy, dz] = ob.size_m;
    rows.push('<tr>' + [
      `<td>${esc(displayName(ob))}</td>`,
      cell(domainLabel('obstruction')),
      cell(`${formatLength(dx, unit)} × ${formatLength(dy, unit)} × `
        + `${formatLengthWithUnit(dz, unit)}`),
      cell(i18n.t("{p1} m² footprint", { p1: i18n.numberText((dx * dy).toFixed(2)) })),
      cell('—'),
      cell(formatLength(positionOf(ob)[2] + dz, unit), 'num'),
      cell('—'),
    ].join('') + '</tr>');
  }

  for (const s of heatFluxSensors(doc)) {
    const range = gaugeRangeKwM2(s);
    const e = heatFluxEstimate(doc, s);
    const view = gaugeViewAngleDeg(s);
    rows.push('<tr>' + [
      `<td><span class="swatch" style="background:${esc(objectColor(s))}"></span>${esc(displayName(s))}</td>`,
      cell(domainLabel('heat flux')),
      cell(`${domainLabel(s.gauge?.kind ?? 'schmidt-boelter')}${range === null ? '' : `, 0–${range}${i18n.unitSpace(" ")}kW/m²`}`),
      cell(e === null ? i18n.t("{p1}° view", { p1: i18n.numberText(view.toFixed(0)) })
        : Number.isFinite(e.incidentKwM2) ? i18n.t("predicted {p1} kW/m²", { p1: i18n.numberText(e.incidentKwM2.toFixed(2)) })
          : i18n.t("in the fire")),
      cell(formatLength(standoffHorizontalM(s as never), unit), 'num'),
      cell(formatLength(positionOf(s)[2], unit), 'num'),
      cell('—'),
    ].join('') + '</tr>');
  }

  for (const tc of thermocouples(doc)) {
    const beads = thermocoupleBeads(doc, tc);
    const heights = beads.map((b) => b.world[2]);
    rows.push('<tr>' + [
      `<td><span class="swatch" style="background:${esc(objectColor(tc))}"></span>${esc(displayName(tc))}</td>`,
      cell(domainLabel('thermocouple')),
      cell(i18n.plural("type {p1}, {p2} bead", "type {p1}, {p2} beads", beads.length, { p1: tcTypeOf(tc), p2: beads.length })),
      cell(beads.length > 1
        ? `${formatLength(Math.min(...heights), unit)}–${formatLengthWithUnit(Math.max(...heights), unit)}`
        : i18n.t("to {p1} °C", { p1: tcMaxTemperatureC(tc) })),
      cell(formatLength(planDistance(positionOf(tc)), unit), 'num'),
      cell(formatLength(Math.max(...heights), unit), 'num'),
      cell('—'),
    ].join('') + '</tr>');
  }

  for (const obj of doc.objects.filter(isNewInstrument)) {
    const detail = isVelocityProbe(obj) ? i18n.t("Range: {p1} m/s; {p2}", { p1: obj.range_m_s ?? i18n.t("unstated"), p2: obj.transform?.rotation_quat ? facingText(forwardOf(quatOf(obj)), true) : i18n.t("axis unstated") })
      : isGasSampling(obj) ? `${obj.species.join(', ') || i18n.t("Species unstated")}${obj.inDuct ? i18n.t("; in duct") : ''}`
        : i18n.t("Capacity: {p1} kg; platform {p2}", { p1: obj.capacity_kg ?? i18n.t("unstated"), p2: obj.platform_m ? obj.platform_m.map(v => formatLength(v, unit)).join(' x ') + i18n.unitSpace() + unit : i18n.t("unstated (point)") });
    rows.push('<tr>' + [
      `<td><span class="swatch" style="background:${esc(objectColor(obj))}"></span>${esc(displayName(obj))}</td>`,
      cell(domainLabel(isVelocityProbe(obj) ? 'velocity probe' : isGasSampling(obj) ? 'gas sample' : 'load cell')),
      cell(detail), cell(i18n.t("No prediction model.")), cell(formatLength(planDistance(positionOf(obj)), unit)),
      cell(formatLength(positionOf(obj)[2], unit)), cell('')].join('') + '</tr>');
  }

  // Recorded data, listed beside the equipment it was recorded with. The hull
  // itself is time-varying and is not drawn (see docs/flame-playback.md); the row
  // says which run it is, its span, and where its envelope stands relative to the
  // burner it was reconstructed from.
  for (const f of reconstructedFlames(doc)) {
    const link = flameSequenceLink(f);
    const manifest = flameManifest(f);
    const burner = flameBurner(doc, f);
    const corners = flameBoundsCorners(f);
    const frames = manifest?.frames ?? [];
    const detail = manifest
      ? i18n.plural("{p1} frame, {p2}–{p3} s, {p4} mm voxels", "{p1} frames, {p2}–{p3} s, {p4} mm voxels", frames.length, { p1: frames.length, p2: frames[0][0], p3: frames[frames.length - 1][0], p4: i18n.numberText((manifest.grid.pitch_m * 1000).toFixed(1)) })
      : i18n.t("no voxel folder linked");
    const notes = [
      link ? i18n.t("run {p1}", { p1: link.label || fileName(link.path) }) : null,
      burner ? i18n.t("on {p1}", { p1: displayName(burner) }) : null,
    ].filter((s): s is string => s !== null).join(', ');
    let offset = '—';
    if (burner && corners.length) {
      const bp = positionOf(burner);
      const cx = corners.reduce((a, c) => a + c[0], 0) / corners.length;
      const cy = corners.reduce((a, c) => a + c[1], 0) / corners.length;
      offset = formatLength(Math.hypot(cx - bp[0], cy - bp[1]), unit);
    }
    rows.push('<tr>' + [
      `<td>${esc(displayName(f))}</td>`,
      cell(domainLabel('reconstructed flame')),
      cell(detail),
      cell(notes || '—'),
      cell(offset, 'num'),
      cell(corners.length ? formatLength(Math.max(...corners.map((c) => c[2])), unit) : '—', 'num'),
      cell('—'),
    ].join('') + '</tr>');
  }

  if (rows.length === 0) return `<p class="empty">${esc(i18n.t("No objects in this plan."))}</p>`;

  return `<table>
    <thead><tr>${[
      i18n.t("Item"), i18n.t("Type"), i18n.t("Detail"), i18n.t("Notes"), i18n.t("Standoff ({p1})", { p1: unit }), i18n.t("Height ({p1})", { p1: unit }), i18n.t("Intrinsics"),
    ].map(head).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>
  <p class="note">${esc(i18n.t("Standoff is the plan distance from the burner centre (for a reconstructed\n  flame, from its burner). Height is above the floor: the lens or sensing face of an\n  instrument, the top bead of a rake, the fuel surface of a burner, the intake of a hood,\n  the soffit of a ceiling, and the top of a wall, box or flame envelope."))}</p>`;
}

function coverageTable(doc: PlanDocument, unit: LengthUnit): string {
  const list = cameras(doc);
  if (list.length === 0) return `<p class="empty">${esc(i18n.t("No cameras in this plan."))}</p>`;

  const rows = list.map((cam) => {
    const c = framingOf(doc, cam);
    const yesNo = (v: boolean): string => `<td class="${v ? 'ok' : 'bad'}">${esc(domainLabel(v ? 'yes' : 'no'))}</td>`;
    const zoom = zoomOf(cam);
    return '<tr>' + [
      `<td><span class="swatch" style="background:${esc(cameraColor(cam))}"></span>${esc(displayName(cam))}</td>`,
      cell(formatLength(standoffM(cam), unit), 'num'),
      cell(`${i18n.numberText((groundSampleDistanceM(cam) * 1000).toFixed(2))}${zoom === 1 ? '' : i18n.t(" at {p1}×", { p1: zoom })}`, 'num'),
    ].join('')
      + (c ? yesNo(c.base) + yesNo(c.tip)
        + `<td class="num ${c.fraction > 0.999 ? 'ok' : 'bad'}">${i18n.numberText((c.fraction * 100).toFixed(0))}${i18n.unitSpace("")}%</td>`
        + (c.unobstructed === null ? '<td>—</td>'
          : `<td class="num ${c.unobstructed > 0.999 ? 'ok' : 'bad'}">${i18n.numberText((c.unobstructed * 100).toFixed(0))}${i18n.unitSpace("")}%</td>`)
        : '<td>—</td><td>—</td><td>—</td><td>—</td>')
      + '</tr>';
  });

  return `<table>
    <thead><tr>${[
      i18n.t("Camera"), i18n.t("Slant range ({p1})", { p1: unit }), i18n.t("mm/px at fire"), i18n.t("Flame base"), i18n.t("Flame tip"), i18n.t("Plume"), i18n.t("Unobstructed"),
    ].map(head).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>
  <p class="note">${esc(i18n.t("Coverage is computed against the Heskestad mean flame height and a 15° plume\n  envelope. Unobstructed is the clear share of centreline samples inside the frame.\n  The intermittent flame tip reaches higher than the mean."))}</p>${list.some((cam) => zoomOf(cam) !== 1) ? `
  <p class="note">${esc(i18n.t("mm/px for a zoomed camera is what its output pixels imply. A digital zoom\n  crops and interpolates: it does not resolve finer detail than the unzoomed detector."))}</p>` : ''}`;
}

/**
 * What each instrument is predicted to see.
 *
 * The counterpart of the camera coverage table: a gauge that pins at full scale
 * and a rake whose beads all sit outside the plume are the same class of mistake
 * as a camera that clips the flame, and this is the page where they get caught.
 */
function instrumentTable(doc: PlanDocument, unit: LengthUnit): string {
  const gauges = heatFluxSensors(doc);
  const rakes = thermocouples(doc);
  if (gauges.length === 0 && rakes.length === 0) return '';

  const rows: string[] = [];

  for (const s of gauges) {
    const e = heatFluxEstimate(doc, s);
    const swatch = `<td><span class="swatch" style="background:${esc(objectColor(s))}"></span>${esc(displayName(s))}</td>`;

    if (!e) {
      rows.push(`<tr>${swatch}${cell(domainLabel('heat flux'))}${cell('—')}${cell('—')}${cell('—')}<td>${esc(i18n.t("needs an HRR"))}</td></tr>`);
      continue;
    }
    const frac = e.fractionOfRange;
    const finite = Number.isFinite(e.incidentKwM2);
    // Word and colour from one classifier, shared with Checks and the inspector.
    // Deriving them separately is how "near field" -- a figure the checks list
    // says must not size a gauge -- came to be printed in green.
    const verdict = gaugeVerdict(doc, s)!;
    rows.push('<tr>' + swatch + [
      cell(domainLabel('heat flux')),
      cell(i18n.t("{p1} to {p2}", { p1: formatLength(e.distanceM, unit), p2: displayName(findObject(doc, e.sourceId)!) }), 'num'),
      cell(i18n.t("{p1} ({p2}% line of sight)", { p1: i18n.numberText((finite ? `${e.incidentKwM2.toFixed(2)}${i18n.unitSpace(" ")}kW/m²` : i18n.t("unbounded"))), p2: i18n.numberText((e.visibleFraction * 100).toFixed(0)) }), 'num'),
      cell(frac === null || !Number.isFinite(frac) ? '—' : `${i18n.numberText((frac * 100).toFixed(0))}${i18n.unitSpace("")}%`, 'num'),
    ].join('')
      + `<td class="${verdict.status}">${esc(verdict.label)}</td></tr>`);
  }

  for (const tc of rakes) {
    const beads = thermocoupleBeads(doc, tc);
    const hottest = beads.reduce<number | null>(
      (acc, b) => (b.gasTemperatureC !== null && (acc === null || b.gasTemperatureC > acc)
        ? b.gasTemperatureC : acc),
      null,
    );
    const inFire = beads.filter((b) => b.region !== 'outside').length;
    const swatch = `<td><span class="swatch" style="background:${esc(objectColor(tc))}"></span>${esc(displayName(tc))}</td>`;
    // The rake reads as its worst bead. "Outside the plume" stays neutral rather
    // than bad -- a rake on a wall is there to read the wall, and
    // `instrumentChecks` files that as info -- but a bead in the flame is no
    // longer described as being in the plume, nor coloured as if it were fine.
    const verdict = thermocoupleVerdict(doc, tc);

    rows.push('<tr>' + swatch + [
      cell(i18n.t("thermocouple, type {p1}", { p1: tcTypeOf(tc) })),
      cell(formatLength(planDistance(positionOf(tc)), unit), 'num'),
      cell(hottest === null ? '—' : `${i18n.numberText(hottest.toFixed(0))}${i18n.unitSpace(" ")}°C`, 'num'),
      cell(`${inFire}/${beads.length}`, 'num'),
    ].join('')
      + `<td class="${verdict.status}">${esc(verdict.label)}</td></tr>`);
  }

  return `<h2>${esc(i18n.t("Instrument exposure"))}</h2>
  <table>
    <thead><tr>${[
      i18n.t("Instrument"), i18n.t("Type"), i18n.t("Distance / standoff ({p1})", { p1: unit }), i18n.t("Predicted"), i18n.t("Range / beads used"), i18n.t("Verdict"),
    ].map(head).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>
  <p class="note">${esc(i18n.t("Heat flux is a point-source estimate at mid-flame height,\n  q″ = χ_r·Q̇·cos θ / (4πr²), summed over all fires. Gauge distances refer to the dominant source.\n  Each fire's flux is scaled by its visible share of nine flame centreline samples;\n  the total line of sight is weighted by the unshadowed flux. Indirect radiation is not estimated.\n  Thermocouple temperatures are the Heskestad plume centreline, quoted only\n  for beads above the mean flame tip and inside the plume envelope; a bead off the axis reads\n  lower. Both are for sizing and placement, not for calibration."))}</p>`;
}

function checksList(issues: Issue[]): string {
  if (issues.length === 0) return `<p class="empty">${esc(i18n.t("No issues found."))}</p>`;
  const order: Record<Issue['severity'], number> = { error: 0, warning: 1, info: 2 };
  return `<ul class="checks">${[...issues]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((i) => `<li class="sev-${i.severity}"><strong>${esc(domainLabel(i.severity))}</strong> ${esc(i.message)}</li>`)
    .join('')}</ul>`;
}

// -- document -------------------------------------------------------------

/**
 * Every selector is scoped under `.report`, and must stay that way.
 *
 * The drawing preview injects this stylesheet into the editor's own page and leaves
 * it there (it has to: the styles are what the browser prints). An unscoped rule
 * therefore restyles the app for the rest of the session -- `.checks li` alone was
 * enough to grow a white box around every item in the editor's checks panel after
 * one visit to the preview. The report's markup is entirely inside
 * `<div class="report">`, so scoping costs nothing and the standalone HTML file is
 * unaffected. `core.test.ts` asserts the invariant rather than trusting it.
 */
const REPORT_CSS = `
  .report { color: #111827; background: #fff; font: 12px/1.5 "Segoe UI", system-ui, sans-serif; }
  .report h1 { font-size: 19px; margin: 0 0 2px; }
  .report h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em;
               color: #475569; margin: 26px 0 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  .report .titleblock { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 18px;
                        border: 1px solid #cbd5e1; padding: 12px 14px; border-radius: 4px; }
  .report .titleblock .k { color: #64748b; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
  .report .titleblock .v { font-weight: 600; }
  .report .titleblock .wide { grid-column: 1 / -1; font-weight: 400; }
  .report .drawing { border: 1px solid #e2e8f0; border-radius: 4px; display: block; }
  .report .drawing .dim-text { font: 10px "Cascadia Mono", Consolas, monospace; fill: #0369a1; }
  .report .drawing .obj-label { font: 10px "Segoe UI", sans-serif; fill: #1f2937; }
  .report table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .report th { text-align: left; background: #f1f5f9; padding: 5px 7px; border-bottom: 1px solid #cbd5e1;
               font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #475569; }
  .report td { padding: 5px 7px; border-bottom: 1px solid #eef2f7; }
  .report td.num { text-align: right; font-family: "Cascadia Mono", Consolas, monospace; }
  .report .set-out { table-layout: fixed; margin-top: 8px; font-size: 10px; }
  .report .set-out th, .report .set-out td { padding: 4px; vertical-align: top; overflow-wrap: anywhere; }
  .report .set-out .coord { white-space: pre-line; font-variant-numeric: tabular-nums; }
  .report .set-out th:first-child { width: 15%; }
  .report .set-out th:nth-child(2) { width: 9%; }
  .report .set-out tr { break-inside: avoid; page-break-inside: avoid; }
  .report .set-out thead { display: table-header-group; }
  .report td.ok { color: #047857; font-weight: 600; }
  .report td.warn { color: #b45309; font-weight: 600; }
  .report td.bad { color: #b91c1c; font-weight: 600; }
  .report td.muted { color: #64748b; }
  .report .swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; }
  .report .checks { list-style: none; padding: 0; margin: 0; }
  .report .checks li { padding: 5px 9px; border-left: 3px solid #cbd5e1; background: #f8fafc; margin-bottom: 4px; }
  .report .checks li.sev-error { border-left-color: #dc2626; }
  .report .checks li.sev-warning { border-left-color: #d97706; }
  .report .checks li strong { text-transform: uppercase; font-size: 10px; letter-spacing: .05em; margin-right: 6px; }
  .report .note, .report .empty { color: #64748b; font-size: 11px; margin: 6px 0 0; }
  .report footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #e2e8f0;
                   color: #64748b; font-size: 10px; }
  .report .page-break { break-before: page; }
`;

/** Only the standalone file uses this -- the app has its own print rules in
 *  styles.css -- but it is scoped like REPORT_CSS so that stays true by accident
 *  rather than by luck. `.no-print` is deliberately global: it marks the preview
 *  chrome, which sits outside the report. */
const PRINT_CSS = `
  @page { size: A4 portrait; margin: 14mm; }
  @media print {
    .no-print { display: none !important; }
    .report { padding: 0 !important; }
    .report .drawing { break-inside: avoid; }
    .report table { break-inside: auto; }
    .report tr { break-inside: avoid; }
  }
`;

function titleBlock(doc: PlanDocument, unit: LengthUnit): string {
  const m = doc.meta ?? {};
  const field = (k: string, v: string): string =>
    `<div><div class="k">${esc(k)}</div><div class="v">${esc(v || '—')}</div></div>`;

  return `<div class="titleblock">
    ${field(i18n.t("Title"), m.title ?? 'Untitled fire test')}
    ${field(i18n.t("Test ID"), m.testId ?? '')}
    ${field(i18n.t("Site"), m.siteName ?? '')}
    ${field(i18n.t("Revision"), m.revision ?? '')}
    ${field(i18n.t("Author"), m.author ?? '')}
    ${field(i18n.t("Modified"), m.modified ?? '')}
    ${field(i18n.t("Display units"), unit)}
    ${field(i18n.t("Origin"), i18n.t("burner centre, floor level"))}
    ${m.notes ? `<div class="wide"><div class="k">${esc(i18n.t("Notes"))}</div><div>${esc(m.notes)}</div></div>` : ''}
  </div>`;
}

/** The report body, without the page chrome. Used by the in-app overlay. */
export function buildReportBody(doc: PlanDocument, unit: LengthUnit): string {
  const hasElevationContent = doc.objects.length > 0;

  return `<div class="report">
    ${titleBlock(doc, unit)}

    <h2>${esc(i18n.t("Plan view"))}</h2>
    ${buildViewSvg(doc, 'plan', unit)}

    ${hasElevationContent ? `
      <h2>${esc(i18n.t("Front elevation — {p1}", { p1: elevationHeading(doc, 'front') }))}</h2>
      ${buildViewSvg(doc, 'front', unit)}

      <h2>${esc(i18n.t("Side elevation — {p1}", { p1: elevationHeading(doc, 'side') }))}</h2>
      ${buildViewSvg(doc, 'side', unit)}
    ` : ''}

    <div class="page-break"></div>
    <h2>${esc(i18n.t("Equipment"))}</h2>
    ${equipmentTable(doc, unit)}

    <h2>${esc(i18n.t("Set-out"))}</h2>
    ${setOutTable(doc, unit)}
    ${setOutCheckTable(doc, unit)}

    <h2>${esc(i18n.t("Camera coverage"))}</h2>
    ${coverageTable(doc, unit)}

    ${instrumentTable(doc, unit)}

    <h2>${esc(i18n.t("Checks"))}</h2>
    ${checksList(checkPlan(doc))}

    <footer>${esc(i18n.t("\n      World frame is Z-up, right-handed, with the origin at the burner centre at floor\n      level; stored values are metric regardless of the display units above. Flame and\n      plume geometry are Heskestad correlations, not measurements.\n    "))}</footer>
  </div>`;
}

/** A standalone printable document, for saving or emailing. */
export function buildReportHtml(doc: PlanDocument, unit: LengthUnit): string {
  const title = doc.meta?.title ?? i18n.t("Fire test plan");
  return `<!doctype html>
<html lang="${i18n.language()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(i18n.t("{p1} — drawing", { p1: title }))}</title>
<style>
  body { margin: 0; background: #f1f5f9; }
  .report { max-width: 940px; margin: 0 auto; padding: 28px 24px 48px; }
  ${REPORT_CSS}
  ${PRINT_CSS}
  @media print { body { background: #fff; } }
</style>
</head>
<body>
${buildReportBody(doc, unit)}
</body>
</html>`;
}

export { REPORT_CSS, PRINT_CSS };
