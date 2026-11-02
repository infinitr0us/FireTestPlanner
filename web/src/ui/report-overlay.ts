import * as i18n from './i18n';
/**
 * Full-screen preview of the drawing, with Print and Download.
 *
 * Printing is the export path: the browser's own print-to-PDF produces vector
 * output with selectable text and correct page breaks, which no bundled PDF
 * library would match for the weight it costs.
 */

import { REPORT_CSS, buildReportBody, buildReportHtml } from '../export/report';
import type { LengthUnit, PlanDocument } from '../core/types';
import { instrumentScheduleCsv } from '../core/instrument-schedule';
import { saveScheduleCsv } from '../io/files';
import { h } from './dom';

const STYLE_ID = 'report-styles';

/**
 * Reuse the standalone document's stylesheet rather than keeping a second copy in
 * styles.css, so the preview and the downloaded file cannot drift apart.
 *
 * The tag stays in `<head>` after close, because it has to survive printing and
 * reopening. That is only safe because every rule in `REPORT_CSS` is scoped under
 * `.report`; an unscoped one would restyle the editor permanently after a single
 * visit to the preview. See the note above REPORT_CSS in export/report.ts.
 */
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = REPORT_CSS;
  document.head.appendChild(style);
}

export class ReportOverlay {
  private root: HTMLDialogElement | null = null;

  constructor(private onDownload: (html: string, suggestedName: string) => void) {}

  get isOpen(): boolean {
    return this.root !== null;
  }

  open(doc: PlanDocument, unit: LengthUnit, suggestedName: string): void {
    this.close();
    ensureStyles();

    const body = h('div', { class: 'report-overlay__body', tabIndex: 0 });
    body.innerHTML = buildReportBody(doc, unit);

    const bar = h('div', { class: 'report-overlay__bar no-print' }, [
      h('span', { class: 'report-overlay__title' }, [i18n.t("Drawing preview")]),
      h('span', { class: 'report-overlay__hint' }, [
        i18n.t("Print, then choose \"Save as PDF\" as the destination."),
      ]),
      h('button', {
        class: 'btn', type: 'button',
        onclick: () => window.print(),
      }, [i18n.t("Print / Save as PDF")]),
      h('button', {
        class: 'btn', type: 'button',
        onclick: () => this.onDownload(buildReportHtml(doc, unit), suggestedName),
      }, [i18n.t("Download HTML")]),
      h('button', {
        class: 'btn', type: 'button',
        onclick: () => { void saveScheduleCsv(instrumentScheduleCsv(doc, unit), suggestedName.replace(/-drawing\.html$/, '-schedule.csv').replace(/\.html$/, '.csv'))
          .catch(error => window.alert(i18n.t("Schedule could not be saved: {p1}", { p1: (error as Error).message }))); },
      }, [i18n.t("Download schedule (CSV)")]),
      h('button', { class: 'btn', type: 'button', onclick: () => this.close() }, [i18n.t("Close")]),
    ]);

    this.root = h('dialog', { class: 'report-overlay', 'aria-label': i18n.t('Drawing preview') }, [bar, body]);
    document.body.appendChild(this.root);
    document.body.classList.add('is-reporting');
    this.root.addEventListener('cancel', e => { e.preventDefault(); this.close(); });
    this.root.showModal();
    this.root.querySelector<HTMLButtonElement>('button')?.focus();
  }

  close(): void {
    this.root?.close();
    this.root?.remove();
    this.root = null;
    document.body.classList.remove('is-reporting');
  }
}
