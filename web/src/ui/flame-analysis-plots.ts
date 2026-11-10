/**
 * The flame analysis board's plots: one SVG per quantity on a shared time axis
 * (seconds from the onset), a cursor at the playback time, the key moments, and
 * the instants the quality flags mark shaded behind the lines.
 *
 * Styles follow the instrument plots (docs/visual-language.md): measured solid in
 * `--plot-primary`, estimated in the simulated family (dashed, `--plot-secondary`),
 * gaps break a line and nothing is interpolated. The legend doubles as the
 * readout at the cursor. Each plot takes its share of the column and is drawn at
 * that size in screen pixels, so text stays the size of the interface's.
 */

import { fmt, niceTicks, PLANNED_DASH, roleColor, runs, seriesDash, svgElement, valueAt, valueExtent } from './plot-svg';
import { h } from './dom';
import * as i18n from './i18n';

export interface PlotLine {
  label: string;
  note?: string;
  t: Float64Array;
  v: Float64Array;
  /** `predicted`: a correlation's value (Heskestad), in the planned-value style. */
  role: 'measured' | 'estimated' | 'reconstructed' | 'predicted';
  /** n-th line of its role on this plot, for the dash pattern. */
  nth: number;
  /** A thin line of every sample under the thick one (10 Hz under its 1 s mean). */
  thin?: boolean;
}
export interface PlotSpec {
  id: string;
  title: string;
  unit: string;
  lines: PlotLine[];
  /** Shown value = stored value x scale (m3 to litres, ...). */
  scale?: number;
}
export interface Band { from: number; to: number; kind: 'noHull' | 'outsideFrame' }
export interface Moment { t: number; label: string }

/** Shared text and colour meaning on the board and in exported compositions. */
export const qualityKey = (kind: Band['kind']): { text: string; token: string } => kind === 'noHull'
  ? { text: i18n.t("a camera sees flame but there is no 3-D flame"), token: '--warn' }
  : { text: i18n.t("flame at a picture's edge"), token: '--text-dim' };

const LEFT = 44, RIGHT = 10, TOP = 8, AXIS = 30;
/** Each drawing's clip needs an id of its own in the document. */
let clips = 0;

/** A line's colour token: measured and reconstructed primary, estimated in the
 *  simulated family, a correlation's prediction in the planned-value neutral. */
export const colourOf = (line: Pick<PlotLine, 'role'>): string =>
  line.role === 'predicted' ? 'var(--plot-planned)' : line.role === 'estimated' ? roleColor('simulated') : roleColor('measured');
/** Measured and reconstructed solid, estimated dashed, predicted long dashes. A
 *  second measured line on a plot (a total beside a convective hood record) takes
 *  the measured family's next pattern, so the two can be told apart. */
export const dashOf = (line: Pick<PlotLine, 'role' | 'nth'>): string =>
  line.role === 'predicted' ? PLANNED_DASH : line.role === 'estimated' ? seriesDash('simulated', line.nth)
    : line.role === 'measured' ? seriesDash('measured', line.nth) : '';

interface Drawn { spec: PlotSpec; host: HTMLElement; svg?: SVGSVGElement; cursor?: SVGLineElement; x0: number; x1: number; last: boolean }

export class AnalysisPlots {
  readonly element = h('div', { class: 'flame-analysis__plots' });
  private plots: Drawn[] = [];
  private readouts: { cell: HTMLElement; line: PlotLine; scale: number }[] = [];
  private sections = new Map<string, HTMLElement>();
  private observer: ResizeObserver;
  private time: number;

  constructor(
    specs: PlotSpec[],
    private window: [number, number],
    private onset: number,
    private bands: Band[],
    private moments: Moment[],
    private onSeek: (t: number) => void,
  ) {
    this.time = window[0];
    this.observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const plot = this.plots.find((p) => p.host === entry.target);
        if (plot) this.draw(plot);
      }
    });
    specs.forEach((spec, n) => {
      const host = h('div', { class: 'flame-analysis__plot-area' });
      const scale = spec.scale ?? 1;
      const legend = h('table', { class: 'flame-analysis__legend' }, [
        h('caption', {}, [`${spec.title} (${spec.unit})`]),
        h('tbody', {}, spec.lines.map((line) => {
          const cell = h('td', { class: 'flame-analysis__value' }, ['–']);
          this.readouts.push({ cell, line, scale });
          return h('tr', {}, [h('td', {}, [this.key(line)]), h('th', { scope: 'row', title: line.note }, [line.label]), cell]);
        })),
      ]);
      const section = h('section', { class: 'flame-analysis__plot', dataset: { plot: spec.id } }, [host, legend]);
      this.sections.set(spec.id, section);
      this.element.append(section);
      this.plots.push({ spec, host, x0: 0, x1: 1, last: n === specs.length - 1 });
      this.observer.observe(host);
    });
    if (bands.length) {
      this.element.append(h('p', { class: 'flame-analysis__bands' }, [
        bands.some((b) => b.kind === 'noHull') ? h('span', { class: 'flame-analysis__band-key flame-analysis__band-key--nohull' }, [qualityKey('noHull').text]) : null,
        bands.some((b) => b.kind === 'outsideFrame') ? h('span', { class: 'flame-analysis__band-key flame-analysis__band-key--edge' }, [qualityKey('outsideFrame').text]) : null,
      ]));
    }
  }

  /** The plot's section, to outline when a step points at it. */
  section(id: string): HTMLElement | undefined { return this.sections.get(id); }

  private draw(plot: Drawn): void {
    const width = Math.floor(plot.host.clientWidth), height = Math.floor(plot.host.clientHeight);
    if (width < 60 || height < 40) return;
    const { spec } = plot;
    const scale = spec.scale ?? 1;
    const [t0, t1] = this.window;
    const X0 = LEFT, X1 = width - RIGHT, Y0 = TOP, Y1 = height - (plot.last ? AXIS : 6);
    plot.x0 = X0; plot.x1 = X1;
    const x = (t: number): number => X0 + ((t - t0) / Math.max(t1 - t0, 1e-9)) * (X1 - X0);
    let hi = -Infinity, lo = 0;
    for (const line of spec.lines) {
      for (let i = 0; i < line.t.length; i++) {
        if (line.t[i] < t0 || line.t[i] > t1 || !Number.isFinite(line.v[i])) continue;
        hi = Math.max(hi, line.v[i] * scale);
        lo = Math.min(lo, line.v[i] * scale);
      }
    }
    const extent = valueExtent(lo, Number.isFinite(hi) ? hi : 1, Math.max(2, Math.round((Y1 - Y0) / 28)));
    const y = (v: number): number => Y1 - ((v - extent.lo) / Math.max(extent.hi - extent.lo, 1e-12)) * (Y1 - Y0);
    const svg = svgElement('svg', {
      width, height, viewBox: `0 0 ${width} ${height}`, class: 'flame-analysis__plot-svg', role: 'img',
      'aria-label': i18n.t("{p1} over time; the table beside it reads the values at the playback time", { p1: spec.title }),
    }) as SVGSVGElement;
    for (const band of this.bands) {
      const a = Math.max(x(band.from), X0), b = Math.min(x(band.to), X1);
      if (b > a) svg.append(svgElement('rect', { x: a, y: Y0, width: Math.max(b - a, 1.5), height: Y1 - Y0, class: `flame-analysis__band flame-analysis__band--${band.kind}` }));
    }
    for (const tick of extent.ticks) {
      svg.append(svgElement('line', { x1: X0, x2: X1, y1: y(tick), y2: y(tick), stroke: 'var(--plot-grid)', 'stroke-width': 0.6 }));
      svg.append(svgElement('text', { x: X0 - 5, y: y(tick) + 3.5, 'text-anchor': 'end', class: 'flame-analysis__tick' }, fmt(tick)));
    }
    for (const tick of niceTicks(t0 - this.onset, t1 - this.onset, Math.max(3, Math.round((X1 - X0) / 70)))) {
      const px = x(tick + this.onset);
      svg.append(svgElement('line', { x1: px, x2: px, y1: Y0, y2: Y1, stroke: 'var(--plot-grid)', 'stroke-width': 0.4 }));
      if (plot.last) svg.append(svgElement('text', { x: px, y: Y1 + 13, 'text-anchor': 'middle', class: 'flame-analysis__tick' }, (tick > 0 ? '+' : '') + fmt(tick)));
    }
    if (plot.last) svg.append(svgElement('text', { x: X1, y: Y1 + 26, 'text-anchor': 'end', class: 'flame-analysis__tick' }, i18n.t("Time from the onset (s)")));
    // The onset is marked unless a key moment already names that instant.
    const marks = this.moments.some((m) => Math.abs(m.t - this.onset) < 1e-6) ? this.moments
      : [{ t: this.onset, label: i18n.t("Onset") }, ...this.moments];
    let labelEnd = -Infinity, row = 0;
    for (const moment of [...marks].sort((a, b) => a.t - b.t)) {
      if (moment.t < t0 || moment.t > t1) continue;
      const px = x(moment.t);
      svg.append(svgElement('line', { x1: px, x2: px, y1: Y0, y2: Y1, class: 'flame-analysis__moment' }));
      if (this.plots[0] === plot) {
        // Right of its line, or left of it where it would run past the plot's edge.
        const width = moment.label.length * 5.5, before = px + 3 + width > X1;
        const start = before ? px - 3 - width : px + 3;
        row = start < labelEnd ? row + 1 : 0;
        const label = svgElement('text', {
          x: before ? px - 3 : px + 3, y: Y0 + 9 + row * 11, class: 'flame-analysis__moment-label',
          ...(before ? { 'text-anchor': 'end' } : {}),
        }, moment.label);
        svg.append(label);
        labelEnd = start + width + 3;
      }
    }
    // A series may run past the event's instants (a hood record of the whole test):
    // its line stops at the plot's edge, as in the exported composition.
    const clip = `flame-analysis-clip-${++clips}`;
    const clipPath = svgElement('clipPath', { id: clip });
    clipPath.append(svgElement('rect', { x: X0, y: Y0 - 2, width: Math.max(X1 - X0, 0), height: Math.max(Y1 - Y0 + 4, 0) }));
    svg.append(clipPath);
    for (const line of spec.lines) {
      const d = this.path(line, scale, x, y);
      if (!d) continue;
      svg.append(svgElement('path', {
        d, fill: 'none', stroke: this.colour(line), 'clip-path': `url(#${clip})`,
        'stroke-width': line.thin ? 0.8 : line.role === 'measured' || line.role === 'reconstructed' ? 2 : 1.6,
        'stroke-opacity': line.thin ? 0.5 : 1,
        'stroke-dasharray': dashOf(line),
        'stroke-linejoin': 'round',
      }));
    }
    plot.cursor = svgElement('line', { y1: Y0, y2: Y1, stroke: 'var(--plot-cursor)', 'stroke-dasharray': '3 3' }) as SVGLineElement;
    svg.append(plot.cursor);
    this.bindSeek(svg, plot);
    if (plot.svg) plot.svg.replaceWith(svg); else plot.host.append(svg);
    plot.svg = svg;
    this.place(plot);
  }

  private colour(line: PlotLine): string { return colourOf(line); }

  private path(line: PlotLine, scale: number, x: (t: number) => number, y: (v: number) => number): string {
    const [t0, t1] = this.window;
    const parts: string[] = [];
    for (const [a, b] of runs(line.t)) {
      let pen = false;
      for (let i = a; i < b; i++) {
        if (line.t[i] < t0 - 1 || line.t[i] > t1 + 1 || !Number.isFinite(line.v[i])) { pen = false; continue; }
        parts.push(`${pen ? 'L' : 'M'}${x(line.t[i]).toFixed(1)} ${y(line.v[i] * scale).toFixed(1)}`);
        pen = true;
      }
    }
    return parts.join('');
  }

  private key(line: PlotLine): SVGElement {
    const svg = svgElement('svg', { width: 26, height: 10, 'aria-hidden': 'true' });
    svg.append(svgElement('line', {
      x1: 1, x2: 25, y1: 5, y2: 5, stroke: this.colour(line), 'stroke-width': line.thin ? 1 : 2,
      'stroke-opacity': line.thin ? 0.6 : 1,
      'stroke-dasharray': dashOf(line),
    }));
    return svg;
  }

  private bindSeek(svg: SVGSVGElement, plot: Drawn): void {
    const seek = (e: PointerEvent): void => {
      const box = svg.getBoundingClientRect();
      const px = Math.min(Math.max(e.clientX - box.left, plot.x0), plot.x1);
      const [t0, t1] = this.window;
      this.onSeek(t0 + ((px - plot.x0) / (plot.x1 - plot.x0)) * (t1 - t0));
    };
    svg.addEventListener('pointerdown', (e) => {
      svg.setPointerCapture(e.pointerId);
      seek(e);
    });
    svg.addEventListener('pointermove', (e) => { if (svg.hasPointerCapture(e.pointerId)) seek(e); });
  }

  private place(plot: Drawn): void {
    if (!plot.cursor) return;
    const [t0, t1] = this.window;
    const px = plot.x0 + ((this.time - t0) / Math.max(t1 - t0, 1e-9)) * (plot.x1 - plot.x0);
    plot.cursor.setAttribute('x1', String(px));
    plot.cursor.setAttribute('x2', String(px));
  }

  setTime(t: number): void {
    this.time = t;
    for (const plot of this.plots) this.place(plot);
    for (const { cell, line, scale } of this.readouts) {
      const value = valueAt(line.t, line.v, t);
      cell.textContent = value === null || !Number.isFinite(value) ? '–' : fmt(value * scale);
    }
  }

  dispose(): void {
    this.observer.disconnect();
  }
}
