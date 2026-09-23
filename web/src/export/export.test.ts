/**
 * Tests for the printable deliverable.
 *
 * The load-bearing one is stylesheet scoping: the drawing preview injects the
 * report's CSS into the editor's own page and leaves it there, so a rule that is not
 * scoped under `.report` silently restyles the app for the rest of the session.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { checkPlan, firePointSourceM, newPlan, parsePlan, positionOf } from '../core/plan';
import { lookAtQuat } from '../core/math';
import type { CameraObject, PlanDocument } from '../core/types';
import { buildViewSvg, elevationHeading, escapeXml } from './drawing';
import { PRINT_CSS, REPORT_CSS, buildReportBody, buildReportHtml, formatKw } from './report';

const FIXTURE_PATH = fileURLToPath(new URL('../../../fixtures/pool-fire-camera-row.ftp.json', import.meta.url));
const fixture = (): PlanDocument => parsePlan(readFileSync(FIXTURE_PATH, 'utf8'));
const FLAME_PATH = fileURLToPath(new URL('../../../fixtures/flame/flame-test.ftp.json', import.meta.url));
const flameFixture = (): PlanDocument => parsePlan(readFileSync(FLAME_PATH, 'utf8'));

/** The exposure table's row for one instrument. Scoped to that table: the same
 *  name also appears in the drawing labels and in the equipment list above it. */
const rowFor = (body: string, name: string): string =>
  body.slice(body.indexOf('<h2>Instrument exposure</h2>'))
    .split('<tr>')
    .find((r) => r.includes(`>${escapeXml(name)}<`)) as string;

/** Every selector in a flat (no at-rule) stylesheet, one per comma-separated part. */
function selectorsOf(css: string): string[] {
  return css
    .split('}')
    .map((rule) => rule.split('{')[0].trim())
    .filter(Boolean)
    .flatMap((list) => list.split(',').map((s) => s.trim()));
}

describe('report stylesheet', () => {
  it('scopes every rule under .report', () => {
    // `.checks li` alone was enough to grow a white box around every item in the
    // editor's own checks panel, permanently, after one visit to the preview -- the
    // app's markup is `<ul class="checks"><li class="checks__item">`, which the
    // report's unscoped rule matched exactly.
    const selectors = selectorsOf(REPORT_CSS);
    expect(selectors.length).toBeGreaterThan(10);

    const unscoped = selectors.filter((s) => !s.startsWith('.report'));
    expect(unscoped).toEqual([]);
  });

  it('still styles the markup the report actually emits', () => {
    // The other half of the invariant: scoping must not have orphaned a class.
    const body = buildReportBody(fixture(), 'm');
    expect(body).toContain('class="report"');
    for (const cls of ['titleblock', 'checks', 'swatch', 'page-break', 'drawing']) {
      expect(body).toContain(`class="${cls}`);
      expect(REPORT_CSS).toContain(`.report .${cls}`);
    }
  });

  it('keeps only .no-print global in the print rules', () => {
    // PRINT_CSS goes into the standalone file, never into the editor -- but it is
    // scoped the same way so that stays true by construction. `.no-print` is the
    // deliberate exception: it marks the preview chrome, which sits outside .report.
    const inner = PRINT_CSS.slice(PRINT_CSS.indexOf('@media'));
    const unscoped = selectorsOf(inner.replace(/@media print\s*\{/, ''))
      .filter((s) => !s.startsWith('.report') && s !== '.no-print' && !s.startsWith('@'));
    expect(unscoped).toEqual([]);
  });

  it('carries its stylesheet into the standalone download', () => {
    const html = buildReportHtml(fixture(), 'm');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain(REPORT_CSS);
    expect(html).toContain('class="report"');
  });
});

describe('report content', () => {
  it('lists every object in the plan, of every type', () => {
    // An object the equipment table cannot describe is one that quietly vanishes
    // from the sheet somebody takes to site.
    const doc = fixture();
    const body = buildReportBody(doc, 'm');
    for (const obj of doc.objects) {
      expect(body).toContain(escapeXml(obj.name ?? obj.id));
    }
    for (const label of ['heat flux', 'thermocouple', 'wall']) {
      expect(body).toContain(`<td>${label}</td>`);
    }
  });

  it('lists an obstruction, and draws it in the plan and the elevations', () => {
    // A box between a camera and the fire is the reason the type exists, so it has
    // to reach the sheet somebody takes to site -- in the table and in both views.
    const doc = fixture();
    doc.objects.push({
      id: 'obst-couch', type: 'obstruction', name: 'Couch',
      transform: { position_m: [1.2, 0.8, 0] },
      size_m: [2, 0.9, 0.8],
    } as never);

    const body = buildReportBody(doc, 'm');
    expect(body).toContain('<td>obstruction</td>');
    expect(body).toContain('Couch');

    // Its corners have to move the drawing's extents, or a box outside the current
    // bounds is simply clipped off the page.
    for (const view of ['plan', 'front', 'side'] as const) {
      const svg = buildViewSvg(doc, view, 'm');
      const without = buildViewSvg(fixture(), view, 'm');
      expect(svg).not.toBe(without);
    }
  });

  it('lists a reconstructed flame: the run, its span and where its envelope stands', () => {
    // The hull is not drawn (docs/flame-playback.md says so), but the equipment
    // list has to name it, and a flame-only plan is not a plan with no objects.
    const doc = flameFixture();
    const body = buildReportBody(doc, 'm');
    const row = body.split('<tr>').find((r) => r.includes('Visual hull')) as string;
    expect(row).toContain('<td>reconstructed flame</td>');
    expect(row).toContain('80 frames, 0–395 s, 15.7 mm voxels');
    expect(row).toContain('run Visual hull frames, on Heptane pan, 1 ft square');
    expect(row).toMatch(/<td class="num">0\.\d+<\/td>/); // the envelope's offset from the pan, and its top
    expect(row).toContain('<td class="num">0.905</td>');

    doc.objects = doc.objects.filter((o) => o.type === 'reconstructedFlame');
    const alone = buildReportBody(doc, 'm');
    expect(alone).not.toContain('No objects in this plan');
    expect(alone).toContain('Visual hull');
    delete doc.objects[0].linkedFiles;
    expect(buildReportBody(doc, 'm')).toContain('no voxel folder linked');
  });

  it('gives instruments their own exposure table', () => {
    const body = buildReportBody(fixture(), 'm');
    expect(body).toContain('Instrument exposure');
    // The east-wall gauge is the plan's teaching case: 1.70 kW/m2 on a 50 kW/m2
    // scale, which the table has to call out rather than merely print.
    expect(body).toContain('1.70 kW/m²');
    expect(body).toContain('low signal');
  });

  it('omits the exposure table entirely when there are no instruments', () => {
    const doc = fixture();
    doc.objects = doc.objects.filter(
      (o) => o.type !== 'heatFluxSensor' && o.type !== 'thermocouple',
    );
    expect(buildReportBody(doc, 'm')).not.toContain('Instrument exposure');
  });

  it('says the zoom where it quotes the field of view', () => {
    const doc = fixture();
    const cam = doc.objects.find((o) => o.type === 'camera') as CameraObject;
    expect(buildReportBody(doc, 'm')).not.toContain('at 2×');
    cam.camera.zoomFactor = 2;
    expect(buildReportBody(doc, 'm')).toContain('at 2×');
  });

  it('never prints a green verdict the checks list is calling an error', () => {
    // The exposure table is read on its own, a page above the checks list, so a
    // green cell contradicting a red finding is a safety statement rather than a
    // styling bug. A type-T bead in the flame was printed as `ok`, "in the plume".
    const doc = fixture();
    const burner = doc.objects.find((o) => o.type === 'burner')!;
    const source = firePointSourceM(doc)!;
    doc.objects.push({
      id: 'tc-flame', name: 'Flame rake', type: 'thermocouple',
      transform: { position_m: [positionOf(burner)[0], positionOf(burner)[1], source[2]] },
      beadOffsets_m: [0],
      thermocouple: { tcType: 'T' },
    } as never);

    const row = rowFor(buildReportBody(doc, 'm'), 'Flame rake');
    expect(row).toContain('class="bad"');
    expect(row).not.toContain('in the plume');
    expect(checkPlan(doc).some((i) => i.objectId === 'tc-flame' && i.severity === 'error'))
      .toBe(true);
  });

  it('prints a near-field estimate as a caveat rather than as usable', () => {
    // `gauge-near-field` says the figure is an order of magnitude, "not a value to
    // size a gauge on"; the table printed it in the same green as a good placement.
    const doc = fixture();
    const source = firePointSourceM(doc)!;
    doc.objects.push({
      id: 'hf-close', name: 'Close gauge', type: 'heatFluxSensor',
      transform: {
        position_m: [source[0] + 0.4, source[1], source[2]],
        rotation_quat: lookAtQuat([source[0] + 0.4, source[1], source[2]], source),
      },
      gauge: { range_kw_m2: 100, viewAngle_deg: 180 },
    } as never);

    const row = rowFor(buildReportBody(doc, 'm'), 'Close gauge');
    expect(row).toContain('class="warn"');
    expect(row).toContain('near field');
    expect(REPORT_CSS).toContain('.report td.warn');
  });

  it('keeps a deep stack of labels on the page at the top edge', () => {
    // Labels only ever stacked upward, so five or six co-located objects at the
    // top of the drawing pushed the last names past y = 0 -- outside the viewBox,
    // and off the printed sheet with nothing to show they had gone.
    const doc = fixture();
    const north = Math.max(...doc.objects
      .filter((o) => o.transform)
      .map((o) => positionOf(o)[1]));
    for (let i = 0; i < 6; i += 1) {
      doc.objects.push({
        id: `hf-stack-${i}`, name: `Stacked gauge ${i}`, type: 'heatFluxSensor',
        transform: { position_m: [0, north, 0.5] },
        gauge: { range_kw_m2: 50 },
      } as never);
    }

    const svg = buildViewSvg(doc, 'plan', 'm');
    const height = Number(/viewBox="0 0 [0-9.]+ ([0-9.]+)"/.exec(svg)![1]);
    const baselines = [...svg.matchAll(/ y="(-?[0-9.]+)"/g)].map((m) => Number(m[1]));
    // Guard the guard: this only tests the top edge if the stack actually reaches
    // it. Six labels at 11 px is 66 px of stack, and the plan margin is 56 px.
    expect(Math.min(...baselines)).toBeLessThan(56);
    expect(baselines.length).toBeGreaterThan(6);
    expect(Math.min(...baselines)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...baselines)).toBeLessThanOrEqual(height);

    // Every stacked name still reaches the sheet, and none of them overprint.
    const ys = new Set<number>();
    for (let i = 0; i < 6; i += 1) {
      // Unrotated, so each faces straight down, and the plan label says so (EXP-3).
      const line = svg.split('\n').find((l) => l.includes(`>Stacked gauge ${i} (faces down)<`));
      expect(line).toBeDefined();
      ys.add(Number(/ y="(-?[0-9.]+)"/.exec(line as string)![1]));
    }
    expect(ys.size).toBe(6);
  });

  it('draws the side elevation with north on the left, as the editor does', () => {
    // Looking east from the west, north (+Y) is on your left. The projector mapped
    // +Y to increasing screen X, so the exported side view was the mirror image of
    // the editor's Side view while both claimed to look east.
    const doc = newPlan('side');
    doc.objects.push({
      id: 'north', type: 'obstruction', name: 'North box',
      transform: { position_m: [0, 2, 0] }, size_m: [0.5, 0.5, 1.6],
    } as never);
    doc.objects.push({
      id: 'south', type: 'obstruction', name: 'South box',
      transform: { position_m: [0, -2, 0] }, size_m: [0.5, 0.5, 0.8],
    } as never);
    const svg = buildViewSvg(doc, 'side', 'm');
    const polygons = [...svg.matchAll(/<polygon points="([^"]+)"/g)].map((m) => m[1]);
    const centreX = (points: string): number => {
      const xs = points.split(' ').map((p) => Number(p.split(',')[0]));
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    const heights = polygons.map((p) => {
      const ys = p.split(' ').map((q) => Number(q.split(',')[1]));
      return Math.max(...ys) - Math.min(...ys);
    });
    const tall = polygons[heights.indexOf(Math.max(...heights))];
    const short = polygons[heights.indexOf(Math.min(...heights))];
    expect(centreX(tall)).toBeLessThan(centreX(short));

    // The front view is unchanged: east (+X) to the right.
    const front = newPlan('front');
    front.objects.push({
      id: 'east', type: 'obstruction', transform: { position_m: [2, 0, 0] }, size_m: [0.5, 0.5, 1.6],
    } as never);
    front.objects.push({
      id: 'west', type: 'obstruction', transform: { position_m: [-2, 0, 0] }, size_m: [0.5, 0.5, 0.8],
    } as never);
    const fsvg = buildViewSvg(front, 'front', 'm');
    const fpolys = [...fsvg.matchAll(/<polygon points="([^"]+)"/g)].map((m) => m[1]);
    const fh = fpolys.map((p) => {
      const ys = p.split(' ').map((q) => Number(q.split(',')[1]));
      return Math.max(...ys) - Math.min(...ys);
    });
    expect(centreX(fpolys[fh.indexOf(Math.max(...fh))]))
      .toBeGreaterThan(centreX(fpolys[fh.indexOf(Math.min(...fh))]));
  });

  it('keeps a raised wall, and a translated slab, on the page', () => {
    // The page was sized from a wall's transform Z alone, so a wall with a base
    // height of 10 m was drawn at y = -3500 on a 934-pixel sheet.
    const doc = newPlan('raised');
    doc.objects.push({
      id: 'w', type: 'wall', transform: { position_m: [0, 0, 0] },
      polyline_m: [[0, 0], [1, 0]], height_m: 1, baseHeight_m: 10,
    } as never);
    doc.objects.push({
      id: 'c', type: 'ceiling', transform: { position_m: [0, 0, -3] },
      polygon_m: [[-1, -1], [1, -1], [1, 1], [-1, 1]], height_m: 4,
    } as never);
    for (const view of ['front', 'side'] as const) {
      const svg = buildViewSvg(doc, view, 'm');
      const height = Number(/viewBox="0 0 [0-9.]+ ([0-9.]+)"/.exec(svg)![1]);
      const coords = [...svg.matchAll(/<polygon points="([^"]+)"/g)]
        .flatMap((m) => m[1].split(' ').map((p) => Number(p.split(',')[1])));
      const lines = [...svg.matchAll(/<line [^>]*y1="(-?[0-9.]+)"[^>]*y2="(-?[0-9.]+)"/g)]
        .flatMap((m) => [Number(m[1]), Number(m[2])]);
      for (const y of [...coords, ...lines]) {
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(height);
      }
    }
  });

  it('draws instrument symbols in the plan and the elevations', () => {
    const doc = fixture();
    for (const view of ['plan', 'front', 'side'] as const) {
      const svg = buildViewSvg(doc, view, 'm');
      // The gauge and rake colours, which is how each reads as itself on paper.
      expect(svg).toContain('#ef4444');
      expect(svg).toContain('#10b981');
      expect(svg).toContain('East wall gauge');
      expect(svg).toContain('Plume rake');
    }
  });

  it('shows the bead count in plan, where a rake stacks onto one point', () => {
    expect(buildViewSvg(fixture(), 'plan', 'm')).toContain('Plume rake (×3)');
  });

  it('stacks the labels of instruments that share a point in plan', () => {
    // The east-wall gauge and the east-wall rake are the same XY, so without
    // stacking their names print on top of each other and neither is readable.
    const doc = fixture();
    const svg = buildViewSvg(doc, 'plan', 'm');
    const yOf = (name: string): number => {
      // The rake's label carries its bead count, so match the name as a prefix.
      const tag = svg.split('\n').find((l) => l.includes(`>${name}`));
      return Number(/ y="(-?[0-9.]+)"/.exec(tag as string)![1]);
    };
    expect(Math.abs(yOf('East wall gauge') - yOf('East wall rake'))).toBeGreaterThan(6);
  });
});

// -- review 2026-09-22 ----------------------------------------------------------

/** Every x and y a drawing's polygons and paths use, in page pixels. */
const pagePoints = (svg: string): Array<[number, number]> =>
  [...svg.matchAll(/<polygon points="([^"]+)"/g)]
    .flatMap((m) => m[1].split(' ').map((pt) => pt.split(',').map(Number) as [number, number]));

/** The polygons drawn in one colour, as lists of page points. */
const polygonsIn = (svg: string, color: string): Array<Array<[number, number]>> =>
  svg.split('\n')
    .filter((l) => l.startsWith('<polygon') && l.includes(`stroke="${color}"`))
    .map((l) => /points="([^"]+)"/.exec(l)![1].split(' ').map((pt) => pt.split(',').map(Number) as [number, number]));

const extent = (pts: Array<[number, number]>, axis: 0 | 1): number =>
  Math.max(...pts.map((q) => q[axis])) - Math.min(...pts.map((q) => q[axis]));

describe('drawings and report (review 2026-09-22)', () => {
  it('names elevations from the recorded north, and marks the plan (EXP-2)', () => {
    const doc = newPlan('north');
    expect(elevationHeading(doc, 'front')).toBe('looking along +Y');
    expect(elevationHeading(doc, 'side')).toBe('looking along +X');
    expect(buildViewSvg(doc, 'plan', 'm')).toContain('>+Y</text>');

    // +Y points south: the front elevation looks south, the side one west.
    doc.coordinateSystem.northAzimuth_rad = Math.PI;
    expect(elevationHeading(doc, 'front')).toBe('looking south (+Y)');
    expect(elevationHeading(doc, 'side')).toBe('looking west (+X)');
    const svg = buildViewSvg(doc, 'plan', 'm');
    expect(svg).toContain('>N</text>');
    const body = buildReportBody({ ...fixture(), coordinateSystem: doc.coordinateSystem }, 'm');
    expect(body).toContain('Front elevation — looking south (+Y)');
    expect(body).not.toContain('looking north (+Y)');
  });

  it('lays a camera looking straight down over the floor around it (EXP-3, PHY-6)', () => {
    const doc = newPlan('overhead');
    const position: [number, number, number] = [2, 0, 4];
    doc.objects.push({
      id: 'cam', type: 'camera', name: 'Overhead',
      transform: { position_m: position, rotation_quat: lookAtQuat(position, [2, 0, 0]) },
      camera: { modality: 'RGB', resolution_px: [1920, 1080], sensor_mm: [6.4, 3.6], focalLength_mm: 4 },
    } as never);
    const svg = buildViewSvg(doc, 'plan', 'm');
    const [wedge] = svg.split('\n').filter((l) => l.startsWith('<polygon') && l.includes('fill-opacity="0.07"'));
    const pts = /points="([^"]+)"/.exec(wedge)![1].split(' ').map((pt) => pt.split(',').map(Number));
    const xs = pts.map((q) => q[0]);
    // The camera's own marker sits inside the footprint, not at a wedge's apex.
    const marker = /<circle cx="([0-9.]+)" cy="([0-9.]+)" r="4"/.exec(svg)!;
    expect(Math.min(...xs)).toBeLessThan(Number(marker[1]));
    expect(Math.max(...xs)).toBeGreaterThan(Number(marker[1]));
  });

  it('says a gauge facing the ceiling faces up, and draws no invented heading (EXP-3)', () => {
    const doc = newPlan('up');
    doc.objects.push({
      id: 'hf', type: 'heatFluxSensor', name: 'Ceiling gauge',
      transform: { position_m: [1, 1, 0.5], rotation_quat: [1, 0, 0, 0] },
      gauge: { range_kw_m2: 50, viewAngle_deg: 180 },
    } as never);
    const svg = buildViewSvg(doc, 'plan', 'm');
    expect(svg).toContain('>Ceiling gauge (faces up)<');
    expect(svg).not.toContain('stroke-dasharray="4 3"');
  });

  it('draws a horizontal rake bead by bead in plan (EXP-4)', () => {
    const doc = newPlan('rake');
    doc.objects.push({
      id: 'tc', type: 'thermocouple', name: 'Ceiling rake',
      // Local +Z along world +X: the rake lies flat, its beads spread east.
      transform: { position_m: [0, 1, 2], rotation_quat: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
      beadOffsets_m: [0, 0.5, 1, 1.5], thermocouple: { type: 'K' },
    } as never);
    const svg = buildViewSvg(doc, 'plan', 'm');
    expect(svg).toContain('>Ceiling rake<');
    expect(svg).not.toContain('(×4)');
    expect((svg.match(/r="2.6"/g) ?? []).length).toBe(4);
  });

  it('draws a line burner at its own width in each elevation (EXP-6)', () => {
    const doc = newPlan('line burner');
    doc.objects.push({
      id: 'b', type: 'burner', transform: { position_m: [0, 0, 0] },
      footprint: { shape: 'rectangle', size_m: [2, 0.25] }, rimHeight_m: 0.1,
      fire: { hrr_kw: 100 },
    } as never);
    const widths = (['front', 'side'] as const).map((view) => {
      const [pan] = polygonsIn(buildViewSvg(doc, view, 'm'), '#7c3aed');
      return extent(pan, 0);
    });
    // Both pages span the 2 m minimum, so pixels compare directly: 2 m against
    // 0.25 m. The equal-area diameter drew both 0.8 m wide.
    expect(widths[0] / widths[1]).toBeCloseTo(8, 1);
  });

  it('keeps a wide hood canopy on the sheet (EXP-7)', () => {
    const doc = newPlan('hood');
    doc.objects.push({
      id: 'h', type: 'hood', transform: { position_m: [0, 0, 0] }, height_m: 2.5, opening_m: [4, 1],
    } as never);
    const svg = buildViewSvg(doc, 'front', 'm');
    const height = Number(/viewBox="0 0 [0-9.]+ ([0-9.]+)"/.exec(svg)![1]);
    for (const [, y] of pagePoints(svg)) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(height);
    }
  });

  it('prints heights as each object\'s own extent, and HRR as written (EXP-9, EXP-10)', () => {
    expect(formatKw(300.00000000000006)).toBe('300');
    expect(formatKw(12.345)).toBe('12.35');
    const doc = newPlan('heights');
    doc.objects.push({
      id: 'b', type: 'burner', name: 'Pan', transform: { position_m: [0, 0, 0] },
      footprint: { shape: 'circle', diameter_m: 0.5 }, rimHeight_m: 0.1, fire: { hrr_kw: 300.00000000000006 },
    } as never);
    doc.objects.push({
      id: 'w', type: 'wall', name: 'Upstand', transform: { position_m: [0, 0, 0] },
      polyline_m: [[1, 0], [2, 0]], height_m: 0.6, baseHeight_m: 2,
    } as never);
    const body = buildReportBody(doc, 'm');
    const row = (name: string): string => body.split('<tr>').find((r) => r.includes(`>${name}<`))!;
    expect(row('Pan')).toContain('300 kW');
    expect(row('Pan')).not.toContain('300.00000000000006');
    expect(row('Pan')).toContain('mean flame tip');
    expect(row('Pan')).toContain('<td class="num">0.1</td>');
    expect(row('Upstand')).toContain('<td class="num">2.6</td>');
  });

  it('warns that a zoomed camera\'s mm/px is output pixels (EXP-11)', () => {
    const doc = fixture();
    expect(buildReportBody(doc, 'm')).not.toContain('A digital zoom');
    (doc.objects.find((o) => o.type === 'camera') as CameraObject).camera.zoomFactor = 2;
    const body = buildReportBody(doc, 'm');
    expect(body).toContain('A digital zoom');
    expect(body).toMatch(/[0-9.]+ at 2×<\/td>/);
  });

  it('breaks a wall at a doorway in plan, and not at a window (EXP-15)', () => {
    const doc = newPlan('door');
    doc.objects.push({
      id: 'w', type: 'wall', transform: { position_m: [0, 0, 0] },
      polyline_m: [[0, 0], [4, 0], [4, 3]], height_m: 2.5,
      openings: [
        { offset_m: 1, width_m: 0.9, sillHeight_m: 0, height_m: 2.1 },
        { offset_m: 5, width_m: 1, sillHeight_m: 1, height_m: 1 },
      ],
    } as never);
    const svg = buildViewSvg(doc, 'plan', 'm');
    const walls = svg.split('\n').filter((l) => l.startsWith('<path') && l.includes('stroke="#64748b"'));
    expect(walls).toHaveLength(2);
    // The second run turns the corner with the wall; the window does not cut it.
    expect((walls[1].match(/L/g) ?? []).length).toBe(2);
  });
});
