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
import type { PlanDocument } from '../core/types';
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
