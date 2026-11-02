import { fileName } from '../core/linked-files';
import { flameSequenceLink, plotFollowsFlame } from '../core/plan';
import { isBurner, type LinkedFile, type PlanObject, type ReconstructionPlot } from '../core/types';
import type { FlameStore } from '../state/flame-store';
import type { Playhead } from '../state/playhead';
import type { Store } from '../state/store';
import { h } from './dom';
import type { PlotView } from './plot-panel';
import { fmt, lastIndexAtOrBefore, svgElement } from './plot-svg';

/** Two aligned plots keep volume and area in their own units and scales. */
function chart(plot: ReconstructionPlot, column: 1 | 2): { svg: SVGElement; select: (index: number) => void } {
  const samples = plot.samples;
  const title = column === 1 ? 'Volume (m³)' : 'Surface area (m²)';
  const color = column === 1 ? 'var(--plot-primary)' : 'var(--plot-secondary)';
  const minTime = samples[0][0], maxTime = samples.at(-1)![0];
  let ymax = 0;
  for (const sample of samples) ymax = Math.max(ymax, sample[column]);
  ymax ||= 1;
  const x = (t: number): number => maxTime === minTime ? 192 : 56 + ((t - minTime) / (maxTime - minTime)) * 272;
  const y = (v: number): number => 103 - (v / ymax) * 70;
  const svg = svgElement('svg', { viewBox: '0 0 350 135', role: 'img', 'aria-label': `${title} over time, ${samples.length} measurements` });
  svg.append(svgElement('title', {}, `${title} over time (s)`));
  svg.append(svgElement('text', { x: 56, y: 18, fill: color, 'font-weight': '600' }, title));
  for (const fraction of [0, 0.5, 1]) {
    const yy = y(ymax * fraction);
    svg.append(svgElement('line', { x1: 56, x2: 328, y1: yy, y2: yy, stroke: 'var(--plot-grid)', 'stroke-width': 0.6 }));
    svg.append(svgElement('text', { x: 49, y: yy + 4, 'text-anchor': 'end' }, fmt(ymax * fraction)));
  }
  for (const t of maxTime === minTime ? [minTime] : [minTime, minTime + (maxTime - minTime) / 2, maxTime]) {
    svg.append(svgElement('text', { x: x(t), y: 119, 'text-anchor': 'middle' }, fmt(t)));
  }
  svg.append(svgElement('text', { x: 192, y: 133, 'text-anchor': 'middle' }, 'Time (s)'));
  svg.append(svgElement('path', { d: samples.map((s, i) => `${i ? 'L' : 'M'}${x(s[0]).toFixed(2)},${y(s[column]).toFixed(2)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 1.5 }));
  const cursor = svgElement('line', { y1: 28, y2: 103, stroke: 'var(--plot-cursor)', 'stroke-dasharray': '3 3' });
  const point = svgElement('circle', { r: 3, fill: color });
  svg.append(cursor, point);
  return { svg, select: (index) => {
    const selected = samples[index], xx = String(x(selected[0]));
    cursor.setAttribute('x1', xx); cursor.setAttribute('x2', xx);
    point.setAttribute('cx', xx); point.setAttribute('cy', String(y(selected[column])));
  } };
}

/**
 * A burner's reconstruction CSV in the shared plot panel.
 *
 * The plot follows the playback clock when it is this reconstruction's own
 * data: the burner's flame is loaded and the CSV matches its manifest. Then the
 * cursor sits on the last sample at or before the clock's time, and dragging
 * the slider seeks the clock. Any other dataset -- another run's, another
 * burner's, or with no flame loaded at all -- keeps the slider to itself,
 * exactly as in format 1.3.
 */
export class ReconstructionView implements PlotView {
  readonly id = 'reconstruction';
  readonly label = 'Reconstruction';
  private selectedLink = '';
  private index = 0;
  private key = '';
  private snapshots = new WeakMap<ReconstructionPlot['samples'], number>();
  private nextSnapshot = 0;
  /** Redraw the cursor for the current index; set while the plot is on screen. */
  private draw: (() => void) | null = null;
  private samples: ReconstructionPlot['samples'] | null = null;
  private times: number[] = [];
  /** Whether the plot on screen is one the clock drives. */
  private following = false;

  constructor(private store: Store, private playhead?: Playhead, private flames?: FlameStore) {}

  title(): string { return 'Reconstruction results'; }

  /** Whether a flame's frames are in the session, for `plotFollowsFlame`. */
  private loaded = (flame: Parameters<typeof flameSequenceLink>[0]): boolean => {
    const link = flameSequenceLink(flame);
    return Boolean(link && this.flames?.sequenceOf(link));
  };

  private links(obj: PlanObject): LinkedFile[] {
    return isBurner(obj) ? obj.linkedFiles?.filter((f) => f.plot) ?? [] : [];
  }

  signature(obj: PlanObject, key: string): string | null {
    const links = this.links(obj);
    if (!isBurner(obj) || !links.length) { this.draw = null; this.samples = null; this.times = []; return null; }
    if (key !== this.key) { this.key = key; this.selectedLink = ''; this.index = 0; }
    const link = links.find((l) => l.id === this.selectedLink) ?? links[0];
    this.selectedLink = link.id;
    const following = Boolean(this.playhead?.hasRange) && plotFollowsFlame(this.store.document, obj, link, this.loaded);
    // Imports replace the sample array; undo/redo also restore new arrays. Identity
    // catches replacements even when timestamps and sample counts are unchanged.
    return JSON.stringify([obj.name, link.id, links.map((l) => {
      const samples = l.plot!.samples;
      if (!this.snapshots.has(samples)) this.snapshots.set(samples, ++this.nextSnapshot);
      return [l.id, l.label, l.path, l.plot!.importedAt, samples.length, this.snapshots.get(samples)];
    }), following]);
  }

  /** The clock moved: put the cursor on the sample it is at, if it is on any. */
  follow(): void {
    if (!this.following || !this.playhead?.hasRange || !this.samples || !this.draw) return;
    const index = Math.max(lastIndexAtOrBefore(this.times, this.playhead.time_s), 0);
    if (index === this.index) return;
    this.index = index;
    this.draw();
  }

  render(obj: PlanObject, root: HTMLElement, rerender: () => void): void {
    if (!isBurner(obj)) return;
    const links = this.links(obj);
    const link = links.find((l) => l.id === this.selectedLink) ?? links[0];
    const following = Boolean(this.playhead?.hasRange) && plotFollowsFlame(this.store.document, obj, link, this.loaded);
    this.following = following;
    const plot = link.plot!;
    this.index = Math.min(this.index, plot.samples.length - 1);
    root.append(h('div', { class: 'plot-panel__source', title: link.path }, [`${obj.name || obj.id} · ${link.label || fileName(link.path)}`]));
    if (links.length > 1) root.append(h('select', { 'aria-label': 'Reconstruction dataset', class: 'field__input',
      onchange: (e: Event) => { this.selectedLink = (e.target as HTMLSelectElement).value; this.index = 0; rerender(); } },
    links.map((l) => h('option', { value: l.id, selected: l.id === link.id }, [l.label || fileName(l.path)]))));
    const charts = h('div');
    const volume = chart(plot, 1), area = chart(plot, 2);
    charts.append(volume.svg, area.svg);
    const value = h('output', { class: 'plot-panel__values', 'aria-live': 'polite' });
    const slider = h('input', { type: 'range', min: 0, max: plot.samples.length - 1, step: 1, value: this.index,
      'aria-label': 'Measurement sample', disabled: plot.samples.length === 1,
      oninput: (e: Event) => {
        this.index = Number((e.target as HTMLInputElement).value);
        // Seeking the clock brings the cursor back here through `follow`; drawing
        // now as well keeps the plot responsive when there is no clock to seek.
        if (following) this.playhead!.seek(plot.samples[this.index][0]);
        draw();
      } });
    const draw = (): void => {
      volume.select(this.index); area.select(this.index);
      const sample = plot.samples[this.index];
      slider.value = String(this.index);
      value.textContent = `${fmt(sample[0])} s · ${fmt(sample[1])} m³ · ${fmt(sample[2])} m²`;
    };
    this.draw = draw;
    this.samples = plot.samples;
    this.times = plot.samples.map((s) => s[0]);
    this.follow();
    draw();
    root.append(charts, slider, value, h('p', { class: 'plot-panel__note' }, [this.caption(link, following)]));
  }

  private caption(link: LinkedFile, following: boolean): string {
    return `CSV snapshot · ${link.plot!.samples.length.toLocaleString()} samples · ${link.plot!.importedAt.replace('T', ' ').replace(/(?:\.\d+)?Z$/, ' UTC')}. `
      + (following
        ? 'The cursor follows the flame playback; dragging it seeks the playback.'
        : this.playhead?.hasRange
          ? 'Not this burner\'s reconstruction, so the cursor is its own. Refresh or relink from Linked files after the source changes.'
          : 'Refresh or relink from Linked files after the source changes.');
  }
}
