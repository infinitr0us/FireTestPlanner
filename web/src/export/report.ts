/**
 * The printable deliverable: dimensioned plan, elevations, equipment list and
 * camera coverage, in a layout you can staple to a test protocol.
 *
 * Output is HTML + inline SVG rather than a generated PDF. Printing to PDF from
 * the browser produces real vector output with selectable text, for none of the
 * weight of a PDF library -- and the same markup doubles as a shareable file.
 */

import {
  burnerDiameterM,
  burners,
  cameraColor,
  cameras,
  ceilingAreaM2,
  ceilingSoffitZM,
  ceilings,
  checkPlan,
  displayName,
  flameTipZM,
  framingOf,
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
  standoffHorizontalM,
  standoffM,
  tcMaxTemperatureC,
  tcTypeOf,
  thermocoupleBeads,
  thermocouples,
  thermocoupleVerdict,
  vfovDegOf,
  walls,
  zoomOf,
} from '../core/plan';
import { formatLength, formatLengthWithUnit } from '../core/units';
import type { Issue, LengthUnit, PlanDocument } from '../core/types';
import { buildViewSvg, escapeXml } from './drawing';

const esc = escapeXml;

const cell = (v: string, cls = ''): string => `<td${cls ? ` class="${cls}"` : ''}>${esc(v)}</td>`;
const head = (v: string): string => `<th>${esc(v)}</th>`;

// -- tables ---------------------------------------------------------------

function equipmentTable(doc: PlanDocument, unit: LengthUnit): string {
  const rows: string[] = [];

  for (const cam of cameras(doc)) {
    rows.push('<tr>' + [
      `<td><span class="swatch" style="background:${esc(cameraColor(cam))}"></span>${esc(displayName(cam))}</td>`,
      cell(cam.camera.modality),
      cell(`${cam.camera.resolution_px[0]}×${cam.camera.resolution_px[1]}`),
      cell(`${hfovDegOf(cam).toFixed(1)}° × ${vfovDegOf(cam).toFixed(1)}°`
        + (zoomOf(cam) === 1 ? '' : ` at ${zoomOf(cam)}×`)),
      cell(formatLength(standoffHorizontalM(cam), unit), 'num'),
      cell(formatLength(positionOf(cam)[2], unit), 'num'),
      cell(intrinsicsSourceOf(cam)),
    ].join('') + '</tr>');
  }

  for (const b of burners(doc)) {
    const tip = flameTipZM(b);
    rows.push('<tr>' + [
      `<td>${esc(displayName(b))}</td>`,
      cell('burner'),
      cell(`${b.footprint.shape}, D_eff ${formatLengthWithUnit(burnerDiameterM(b), unit)}`),
      cell(b.fire?.hrr_kw ? `${b.fire.hrr_kw} kW ${b.fire.fuel ?? ''}`.trim() : '—'),
      cell(formatLength(Math.hypot(positionOf(b)[0], positionOf(b)[1]), unit), 'num'),
      cell(tip === null ? '—' : formatLength(tip, unit), 'num'),
      cell('—'),
    ].join('') + '</tr>');
  }

  for (const hd of hoods(doc)) {
    rows.push('<tr>' + [
      `<td>${esc(displayName(hd))}</td>`,
      cell('hood'),
      cell(`${formatLength(hd.opening_m[0], unit)} × ${formatLengthWithUnit(hd.opening_m[1], unit)} opening`),
      cell(hd.duct ? `duct ⌀ ${formatLengthWithUnit(hd.duct.diameter_m, unit)}` : 'no duct'),
      cell('—'),
      cell(formatLength(hoodIntakeHeightM(hd), unit), 'num'),
      cell('—'),
    ].join('') + '</tr>');
  }

  for (const wl of walls(doc)) {
    const length = wl.polyline_m.slice(1).reduce((acc, p, i) =>
      acc + Math.hypot(p[0] - wl.polyline_m[i][0], p[1] - wl.polyline_m[i][1]), 0);
    rows.push('<tr>' + [
      `<td>${esc(displayName(wl))}</td>`,
      cell('wall'),
      cell(`${formatLengthWithUnit(length, unit)} long`),
      cell(`${(wl.openings ?? []).length} opening(s)`),
      cell('—'),
      cell(formatLength(wl.height_m, unit), 'num'),
      cell('—'),
    ].join('') + '</tr>');
  }

  for (const cl of ceilings(doc)) {
    rows.push('<tr>' + [
      `<td>${esc(displayName(cl))}</td>`,
      cell('ceiling'),
      cell(`${ceilingAreaM2(cl).toFixed(2)} m² slab`),
      cell(`${cl.polygon_m.length}-sided`),
      cell('—'),
      cell(formatLength(ceilingSoffitZM(cl), unit), 'num'),
      cell('—'),
    ].join('') + '</tr>');
  }

  for (const ob of obstructions(doc)) {
    const [dx, dy, dz] = ob.size_m;
    rows.push('<tr>' + [
      `<td>${esc(displayName(ob))}</td>`,
      cell('obstruction'),
      cell(`${formatLength(dx, unit)} × ${formatLength(dy, unit)} × `
        + `${formatLengthWithUnit(dz, unit)}`),
      cell(`${(dx * dy).toFixed(2)} m² footprint`),
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
      cell('heat flux'),
      cell(`${s.gauge?.kind ?? 'schmidt-boelter'}${range === null ? '' : `, 0–${range} kW/m²`}`),
      cell(e === null ? `${view.toFixed(0)}° view`
        : Number.isFinite(e.incidentKwM2) ? `predicted ${e.incidentKwM2.toFixed(2)} kW/m²`
          : 'in the fire'),
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
      cell('thermocouple'),
      cell(`type ${tcTypeOf(tc)}, ${beads.length} bead${beads.length > 1 ? 's' : ''}`),
      cell(beads.length > 1
        ? `${formatLength(Math.min(...heights), unit)}–${formatLengthWithUnit(Math.max(...heights), unit)}`
        : `to ${tcMaxTemperatureC(tc)} °C`),
      cell(formatLength(Math.hypot(positionOf(tc)[0], positionOf(tc)[1]), unit), 'num'),
      cell(formatLength(Math.max(...heights), unit), 'num'),
      cell('—'),
    ].join('') + '</tr>');
  }

  if (rows.length === 0) return '<p class="empty">No objects in this plan.</p>';

  return `<table>
    <thead><tr>${[
      'Item', 'Type', 'Detail', 'Notes', `Standoff (${unit})`, `Height (${unit})`, 'Intrinsics',
    ].map(head).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>`;
}

function coverageTable(doc: PlanDocument, unit: LengthUnit): string {
  const list = cameras(doc);
  if (list.length === 0) return '<p class="empty">No cameras in this plan.</p>';

  const rows = list.map((cam) => {
    const c = framingOf(doc, cam);
    const yesNo = (v: boolean): string => `<td class="${v ? 'ok' : 'bad'}">${v ? 'yes' : 'no'}</td>`;
    return '<tr>' + [
      `<td><span class="swatch" style="background:${esc(cameraColor(cam))}"></span>${esc(displayName(cam))}</td>`,
      cell(formatLength(standoffM(cam), unit), 'num'),
      cell(`${(groundSampleDistanceM(cam) * 1000).toFixed(2)}`, 'num'),
    ].join('')
      + (c ? yesNo(c.base) + yesNo(c.tip)
        + `<td class="num ${c.fraction > 0.999 ? 'ok' : 'bad'}">${(c.fraction * 100).toFixed(0)}%</td>`
        : '<td>—</td><td>—</td><td>—</td>')
      + '</tr>';
  });

  return `<table>
    <thead><tr>${[
      'Camera', `Slant range (${unit})`, 'mm/px at fire', 'Flame base', 'Flame tip', 'Plume',
    ].map(head).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>
  <p class="note">Coverage is computed against the Heskestad mean flame height and a 15° plume
  envelope. The intermittent flame tip reaches higher than the mean.</p>`;
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
      rows.push(`<tr>${swatch}${cell('heat flux')}${cell('—')}${cell('—')}${cell('—')}<td>needs an HRR</td></tr>`);
      continue;
    }
    const frac = e.fractionOfRange;
    const finite = Number.isFinite(e.incidentKwM2);
    // Word and colour from one classifier, shared with Checks and the inspector.
    // Deriving them separately is how "near field" -- a figure the checks list
    // says must not size a gauge -- came to be printed in green.
    const verdict = gaugeVerdict(doc, s)!;
    rows.push('<tr>' + swatch + [
      cell('heat flux'),
      cell(formatLength(e.distanceM, unit), 'num'),
      cell(finite ? `${e.incidentKwM2.toFixed(2)} kW/m²` : 'unbounded', 'num'),
      cell(frac === null || !Number.isFinite(frac) ? '—' : `${(frac * 100).toFixed(0)}%`, 'num'),
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
      cell(`thermocouple, type ${tcTypeOf(tc)}`),
      cell(formatLength(Math.hypot(positionOf(tc)[0], positionOf(tc)[1]), unit), 'num'),
      cell(hottest === null ? '—' : `${hottest.toFixed(0)} °C`, 'num'),
      cell(`${inFire}/${beads.length}`, 'num'),
    ].join('')
      + `<td class="${verdict.status}">${esc(verdict.label)}</td></tr>`);
  }

  return `<h2>Instrument exposure</h2>
  <table>
    <thead><tr>${[
      'Instrument', 'Type', `Distance / standoff (${unit})`, 'Predicted', 'Range / beads used', 'Verdict',
    ].map(head).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>
  <p class="note">Heat flux is a point-source estimate at mid-flame height,
  q″ = χ_r·Q̇·cos θ / (4πr²), and assumes an unobstructed view — it does not account for the
  walls in this plan. Thermocouple temperatures are the Heskestad plume centreline, quoted only
  for beads above the mean flame tip and inside the plume envelope; a bead off the axis reads
  lower. Both are for sizing and placement, not for calibration.</p>`;
}

function checksList(issues: Issue[]): string {
  if (issues.length === 0) return '<p class="empty">No issues found.</p>';
  const order: Record<Issue['severity'], number> = { error: 0, warning: 1, info: 2 };
  return `<ul class="checks">${[...issues]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((i) => `<li class="sev-${i.severity}"><strong>${esc(i.severity)}</strong> ${esc(i.message)}</li>`)
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
    ${field('Title', m.title ?? 'Untitled fire test')}
    ${field('Test ID', m.testId ?? '')}
    ${field('Site', m.siteName ?? '')}
    ${field('Revision', m.revision ?? '')}
    ${field('Author', m.author ?? '')}
    ${field('Modified', m.modified ?? '')}
    ${field('Display units', unit)}
    ${field('Origin', 'burner centre, floor level')}
    ${m.notes ? `<div class="wide"><div class="k">Notes</div><div>${esc(m.notes)}</div></div>` : ''}
  </div>`;
}

/** The report body, without the page chrome. Used by the in-app overlay. */
export function buildReportBody(doc: PlanDocument, unit: LengthUnit): string {
  const hasElevationContent = doc.objects.length > 0;

  return `<div class="report">
    ${titleBlock(doc, unit)}

    <h2>Plan view</h2>
    ${buildViewSvg(doc, 'plan', unit)}

    ${hasElevationContent ? `
      <h2>Front elevation — looking north (+Y)</h2>
      ${buildViewSvg(doc, 'front', unit)}

      <h2>Side elevation — looking east (+X)</h2>
      ${buildViewSvg(doc, 'side', unit)}
    ` : ''}

    <div class="page-break"></div>
    <h2>Equipment</h2>
    ${equipmentTable(doc, unit)}

    <h2>Camera coverage</h2>
    ${coverageTable(doc, unit)}

    ${instrumentTable(doc, unit)}

    <h2>Checks</h2>
    ${checksList(checkPlan(doc))}

    <footer>
      World frame is Z-up, right-handed, with the origin at the burner centre at floor
      level; stored values are metric regardless of the display units above. Flame and
      plume geometry are Heskestad correlations, not measurements.
    </footer>
  </div>`;
}

/** A standalone printable document, for saving or emailing. */
export function buildReportHtml(doc: PlanDocument, unit: LengthUnit): string {
  const title = doc.meta?.title ?? 'Fire test plan';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — drawing</title>
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
