import { domainLabel } from './domain-labels';
import * as i18n from './i18n';
/**
 * An instrument's test data in the shared plot panel: measured and simulated
 * series on plan time (seconds from ignition), the plan's own planned value, and
 * for a gauge its full-scale range. A rake plots one line per bead, coloured by
 * height; the source is told apart by dash, never by hue alone.
 */
import { decimateMinMax, seriesKey, type Series } from '../core/test-data';
import { plannedSeries, plannedValue, type PlannedValue } from '../core/planned-value';
import { beadPositions, displayName, gaugeRangeKwM2 } from '../core/plan';
import { isBurner, isHeatFluxSensor, isThermocouple, type LengthUnit, type PlanObject } from '../core/types';
import { formatLengthWithUnit } from './display-units';
import type { TestDataStore } from '../state/test-data-store';
import type { Playhead } from '../state/playhead';
import type { Store } from '../state/store';
import { h } from './dom';
import type { PlotView } from './plot-panel';
import {
  beadColor, fmt, formatTime, heightRanks, lastIndexAtOrBefore, PLANNED_DASH, RANGE_DASH, roleColor, runs,
  seriesDash, svgElement, timeAxis, unionTimes, valueAt, valueExtent,
} from './plot-svg';
import { quantityOf, unitLabel } from './test-data-model';

/** One drawn line: a series with its colour, dash and legend words. */
interface Line { series: Series; color: string; dash: string; bead: number | null }
/** The planned value over time when a burner's heat release rate has a curve. */
interface PlannedCurve { t: number[]; values: (number | null)[]; lo: number; hi: number; peakAt: number; fingerprint: string }
interface Bead { index: number; heightM: number; color: string; planned: PlannedValue | null; curve: PlannedCurve | null }
interface Plot {
  id: string;
  name: string;
  unit: Series['unit'];
  lines: Line[];
  /** One entry for a gauge or burner (bead null); one per bead for a thermocouple. */
  beads: Bead[];
  rake: boolean;
  range: number | null;
  /** Source columns in document order, with the dash each draws in. */
  sources: { id: string; name: string; role: Series['role']; dash: string }[];
  warnings: string[];
  waiting: string[];
}

/** Drawn points per line; min/max decimation keeps every peak. */
const POINTS_PER_LINE = 700;
const X0 = 50, X1 = 330, Y0 = 26, Y1 = 126;

export class TestDataView implements PlotView {
  readonly id = 'test-data';
  get label(): string { return i18n.t("Test data"); }
  private key = '';
  private time: number | null = null;
  private snapshots = new WeakMap<Float64Array, number>();
  private nextSnapshot = 0;
  private plot: Plot | null = null;
  private times: Float64Array = new Float64Array();
  private draw: (() => void) | null = null;
  private following = false;
  /** Planned curves for the document revision they were predicted for. */
  private curves = new Map<string, PlannedCurve | null>();
  private curvesFor = '';

  constructor(private store: Store, private data: TestDataStore, private playhead?: Playhead) {}

  title(): string { return i18n.t("Test data"); }

  private snapshot(a: Float64Array): number {
    if (!this.snapshots.has(a)) this.snapshots.set(a, ++this.nextSnapshot);
    return this.snapshots.get(a)!;
  }

  /** The series this object has, with their styles; null when it has none. */
  private gather(obj: PlanObject): Plot | null {
    const doc = this.store.document;
    let unit: Series['unit'];
    let beads: Bead[];
    if (isHeatFluxSensor(obj) || isBurner(obj)) {
      unit = isBurner(obj) ? 'kW' : 'kW/m2';
      beads = [{ index: -1, heightM: 0, color: '', planned: plannedValue(doc, obj.id), curve: null }];
    } else if (isThermocouple(obj)) {
      unit = '°C';
      const heights = beadPositions(obj).map((p) => p[2]);
      const { ranks, count } = heightRanks(heights);
      beads = heights.map((heightM, index) => ({ index, heightM, color: beadColor(ranks[index], count),
        planned: plannedValue(doc, obj.id, index), curve: null }));
    } else return null;
    const rake = beads.length > 1;
    const sources: Plot['sources'] = [];
    const lines: Line[] = [];
    for (const bead of beads) {
      for (const series of this.data.seriesFor(obj.id, bead.index < 0 ? undefined : bead.index)) {
        let source = sources.find((s) => s.id === series.sourceId);
        if (!source) {
          const nth = sources.filter((s) => s.role === series.role).length;
          source = { id: series.sourceId, name: series.sourceName, role: series.role, dash: seriesDash(series.role, nth) };
          sources.push(source);
        }
        lines.push({ series, bead: bead.index < 0 ? null : bead.index, dash: source.dash,
          color: rake ? bead.color : roleColor(series.role) });
      }
    }
    if (!lines.length) return null;
    for (const bead of beads) bead.curve = this.plannedCurve(obj.id, bead.index < 0 ? undefined : bead.index);
    // Sources that map this object but have nothing loaded, and loaded sources
    // whose file is not the one the plan recorded.
    const warnings: string[] = [], waiting: string[] = [];
    for (const source of doc.testData ?? []) {
      if (!source.channels.some((c) => c.object === obj.id)) continue;
      const entry = this.data.get(source.id);
      if (entry?.mismatches.length && lines.some((l) => l.series.sourceId === source.id)) {
        warnings.push(i18n.t("{p1}: the file differs from the one recorded. {p2}", { p1: source.name, p2: entry.mismatches.join(' ') }));
      }
      if (!lines.some((l) => l.series.sourceId === source.id)) {
        waiting.push(entry?.status === 'error' ? i18n.t("{p1} could not be read: {p2}", { p1: source.name, p2: entry.error ?? i18n.t("unknown error") })
          : i18n.t("{p1} is not loaded; open Test data… to load it.", { p1: source.name }));
      }
    }
    const range = isHeatFluxSensor(obj) ? gaugeRangeKwM2(obj) : null;
    return { id: obj.id, name: displayName(obj), unit, lines, beads, rake, range, sources, warnings, waiting };
  }

  /**
   * The planned value over time when a burner's heat release rate has a curve:
   * a burner's own curve, or a gauge's or bead's prediction from every burner's
   * Q(t) (`plannedSeries`). Cached per document revision, since a rake predicts
   * each bead at up to 2,000 times and the panel asks on every store event.
   */
  private plannedCurve(objectId: string, bead?: number): PlannedCurve | null {
    const revision = `${this.store.documentId}/${this.store.revision}`;
    if (revision !== this.curvesFor) { this.curvesFor = revision; this.curves.clear(); }
    const key = seriesKey(objectId, bead);
    if (this.curves.has(key)) return this.curves.get(key)!;
    const series = plannedSeries(this.store.document, objectId, bead);
    let curve: PlannedCurve | null = null;
    if (series) {
      let lo = Infinity, hi = -Infinity, peakAt = series.t[0], sum = 0;
      series.values.forEach((v, i) => {
        // A fingerprint for the signature: any change of shape or timing changes it.
        sum += ((v ?? -1) + 1e-3 * series.t[i]) * (i + 1);
        if (v === null) return;
        lo = Math.min(lo, v);
        if (v > hi) { hi = v; peakAt = series.t[i]; }
      });
      if (hi >= lo) curve = { t: series.t, values: series.values, lo, hi, peakAt, fingerprint: `${series.t.length}/${sum}` };
    }
    this.curves.set(key, curve);
    return curve;
  }

  signature(obj: PlanObject, key: string): string | null {
    const plot = this.gather(obj);
    if (!plot) { this.plot = null; this.draw = null; return null; }
    if (key !== this.key) { this.key = key; this.time = null; }
    this.plot = plot;
    this.following = Boolean(this.playhead?.hasRange);
    return JSON.stringify([plot.name, this.store.displayUnit, plot.range, plot.warnings, plot.waiting,
      plot.beads.map((b) => [b.heightM, b.color, b.planned, b.curve?.fingerprint ?? null]),
      plot.lines.map((l) => [l.series.sourceId, l.series.sourceName, l.series.role, l.bead, l.color, l.dash,
        this.snapshot(l.series.t), this.snapshot(l.series.values), l.series.missing]),
      this.following, this.playhead?.kind ?? null]);
  }

  follow(): void {
    if (!this.following || !this.playhead?.hasRange || !this.draw || !this.times.length) return;
    const index = Math.max(lastIndexAtOrBefore(this.times, this.playhead.time_s), 0);
    if (this.times[index] === this.time) return;
    this.time = this.times[index];
    this.draw();
  }

  render(obj: PlanObject, root: HTMLElement): void {
    const plot = this.plot;
    if (!plot) return;
    const unit = this.store.displayUnit;
    const kind = isHeatFluxSensor(obj) ? domainLabel('heat flux gauge') : isBurner(obj) ? i18n.t("burner, heat release rate")
      : plot.rake ? i18n.t("thermocouple rake, {p1} beads", { p1: plot.beads.length }) : domainLabel('thermocouple');
    root.append(h('div', { class: 'plot-panel__source' }, [`${plot.name} · ${kind}`]));
    for (const warning of plot.warnings) root.append(h('p', { class: 'plot-panel__warning', role: 'note' }, [warning]));

    // A planned curve joins the time axis, so the whole planned test is in view.
    const times = unionTimes([...plot.lines.map((l) => l.series.t), ...plot.beads.flatMap((b) => b.curve ? [b.curve.t] : [])]);
    this.times = times;
    const axis = timeAxis(times[0], times[times.length - 1]);
    const chart = this.chart(plot, times, axis);
    if (this.time === null || this.time < times[0] || this.time > times[times.length - 1]) this.time = times[0];

    const readout = h('output', { class: 'plot-panel__values', 'aria-live': 'polite' });
    const following = this.following;
    const slider = h('input', { type: 'range', min: 0, max: times.length - 1, step: 1,
      value: Math.max(lastIndexAtOrBefore(times, this.time), 0),
      'aria-label': i18n.t("Test data time"), disabled: times.length === 1,
      oninput: (e: Event) => {
        this.time = times[Number((e.target as HTMLInputElement).value)];
        if (following) this.playhead!.seek(this.time);
        draw();
      } });
    const legend = this.legend(plot, unit);
    const draw = (): void => {
      const t = this.time!;
      chart.select(t);
      slider.value = String(Math.max(lastIndexAtOrBefore(times, t), 0));
      readout.textContent = i18n.t("t = {p1} from ignition", { p1: formatTime(t, axis) });
      legend.select(t);
    };
    this.draw = draw;
    this.follow();
    draw();
    root.append(chart.svg, slider, readout, legend.table);
    for (const note of this.notes(plot, following)) root.append(h('p', { class: 'plot-panel__note' }, [note]));
  }

  private chart(plot: Plot, times: Float64Array, axis: ReturnType<typeof timeAxis>): { svg: SVGElement; select: (t: number) => void } {
    const t0 = times[0], t1 = times[times.length - 1];
    let lo = Infinity, hi = -Infinity;
    for (const l of plot.lines) for (const v of l.series.values) { if (v < lo) lo = v; if (v > hi) hi = v; }
    // A planned curve where a burner's heat release rate changes; otherwise a line.
    const planned = plot.beads.filter((b) => b.curve !== null || (b.planned?.value !== null && b.planned?.value !== undefined));
    const top = (b: Bead): number => b.curve ? b.curve.hi : b.planned!.value!;
    for (const b of planned) { lo = Math.min(lo, b.curve ? b.curve.lo : top(b)); hi = Math.max(hi, top(b)); }
    // Heat flux and HRR are non-negative quantities read from zero; temperatures are not.
    if (plot.unit !== '°C') lo = Math.min(lo, 0);
    // The range joins the axis while it stays within twice what is plotted; beyond
    // that it would flatten the data, and the panel says where it is instead.
    const rangeShown = plot.range !== null && plot.range <= Math.max(hi, 0) * 2;
    if (rangeShown) hi = Math.max(hi, plot.range!);
    const extent = valueExtent(lo, hi);
    const x = (t: number): number => t1 === t0 ? (X0 + X1) / 2 : X0 + ((t - t0) / (t1 - t0)) * (X1 - X0);
    const y = (v: number): number => Y1 - ((v - extent.lo) / (extent.hi - extent.lo)) * (Y1 - Y0);
    const quantity = `${quantityOf(plot.unit)} (${unitLabel(plot.unit)})`;
    const svg = svgElement('svg', { viewBox: '0 0 350 160', role: 'img',
      'aria-label': i18n.t("{p1} of {p2} over time, {p3} series", { p1: quantity, p2: plot.name, p3: plot.lines.length }) });
    svg.append(svgElement('title', {}, i18n.t("{p1} against time from ignition", { p1: quantity })));
    svg.append(svgElement('text', { x: X0, y: 15, class: 'plot-panel__axis-title' }, quantity));
    for (const tick of extent.ticks) {
      svg.append(svgElement('line', { x1: X0, x2: X1, y1: y(tick), y2: y(tick), stroke: 'var(--plot-grid)', 'stroke-width': 0.6 }));
      svg.append(svgElement('text', { x: X0 - 5, y: y(tick) + 3.5, 'text-anchor': 'end' }, fmt(tick)));
    }
    for (const tick of axis.ticks) svg.append(svgElement('text', { x: x(tick), y: Y1 + 14, 'text-anchor': 'middle' }, fmt(tick / axis.scale)));
    svg.append(svgElement('text', { x: (X0 + X1) / 2, y: Y1 + 29, 'text-anchor': 'middle' }, axis.label));

    if (plot.range !== null) {
      if (rangeShown) {
        svg.append(svgElement('line', { x1: X0, x2: X1, y1: y(plot.range), y2: y(plot.range), stroke: 'var(--plot-limit)',
          'stroke-width': 1, 'stroke-dasharray': RANGE_DASH, class: 'plot-panel__range' }));
        svg.append(svgElement('text', { x: X1 - 2, y: y(plot.range) - 3, 'text-anchor': 'end', class: 'plot-panel__line-label' }, i18n.t("Range")));
      } else {
        svg.append(svgElement('text', { x: X1 - 2, y: Y0 + 9, 'text-anchor': 'end', class: 'plot-panel__line-label' },
          i18n.t("Range {p1} {p2} ↑", { p1: fmt(plot.range), p2: unitLabel(plot.unit) })));
      }
    }
    // Planned lines: neutral for one instrument, the bead's own colour on a rake,
    // where only the highest is labelled so five labels do not stack. With a curve
    // the planned value is a path over time, broken where no correlation applies,
    // and its label sits over its highest point.
    const highest = planned.reduce<Bead | null>((best, b) => (best && top(best) >= top(b) ? best : b), null);
    for (const b of planned) {
      const style = { stroke: plot.rake ? b.color : 'var(--plot-planned)', 'stroke-width': 1.2, 'stroke-dasharray': PLANNED_DASH,
        class: 'plot-panel__planned' };
      if (b.curve) {
        const path: string[] = [];
        let open = false;
        b.curve.t.forEach((t, i) => {
          const v = b.curve!.values[i];
          if (v === null) { open = false; return; }
          path.push(`${open ? 'L' : 'M'}${x(t).toFixed(2)},${y(v).toFixed(2)}`);
          open = true;
        });
        svg.append(svgElement('path', { d: path.join(' '), fill: 'none', 'stroke-linejoin': 'round', ...style,
          ...(b.index >= 0 ? { 'data-bead': b.index } : {}) }));
        if (b === highest) {
          const xx = x(b.curve.peakAt), right = xx > (X0 + X1) / 2;
          svg.append(svgElement('text', { x: right ? xx - 3 : xx + 3, y: Math.max(y(b.curve.hi) - 4, Y0 + 8),
            'text-anchor': right ? 'end' : 'start', class: 'plot-panel__line-label' }, i18n.t("Planned")));
        }
      } else {
        const yy = y(b.planned!.value!);
        svg.append(svgElement('line', { x1: X0, x2: X1, y1: yy, y2: yy, ...style }));
        if (b === highest) svg.append(svgElement('text', { x: X1 - 2, y: yy - 3, 'text-anchor': 'end', class: 'plot-panel__line-label' }, i18n.t("Planned")));
      }
    }

    const cursor = svgElement('line', { y1: Y0, y2: Y1, stroke: 'var(--plot-cursor)', 'stroke-dasharray': '3 3' });
    const points = plot.lines.map((l) => {
      const path: string[] = [];
      const n = l.series.t.length;
      for (const [a, b] of runs(l.series.t)) {
        const budget = Math.max(2, Math.round(POINTS_PER_LINE * (b - a) / n));
        const part = decimateMinMax(l.series.t.subarray(a, b), l.series.values.subarray(a, b), budget);
        part.t.forEach((t, i) => path.push(`${i ? 'L' : 'M'}${x(t).toFixed(2)},${y(part.values[i]).toFixed(2)}`));
      }
      svg.append(svgElement('path', { d: path.join(' '), fill: 'none', stroke: l.color, 'stroke-width': 1.5,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round', ...(l.dash ? { 'stroke-dasharray': l.dash } : {}),
        'data-source': l.series.sourceId, ...(l.bead !== null ? { 'data-bead': l.bead } : {}) }));
      return svgElement('circle', { r: 2.5, fill: l.color, stroke: 'var(--bg-panel)', 'stroke-width': 1 });
    });
    svg.append(cursor, ...points);
    return { svg, select: (t) => {
      const xx = String(x(t));
      cursor.setAttribute('x1', xx); cursor.setAttribute('x2', xx);
      plot.lines.forEach((l, i) => {
        const v = valueAt(l.series.t, l.series.values, t);
        points[i].setAttribute('visibility', v === null ? 'hidden' : 'visible');
        if (v !== null) { points[i].setAttribute('cx', xx); points[i].setAttribute('cy', String(y(v))); }
      });
    } };
  }

  /** A short line sample in the legend, drawn with the series' own stroke. */
  private lineKey(color: string, dash: string): SVGElement {
    const svg = svgElement('svg', { viewBox: '0 0 22 8', width: 22, height: 8, class: 'plot-panel__key', 'aria-hidden': 'true' });
    svg.append(svgElement('line', { x1: 1, x2: 21, y1: 4, y2: 4, stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round',
      ...(dash ? { 'stroke-dasharray': dash } : {}) }));
    return svg;
  }

  /**
   * The legend is also the readout: each row's value at the cursor time. One
   * instrument lists its series, then Planned and Range; a rake is a table of
   * beads against sources, with the planned value per bead.
   */
  private legend(plot: Plot, unit: LengthUnit): { table: HTMLTableElement; select: (t: number) => void } {
    const u = unitLabel(plot.unit);
    const value = (v: number | null): string => v === null ? '–' : `${fmt(v)}${i18n.unitSpace()}${u}`;
    const cells: { cell: HTMLElement; line: Line }[] = [];
    // Planned cells: a fixed value, or with a curve the prediction at the cursor,
    // within the curve's span (plannedValue at t), like every other row.
    const plannedCells: { cell: HTMLElement; bead: Bead }[] = [];
    const plannedCell = (bead: Bead): HTMLElement => {
      const cell = h('td', { class: 'plot-panel__num' }, [value(bead.planned?.value ?? null)]);
      if (bead.curve) plannedCells.push({ cell, bead });
      return cell;
    };
    const table = h('table', { class: 'plot-panel__legend', 'aria-label': i18n.t("Legend and values at the cursor") });
    if (!plot.rake) {
      const rows = plot.lines.map((line) => {
        const cell = h('td', { class: 'plot-panel__num' });
        cells.push({ cell, line });
        return h('tr', {}, [h('td', {}, [this.lineKey(line.color, line.dash)]),
          h('th', { scope: 'row' }, [`${line.series.sourceName} · ${domainLabel(line.series.role)}`]), cell]);
      });
      const bead = plot.beads[0];
      if (bead.curve || (bead.planned?.value !== null && bead.planned?.value !== undefined)) {
        rows.push(h('tr', {}, [h('td', {}, [this.lineKey('var(--plot-planned)', PLANNED_DASH)]), h('th', { scope: 'row' }, [i18n.t("Planned")]),
          plannedCell(bead)]));
      }
      if (plot.range !== null) {
        rows.push(h('tr', {}, [h('td', {}, [this.lineKey('var(--plot-limit)', RANGE_DASH)]), h('th', { scope: 'row' }, [i18n.t("Range")]),
          h('td', { class: 'plot-panel__num' }, [value(plot.range)])]));
      }
      table.append(h('tbody', {}, rows));
    } else {
      table.append(h('thead', {}, [h('tr', {}, [
        h('th', { scope: 'col' }, [i18n.t("Bead")]),
        ...plot.sources.map((s) => h('th', { scope: 'col' }, [this.lineKey('var(--text-dim)', s.dash), h('span', {}, [`${s.name} · ${domainLabel(s.role)}`])])),
        h('th', { scope: 'col' }, [this.lineKey('var(--text-dim)', PLANNED_DASH), h('span', {}, [i18n.t("Planned")])]),
      ])]));
      table.append(h('tbody', {}, plot.beads.map((bead) => h('tr', {}, [
        h('th', { scope: 'row' }, [this.lineKey(bead.color, ''), `${bead.index + 1} · ${formatLengthWithUnit(bead.heightM, unit)}`]),
        ...plot.sources.map((s) => {
          const line = plot.lines.find((l) => l.bead === bead.index && l.series.sourceId === s.id);
          const cell = h('td', { class: 'plot-panel__num' }, [line ? '' : '–']);
          if (line) cells.push({ cell, line });
          return cell;
        }),
        plannedCell(bead),
      ]))));
    }
    return { table, select: (t) => {
      for (const { cell, line } of cells) cell.textContent = value(valueAt(line.series.t, line.series.values, t));
      for (const { cell, bead } of plannedCells) {
        const c = bead.curve!;
        const inside = t >= c.t[0] && t <= c.t[c.t.length - 1];
        cell.textContent = value(inside ? plannedValue(this.store.document, plot.id, bead.index < 0 ? undefined : bead.index, t)?.value ?? null : null);
      }
    } };
  }

  private notes(plot: Plot, following: boolean): string[] {
    const notes: string[] = [];
    // Why there is no planned line, grouped so a rake says it once per reason.
    const reasons = new Map<string, number[]>();
    const gaps: number[] = [];
    for (const b of plot.beads) {
      if (!b.planned) continue;
      if (b.curve) { if (b.curve.values.includes(null)) gaps.push(b.index + 1); continue; }
      if (b.planned.value === null) reasons.set(b.planned.note, [...(reasons.get(b.planned.note) ?? []), b.index + 1]);
    }
    for (const [note, beads] of reasons) {
      notes.push(plot.rake ? i18n.plural("No planned line for bead {p2}: {p3}", "No planned line for beads {p2}: {p3}", beads.length, { p2: beads.join(', '), p3: note }) : i18n.t("No planned line: {p1}", { p1: note }));
    }
    if (gaps.length) {
      notes.push(plot.rake ? i18n.plural("The planned line for bead {p2} breaks where no gas temperature correlation applies.", "The planned line for beads {p2} breaks where no gas temperature correlation applies.", gaps.length, { p2: gaps.join(', ') })
        : i18n.t("The planned line breaks where no correlation applies."));
    }
    const curved = plot.beads.find((b) => b.curve);
    const said = plot.beads.find((b) => !b.curve && b.planned?.value !== null && b.planned?.value !== undefined)?.planned?.note
      ?? (curved ? plannedValue(this.store.document, plot.id, curved.index < 0 ? undefined : curved.index, curved.curve!.peakAt)?.note : undefined);
    if (said) notes.push(i18n.t("Planned: {p1}", { p1: said }));
    if (curved) notes.push(i18n.t("The planned line follows the heat release rate curve; the checks use its peak."));
    for (const s of plot.sources) {
      const missing = plot.lines.filter((l) => l.series.sourceId === s.id).reduce((sum, l) => sum + l.series.missing, 0);
      if (missing) notes.push(i18n.plural("{p1}: {p2} missing sample skipped, not interpolated.", "{p1}: {p2} missing samples skipped, not interpolated.", missing, { p1: s.name, p2: missing.toLocaleString(i18n.language() === 'fr' ? 'fr-CA' : undefined) }));
    }
    notes.push(...plot.waiting);
    notes.push(following ? (this.playhead?.kind === 'fire' ? i18n.t("The cursor follows the fire clock; dragging it seeks the clock.")
      : i18n.t("The cursor follows the flame playback; dragging it seeks the playback."))
      : i18n.t("Plan time is seconds from ignition. Drag the slider to read every series at one time."));
    return notes;
  }
}
