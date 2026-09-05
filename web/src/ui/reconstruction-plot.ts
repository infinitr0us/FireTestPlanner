import { fileName } from '../core/linked-files';
import type { LinkedFile, ReconstructionPlot } from '../core/types';
import type { Store } from '../state/store';
import { h } from './dom';

const fmt = (v: number): string => Number(v.toPrecision(4)).toString();
const NS = 'http://www.w3.org/2000/svg';
function svgElement(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Two aligned plots keep volume and area in their own units and scales. */
function chart(plot: ReconstructionPlot, column: 1 | 2): { svg: SVGElement; select: (index: number) => void } {
  const samples = plot.samples;
  const title = column === 1 ? 'Volume (m³)' : 'Surface area (m²)';
  const color = column === 1 ? '#65caff' : '#ffbe66';
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
    svg.append(svgElement('line', { x1: 56, x2: 328, y1: yy, y2: yy, stroke: '#405066', 'stroke-width': 0.6 }));
    svg.append(svgElement('text', { x: 49, y: yy + 4, 'text-anchor': 'end' }, fmt(ymax * fraction)));
  }
  for (const t of maxTime === minTime ? [minTime] : [minTime, minTime + (maxTime - minTime) / 2, maxTime]) {
    svg.append(svgElement('text', { x: x(t), y: 119, 'text-anchor': 'middle' }, fmt(t)));
  }
  svg.append(svgElement('text', { x: 192, y: 133, 'text-anchor': 'middle' }, 'Time (s)'));
  svg.append(svgElement('path', { d: samples.map((s, i) => `${i ? 'L' : 'M'}${x(s[0]).toFixed(2)},${y(s[column]).toFixed(2)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 1.5 }));
  const cursor = svgElement('line', { y1: 28, y2: 103, stroke: '#cbd5e1', 'stroke-dasharray': '3 3' });
  const point = svgElement('circle', { r: 3, fill: color });
  svg.append(cursor, point);
  return { svg, select: (index) => {
    const selected = samples[index], xx = String(x(selected[0]));
    cursor.setAttribute('x1', xx); cursor.setAttribute('x2', xx);
    point.setAttribute('cx', xx); point.setAttribute('cy', String(y(selected[column])));
  } };
}

export class ReconstructionPlotPanel {
  private root = h('section', { class: 'reconstruction-plot', hidden: true, 'aria-label': 'Burner reconstruction results' });
  private collapsed = false;
  private selectedLink = '';
  private index = 0;
  private key = '';
  private signature = '';
  private snapshots = new WeakMap<ReconstructionPlot['samples'], number>();
  private nextSnapshot = 0;

  constructor(container: HTMLElement, private store: Store) {
    container.append(this.root);
    for (const event of ['pointerdown', 'click', 'dblclick', 'wheel']) this.root.addEventListener(event, (e) => e.stopPropagation());
    store.subscribe(() => this.render());
    this.render();
  }

  render(): void {
    const obj = this.store.soleSelected;
    const links = obj?.type === 'burner' ? obj.linkedFiles?.filter((f) => f.plot) ?? [] : [];
    this.root.hidden = !links.length;
    if (!obj || !links.length) { this.signature = ''; return; }
    const key = `${this.store.documentId}/${obj.id}`;
    if (key !== this.key) { this.key = key; this.selectedLink = ''; this.index = 0; }
    const link = links.find((l) => l.id === this.selectedLink) ?? links[0];
    this.selectedLink = link.id;
    // Imports replace the sample array; undo/redo also restore new arrays. Identity
    // catches replacements even when timestamps and sample counts are unchanged.
    const signature = JSON.stringify([key, obj.name, links.map((l) => {
      const samples = l.plot!.samples;
      if (!this.snapshots.has(samples)) this.snapshots.set(samples, ++this.nextSnapshot);
      return [l.id, l.label, l.path, l.plot!.importedAt, samples.length, this.snapshots.get(samples)];
    }), this.collapsed]);
    if (signature === this.signature) return;
    this.signature = signature;
    const plot = link.plot!;
    this.index = Math.min(this.index, plot.samples.length - 1);
    const title = h('strong', {}, ['Reconstruction results']);
    const collapse = h('button', { type: 'button', 'aria-expanded': String(!this.collapsed), title: 'Collapse or expand results',
      onclick: () => { this.collapsed = !this.collapsed; this.render(); } }, [this.collapsed ? 'Expand' : 'Collapse']);
    this.root.replaceChildren(h('div', { class: 'reconstruction-plot__header' }, [title, collapse]));
    if (this.collapsed) return;
    this.root.append(h('div', { class: 'reconstruction-plot__source', title: link.path }, [`${obj.name || obj.id} · ${link.label || fileName(link.path)}`]));
    if (links.length > 1) this.root.append(h('select', { 'aria-label': 'Reconstruction dataset', class: 'field__input',
      onchange: (e: Event) => { this.selectedLink = (e.target as HTMLSelectElement).value; this.index = 0; this.signature = ''; this.render(); } },
    links.map((l) => h('option', { value: l.id, selected: l.id === link.id }, [l.label || fileName(l.path)]))));
    const charts = h('div');
    const volume = chart(plot, 1), area = chart(plot, 2);
    charts.append(volume.svg, area.svg);
    const value = h('output', { class: 'reconstruction-plot__values', 'aria-live': 'polite' });
    const draw = (): void => {
      volume.select(this.index); area.select(this.index);
      const sample = plot.samples[this.index];
      value.textContent = `${fmt(sample[0])} s · ${fmt(sample[1])} m³ · ${fmt(sample[2])} m²`;
    };
    const slider = h('input', { type: 'range', min: 0, max: plot.samples.length - 1, step: 1, value: this.index,
      'aria-label': 'Measurement sample', disabled: plot.samples.length === 1,
      oninput: (e: Event) => { this.index = Number((e.target as HTMLInputElement).value); draw(); } });
    draw();
    this.root.append(charts, slider, value, h('p', { class: 'reconstruction-plot__note' }, [this.caption(link)]));
  }

  private caption(link: LinkedFile): string {
    return `CSV snapshot · ${link.plot!.samples.length.toLocaleString()} samples · ${link.plot!.importedAt.replace('T', ' ').replace(/(?:\.\d+)?Z$/, ' UTC')}. Refresh or relink from Linked files after the source changes.`;
  }
}
