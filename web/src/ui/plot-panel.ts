import * as i18n from './i18n';
/**
 * The plot frame in the viewport's upper right: one panel for the selected object,
 * with a shared header, Collapse/Expand, and a selector when more than one kind of
 * plot applies (a burner can have both a reconstruction CSV and test data). Each
 * kind is a `PlotView` that fills the panel under the header.
 */
import type { PlanObject } from '../core/types';
import type { Playhead } from '../state/playhead';
import type { Store } from '../state/store';
import { h } from './dom';

export interface PlotView {
  readonly id: string;
  /** The selector's word for this view. */
  readonly label: string;
  /** The header title. */
  title(obj: PlanObject): string;
  /**
   * What this view would draw for `obj`, as a string that changes whenever the
   * drawing must, or null when it has nothing for this object. `key` names the
   * document and object, so a view can reset its cursor for a new selection.
   */
  signature(obj: PlanObject, key: string): string | null;
  /** Append the plot under the header. Called after a non-null signature. */
  render(obj: PlanObject, root: HTMLElement, rerender: () => void): void;
  /** The shared clock moved: move the cursor, if this view follows it. */
  follow?(): void;
}

export class PlotPanel {
  private root = h('section', { class: 'plot-panel', hidden: true, 'aria-label': i18n.t("Plots for the selected object") });
  private collapsed = false;
  /** The view picked for each document/object, so returning to it keeps the choice. */
  private chosen = new Map<string, string>();
  private signature = '';
  private current: PlotView | null = null;

  constructor(container: HTMLElement, private store: Store, private views: PlotView[],
    sources: Array<(listener: () => void) => unknown>, playhead?: Playhead) {
    container.append(this.root);
    for (const event of ['pointerdown', 'click', 'dblclick', 'wheel']) this.root.addEventListener(event, (e) => e.stopPropagation());
    store.subscribe(() => this.render());
    i18n.subscribeLanguage(() => { this.signature = ""; this.render(); });
    for (const subscribe of sources) subscribe(() => this.render());
    playhead?.subscribe((event) => {
      if (event === 'time') { if (!this.collapsed) this.current?.follow?.(); } else this.render();
    });
    this.render();
  }

  get element(): HTMLElement { return this.root; }

  render(): void {
    const obj = this.store.soleSelected;
    const key = obj ? `${this.store.documentId}/${obj.id}` : '';
    const available = obj ? this.views.flatMap((view) => {
      const signature = view.signature(obj, key);
      return signature === null ? [] : [{ view, signature }];
    }) : [];
    if (!obj || !available.length) {
      this.root.hidden = true;
      this.root.setAttribute('aria-label', i18n.t("Plots for the selected object"));
      this.signature = '';
      this.current = null;
      return;
    }
    const picked = available.find((a) => a.view.id === this.chosen.get(key)) ?? available[0];
    const signature = JSON.stringify([key, picked.view.id, available.map((a) => a.view.id), picked.signature, this.collapsed]);
    if (signature === this.signature) return;
    this.signature = signature;
    const view = picked.view;
    this.root.hidden = false;
    this.root.setAttribute('aria-label', view.title(obj));
    const collapse = h('button', { type: 'button', 'aria-expanded': String(!this.collapsed), title: i18n.t("Collapse or expand the plot"),
      onclick: () => { this.collapsed = !this.collapsed; this.render(); } }, [this.collapsed ? i18n.t("Expand") : i18n.t("Collapse")]);
    this.root.replaceChildren(h('div', { class: 'plot-panel__header' }, [h('strong', {}, [view.title(obj)]), collapse]));
    if (available.length > 1) {
      this.root.append(h('div', { class: 'seg plot-panel__views', role: 'group', 'aria-label': i18n.t("Plot") }, available.map((a) =>
        h('button', { type: 'button', class: `seg__btn${a.view === view ? ' seg__btn--active' : ''}`, 'aria-pressed': String(a.view === view),
          onclick: () => { this.chosen.set(key, a.view.id); this.render(); } }, [a.view.label]))));
    }
    this.current = this.collapsed ? null : view;
    if (!this.collapsed) view.render(obj, this.root, () => { this.signature = ''; this.render(); });
  }
}
