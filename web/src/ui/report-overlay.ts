/**
 * Full-screen preview of the drawing, with Print and Download.
 *
 * Printing is the export path: the browser's own print-to-PDF produces vector
 * output with selectable text and correct page breaks, which no bundled PDF
 * library would match for the weight it costs.
 */

import { REPORT_CSS, buildReportBody, buildReportHtml } from '../export/report';
import type { LengthUnit, PlanDocument } from '../core/types';
import { h } from './dom';

const STYLE_ID = 'report-styles';

/** Reuse the standalone document's stylesheet rather than keeping a second copy in
 *  styles.css, so the preview and the downloaded file cannot drift apart. */
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = REPORT_CSS;
  document.head.appendChild(style);
}

export class ReportOverlay {
  private root: HTMLElement | null = null;

  constructor(private onDownload: (html: string, suggestedName: string) => void) {}

  get isOpen(): boolean {
    return this.root !== null;
  }

  open(doc: PlanDocument, unit: LengthUnit, suggestedName: string): void {
    this.close();
    ensureStyles();

    const body = h('div', { class: 'report-overlay__body' });
    body.innerHTML = buildReportBody(doc, unit);

    const bar = h('div', { class: 'report-overlay__bar no-print' }, [
      h('span', { class: 'report-overlay__title' }, ['Drawing preview']),
      h('span', { class: 'report-overlay__hint' }, [
        'Print, then choose "Save as PDF" as the destination.',
      ]),
      h('button', {
        class: 'btn', type: 'button',
        onclick: () => window.print(),
      }, ['Print / Save as PDF']),
      h('button', {
        class: 'btn', type: 'button',
        onclick: () => this.onDownload(buildReportHtml(doc, unit), suggestedName),
      }, ['Download HTML']),
      h('button', { class: 'btn', type: 'button', onclick: () => this.close() }, ['Close']),
    ]);

    this.root = h('div', { class: 'report-overlay' }, [bar, body]);
    document.body.appendChild(this.root);
    document.body.classList.add('is-reporting');
  }

  close(): void {
    this.root?.remove();
    this.root = null;
    document.body.classList.remove('is-reporting');
  }
}
