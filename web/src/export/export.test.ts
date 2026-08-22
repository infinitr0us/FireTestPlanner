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

import { parsePlan } from '../core/plan';
import type { CameraObject, PlanDocument } from '../core/types';
import { buildViewSvg, escapeXml } from './drawing';
import { PRINT_CSS, REPORT_CSS, buildReportBody, buildReportHtml } from './report';

const FIXTURE_PATH = fileURLToPath(new URL('../../../fixtures/pool-fire-camera-row.ftp.json', import.meta.url));
const fixture = (): PlanDocument => parsePlan(readFileSync(FIXTURE_PATH, 'utf8'));

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
