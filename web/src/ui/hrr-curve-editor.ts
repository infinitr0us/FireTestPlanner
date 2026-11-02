/**
 * The burner inspector's Curve control: the ways to make a heat release rate
 * curve (Steady, t² growth, a pasted Table, From test data), the curve's readout
 * with a sparkline, and Remove curve. A curve made elsewhere (an FDS `&RAMP`, a
 * script) keeps its source and can be replaced or removed like any other.
 *
 * Every way commits one undoable edit through the host. The forms are drafts held
 * here, so a repaint of the inspector does not lose what is being typed; the
 * preview under each form updates in place as it is typed.
 */
import { curvePeak, curveSummary, GROWTH_RATES } from '../core/hrr';
import { decimateMinMax, type Series } from '../core/test-data';
import type { BurnerObject, HrrCurve } from '../core/types';
import { h } from './dom';
import { button, row } from './fields';
import {
  curveFromTestSeries, curveMode, curveTable, GROWTH_LABELS, importedLabel, parseCurveTable, t2Draft, t2FromDraft,
  type CurveMode, type GrowthRate, type T2Draft,
} from './hrr-curve-model';
import { fmt, svgElement } from './plot-svg';

export interface CurveEditorHost {
  /** Set the burner's curve as one undoable edit; null makes it steady at the peak. */
  apply(burnerId: string, label: string, curve: HrrCurve | null): void;
  /** The session's test data series mapped to this burner (heat release rate, kW). */
  series(burnerId: string): Series[];
  /** Repaint the inspector (coalesced). */
  rerender(): void;
  /** Names the document, so drafts do not survive into another plan. */
  documentId(): number;
}

/** A number and its unit stay on one line when a narrow inspector wraps a preview. */
const keepUnits = (text: string): string => text.replace(/(\d) (s|kW|kW\/s²)(?=$|[\s.,;·)])/g, '$1\u00a0$2');

const MODE_LABELS: Record<Exclude<CurveMode, 'imported'>, string> = {
  steady: 'Steady', t2: 't² growth', table: 'Table', measured: 'From test data',
};

/** A small picture of the curve, peak marked, beside its readout. */
export function curveSparkline(curve: HrrCurve): SVGElement {
  const W = 96, H = 34, PAD = 3;
  const t = curve.points.map((p) => p[0]), q = curve.points.map((p) => p[1]);
  const thin = curve.points.length > 2 * W ? decimateMinMax(t, q, 2 * W) : { t, values: q };
  const peak = curvePeak(curve), at = curve.points.find((p) => p[1] === peak)![0];
  const t0 = t[0], t1 = t[t.length - 1];
  const x = (v: number): number => PAD + ((v - t0) / (t1 - t0)) * (W - 2 * PAD);
  const y = (v: number): number => H - PAD - (peak > 0 ? v / peak : 0) * (H - 2 * PAD);
  const label = `Heat release rate curve, peak ${fmt(peak)} kW at ${fmt(at)} s`;
  const svg = svgElement('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'hrr-curve__spark', role: 'img', 'aria-label': label });
  svg.append(svgElement('title', {}, label));
  svg.append(svgElement('line', { x1: PAD, x2: W - PAD, y1: H - PAD, y2: H - PAD, stroke: 'var(--plot-grid)', 'stroke-width': 1 }));
  const d = Array.from(thin.t, (v, i) => `${i ? 'L' : 'M'}${x(v).toFixed(2)},${y(thin.values[i]).toFixed(2)}`).join(' ');
  svg.append(svgElement('path', { d, fill: 'none', stroke: 'var(--plot-planned)', 'stroke-width': 1.25, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  svg.append(svgElement('circle', { cx: x(at).toFixed(2), cy: y(peak).toFixed(2), r: 2.4, fill: 'var(--plot-planned)',
    stroke: 'var(--bg-panel)', 'stroke-width': 1, class: 'hrr-curve__peak' }));
  return svg;
}

export class CurveEditor {
  /** Document and burner the drafts below belong to. */
  private key = '';
  /** A way picked in the select but not applied yet; null shows the curve's own. */
  private picked: CurveMode | null = null;
  private t2: T2Draft | null = null;
  private table: string | null = null;
  private sourceId: string | null = null;
  /** What the last From test data kept and clamped, until the next change. */
  private message: string | null = null;

  constructor(private host: CurveEditorHost) {}

  render(b: BurnerObject): HTMLElement[] {
    const key = `${this.host.documentId()}/${b.id}`;
    if (key !== this.key) {
      this.key = key; this.picked = null; this.t2 = null; this.table = null; this.sourceId = null; this.message = null;
    }
    const curve = b.fire?.hrrCurve ?? null;
    const own = curveMode(curve);
    const mode = this.picked ?? own;
    if (mode !== 'measured' || own !== 'measured') this.message = null;

    const options: { value: CurveMode; label: string }[] = (Object.keys(MODE_LABELS) as (keyof typeof MODE_LABELS)[])
      .map((value) => ({ value, label: MODE_LABELS[value] }));
    if (own === 'imported') options.push({ value: 'imported', label: importedLabel(curve?.source) });
    const select = h('select', { class: 'field__input', 'data-focus-key': 'curve-mode',
      onchange: (e: Event) => {
        this.picked = (e.target as HTMLSelectElement).value as CurveMode;
        this.message = null;
        this.host.rerender();
      } }, options.map((o) => h('option', { value: o.value, selected: o.value === mode }, [o.label])));
    const out: HTMLElement[] = [row('Curve', select,
      'How the heat release rate changes with time. The checks and the drawing use the peak; the fire clock plays the curve')];

    if (curve) {
      out.push(
        h('div', { class: 'hrr-curve__row' }, [
          h('p', { class: 'readout__note hrr-curve', style: { overflowWrap: 'anywhere' } }, [curveSummary(curve)]),
          curveSparkline(curve),
        ]),
        this.focusable(button('Remove curve', () => {
          this.picked = null;
          this.host.apply(b.id, 'Remove curve', null);
        }), 'curve-remove'),
      );
    }

    const form = mode === 't2' ? this.t2Form(b) : mode === 'table' ? this.tableForm(b)
      : mode === 'measured' ? this.measuredForm(b) : null;
    if (form) out.push(form);
    else if (mode === 'imported') {
      out.push(h('p', { class: 'hrr-curve__hint' }, ['Made outside the editor, and kept as it is. Choose another way above to replace it.']));
    } else if (mode === 'steady' && curve) {
      out.push(h('p', { class: 'hrr-curve__hint' }, ['Remove curve keeps the peak as the steady heat release rate.']));
    }
    return out;
  }

  private focusable<T extends HTMLElement>(el: T, key: string): T {
    el.dataset.focusKey = key;
    return el;
  }

  private commit(b: BurnerObject, label: string, curve: HrrCurve, message: string | null = null): void {
    this.picked = null;
    this.message = message;
    this.host.apply(b.id, label, curve);
  }

  // -- t² growth ---------------------------------------------------------------

  private t2Form(b: BurnerObject): HTMLElement {
    const draft = this.t2 ??= t2Draft(b.fire?.hrr_kw ?? null, b.fire?.hrrCurve);
    const preview = h('p', { class: 'hrr-curve__preview', 'aria-live': 'polite' });
    const apply = this.focusable(button('Make t² curve', () => {
      const result = t2FromDraft(draft);
      if (result.curve) this.commit(b, 'Make t² curve', result.curve);
    }, 'btn--primary'), 'curve-apply');
    const inputs: Partial<Record<keyof T2Draft, HTMLInputElement>> = {};
    const refresh = (): void => {
      const result = t2FromDraft(draft);
      preview.textContent = keepUnits(result.readout);
      preview.classList.toggle('panel__error', result.error);
      apply.disabled = result.curve === null;
      for (const [name, input] of Object.entries(inputs)) input.setAttribute('aria-invalid', String(result.invalid.includes(name as keyof T2Draft)));
    };
    const field = (name: Exclude<keyof T2Draft, 'rate'>, label: string, hint: string): HTMLElement => {
      const input = h('input', { class: 'field__input', type: 'text', inputMode: 'decimal', value: draft[name], 'data-focus-key': `t2-${name}`,
        oninput: (e: Event) => { draft[name] = (e.target as HTMLInputElement).value; refresh(); },
        // Escape puts back the text the field had (main.ts) without an input event.
        onblur: (e: Event) => { draft[name] = (e.target as HTMLInputElement).value; refresh(); } });
      inputs[name] = input;
      return row(label, input, hint);
    };
    const rate = h('select', { class: 'field__input', 'data-focus-key': 't2-rate',
      onchange: (e: Event) => {
        draft.rate = (e.target as HTMLSelectElement).value as GrowthRate;
        // A custom α starts from the rate it replaces, so the curve does not jump.
        if (draft.rate !== 'custom') draft.alpha = String(GROWTH_RATES[draft.rate]);
        this.host.rerender();
      } }, (Object.keys(GROWTH_LABELS) as GrowthRate[]).map((r) => h('option', { value: r, selected: r === draft.rate },
      [GROWTH_LABELS[r]])));
    const body = h('div', { class: 'hrr-curve__form', role: 'group', 'aria-label': 't² growth' }, [
      row('Growth rate', rate, 'NFPA 72 and SFPE t² design-fire rates, Q = α t² until the peak'),
      // A named rate's α is shown, not typed; Custom α makes it a field.
      draft.rate === 'custom' ? field('alpha', 'α (kW/s²)', 'Growth coefficient: Q = α t²')
        : row('α (kW/s²)', h('span', { class: 'hrr-curve__alpha' }, [String(GROWTH_RATES[draft.rate])]), 'Growth coefficient of the chosen rate: Q = α t²'),
      field('peak', 'Peak (kW)', 'The rate the growth reaches and holds'),
      field('hold', 'Hold (s)', 'Time at the peak before the decay; 0 for none'),
      field('decay', 'Decay (s)', 'Linear decay from the peak to 0 kW'),
      preview,
      apply,
    ]);
    refresh();
    return body;
  }

  // -- a pasted table ----------------------------------------------------------

  private tableForm(b: BurnerObject): HTMLElement {
    const curve = b.fire?.hrrCurve;
    if (this.table === null) this.table = curve ? curveTable(curve) : '';
    const preview = h('p', { class: 'hrr-curve__preview', 'aria-live': 'polite' });
    const apply = this.focusable(button('Use table', () => {
      const result = parseCurveTable(this.table ?? '');
      if (result.curve) this.commit(b, 'Curve from table', result.curve);
    }, 'btn--primary'), 'curve-apply');
    const area = h('textarea', { class: 'field__input hrr-curve__table', rows: 6, spellcheck: false, value: this.table,
      'data-focus-key': 'curve-table', 'aria-label': 'Curve table: time (s) and HRR (kW)',
      placeholder: 'Paste two columns from a spreadsheet:\ntime (s)\tHRR (kW)\n0\t0\n60\t168.8',
      oninput: (e: Event) => { this.table = (e.target as HTMLTextAreaElement).value; refresh(); },
      onblur: (e: Event) => { this.table = (e.target as HTMLTextAreaElement).value; refresh(); } });
    const refresh = (): void => {
      const text = this.table ?? '';
      const result = parseCurveTable(text);
      const empty = text.trim() === '';
      preview.textContent = keepUnits(result.curve ? result.summary : result.error);
      preview.classList.toggle('panel__error', !result.curve && !empty);
      area.setAttribute('aria-invalid', String(!result.curve && !empty));
      apply.disabled = !result.curve;
    };
    refresh();
    return h('div', { class: 'hrr-curve__form', role: 'group', 'aria-label': 'Table' }, [area, preview, apply]);
  }

  // -- from test data ------------------------------------------------------------

  private measuredForm(b: BurnerObject): HTMLElement {
    const series = this.host.series(b.id);
    if (!series.length) {
      return h('div', { class: 'hrr-curve__form' }, [h('p', { class: 'hrr-curve__hint' }, [
        'No heat release rate series is loaded for this burner. In Test data…, map a channel to this burner (HRR, kW) and load its file.',
      ])]);
    }
    const chosen = series.find((s) => s.sourceId === this.sourceId) ?? series[0];
    this.sourceId = chosen.sourceId;
    const n = chosen.t.length;
    const children: (HTMLElement | null)[] = [];
    if (series.length > 1) {
      children.push(row('Series', h('select', { class: 'field__input', 'data-focus-key': 'curve-series',
        onchange: (e: Event) => { this.sourceId = (e.target as HTMLSelectElement).value; this.message = null; this.host.rerender(); } },
      series.map((s) => h('option', { value: s.sourceId, selected: s === chosen }, [`${s.sourceName} · ${s.role}`])))));
    }
    const before = chosen.t.findIndex((t) => t >= 0);
    const early = before < 0 ? n : before;
    children.push(h('p', { class: 'hrr-curve__preview' }, [keepUnits(
      `${chosen.sourceName} · ${chosen.role}: ${n.toLocaleString()} samples from ${fmt(chosen.t[0])} s to ${fmt(chosen.t[n - 1])} s`
        + (early ? `; the ${early.toLocaleString()} before ignition are left out` : '')
        + ', thinned to at most 200 points keeping the extremes.'),
    ]));
    const error = h('p', { class: 'panel__error', role: 'status' });
    error.hidden = true;
    children.push(error, this.focusable(button('Use series', () => {
      try {
        const result = curveFromTestSeries(chosen);
        this.commit(b, 'Curve from test data', result.curve, result.message);
      } catch (err) {
        error.textContent = (err as Error).message;
        error.hidden = false;
      }
    }, 'btn--primary'), 'curve-apply'));
    if (this.message) children.push(h('p', { class: 'hrr-curve__preview hrr-curve__message', role: 'status' }, [this.message]));
    return h('div', { class: 'hrr-curve__form', role: 'group', 'aria-label': 'From test data' }, children);
  }
}
