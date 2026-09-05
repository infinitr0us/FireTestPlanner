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
import { buildViewSvg, escapeXml } from './drawing';
import { PRINT_CSS, REPORT_CSS, buildReportBody, buildReportHtml } from './report';

const FIXTURE_PATH = fileURLToPath(new URL('../../../fixtures/pool-fire-camera-row.ftp.json', import.meta.url));
const fixture = (): PlanDocument => parsePlan(readFileSync(FIXTURE_PATH, 'utf8'));

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
      const line = svg.split('\n').find((l) => l.includes(`>Stacked gauge ${i}<`));
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
